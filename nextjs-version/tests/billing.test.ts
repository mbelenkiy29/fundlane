import test, { before, after } from "node:test"
import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { createServer } from "node:http"
import { readFile } from "node:fs/promises"
import pg from "pg"
import Stripe from "stripe"
import { createPostgresTestDatabase } from "./helpers/postgres-test-db.mjs"
import { createStripeHttpFixture } from "./helpers/stripe-http.mjs"
import { getDatabase, closeDatabaseForTests, nowIso, withTransaction } from "../src/lib/mca/db"
import { createWorkspaceWithAdmin } from "../src/lib/mca/workspaces"
import { BILLING_CATALOG, monthlyPriceCents } from "../src/lib/mca/billing-catalog"
import { initializeCompanyTrial, getCompanyAccess, evaluateCompanyAccess, assertCompanyOperational, assertCompanyOutboundAllowed, STRIPE_ACCESS } from "../src/lib/mca/company-access"
import { deliverBillingEmail } from "../src/lib/mca/email"
import { subscriptionEntitlement, syncWorkspaceBilling, getWorkspaceBilling, assertBillingCapacity, getStripeClient, processStripeBillingEvent, verifyStripeBillingEvent, verifyBillingPrices, createBillingCheckout, changeBillingSeats, cancelBillingSubscription, billingTrialDays, stripeCheckoutTrialConfiguration, isStripeCheckoutTrialConfigured, type BillingSubscription, type StripeBillingClient } from "../src/lib/mca/billing"
import { setPlatformCompanyAccess, deliverBillingNotifications, getPlatformCompanyBillingDetail, runBillingMaintenance } from "../src/lib/mca/billing-operations"
import { recordTrialGrant, releaseTrialReservation, reserveTrialForCheckout, trialAllowedForOwner, trialFingerprintAction } from "../src/lib/mca/trial-abuse"
import type { DbExecutor } from "../src/lib/mca/db"

let database: Awaited<ReturnType<typeof createPostgresTestDatabase>>
const envKeys = ["MCA_STRIPE_BILLING_ENABLED", "MCA_STRIPE_TAX_ENABLED", "MCA_STRIPE_TAX_BEHAVIOR", "MCA_STRIPE_MODE", "STRIPE_SECRET_KEY", "STRIPE_BASE_PRICE_ID", "STRIPE_ADDITIONAL_SEAT_PRICE_ID", "STRIPE_BILLING_WEBHOOK_SECRET", "MCA_APP_ORIGIN", "MCA_EMAIL_WEBHOOK_URL", "MCA_USESEND_API_KEY", "MCA_USESEND_FROM", "MCA_TRIAL_ABUSE_LIMITS_ENABLED", "MCA_TRIAL_LIMIT_PER_USER", "MCA_TRIAL_LIMIT_PER_EMAIL", "MCA_TRIAL_LIMIT_PER_DOMAIN", "MCA_TRIAL_FINGERPRINT_ACTION", "MCA_BILLING_MISSING_STATE_FAIL_CLOSED"]
const initialEnv = Object.fromEntries(envKeys.map(key => [key, process.env[key]]))
before(async () => {
  database = await createPostgresTestDatabase("billing")
  process.env.DATABASE_URL = database.databaseUrl
  Object.assign(process.env, { MCA_STRIPE_BILLING_ENABLED: "true", MCA_STRIPE_MODE: "test", STRIPE_SECRET_KEY: "rk_test_fixture", STRIPE_BASE_PRICE_ID: "price_base", STRIPE_ADDITIONAL_SEAT_PRICE_ID: "price_seats", STRIPE_BILLING_WEBHOOK_SECRET: "whsec_fixture", MCA_APP_ORIGIN: "http://localhost:3000" })
  delete process.env.MCA_STRIPE_TAX_ENABLED;delete process.env.MCA_STRIPE_TAX_BEHAVIOR
  delete process.env.MCA_USESEND_API_KEY;delete process.env.MCA_USESEND_FROM
  delete process.env.MCA_BILLING_MISSING_STATE_FAIL_CLOSED
})
after(async () => {
  for (const key of envKeys) { if (initialEnv[key] === undefined) delete process.env[key]; else process.env[key] = initialEnv[key] }
  await closeDatabaseForTests(); await database?.close()
})
function subscription(customer = "cus_fixture", seats = 5, status = "active", id = `sub_${randomUUID()}`): BillingSubscription {
  const period = { current_period_start: Math.floor(Date.now()/1000)-1000, current_period_end: Math.floor(Date.now()/1000)+2591000 }
  return { id, customer, status, livemode: false, items: { data: [{ id:"si_base",quantity:1,price:{id:"price_base"},...period }, ...(seats > 1 ? [{ id:"si_seats",quantity:seats-1,price:{id:"price_seats"},...period }] : [])] } }
}
async function fixture(mapped = true) {
  const suffix = randomUUID()
  const local = await createWorkspaceWithAdmin({ workspaceName:"Billing test",adminName:"Owner",adminEmail:`${suffix}@example.test`,password:"Unused fixture password 99!",role:"admin" })
  // These billing fixtures model either a historical explicit exemption or a missing row.
  if (mapped) await getDatabase().prepare("UPDATE company_subscription_state SET state_kind='legacy_exempt' WHERE workspace_id=?").run(local.workspaceId)
  else await getDatabase().prepare("DELETE FROM company_subscription_state WHERE workspace_id=?").run(local.workspaceId)
  const customerId = `cus_${suffix}`
  if (mapped) await getDatabase().prepare("INSERT INTO workspace_stripe_customers (workspace_id,stripe_customer_id,created_at) VALUES (?,?,?)").run(local.workspaceId,customerId,nowIso())
  const sub = subscription(customerId)
  const invoice = { id:`in_${suffix}`,customer:customerId,livemode:false,status:"paid",billing_reason:"subscription_create",currency:"usd",amount_due:71500,amount_paid:71500,amount_remaining:0,hosted_invoice_url:null,period_start:sub.items.data[0].current_period_start,period_end:sub.items.data[0].current_period_end,created:Math.floor(Date.now()/1000),parent:{subscription_details:{subscription:sub.id}},attempt_count:1,due_date:null,status_transitions:{finalized_at:Math.floor(Date.now()/1000),paid_at:Math.floor(Date.now()/1000) as number|null} }
   const state = { subscriptions: mapped ? [sub] : [] as BillingSubscription[], invoices: mapped ? [invoice] : [] as typeof invoice[],fail:false,createdCustomers:0,checkouts:0,expires:0,checkoutStatus:"open" as "open"|"expired"|"complete",checkoutSubscription:null as string|null,updates:[] as Record<string,unknown>[], invoiceUpdates:[] as Array<{id:string;params:Record<string,unknown>;key:string|undefined}>, finalizations:[] as Array<{id:string;params:Record<string,unknown>;key:string|undefined}>, invoiceReads:0, checkoutParams:{} as Record<string,unknown>,checkoutKey:undefined as string|undefined,priceAmount:BILLING_CATALOG.base.unitAmountCents,processing:false }
  const client = {
    customers:{ create:async()=>{state.createdCustomers++;return{id:customerId,livemode:false}},retrieve:async()=>({id:customerId,livemode:false,metadata:{workspace_id:local.workspaceId}}) },
    subscriptions:{ list:async()=>{if(state.fail)throw new Error("outage");return{data:state.subscriptions,has_more:false}},retrieve:async(id:string)=>state.subscriptions.find(s=>s.id===id),update:async(_id:string,params:Record<string,unknown>)=>{state.updates.push(params);if("pause_collection" in params)sub.pause_collection=params.pause_collection ? {behavior:"keep_as_draft"} : null;return sub} },
    charges:{list:async()=>({data:[],has_more:false})},
    prices:{ retrieve:async(id:string)=>({id,active:true,livemode:false,currency:"usd",unit_amount:id==="price_base"?state.priceAmount:null,billing_scheme:id==="price_base"?"per_unit":"tiered",tiers_mode:"graduated",tiers:BILLING_CATALOG.additionalSeats.tiers.map(tier=>({up_to:tier.upTo,unit_amount:tier.unitAmountCents})),recurring:{interval:"month",interval_count:1,usage_type:"licensed"}}) },
    invoices:{list:async()=>{state.invoiceReads++;return{data:structuredClone(state.invoices),has_more:false}},finalizeInvoice:async(id:string,params:Record<string,unknown>,options?:{idempotencyKey?:string})=>{state.finalizations.push({id,params,key:options?.idempotencyKey});const target=state.invoices.find(i=>i.id===id)!;Object.assign(target,params,{status:"open",hosted_invoice_url:`https://invoice.stripe.com/i/${id}`,status_transitions:{finalized_at:Math.floor(Date.now()/1000),paid_at:null}});return structuredClone(target)},update:async(id:string,params:Record<string,unknown>,options?:{idempotencyKey?:string})=>{state.invoiceUpdates.push({id,params,key:options?.idempotencyKey});const target=state.invoices.find(i=>i.id===id)!;Object.assign(target,params);return structuredClone(target)}},
    invoicePayments:{list:async(params:{invoice?:string;payment?:{payment_intent?:string}})=>({data:state.processing?state.invoices.filter(i=>i.amount_remaining>0 && (!params.invoice || params.invoice===i.id) && (!params.payment?.payment_intent || params.payment.payment_intent===`pi_${i.id}`)).map(i=>({id:`ip_${i.id}`,invoice:i.id,livemode:false,status:"open",amount_requested:i.amount_remaining,amount_paid:null,currency:"usd",payment:{type:"payment_intent",payment_intent:`pi_${i.id}`}})):[],has_more:false})},
    paymentIntents:{retrieve:async(id:string)=>({id,customer:customerId,livemode:false,currency:"usd",amount:71500,amount_received:0,status:"processing"})},
    checkout:{sessions:{create:async(params:Record<string,unknown>,options?:{idempotencyKey?:string})=>{state.checkouts++;state.checkoutParams=params;state.checkoutKey=options?.idempotencyKey;return{id:`cs_${suffix}`,livemode:false,url:"https://checkout.stripe.com/test"}},retrieve:async()=>({id:`cs_${suffix}`,status:state.checkoutStatus,subscription:state.checkoutSubscription,url:"https://checkout.stripe.com/test"}),expire:async()=>{state.expires++;state.checkoutStatus="expired";return{}}}},
    subscriptionSchedules:{create:async(params:Record<string,unknown>)=>{assert.deepEqual(params,{from_subscription:sub.id});return{id:`sched_${suffix}`,customer:customerId,subscription:sub.id,livemode:false,status:"active",metadata:{},phases:[{start_date:sub.items.data[0].current_period_start,end_date:sub.items.data[0].current_period_end}]}},update:async()=>({})},
  } as unknown as StripeBillingClient
  return {...local,customerId,state,client}
}
async function removeBillingState(workspaceId:string) {
  await getDatabase().prepare("DELETE FROM company_subscription_state WHERE workspace_id=?").run(workspaceId)
}
async function stateFor(workspaceId:string) {
  return getDatabase().prepare<{legacy_exempt:number;selected_seats:number;state_kind:string|null}>("SELECT legacy_exempt,selected_seats,state_kind FROM company_subscription_state WHERE workspace_id=?").get(workspaceId)
}
test("unset missing-state flag preserves maintenance reconciliation",async()=>{
  const f=await fixture()
  await removeBillingState(f.workspaceId)
  const result=await runBillingMaintenance(f.client)
  assert.deepEqual(result.errors,[])
  assert.equal(result.reconciled,1)
  assert.deepEqual(await stateFor(f.workspaceId),{legacy_exempt:0,selected_seats:5,state_kind:"customer"})
})
test("unset missing-state flag preserves checkout and sync for workspaces without state",async()=>{
  const unmapped=await fixture(false)
  assert.equal((await syncWorkspaceBilling(unmapped.workspaceId,unmapped.client)).status,"legacy_exempt")
  assert.equal(await stateFor(unmapped.workspaceId),undefined)

  const checkout=await fixture(false)
  assert.equal((await getCompanyAccess(checkout.workspaceId)).status,"legacy_exempt")
  assert.match((await createBillingCheckout(checkout.workspaceId,5,false,checkout.client)).url,/checkout\.stripe\.com/)
  assert.equal(checkout.state.checkouts,1)
  assert.deepEqual(await stateFor(checkout.workspaceId),{legacy_exempt:1,selected_seats:5,state_kind:null})

  const synced=await fixture()
  await removeBillingState(synced.workspaceId)
  synced.state.fail=true
  await assert.rejects(syncWorkspaceBilling(synced.workspaceId,synced.client),{code:"billing_unavailable"})
  assert.equal(await stateFor(synced.workspaceId),undefined)
  synced.state.fail=false
  assert.equal((await syncWorkspaceBilling(synced.workspaceId,synced.client)).status,"active")
  assert.deepEqual(await stateFor(synced.workspaceId),{legacy_exempt:0,selected_seats:5,state_kind:"customer"})
})
test("unset missing-state flag preserves seat changes and cancellation",async()=>{
  const seats=await fixture()
  await removeBillingState(seats.workspaceId)
  await changeBillingSeats(seats.workspaceId,8,seats.userId,seats.client)
  assert.equal(seats.state.updates.length,1)
  assert.equal((await stateFor(seats.workspaceId))?.state_kind,"customer")

  const canceled=await fixture(),sub=canceled.state.subscriptions[0]
  await removeBillingState(canceled.workspaceId)
  const client={...canceled.client,subscriptions:{...canceled.client.subscriptions,update:async()=>{sub.cancel_at_period_end=true;return sub}}} as unknown as StripeBillingClient
  assert.equal((await cancelBillingSubscription(canceled.workspaceId,canceled.userId,client)).alreadyCanceled,false)
  assert.deepEqual(await stateFor(canceled.workspaceId),{legacy_exempt:1,selected_seats:5,state_kind:null})
})

test("trial grants limit repeat owners, keep public domains exempt, and flag fingerprint reuse without writes", async () => {
  const db = getDatabase()
  const first = await fixture(false)
  await db.prepare("INSERT INTO workspace_owners(workspace_id,membership_id,updated_at) VALUES (?,?,?)").run(first.workspaceId,first.membershipId,nowIso())
  const owner = await db.prepare<{email:string}>("SELECT u.email FROM workspace_owners o JOIN memberships m ON m.id=o.membership_id JOIN users u ON u.id=m.user_id WHERE o.workspace_id=?").get(first.workspaceId)
  assert.ok(owner)
  const second = await createWorkspaceWithAdmin({workspaceName:"Second company",adminName:"Owner",adminEmail:owner.email.toUpperCase(),password:"Unused fixture password 99!"})
  await db.prepare("INSERT INTO workspace_owners(workspace_id,membership_id,updated_at) VALUES (?,?,?)").run(second.workspaceId,second.membershipId,nowIso())
  process.env.MCA_TRIAL_ABUSE_LIMITS_ENABLED = "true"
  try {
    assert.equal(await trialAllowedForOwner(first.workspaceId,db),true)
    await createBillingCheckout(first.workspaceId,1,false,first.client)
    assert.equal((first.state.checkoutParams.subscription_data as Record<string,unknown>).trial_period_days,14,"first owner receives the trial")
    const reserved = await db.prepare<{checkout_session_id:string}>("SELECT checkout_session_id FROM company_trial_reservations WHERE workspace_id=?").get(first.workspaceId)
    assert.ok(reserved?.checkout_session_id)
    await createBillingCheckout(first.workspaceId,1,false,first.client)
    assert.equal(first.state.checkouts,1,"the same workspace reuses its open trial Checkout")
    assert.equal((await db.prepare<{checkout_session_id:string}>("SELECT checkout_session_id FROM company_trial_reservations WHERE workspace_id=?").get(first.workspaceId))?.checkout_session_id,reserved.checkout_session_id)
    assert.equal(await trialAllowedForOwner(second.workspaceId,db),false,"another workspace cannot claim the open trial")
    const checkoutClient = await fixture(false)
    const checkout = await createBillingCheckout(second.workspaceId,1,false,checkoutClient.client)
    assert.ok(checkout.url)
    assert.equal((checkoutClient.state.checkoutParams.subscription_data as Record<string,unknown>).trial_period_days,undefined,"second Checkout before reconciliation is paid")
    const sub = {id:`sub_${randomUUID()}`,trial_start:Math.floor(Date.now()/1000),trial_end:Math.floor(Date.now()/1000)+1209600,default_payment_method:"pm_one"} as Stripe.Subscription
    const card = {paymentMethods:{retrieve:async()=>({card:{fingerprint:"fp_repeat"}})},setupIntents:{retrieve:async()=>{throw new Error("unexpected")}}} as unknown as Pick<Stripe,"paymentMethods"|"setupIntents">
    await recordTrialGrant(first.workspaceId,sub,card,db)
    assert.equal((await db.prepare("SELECT workspace_id FROM company_trial_reservations WHERE workspace_id=?").get(first.workspaceId)),undefined)
    assert.equal(await trialAllowedForOwner(second.workspaceId,db),false)
    const grant = await db.prepare<{owner_email:string;email_domain:string}>("SELECT owner_email,email_domain FROM company_trial_grants WHERE workspace_id=?").get(first.workspaceId)
    assert.equal(grant?.owner_email,owner.email.toLowerCase())
    process.env.MCA_TRIAL_LIMIT_PER_USER = "2"
    process.env.MCA_TRIAL_LIMIT_PER_EMAIL = "2"
    assert.equal(await trialAllowedForOwner(second.workspaceId,db),true)
    process.env.MCA_TRIAL_LIMIT_PER_DOMAIN = "1"
    assert.equal(await trialAllowedForOwner(second.workspaceId,db),false)
    const gmail = await createWorkspaceWithAdmin({workspaceName:"Public domain",adminName:"Owner",adminEmail:`${randomUUID()}@gmail.com`,password:"Unused fixture password 99!"})
    await db.prepare("INSERT INTO workspace_owners(workspace_id,membership_id,updated_at) VALUES (?,?,?)").run(gmail.workspaceId,gmail.membershipId,nowIso())
    await db.prepare("INSERT INTO company_trial_grants (workspace_id,stripe_subscription_id,owner_user_id,owner_email,email_domain,trial_started_at,created_at) SELECT ?,?,m.user_id,lower(u.email),'gmail.com',?,? FROM workspace_owners o JOIN memberships m ON m.id=o.membership_id JOIN users u ON u.id=m.user_id WHERE o.workspace_id=?").run(gmail.workspaceId,`sub_${randomUUID()}`,nowIso(),nowIso(),gmail.workspaceId)
    const anotherGmail = await createWorkspaceWithAdmin({workspaceName:"Another public domain",adminName:"Owner",adminEmail:`${randomUUID()}@gmail.com`,password:"Unused fixture password 99!"})
    await db.prepare("INSERT INTO workspace_owners(workspace_id,membership_id,updated_at) VALUES (?,?,?)").run(anotherGmail.workspaceId,anotherGmail.membershipId,nowIso())
    assert.equal(await trialAllowedForOwner(anotherGmail.workspaceId,db),true)
    await recordTrialGrant(second.workspaceId,{...sub,id:`sub_${randomUUID()}`} as Stripe.Subscription,card,db)
    const flagged = await db.prepare<{fingerprint_flagged_at:string|null}>("SELECT fingerprint_flagged_at FROM company_trial_grants WHERE workspace_id=?").get(second.workspaceId)
    assert.ok(flagged?.fingerprint_flagged_at)
    assert.equal((await db.prepare<{count:number}>("SELECT count(*)::int count FROM audit_events WHERE workspace_id=? AND action='billing.trial_fingerprint_review'").get(second.workspaceId))?.count,1)
    const audit = await db.prepare<{metadata:string}>("SELECT metadata FROM audit_events WHERE workspace_id=? AND action='billing.trial_fingerprint_review'").get(second.workspaceId)
    assert.ok(audit)
    assert.equal(audit.metadata.includes(first.workspaceId),false,"tenant audit metadata hides the other workspace")
    assert.equal((await db.prepare<{fingerprint_prior_workspace_id:string}>("SELECT fingerprint_prior_workspace_id FROM company_trial_grants WHERE workspace_id=?").get(second.workspaceId))?.fingerprint_prior_workspace_id,first.workspaceId)
  } finally {
    for (const key of ["MCA_TRIAL_ABUSE_LIMITS_ENABLED","MCA_TRIAL_LIMIT_PER_USER","MCA_TRIAL_LIMIT_PER_EMAIL","MCA_TRIAL_LIMIT_PER_DOMAIN"]) delete process.env[key]
  }
})

test("grant reconciliation keeps the owner who reserved Checkout after ownership transfers", async () => {
  const db = getDatabase()
  const first = await fixture(false)
  await db.prepare("INSERT INTO workspace_owners(workspace_id,membership_id,updated_at) VALUES (?,?,?)").run(first.workspaceId,first.membershipId,nowIso())
  const original = await db.prepare<{user_id:string;email:string}>("SELECT m.user_id,u.email FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.id=?").get(first.membershipId)
  assert.ok(original)
  const sameOwner = await createWorkspaceWithAdmin({workspaceName:"Original owner's other company",adminName:"Owner",adminEmail:original.email,password:"Unused fixture password 99!"})
  await db.prepare("INSERT INTO workspace_owners(workspace_id,membership_id,updated_at) VALUES (?,?,?)").run(sameOwner.workspaceId,sameOwner.membershipId,nowIso())
  const replacement = await fixture(false)
  await db.prepare("INSERT INTO workspace_owners(workspace_id,membership_id,updated_at) VALUES (?,?,?)").run(replacement.workspaceId,replacement.membershipId,nowIso())
  const replacementUser = await db.prepare<{user_id:string}>("SELECT user_id FROM memberships WHERE id=?").get(replacement.membershipId)
  assert.ok(replacementUser)
  process.env.MCA_TRIAL_ABUSE_LIMITS_ENABLED = "true"
  try {
    await createBillingCheckout(first.workspaceId,1,false,first.client)
    const reservation = await db.prepare<{owner_user_id:string;owner_email:string;email_domain:string}>("SELECT owner_user_id,owner_email,email_domain FROM company_trial_reservations WHERE workspace_id=?").get(first.workspaceId)
    assert.deepEqual(reservation,{owner_user_id:original.user_id,owner_email:original.email.toLowerCase(),email_domain:"example.test"})
    const newMembership = randomUUID()
    await db.prepare("INSERT INTO memberships(id,workspace_id,user_id,role,status,created_at,updated_at) VALUES (?,?,?,'admin','active',?,?)").run(newMembership,first.workspaceId,replacementUser.user_id,nowIso(),nowIso())
    await db.prepare("UPDATE workspace_owners SET membership_id=?,updated_at=? WHERE workspace_id=?").run(newMembership,nowIso(),first.workspaceId)
    const trial = {...subscription(first.customerId,5,"trialing"),trial_start:Math.floor(Date.now()/1000),trial_end:Math.floor(Date.now()/1000)+1209600}
    first.state.subscriptions.push(trial)
    await syncWorkspaceBilling(first.workspaceId,first.client)
    const grant = await db.prepare<{owner_user_id:string;owner_email:string;email_domain:string}>("SELECT owner_user_id,owner_email,email_domain FROM company_trial_grants WHERE workspace_id=?").get(first.workspaceId)
    assert.deepEqual(grant,reservation)
    assert.equal(await db.prepare("SELECT workspace_id FROM company_trial_reservations WHERE workspace_id=?").get(first.workspaceId),undefined)
    assert.equal(await trialAllowedForOwner(sameOwner.workspaceId,db),false,"the original owner still uses their one trial")
    assert.equal(await trialAllowedForOwner(replacement.workspaceId,db),true,"the new owner did not claim this trial")
  } finally { delete process.env.MCA_TRIAL_ABUSE_LIMITS_ENABLED }
})

test("invalid fingerprint action warns and explicitly falls back to flag", () => {
  const previous = process.env.MCA_TRIAL_FINGERPRINT_ACTION
  const warnings:string[] = []
  const originalWarn = console.warn
  console.warn = (message: string) => { warnings.push(message) }
  try {
    process.env.MCA_TRIAL_FINGERPRINT_ACTION = "ignore"
    assert.equal(trialFingerprintAction(),"flag")
    assert.deepEqual(warnings,["Invalid MCA_TRIAL_FINGERPRINT_ACTION; falling back to flag."])
    process.env.MCA_TRIAL_FINGERPRINT_ACTION = "off"
    assert.equal(trialFingerprintAction(),"off")
    delete process.env.MCA_TRIAL_FINGERPRINT_ACTION
    assert.equal(trialFingerprintAction(),"flag")
    assert.equal(warnings.length,1)
  } finally {
    console.warn = originalWarn
    if (previous === undefined) delete process.env.MCA_TRIAL_FINGERPRINT_ACTION
    else process.env.MCA_TRIAL_FINGERPRINT_ACTION = previous
  }
})

test("expired trial Checkout releases its reservation for another workspace", async () => {
  const db = getDatabase()
  const first = await fixture(false)
  await db.prepare("INSERT INTO workspace_owners(workspace_id,membership_id,updated_at) VALUES (?,?,?)").run(first.workspaceId,first.membershipId,nowIso())
  const owner = await db.prepare<{email:string}>("SELECT u.email FROM workspace_owners o JOIN memberships m ON m.id=o.membership_id JOIN users u ON u.id=m.user_id WHERE o.workspace_id=?").get(first.workspaceId)
  assert.ok(owner)
  const second = await createWorkspaceWithAdmin({workspaceName:"Second company",adminName:"Owner",adminEmail:owner.email,password:"Unused fixture password 99!"})
  await db.prepare("INSERT INTO workspace_owners(workspace_id,membership_id,updated_at) VALUES (?,?,?)").run(second.workspaceId,second.membershipId,nowIso())
  const secondClient = await fixture(false)
  process.env.MCA_TRIAL_ABUSE_LIMITS_ENABLED = "true"
  try {
    await createBillingCheckout(first.workspaceId,1,false,first.client)
    first.state.checkoutStatus = "expired"
    await syncWorkspaceBilling(first.workspaceId,first.client)
    assert.equal(await db.prepare("SELECT workspace_id FROM company_trial_reservations WHERE workspace_id=?").get(first.workspaceId),undefined)
    await createBillingCheckout(second.workspaceId,1,false,secondClient.client)
    assert.equal((secondClient.state.checkoutParams.subscription_data as Record<string,unknown>).trial_period_days,14)
  } finally { delete process.env.MCA_TRIAL_ABUSE_LIMITS_ENABLED }
})

test("completed trial Checkout stays counted past reservation expiry until a lagging subscription is granted", async () => {
  const db = getDatabase()
  const first = await fixture(false)
  await db.prepare("INSERT INTO workspace_owners(workspace_id,membership_id,updated_at) VALUES (?,?,?)").run(first.workspaceId,first.membershipId,nowIso())
  const owner = await db.prepare<{email:string}>("SELECT u.email FROM workspace_owners o JOIN memberships m ON m.id=o.membership_id JOIN users u ON u.id=m.user_id WHERE o.workspace_id=?").get(first.workspaceId)
  assert.ok(owner)
  const second = await createWorkspaceWithAdmin({workspaceName:"Same owner",adminName:"Owner",adminEmail:owner.email,password:"Unused fixture password 99!"})
  await db.prepare("INSERT INTO workspace_owners(workspace_id,membership_id,updated_at) VALUES (?,?,?)").run(second.workspaceId,second.membershipId,nowIso())
  process.env.MCA_TRIAL_ABUSE_LIMITS_ENABLED = "true"
  try {
    await createBillingCheckout(first.workspaceId,1,false,first.client)
    await db.prepare("UPDATE company_trial_reservations SET expires_at=? WHERE workspace_id=?").run(new Date(Date.now()-1000).toISOString(),first.workspaceId)
    first.state.checkoutStatus = "complete"
    const trial = {...subscription(first.customerId,5,"trialing"),trial_start:Math.floor(Date.now()/1000),trial_end:Math.floor(Date.now()/1000)+1209600}
    first.state.checkoutSubscription = trial.id
    assert.equal(await trialAllowedForOwner(second.workspaceId,db),false,"expired timestamp cannot free a completed Checkout")
    const secondClient = await fixture(false)
    await createBillingCheckout(second.workspaceId,1,false,secondClient.client)
    assert.equal((secondClient.state.checkoutParams.subscription_data as Record<string,unknown>).trial_period_days,undefined)
    const laggingClient = {...first.client,subscriptions:{...first.client.subscriptions,retrieve:async()=>trial}} as unknown as StripeBillingClient
    await syncWorkspaceBilling(first.workspaceId,laggingClient)
    assert.equal(first.state.subscriptions.length,0,"subscription list still lags")
    assert.equal((await db.prepare<{stripe_subscription_id:string}>("SELECT stripe_subscription_id FROM company_trial_grants WHERE workspace_id=?").get(first.workspaceId))?.stripe_subscription_id,trial.id)
    assert.equal(await db.prepare("SELECT workspace_id FROM company_trial_reservations WHERE workspace_id=?").get(first.workspaceId),undefined)
    assert.equal(await trialAllowedForOwner(second.workspaceId,db),false,"durable grant continues to count")
  } finally { delete process.env.MCA_TRIAL_ABUSE_LIMITS_ENABLED }
})

test("completed Checkout without a trial releases its reservation", async () => {
  const db = getDatabase()
  const f = await fixture(false)
  await db.prepare("INSERT INTO workspace_owners(workspace_id,membership_id,updated_at) VALUES (?,?,?)").run(f.workspaceId,f.membershipId,nowIso())
  process.env.MCA_TRIAL_ABUSE_LIMITS_ENABLED = "true"
  try {
    await createBillingCheckout(f.workspaceId,1,false,f.client)
    const paid = subscription(f.customerId)
    f.state.subscriptions.push(paid)
    f.state.checkoutStatus = "complete"
    f.state.checkoutSubscription = paid.id
    await syncWorkspaceBilling(f.workspaceId,f.client)
    assert.equal(await db.prepare("SELECT workspace_id FROM company_trial_reservations WHERE workspace_id=?").get(f.workspaceId),undefined)
  } finally { delete process.env.MCA_TRIAL_ABUSE_LIMITS_ENABLED }
})

test("disabled trial limits make no reservation queries or writes", async () => {
  delete process.env.MCA_TRIAL_ABUSE_LIMITS_ENABLED
  const forbidden = {prepare: () => { throw new Error("disabled trial limits touched the database") }} as unknown as DbExecutor
  assert.equal(await trialAllowedForOwner("workspace",forbidden),true)
  await reserveTrialForCheckout("workspace","cs_disabled",Math.floor(Date.now()/1000)+3600,forbidden)
  await releaseTrialReservation("workspace","cs_disabled",forbidden)
})

test("enabled trial limits require an owner identity before granting trial Checkout", async () => {
  const f = await fixture(false)
  process.env.MCA_TRIAL_ABUSE_LIMITS_ENABLED = "true"
  try {
    assert.equal(await trialAllowedForOwner(f.workspaceId,getDatabase()),false)
    await createBillingCheckout(f.workspaceId,1,false,f.client)
    assert.equal((f.state.checkoutParams.subscription_data as Record<string,unknown>).trial_period_days,undefined)
    assert.equal(await getDatabase().prepare("SELECT workspace_id FROM company_trial_reservations WHERE workspace_id=?").get(f.workspaceId),undefined)
  } finally { delete process.env.MCA_TRIAL_ABUSE_LIMITS_ENABLED }
})

test("reconciliation records a trial even when the subscription is already active", async () => {
  const f = await fixture()
  await getDatabase().prepare("INSERT INTO workspace_owners(workspace_id,membership_id,updated_at) VALUES (?,?,?)").run(f.workspaceId,f.membershipId,nowIso())
  f.state.subscriptions[0].trial_start = Math.floor(Date.now()/1000)-1209600
  f.state.subscriptions[0].trial_end = Math.floor(Date.now()/1000)-60
  process.env.MCA_TRIAL_ABUSE_LIMITS_ENABLED = "true"
  try {
    await syncWorkspaceBilling(f.workspaceId,f.client)
    assert.equal((await getDatabase().prepare<{stripe_subscription_id:string}>("SELECT stripe_subscription_id FROM company_trial_grants WHERE workspace_id=?").get(f.workspaceId))?.stripe_subscription_id,f.state.subscriptions[0].id)
  } finally { delete process.env.MCA_TRIAL_ABUSE_LIMITS_ENABLED }
})

for (const entry of ["standalone", "outer_sync_failure", "outer_failure"] as const) test(`recovery verification failure survives ${entry} rollback with a single pool connection`, { timeout: 20000 }, async () => {
  const previousMax = process.env.MCA_DB_POOL_MAX
  await closeDatabaseForTests()
  process.env.MCA_DB_POOL_MAX = "1"
  try {
    const f = await fixture()
    Object.assign(f.state.invoices[0], { status: "open", billing_reason: "subscription_cycle", amount_paid: 0, amount_remaining: 71500, hosted_invoice_url: "https://invoice.stripe.com/i/previous" })
    await syncWorkspaceBilling(f.workspaceId, f.client)
    const before = (await getWorkspaceBilling(f.workspaceId)).recovery
    assert.equal(before.verificationPending, false)
    assert.equal(before.overdueAmount, 71500)
    const error = new Error("provider invoice verification failed")
    const event = { id: `evt_${randomUUID()}`, type: "invoice.payment_failed", livemode: false, data: { object: { customer: f.customerId } } } as Stripe.Event
    const client = { ...f.client, invoices: { ...f.client.invoices, list: async () => { throw error } } } as unknown as StripeBillingClient
    const operation = entry === "standalone" ? () => syncWorkspaceBilling(f.workspaceId, client)
      : entry === "outer_sync_failure" ? () => withTransaction(() => syncWorkspaceBilling(f.workspaceId, client))
      : () => withTransaction(async db => {
        // Even a successful nested reconciliation is uncommitted until its caller commits.
        f.state.invoices[0].amount_remaining = 100
        f.state.invoices[0].status = "open"
        await syncWorkspaceBilling(f.workspaceId, f.client)
        await db.prepare("INSERT INTO stripe_billing_events (event_id,event_type,stripe_customer_id,workspace_id,received_at) VALUES (?,?,?,?,?)").run(event.id,event.type,f.customerId,f.workspaceId,nowIso())
        throw error
      })
    await assert.rejects(operation, actual => actual === error)
    assert.equal(await getDatabase().prepare("SELECT event_id FROM stripe_billing_events WHERE event_id=?").get(event.id), undefined)
    const recovery = (await getWorkspaceBilling(f.workspaceId)).recovery
    assert.deepEqual(recovery, { ...before, verificationPending: true })
    const markers = await getDatabase().prepare<{n:number}>("SELECT count(*)::int n FROM audit_events WHERE workspace_id=? AND action='billing.recovery_verification_failed'").get(f.workspaceId)
    assert.equal(markers?.n, 1)
  } finally {
    await closeDatabaseForTests()
    if (previousMax === undefined) delete process.env.MCA_DB_POOL_MAX
    else process.env.MCA_DB_POOL_MAX = previousMax
  }
})

test("graduated pricing includes the first seat and uses marginal tiers",()=>{
  for(const [seats,total] of [[1,39900],[2,47800],[10,111000],[11,117900],[20,180000],[21,185900]]) assert.equal(monthlyPriceCents(seats),total)
  for(const seats of [0,-1,1.5,NaN,Infinity]) assert.throws(()=>monthlyPriceCents(seats))
  assert.equal(subscriptionEntitlement(subscription("cus_fixture",21)).seatLimit,21)
})
for (const scheduled of [false,true]) test(`cancellation ${scheduled ? "supersedes a seat schedule" : "updates an ordinary subscription"} while paused without forgiving debt`,async()=>{
  const f=await fixture(),sub=f.state.subscriptions[0],end=sub.items.data[0].current_period_end!
  await syncWorkspaceBilling(f.workspaceId,f.client)
  assert.equal((await getDatabase().prepare<{state_kind:string}>("SELECT state_kind FROM company_subscription_state WHERE workspace_id=?").get(f.workspaceId))?.state_kind,"customer")
  await getDatabase().prepare("UPDATE company_subscription_state SET manual_paused=1,delinquent_since=?,grace_ends_at=?,collection_paused=1 WHERE workspace_id=?").run(nowIso(),nowIso(),f.workspaceId)
  await getDatabase().prepare("UPDATE company_billing_invoices SET status='open',amount_paid=0,amount_remaining=amount_due WHERE workspace_id=?").run(f.workspaceId)
  sub.pause_collection={behavior:"keep_as_draft"}
  const before=await getDatabase().prepare("SELECT * FROM company_billing_invoices WHERE workspace_id=?").all(f.workspaceId)
  const writes:Array<{kind:string;params:Record<string,unknown>;key?:string}>=[]
  const phase={start_date:sub.items.data[0].current_period_start!,end_date:end,items:sub.items.data.map(i=>({price:i.price.id,quantity:i.quantity})),proration_behavior:"none"}
  const schedule={id:`sched_${sub.id}`,customer:f.customerId,subscription:sub.id,livemode:false,status:"active",metadata:{workspace_id:f.workspaceId,selected_seats:"2"},current_phase:{start_date:phase.start_date,end_date:end},end_behavior:"release",phases:[phase,{...phase,start_date:end,end_date:end+2592000}]}
  if(scheduled){sub.schedule=schedule.id;await getDatabase().prepare("UPDATE company_subscription_state SET pending_seats=2,pending_seats_at=?,stripe_schedule_id=? WHERE workspace_id=?").run(new Date(end*1000).toISOString(),schedule.id,f.workspaceId)}
  const client={...f.client,subscriptions:{...f.client.subscriptions,update:async(_id:string,params:Record<string,unknown>,options:{idempotencyKey:string})=>{writes.push({kind:"subscription",params,key:options.idempotencyKey});sub.cancel_at_period_end=true;sub.cancel_at=end;return sub}},subscriptionSchedules:{retrieve:async()=>schedule,update:async(_id:string,params:Record<string,unknown>,options:{idempotencyKey:string})=>{writes.push({kind:"schedule",params,key:options.idempotencyKey});Object.assign(schedule,params);sub.cancel_at=end;return schedule}}} as unknown as StripeBillingClient
  const result=await cancelBillingSubscription(f.workspaceId,f.userId,client)
  assert.equal(result.cancelAt,new Date(end*1000).toISOString())
  assert.equal(writes.length,1);assert.ok(writes[0].key)
  if(scheduled){assert.equal(writes[0].kind,"schedule");assert.equal(writes[0].params.end_behavior,"cancel");const phases=writes[0].params.phases as typeof phase[];assert.equal(phases.length,1);assert.equal(phases[0].end_date,end);assert.deepEqual(phases[0].items,phase.items);assert.equal(writes[0].params.proration_behavior,"none")}
  else assert.deepEqual(writes[0].params,{cancel_at_period_end:true,proration_behavior:"none"})
  assert.deepEqual(sub.pause_collection,{behavior:"keep_as_draft"});assert.equal(sub.items.data[1].quantity,4)
  assert.equal((await getCompanyAccess(f.workspaceId)).manualPaused,true)
  assert.deepEqual(await getDatabase().prepare("SELECT * FROM company_billing_invoices WHERE workspace_id=?").all(f.workspaceId),before)
  assert.equal((await getDatabase().prepare<{pending_seats:number|null}>("SELECT pending_seats FROM company_subscription_state WHERE workspace_id=?").get(f.workspaceId))?.pending_seats,null)
  await cancelBillingSubscription(f.workspaceId,f.userId,client)
  assert.equal(writes.length,1,"retry reads provider state instead of replaying a billing change")
  await assert.rejects(changeBillingSeats(f.workspaceId,2,f.userId,client),/active paid subscription|pending subscription change/)
})
for(const scheduled of [false,true]) test(`cancellation retry repairs local state after ${scheduled ? "schedule" : "subscription"} provider success and lost response`,async()=>{
  const f=await fixture(),sub=f.state.subscriptions[0],end=sub.items.data[0].current_period_end!
  await syncWorkspaceBilling(f.workspaceId,f.client)
  const phase={start_date:sub.items.data[0].current_period_start,end_date:end,items:sub.items.data.map(i=>({price:i.price.id,quantity:i.quantity}))}
  const schedule={id:`sched_${sub.id}`,customer:f.customerId,subscription:sub.id,livemode:false,status:"active",metadata:{workspace_id:f.workspaceId},current_phase:{start_date:phase.start_date,end_date:end},end_behavior:"release",phases:[phase,{...phase,start_date:end,end_date:end+2592000}]}
  if(scheduled){sub.schedule=schedule.id;await getDatabase().prepare("UPDATE company_subscription_state SET pending_seats=2,stripe_schedule_id=? WHERE workspace_id=?").run(schedule.id,f.workspaceId)}
  let writes=0
  const client={...f.client,subscriptions:{...f.client.subscriptions,update:async()=>{writes++;sub.cancel_at_period_end=true;sub.cancel_at=end;throw new Error("lost response")}},subscriptionSchedules:{retrieve:async()=>schedule,update:async(_id:string,params:object)=>{writes++;Object.assign(schedule,params);sub.cancel_at=end;throw new Error("lost response")}}} as unknown as StripeBillingClient
  await assert.rejects(cancelBillingSubscription(f.workspaceId,f.userId,client))
  assert.equal((await getDatabase().prepare<{pending_seats:number|null}>("SELECT pending_seats FROM company_subscription_state WHERE workspace_id=?").get(f.workspaceId))?.pending_seats,scheduled?2:null,"failed request cannot claim local completion")
  if(scheduled){assert.equal(schedule.end_behavior,"cancel");assert.equal(schedule.phases.length,1);assert.equal(schedule.phases[0].end_date,end,"provider success already prevents renewal despite local rollback")}
  assert.equal((await getDatabase().prepare<{n:number}>("SELECT count(*)::int n FROM audit_events WHERE workspace_id=? AND action='billing.cancellation_scheduled'").get(f.workspaceId))?.n,0)
  assert.equal((await cancelBillingSubscription(f.workspaceId,f.userId,client)).cancelAt,new Date(end*1000).toISOString())
  assert.equal(writes,1)
  assert.equal((await getDatabase().prepare<{pending_seats:number|null}>("SELECT pending_seats FROM company_subscription_state WHERE workspace_id=?").get(f.workspaceId))?.pending_seats,null)
  await assert.rejects(changeBillingSeats(f.workspaceId,2,f.userId,client),/pending subscription change/)
})
test("explicit key mode and subscription mode must agree",()=>{
  process.env.STRIPE_SECRET_KEY="sk_live_fixture"
  assert.throws(()=>getStripeClient(),/configured billing mode/)
  process.env.MCA_STRIPE_MODE="live"
  assert.ok(getStripeClient())
  assert.throws(()=>subscriptionEntitlement(subscription()),/mode/)
  process.env.MCA_STRIPE_MODE="test";process.env.STRIPE_SECRET_KEY="rk_test_fixture"
})
function restoreConfiguredStripe(){
  Object.assign(process.env,{MCA_STRIPE_BILLING_ENABLED:"true",MCA_STRIPE_MODE:"test",STRIPE_SECRET_KEY:"rk_test_fixture",STRIPE_BASE_PRICE_ID:"price_base",STRIPE_ADDITIONAL_SEAT_PRICE_ID:"price_seats",STRIPE_BILLING_WEBHOOK_SECRET:"whsec_fixture"})
}
test("stripeCheckoutTrialConfiguration reports each missing setting by name",()=>{
  restoreConfiguredStripe()
  assert.deepEqual(stripeCheckoutTrialConfiguration(),{configured:true,missing:[]})
  assert.equal(isStripeCheckoutTrialConfigured(),true)
  process.env.MCA_STRIPE_BILLING_ENABLED="false"
  assert.equal(isStripeCheckoutTrialConfigured(),false)
  assert.deepEqual(stripeCheckoutTrialConfiguration().missing,["MCA_STRIPE_BILLING_ENABLED"])
  restoreConfiguredStripe();delete process.env.STRIPE_SECRET_KEY
  assert.deepEqual(stripeCheckoutTrialConfiguration().missing,["STRIPE_SECRET_KEY"])
  restoreConfiguredStripe();process.env.STRIPE_SECRET_KEY="sk_live_fixture"
  assert.deepEqual(stripeCheckoutTrialConfiguration().missing,["STRIPE_SECRET_KEY"])
  restoreConfiguredStripe();delete process.env.STRIPE_BASE_PRICE_ID
  assert.deepEqual(stripeCheckoutTrialConfiguration().missing,["STRIPE_BASE_PRICE_ID"])
  restoreConfiguredStripe();process.env.STRIPE_ADDITIONAL_SEAT_PRICE_ID="not-a-price"
  assert.deepEqual(stripeCheckoutTrialConfiguration().missing,["STRIPE_ADDITIONAL_SEAT_PRICE_ID"])
  restoreConfiguredStripe();process.env.STRIPE_ADDITIONAL_SEAT_PRICE_ID="price_base"
  assert.deepEqual(stripeCheckoutTrialConfiguration().missing,["STRIPE_BASE_PRICE_ID","STRIPE_ADDITIONAL_SEAT_PRICE_ID"])
  restoreConfiguredStripe();delete process.env.STRIPE_BILLING_WEBHOOK_SECRET
  assert.deepEqual(stripeCheckoutTrialConfiguration().missing,["STRIPE_BILLING_WEBHOOK_SECRET"])
  restoreConfiguredStripe()
  assert.equal(isStripeCheckoutTrialConfigured(),true)
})
for(const mode of ["classic","flexible"]) test(`SDK ${mode} cancellation atomically replaces the reduction with a final current phase`,async()=>{
  const f=await fixture(),http=await createStripeHttpFixture(),url=new URL(http.origin)
  const client=new Stripe("rk_test_fixture",{apiVersion:"2026-08-26.dahlia",host:url.hostname,port:Number(url.port),protocol:"http",maxNetworkRetries:0})
  const sub={...f.state.subscriptions[0],billing_mode:{type:mode}}
  http.subscriptions.set(f.customerId,[sub]);http.invoices.set(f.customerId,f.state.invoices)
  try {
    await changeBillingSeats(f.workspaceId,2,f.userId,client)
    const schedule=[...http.schedules.values()][0]
    // Provider response fields must be converted to writable parameters, while
    // existing tax/discount/payment terms remain intact through cancellation.
    Object.assign(schedule.phases[0],{automatic_tax:{enabled:false,disabled_reason:null,liability:null},default_payment_method:{id:"pm_saved",object:"payment_method"},discounts:[{discount:{id:"di_existing",object:"discount"},coupon:"coupon_existing",promotion_code:null}],default_tax_rates:[{id:"txr_existing",object:"tax_rate"}],metadata:{id:"opaque",plan:"keep"},collection_method:"charge_automatically"})
    schedule.phases.push({...schedule.phases[0],start_date:schedule.phases[0].end_date,end_date:schedule.phases[0].end_date+2592000})
    const before=http.calls.length
    await cancelBillingSubscription(f.workspaceId,f.userId,client)
    const writes=http.calls.slice(before).filter(call=>call.method==="POST")
    assert.equal(writes.length,1);assert.equal(writes[0].path,`/v1/subscription_schedules/${schedule.id}`)
    const body=writes[0].body
    assert.equal(body.get("end_behavior"),"cancel");assert.equal(body.get("proration_behavior"),"none")
    assert.equal(body.get("phases[0][end_date]"),String(sub.items.data[0].current_period_end))
    assert.equal(body.get("phases[0][items][1][quantity]"),"4","do not apply the reduced seat quantity early")
    assert.equal(body.get("phases[0][default_payment_method]"),"pm_saved")
    assert.equal(body.get("phases[0][discounts][0][discount]"),"di_existing")
    assert.equal(body.get("phases[0][default_tax_rates][0]"),"txr_existing")
    assert.equal(body.get("phases[0][metadata][plan]"),"keep")
    assert.equal(body.get("phases[0][automatic_tax][enabled]"),"false")
    assert.equal([...body.keys()].some(key=>key.startsWith("phases[1]")||key.includes("disabled_reason")||key.includes("billing_mode")),false)
    assert.equal(sub.billing_mode.type,mode)
    await cancelBillingSubscription(f.workspaceId,f.userId,client)
    assert.equal(http.calls.slice(before).filter(call=>call.method==="POST").length,1)
  } finally {await http.close()}
})
test("cancellation failures retain stable retry keys, and renewed cancellation uses a fresh generation",async()=>{
  const f=await fixture(),sub=f.state.subscriptions[0],end=sub.items.data[0].current_period_end!
  await syncWorkspaceBilling(f.workspaceId,f.client)
  const keys:string[]=[];let fail=true
  const client={...f.client,subscriptions:{...f.client.subscriptions,update:async(_id:string,_params:unknown,options:{idempotencyKey:string})=>{keys.push(options.idempotencyKey);if(fail)throw new Error("provider unavailable");sub.cancel_at_period_end=true;sub.cancel_at=end;return sub}}} as unknown as StripeBillingClient
  await assert.rejects(cancelBillingSubscription(f.workspaceId,f.userId,client),/Retry cancellation/)
  fail=false;await cancelBillingSubscription(f.workspaceId,f.userId,client)
  assert.equal(keys[0],keys[1])
  sub.cancel_at=null;sub.cancel_at_period_end=false // operator/Portal reversal
  await cancelBillingSubscription(f.workspaceId,f.userId,client)
  assert.notEqual(keys[2],keys[1])
  sub.cancel_at=null;sub.cancel_at_period_end=false
  await cancelBillingSubscription(f.workspaceId,f.userId,client)
  assert.notEqual(keys[3],keys[2])
})
for(const failure of ["create_response_lost","before_update","update_response_lost"] as const) test(`schedule creation recovers ${failure} using provider idempotency proof after local rollback`,async()=>{
  const f=await fixture(),http=await createStripeHttpFixture(),url=new URL(http.origin)
  const sdk=new Stripe("rk_test_fixture",{apiVersion:"2026-08-26.dahlia",host:url.hostname,port:Number(url.port),protocol:"http",maxNetworkRetries:0})
  http.subscriptions.set(f.customerId,f.state.subscriptions);http.invoices.set(f.customerId,f.state.invoices)
  let failed=false
  const client={...f.client,subscriptions:sdk.subscriptions,subscriptionSchedules:{retrieve:sdk.subscriptionSchedules.retrieve.bind(sdk.subscriptionSchedules),create:async(...args:Parameters<typeof sdk.subscriptionSchedules.create>)=>{const result=await sdk.subscriptionSchedules.create(...args);if(!failed&&failure==="create_response_lost"){failed=true;throw new Error("lost create response")}return result},update:async(...args:Parameters<typeof sdk.subscriptionSchedules.update>)=>{if(!failed&&failure==="before_update"){failed=true;throw new Error("crash before update")}const result=await sdk.subscriptionSchedules.update(...args);if(!failed&&failure==="update_response_lost"){failed=true;throw new Error("lost update response")}return result}}} as unknown as StripeBillingClient
  try {
    await assert.rejects(changeBillingSeats(f.workspaceId,2,f.userId,client),/lost|crash/)
    assert.equal(http.schedules.size,1)
    assert.equal((await getDatabase().prepare<{pending_seats:number|null}>("SELECT pending_seats FROM company_subscription_state WHERE workspace_id=?").get(f.workspaceId))?.pending_seats??null,null)
    await changeBillingSeats(f.workspaceId,2,f.userId,client)
    const creations=http.calls.filter(c=>c.method==="POST"&&c.path==="/v1/subscription_schedules")
    assert.equal(creations.length,2);assert.equal(creations[0].idempotencyKey,creations[1].idempotencyKey)
    for(const call of creations) assert.deepEqual(Object.fromEntries(call.body),{from_subscription:f.state.subscriptions[0].id})
    const updates=http.calls.filter(c=>c.method==="POST"&&c.path.startsWith("/v1/subscription_schedules/"))
    for(const call of updates){assert.equal(call.body.get("metadata[workspace_id]"),f.workspaceId);assert.equal(call.body.get("metadata[selected_seats]"),"2")}
    if(updates.length>1)assert.equal(updates[0].idempotencyKey,updates[1].idempotencyKey)
    assert.equal(http.schedules.size,1)
    assert.equal((await getDatabase().prepare<{pending_seats:number|null}>("SELECT pending_seats FROM company_subscription_state WHERE workspace_id=?").get(f.workspaceId))?.pending_seats,2)
  } finally {await http.close()}
})
for(const tagged of [false,true]) test(`unknown ${tagged?"metadata-tagged":"untagged"} existing schedule cannot be adopted without creation replay proof`,async()=>{
  const f=await fixture(),http=await createStripeHttpFixture(),url=new URL(http.origin)
  const sdk=new Stripe("rk_test_fixture",{apiVersion:"2026-08-26.dahlia",host:url.hostname,port:Number(url.port),protocol:"http",maxNetworkRetries:0})
  const sub=f.state.subscriptions[0];sub.schedule="sched_foreign"
  http.subscriptions.set(f.customerId,[sub]);http.invoices.set(f.customerId,f.state.invoices)
  http.schedules.set("sched_foreign",{id:"sched_foreign",customer:f.customerId,subscription:sub.id,status:"active",livemode:false,metadata:tagged?{workspace_id:f.workspaceId,selected_seats:"2"}:{},phases:[{start_date:sub.items.data[0].current_period_start,end_date:sub.items.data[0].current_period_end}]})
  try {
    await assert.rejects(changeBillingSeats(f.workspaceId,2,f.userId,sdk),/schedule.*review/)
    assert.equal(http.calls.filter(c=>c.method==="POST"&&c.path.startsWith("/v1/subscription_schedules/")).length,0)
    assert.equal(http.schedules.size,1)
  } finally {await http.close()}
})
test("cancellation refuses mismatched schedule ownership and unverified provider success",async()=>{
  const f=await fixture(),sub=f.state.subscriptions[0]
  await syncWorkspaceBilling(f.workspaceId,f.client)
  sub.schedule="sched_wrong"
  let writes=0
  const client={...f.client,subscriptionSchedules:{retrieve:async()=>({id:"sched_wrong",customer:"cus_other",subscription:sub.id,livemode:false,status:"active"}),update:async()=>{writes++;return{}}}} as unknown as StripeBillingClient
  await assert.rejects(cancelBillingSubscription(f.workspaceId,f.userId,client),/schedule could not be verified/)
  assert.equal(writes,0)
  sub.schedule=null
  await assert.rejects(cancelBillingSubscription(f.workspaceId,f.userId,f.client),/Cancellation could not yet be verified/)
  assert.equal((await getDatabase().prepare<{n:number}>("SELECT count(*)::int n FROM audit_events WHERE workspace_id=? AND action='billing.cancellation_scheduled'").get(f.workspaceId))?.n,0)
})
test("schedule retry rejects a different attached schedule even when creation replay succeeds",async()=>{
  const f=await fixture(),http=await createStripeHttpFixture(),url=new URL(http.origin)
  const sdk=new Stripe("rk_test_fixture",{apiVersion:"2026-08-26.dahlia",host:url.hostname,port:Number(url.port),protocol:"http",maxNetworkRetries:0})
  const sub=f.state.subscriptions[0]
  http.subscriptions.set(f.customerId,[sub]);http.invoices.set(f.customerId,f.state.invoices)
  try {
    const created=await sdk.subscriptionSchedules.create({from_subscription:sub.id},{idempotencyKey:`fundlane-schedule-${sub.id}-${subscriptionEntitlement(sub).periodStart}`})
    sub.schedule="sched_replacement"
    http.schedules.set("sched_replacement",{...created,id:"sched_replacement",metadata:{workspace_id:f.workspaceId,selected_seats:"2"}})
    await assert.rejects(changeBillingSeats(f.workspaceId,2,f.userId,sdk),/creation does not match/)
    assert.equal(http.calls.filter(c=>c.method==="POST"&&c.path.startsWith("/v1/subscription_schedules/")).length,0)
  } finally {await http.close()}
})
test("trial starts once, is immutable, has five seats; absent legacy state retains access",async()=>{
  const f=await fixture(false)
  assert.equal((await getCompanyAccess(f.workspaceId)).status,"legacy_exempt")
  await initializeCompanyTrial(f.workspaceId,12)
  const first=await getCompanyAccess(f.workspaceId)
  assert.equal(first.status,"trial");assert.equal(first.seatLimit,5)
  await initializeCompanyTrial(f.workspaceId,2)
  assert.equal((await getCompanyAccess(f.workspaceId)).trialEndsAt,first.trialEndsAt)
  await assert.rejects(getDatabase().prepare("UPDATE company_subscription_state SET trial_started_at=? WHERE workspace_id=?").run(nowIso(),f.workspaceId),/immutable/)
  await assertBillingCapacity(f.workspaceId,4)
  await assert.rejects(assertBillingCapacity(f.workspaceId,5),/seats/)
})
test("time-based expiry works without cron and cancellation cannot restart a trial",()=>{
  const row={legacy_exempt:0,trial_ends_at:"2030-01-15T00:00:00.000Z",manual_paused:0,access_extended_until:null,grace_ends_at:null,processing_extension_until:null,pending_seats:null,status:null,period_end:null,seat_limit:5}
  assert.equal(evaluateCompanyAccess(row,Date.parse("2030-01-15")).allowed,false)
  assert.equal(evaluateCompanyAccess({...row,status:"canceled"},Date.parse("2030-01-10")).allowed,false)
  assert.equal(evaluateCompanyAccess({...row,legacy_exempt:1},Date.parse("2031-01-01")).allowed,true)
})
test("checkout reuses customer and open session and includes base plus additional seats without Stripe trial",async()=>{
  const f=await fixture(false)
  await initializeCompanyTrial(f.workspaceId,5)
  await createBillingCheckout(f.workspaceId,5,false,f.client)
  await createBillingCheckout(f.workspaceId,5,false,f.client)
  assert.equal(f.state.createdCustomers,1);assert.equal(f.state.checkouts,1);assert.equal(f.state.expires,0)
  assert.match(String(f.state.checkoutKey),new RegExp(`^fundlane-checkout-${f.workspaceId}-fundlane:5-initial-\\d+$`))
  assert.deepEqual(f.state.checkoutParams.line_items,[{price:"price_base",quantity:1},{price:"price_seats",quantity:4}])
  assert.deepEqual(f.state.checkoutParams.subscription_data,{metadata:{workspace_id:f.workspaceId},billing_mode:{type:"flexible"}})
  assert.match(String(f.state.checkoutParams.integration_identifier),/^fundlane_company_subscription_[a-z]{8}$/)
  assert.equal((await getCompanyAccess(f.workspaceId)).status,"trial")
})
test("tax flag off preserves the complete Checkout request",async()=>{
  delete process.env.MCA_STRIPE_TAX_ENABLED
  const f=await fixture(false)
  await initializeCompanyTrial(f.workspaceId,5)
  await createBillingCheckout(f.workspaceId,5,false,f.client)
  assert.deepEqual(f.state.checkoutParams,{
    mode:"subscription",customer:f.customerId,integration_identifier:"fundlane_company_subscription_ndmotxpw",
    client_reference_id:f.workspaceId,metadata:{workspace_id:f.workspaceId},payment_method_collection:"always",
    subscription_data:{metadata:{workspace_id:f.workspaceId},billing_mode:{type:"flexible"}},
    line_items:[{price:"price_base",quantity:1},{price:"price_seats",quantity:4}],
    success_url:"http://localhost:3000/settings/billing",cancel_url:"http://localhost:3000/settings/billing",
    expires_at:(Number(f.state.checkoutKey?.split("-").at(-1))+2)*1800,
  })
})
test("turning tax off expires an open tax-enabled Checkout and creates an untaxed session",async()=>{
  const f=await fixture(false)
  await initializeCompanyTrial(f.workspaceId,5)
  process.env.MCA_STRIPE_TAX_ENABLED="true"
  try {
    await createBillingCheckout(f.workspaceId,5,false,f.client)
    assert.deepEqual(f.state.checkoutParams.automatic_tax,{enabled:true})
    const client={...f.client,checkout:{sessions:{
      ...f.client.checkout.sessions,
      retrieve:async(id:string)=>({id,status:"open",url:"https://checkout.stripe.com/taxed",automatic_tax:{enabled:true}}),
    }}} as StripeBillingClient
    delete process.env.MCA_STRIPE_TAX_ENABLED
    const result=await createBillingCheckout(f.workspaceId,5,false,client)
    assert.equal(result.url,"https://checkout.stripe.com/test")
    assert.equal(f.state.checkouts,2)
    assert.equal(f.state.expires,1)
    assert.equal("automatic_tax" in f.state.checkoutParams,false)
    assert.equal("billing_address_collection" in f.state.checkoutParams,false)
    assert.equal("tax_id_collection" in f.state.checkoutParams,false)
    assert.equal("customer_update" in f.state.checkoutParams,false)
  } finally {delete process.env.MCA_STRIPE_TAX_ENABLED}
})
test("turning tax on expires an open untaxed Checkout and creates a tax-enabled session",async()=>{
  const f=await fixture(false)
  await initializeCompanyTrial(f.workspaceId,5)
  await createBillingCheckout(f.workspaceId,5,false,f.client)
  process.env.MCA_STRIPE_TAX_ENABLED="true"
  try {
    await createBillingCheckout(f.workspaceId,5,false,f.client)
    assert.equal(f.state.checkouts,2)
    assert.equal(f.state.expires,1)
    assert.deepEqual(f.state.checkoutParams.automatic_tax,{enabled:true})
  } finally {delete process.env.MCA_STRIPE_TAX_ENABLED}
})
for(const existingCustomer of [false,true]) test(`tax-enabled Checkout ${existingCustomer?"reuses an existing":"creates a new"} customer`,async()=>{
  process.env.MCA_STRIPE_TAX_ENABLED="true"
  try {
    const f=await fixture(existingCustomer)
    if(existingCustomer){f.state.subscriptions=[];f.state.invoices=[]}
    await initializeCompanyTrial(f.workspaceId,5)
    await createBillingCheckout(f.workspaceId,5,false,f.client)
    assert.equal(f.state.createdCustomers,existingCustomer?0:1)
    assert.equal(f.state.checkoutParams.customer,f.customerId)
    assert.deepEqual(f.state.checkoutParams.automatic_tax,{enabled:true})
    assert.equal(f.state.checkoutParams.billing_address_collection,"required")
    assert.deepEqual(f.state.checkoutParams.tax_id_collection,{enabled:true})
    assert.deepEqual(f.state.checkoutParams.customer_update,{address:"auto",name:"auto"})
  } finally {delete process.env.MCA_STRIPE_TAX_ENABLED}
})
test("price verification checks configured tax behavior without changing the unset rule",async()=>{
  const f=await fixture(false)
  const prices={retrieve:async(id:string)=>({...await f.client.prices.retrieve(id),tax_behavior:id==="price_base"?"exclusive":"inclusive"})}
  const client={...f.client,prices} as StripeBillingClient
  delete process.env.MCA_STRIPE_TAX_BEHAVIOR
  await verifyBillingPrices(client)
  process.env.MCA_STRIPE_TAX_BEHAVIOR="exclusive"
  try {
    await assert.rejects(verifyBillingPrices(client),{code:"billing_price_mismatch"})
    await verifyBillingPrices({...f.client,prices:{retrieve:async(id:string)=>({...await f.client.prices.retrieve(id),tax_behavior:"exclusive"})}} as StripeBillingClient)
    process.env.MCA_STRIPE_TAX_BEHAVIOR="invalid"
    await assert.rejects(verifyBillingPrices(client),{code:"billing_tax_behavior_invalid"})
  } finally {delete process.env.MCA_STRIPE_TAX_BEHAVIOR}
})
test("new company Checkout requires a card and one Stripe trial; retries reuse the session",async()=>{
  const f=await fixture(false)
  await getDatabase().prepare("INSERT INTO company_subscription_state(workspace_id,legacy_exempt,selected_seats,updated_at) VALUES (?,0,8,?)").run(f.workspaceId,nowIso())
  assert.equal((await getCompanyAccess(f.workspaceId)).reason,"finish_setup")
  await createBillingCheckout(f.workspaceId,8,true,f.client)
  await createBillingCheckout(f.workspaceId,8,true,f.client)
  assert.equal(f.state.checkouts,1);assert.equal(f.state.expires,0)
  assert.equal(f.state.checkoutParams.payment_method_collection,"always")
  assert.deepEqual(f.state.checkoutParams.subscription_data,{metadata:{workspace_id:f.workspaceId},billing_mode:{type:"flexible"},trial_period_days:14,trial_settings:{end_behavior:{missing_payment_method:"pause"}}})
  assert.deepEqual(f.state.checkoutParams.line_items,[{price:"price_base",quantity:1},{price:"price_seats",quantity:7}])
  assert.equal(f.state.checkoutParams.client_reference_id,f.workspaceId)
  process.env.MCA_BILLING_TRIAL_DAYS="21"
  assert.equal(billingTrialDays(),21)
  process.env.MCA_BILLING_TRIAL_DAYS="0"
  assert.throws(billingTrialDays,/Trial days/)
  delete process.env.MCA_BILLING_TRIAL_DAYS
})
test("changing checkout seats expires the open session and creates a new one",async()=>{
  const f=await fixture(false)
  await getDatabase().prepare("INSERT INTO company_subscription_state(workspace_id,legacy_exempt,selected_seats,updated_at) VALUES (?,0,8,?)").run(f.workspaceId,nowIso())
  await createBillingCheckout(f.workspaceId,8,true,f.client)
  await createBillingCheckout(f.workspaceId,2,true,f.client)
  assert.equal(f.state.checkouts,2);assert.equal(f.state.expires,1)
  assert.deepEqual(f.state.checkoutParams.line_items,[{price:"price_base",quantity:1},{price:"price_seats",quantity:1}])
  assert.match(String(f.state.checkoutKey),new RegExp(`^fundlane-checkout-${f.workspaceId}-fundlane:2-cs_[-\\w]+-\\d+$`))
})
test("Stripe status access table and trial quantity use provider state",()=>{
  const end=new Date(Date.now()+86400000).toISOString()
  const expired=new Date(Date.now()-86400000).toISOString()
  const row={legacy_exempt:0,trial_ends_at:null,manual_paused:0,access_extended_until:null,grace_ends_at:null,processing_extension_until:null,pending_seats:null,status:"none",period_end:end,seat_limit:12}
  for(const [status,expected] of Object.entries(STRIPE_ACCESS)) {
    const access=evaluateCompanyAccess({...row,status})
    assert.equal(access.allowed,expected.allowed,status)
    assert.equal(access.reason,expected.reason,status)
    assert.equal(access.seatLimit,12,status)
  }
  assert.equal(evaluateCompanyAccess({...row,status:"past_due",grace_ends_at:end}).allowed,true)
  assert.equal(evaluateCompanyAccess({...row,status:"trialing",grace_ends_at:"2000-01-01"}).allowed,true)
  assert.equal(evaluateCompanyAccess({...row,status:"none"}).reason,"finish_setup")
  for (const status of ["incomplete","incomplete_expired"] as const) {
    const granted=evaluateCompanyAccess({...row,status,trial_ends_at:end})
    assert.equal(granted.allowed,true,status)
    assert.equal(granted.status,"trial",status)
    assert.equal(granted.reason,null,status)
    assert.equal(granted.seatLimit,5,status)
    const denied=evaluateCompanyAccess({...row,status,trial_ends_at:expired})
    assert.equal(denied.allowed,false,status)
    assert.equal(denied.status,"paused",status)
    assert.equal(denied.reason,STRIPE_ACCESS[status].reason,status)
  }
  const unpaidGrace=evaluateCompanyAccess({...row,status:"unpaid",grace_ends_at:end})
  assert.equal(unpaidGrace.allowed,true)
  assert.equal(unpaidGrace.status,"grace")
  const unpaidExpired=evaluateCompanyAccess({...row,status:"unpaid",grace_ends_at:expired})
  assert.equal(unpaidExpired.allowed,false)
  assert.equal(unpaidExpired.status,"paused")
  assert.equal(unpaidExpired.reason,"payment_overdue")
})
test("trialing webhook receipts once, grants seats, and trial seat changes avoid invoices",async()=>{
  const f=await fixture()
  await getDatabase().prepare("DELETE FROM company_subscription_state WHERE workspace_id=?").run(f.workspaceId)
  await getDatabase().prepare("INSERT INTO company_subscription_state(workspace_id,legacy_exempt,selected_seats,updated_at) VALUES (?,0,5,?)").run(f.workspaceId,nowIso())
  const sub=f.state.subscriptions[0]
  sub.status="trialing";sub.trial_start=Math.floor(Date.now()/1000);sub.trial_end=sub.trial_start+14*86400
  Object.assign(f.state.invoices[0],{amount_due:0,amount_paid:0})
  const client={...f.client,subscriptions:{...f.client.subscriptions,update:async(_id:string,params:{proration_behavior:string;items:Array<{quantity?:number}>})=>{
    assert.equal(params.proration_behavior,"none")
    sub.items.data[1].quantity=params.items[0].quantity
    return sub
  }}} as unknown as StripeBillingClient
  for(const type of ["customer.subscription.created","customer.subscription.trial_will_end","invoice.paid"]) {
    const event={id:`evt_${randomUUID()}`,type,livemode:false,data:{object:{customer:f.customerId}}} as Stripe.Event
    const queued=await processStripeBillingEvent(event,client)
    assert.ok("queued" in queued && queued.queued)
    assert.deepEqual(await processStripeBillingEvent(event,client),{duplicate:true})
  }
  await syncWorkspaceBilling(f.workspaceId,client)
  assert.equal((await getDatabase().prepare<{n:number}>("SELECT count(*)::int n FROM stripe_billing_events WHERE workspace_id=?").get(f.workspaceId))?.n,3)
  assert.equal((await getCompanyAccess(f.workspaceId)).status,"trialing")
  assert.equal((await getCompanyAccess(f.workspaceId)).seatLimit,5)
  assert.equal(subscriptionEntitlement(sub).periodEnd,new Date(sub.trial_end*1000).toISOString())
  await changeBillingSeats(f.workspaceId,8,f.userId,client)
  assert.equal((await getCompanyAccess(f.workspaceId)).seatLimit,8)
  await changeBillingSeats(f.workspaceId,3,f.userId,client)
  assert.equal((await getCompanyAccess(f.workspaceId)).seatLimit,3)
  assert.equal((await getDatabase().prepare<{n:number}>("SELECT count(*)::int n FROM audit_events WHERE workspace_id=? AND action='billing.seats_changed'").get(f.workspaceId))?.n,2)
})
test("a workspace with prior Stripe trial gets a new Checkout without another trial",async()=>{
  const f=await fixture(false)
  await getDatabase().prepare("INSERT INTO company_subscription_state(workspace_id,legacy_exempt,selected_seats,updated_at) VALUES (?,0,1,?)").run(f.workspaceId,nowIso())
  await createBillingCheckout(f.workspaceId,1,true,f.client)
  const prior=subscription(f.customerId,1,"canceled")
  prior.trial_start=Math.floor(Date.now()/1000)-20*86400;prior.trial_end=prior.trial_start+14*86400
  f.state.subscriptions.push(prior)
  const client={...f.client,checkout:{sessions:{...f.client.checkout.sessions,retrieve:async()=>({id:"cs_expired",status:"expired"})}}} as unknown as StripeBillingClient
  await createBillingCheckout(f.workspaceId,1,true,client)
  assert.equal(f.state.checkouts,2)
  assert.equal((f.state.checkoutParams.subscription_data as Record<string,unknown>).trial_period_days,undefined)
})
test("SDK Checkout request explicitly selects flexible billing with a stable flow identifier",async()=>{
  const http=await createStripeHttpFixture(),url=new URL(http.origin)
  const client=new Stripe("rk_test_fixture",{apiVersion:"2026-08-26.dahlia",host:url.hostname,port:Number(url.port),protocol:"http",maxNetworkRetries:0})
  try {
    for (const onboarding of [false,true]) {
      const f=await fixture(false)
      await initializeCompanyTrial(f.workspaceId,5)
      await createBillingCheckout(f.workspaceId,onboarding?1:5,onboarding,client)
      assert.equal((await getCompanyAccess(f.workspaceId)).status,"trial")
    }
    const requests=http.calls.filter(call=>call.method==="POST"&&call.path==="/v1/checkout/sessions")
    assert.equal(requests.length,2)
    for (const request of requests) {
      assert.equal(request.apiVersion,"2026-08-26.dahlia")
      assert.equal(request.body.get("mode"),"subscription")
      assert.equal(request.body.get("subscription_data[billing_mode][type]"),"flexible")
      assert.match(request.body.get("integration_identifier")!,/^fundlane_company_subscription_[a-z]{8}$/)
      assert.equal(request.body.get("subscription_data[metadata][workspace_id]"),request.body.get("client_reference_id"))
      assert.equal(request.body.get("line_items[0][price]"),"price_base")
      assert.equal(request.body.get("line_items[0][quantity]"),"1")
      assert.equal([...request.body.keys()].some(key=>/trial|payment_method_types/.test(key)),false)
      assert.ok(request.idempotencyKey)
    }
    assert.equal(requests[0].body.get("integration_identifier"),requests[1].body.get("integration_identifier"))
    assert.equal(requests[0].body.get("line_items[1][quantity]"),"4")
    assert.equal(requests[1].body.has("line_items[1][price]"),false)
  } finally { await http.close() }
})
for (const mode of ["classic","flexible"] as const) test(`SDK ${mode} seat lifecycle retains mode, gates increases and schedules renewal reductions`,async()=>{
  const f=await fixture(),http=await createStripeHttpFixture(),url=new URL(http.origin)
  const client=new Stripe("rk_test_fixture",{apiVersion:"2026-08-26.dahlia",host:url.hostname,port:Number(url.port),protocol:"http",maxNetworkRetries:0})
  const sub={...f.state.subscriptions[0],billing_mode:{type:mode},pending_update:null as {expires_at:number}|null}
  http.customers.set(f.customerId,{id:f.customerId,livemode:false,metadata:{workspace_id:f.workspaceId}})
  http.subscriptions.set(f.customerId,[sub]);http.invoices.set(f.customerId,f.state.invoices)
  try {
    await syncWorkspaceBilling(f.workspaceId,client)
    await changeBillingSeats(f.workspaceId,8,f.userId,client)
    const increase=http.calls.find(call=>call.method==="POST"&&call.path===`/v1/subscriptions/${sub.id}`)!
    assert.deepEqual(Object.fromEntries(increase.body),{payment_behavior:"pending_if_incomplete",proration_behavior:"always_invoice","items[0][id]":"si_seats","items[0][quantity]":"7"})
    assert.equal((await getCompanyAccess(f.workspaceId)).seatLimit,5)
    // Explicit provider snapshots: pending payment has not applied the item update.
    sub.pending_update={expires_at:Math.floor(Date.now()/1000)+3600}
    await syncWorkspaceBilling(f.workspaceId,client)
    assert.equal((await getCompanyAccess(f.workspaceId)).seatLimit,5)
    await assert.rejects(changeBillingSeats(f.workspaceId,2,f.userId,client),{code:"billing_change_pending"})
    // Paid proration applies the items at Stripe; only the subsequent read grants seats.
    sub.pending_update=null;sub.items.data[1].quantity=7
    http.invoices.set(f.customerId,[...f.state.invoices,{...f.state.invoices[0],id:`in_proration_${mode}`,billing_reason:"subscription_update",amount_due:10000,amount_paid:10000}])
    await syncWorkspaceBilling(f.workspaceId,client)
    assert.equal((await getCompanyAccess(f.workspaceId)).seatLimit,8)
    await changeBillingSeats(f.workspaceId,2,f.userId,client)
    const create=http.calls.find(call=>call.method==="POST"&&call.path==="/v1/subscription_schedules")!
    assert.deepEqual(Object.fromEntries(create.body),{from_subscription:sub.id})
    const schedule=[...http.schedules.values()][0]
    assert.equal(schedule.billing_mode.type,mode)
    const update=http.calls.find(call=>call.method==="POST"&&call.path===`/v1/subscription_schedules/${schedule.id}`)!
    assert.deepEqual(Object.fromEntries(update.body),{
      "metadata[workspace_id]":f.workspaceId,"metadata[selected_seats]":"2",end_behavior:"release",proration_behavior:"none",
      "phases[0][start_date]":String(sub.items.data[0].current_period_start),"phases[0][end_date]":String(sub.items.data[0].current_period_end),
      "phases[0][items][0][price]":"price_base","phases[0][items][0][quantity]":"1","phases[0][items][1][price]":"price_seats","phases[0][items][1][quantity]":"7","phases[0][proration_behavior]":"none",
      "phases[1][start_date]":String(sub.items.data[0].current_period_end),"phases[1][items][0][price]":"price_base","phases[1][items][0][quantity]":"1","phases[1][items][1][price]":"price_seats","phases[1][items][1][quantity]":"1","phases[1][proration_behavior]":"none","phases[1][duration][interval]":"month","phases[1][duration][interval_count]":"1",
    })
    assert.equal(sub.items.data[1].quantity,7)
    assert.equal((await getCompanyAccess(f.workspaceId)).seatLimit,2)
    for (const call of [increase,create,update]) { assert.ok(call.idempotencyKey);assert.equal(call.apiVersion,"2026-08-26.dahlia") }
    assert.equal(http.calls.some(call=>call.path.endsWith("/migrate")),false)
    assert.equal(sub.billing_mode.type,mode)
  } finally { await http.close() }
})
test("tax-enabled seat changes activate existing subscriptions and tax both schedule phases",async()=>{
  process.env.MCA_STRIPE_TAX_ENABLED="true"
  const f=await fixture(),http=await createStripeHttpFixture(),url=new URL(http.origin)
  const client=new Stripe("rk_test_fixture",{apiVersion:"2026-08-26.dahlia",host:url.hostname,port:Number(url.port),protocol:"http",maxNetworkRetries:0})
  const sub=f.state.subscriptions[0]
  http.customers.set(f.customerId,{id:f.customerId,livemode:false,metadata:{workspace_id:f.workspaceId}})
  http.subscriptions.set(f.customerId,[sub]);http.invoices.set(f.customerId,f.state.invoices)
  try {
    await syncWorkspaceBilling(f.workspaceId,client)
    await changeBillingSeats(f.workspaceId,8,f.userId,client)
    const subscriptionWrites=http.calls.filter(call=>call.method==="POST"&&call.path===`/v1/subscriptions/${sub.id}`)
    assert.equal(subscriptionWrites.length,2)
    assert.deepEqual(Object.fromEntries(subscriptionWrites[0].body),{"automatic_tax[enabled]":"true",proration_behavior:"none"})
    assert.equal(subscriptionWrites[1].body.get("payment_behavior"),"pending_if_incomplete")
    assert.equal(subscriptionWrites[1].body.get("proration_behavior"),"always_invoice")
    assert.equal([...subscriptionWrites[1].body.keys()].some(key=>key.startsWith("automatic_tax")),false)
    await changeBillingSeats(f.workspaceId,2,f.userId,client)
    const scheduleWrite=http.calls.find(call=>call.method==="POST"&&call.path.startsWith("/v1/subscription_schedules/"))!
    assert.equal(scheduleWrite.body.get("phases[0][automatic_tax][enabled]"),"true")
    assert.equal(scheduleWrite.body.get("phases[1][automatic_tax][enabled]"),"true")
  } finally {delete process.env.MCA_STRIPE_TAX_ENABLED;await http.close()}
})
test("verified paid subscription replaces trial; failed proration cannot grant more seats",async()=>{
  const f=await fixture()
  await getDatabase().prepare("DELETE FROM company_subscription_state WHERE workspace_id=?").run(f.workspaceId)
  await initializeCompanyTrial(f.workspaceId,5)
  await syncWorkspaceBilling(f.workspaceId,f.client)
  assert.equal((await getCompanyAccess(f.workspaceId)).status,"active")
  await changeBillingSeats(f.workspaceId,8,f.userId,f.client)
  assert.equal(f.state.updates.at(-1)?.payment_behavior,"pending_if_incomplete")
  assert.equal(f.state.updates.at(-1)?.proration_behavior,"always_invoice")
  assert.equal((await getCompanyAccess(f.workspaceId)).seatLimit,5)
  f.state.fail=true
  await assert.rejects(syncWorkspaceBilling(f.workspaceId,f.client),/temporarily unavailable/)
  assert.equal((await getCompanyAccess(f.workspaceId)).seatLimit,5)
  f.state.fail=false
  f.state.subscriptions[0].items.data[1].quantity=7
  await syncWorkspaceBilling(f.workspaceId,f.client)
  assert.equal((await getCompanyAccess(f.workspaceId)).seatLimit,8)
})
test("future reduction reserves lower capacity now and rejects occupied seats",async()=>{
  const f=await fixture()
  await syncWorkspaceBilling(f.workspaceId,f.client)
  await changeBillingSeats(f.workspaceId,2,f.userId,f.client)
  assert.equal((await getCompanyAccess(f.workspaceId)).seatLimit,2)
  await assert.rejects(assertBillingCapacity(f.workspaceId,2,f.client),/seats/)
})
test("renewal grace does not reset, expiry pauses collection retaining debt, paid recovery preserves manual pause",async()=>{
  const f=await fixture()
  await syncWorkspaceBilling(f.workspaceId,f.client)
  const invoice=f.state.invoices[0]
  Object.assign(invoice,{status:"open",billing_reason:"subscription_cycle",amount_paid:0,amount_remaining:71500,created:Math.floor(Date.now()/1000)-8*86400,status_transitions:{finalized_at:Math.floor(Date.now()/1000)-8*86400}})
  f.state.subscriptions[0].status="past_due"
  await syncWorkspaceBilling(f.workspaceId,f.client)
  const access=await getCompanyAccess(f.workspaceId)
  assert.equal(access.allowed,false);assert.equal(access.reason,"payment_overdue")
  assert.deepEqual(f.state.updates.at(-1)?.pause_collection,{behavior:"keep_as_draft"})
  await assert.rejects(assertCompanyOperational(f.workspaceId),/paused/)
  invoice.attempt_count=4
  await syncWorkspaceBilling(f.workspaceId,f.client)
  assert.equal((await getCompanyAccess(f.workspaceId)).graceEndsAt,access.graceEndsAt)
  await setPlatformCompanyAccess(f.workspaceId,f.userId,{manualPaused:true,reason:"Investigation"})
  Object.assign(invoice,{status:"paid",amount_paid:71500,amount_remaining:0});f.state.subscriptions[0].status="active"
  await syncWorkspaceBilling(f.workspaceId,f.client)
  assert.equal(f.state.updates.at(-1)?.pause_collection,"")
  assert.equal((await getCompanyAccess(f.workspaceId)).manualPaused,true)
  assert.equal((await getCompanyAccess(f.workspaceId)).allowed,false)
  assert.equal((await getCompanyAccess(f.workspaceId)).graceEndsAt,null)
})
test("processing first observed after seven days cannot reopen access",async()=>{
  const f=await fixture();await syncWorkspaceBilling(f.workspaceId,f.client)
  Object.assign(f.state.invoices[0],{status:"open",billing_reason:"subscription_cycle",amount_paid:0,amount_remaining:71500,created:Math.floor(Date.now()/1000)-8*86400,status_transitions:{finalized_at:Math.floor(Date.now()/1000)-8*86400}})
  f.state.processing=true;f.state.subscriptions[0].status="past_due"
  await syncWorkspaceBilling(f.workspaceId,f.client)
  const first=await getCompanyAccess(f.workspaceId);assert.equal(first.allowed,false)
  await syncWorkspaceBilling(f.workspaceId,f.client)
  assert.equal((await getCompanyAccess(f.workspaceId)).graceEndsAt,first.graceEndsAt)
  f.state.processing=false
  await syncWorkspaceBilling(f.workspaceId,f.client)
  assert.equal((await getCompanyAccess(f.workspaceId)).allowed,false)
})

async function processingFixture() {
  const f=await fixture();await syncWorkspaceBilling(f.workspaceId,f.client)
  const start=Math.floor(Date.now()/1000)-6*86400
  Object.assign(f.state.invoices[0],{status:"open",billing_reason:"subscription_cycle",amount_paid:0,amount_remaining:71500,created:start,status_transitions:{finalized_at:start,paid_at:null}})
  f.state.processing=true;f.state.subscriptions[0].status="past_due"
  return f
}
const extensionState=(workspaceId:string)=>getDatabase().prepare<{processing_extension_until:string|null;processing_extension_granted_at:string|null;grace_ends_at:string;collection_paused:number}>("SELECT processing_extension_until,processing_extension_granted_at,grace_ends_at,collection_paused FROM company_subscription_state WHERE workspace_id=?").get(workspaceId)

for (const status of ["requires_action", "processing"] as const) for (const anchor of ["due_date", "finalized_at", "created"] as const) test(`zero-attempt ${status} renewal starts fixed grace anchored to ${anchor}`, async t => {
  const f = await processingFixture()
  const invoice = f.state.invoices[0]
  invoice.attempt_count = 0
  const original = invoice.created
  Object.assign(invoice, {
    created: original - (anchor === "created" ? 0 : 3600),
    due_date: anchor === "due_date" ? original : null,
    status_transitions: { finalized_at: anchor === "created" ? null : original - (anchor === "due_date" ? 1800 : 0), paid_at: null },
    auto_advance: true,
  })
  const retrieve = f.client.paymentIntents.retrieve
  f.client.paymentIntents.retrieve = (async (id: string) => ({ ...await retrieve(id), status })) as StripeBillingClient["paymentIntents"]["retrieve"]
  await syncWorkspaceBilling(f.workspaceId, f.client)
  const first = (await extensionState(f.workspaceId))!
  const cutoff = (original + 7 * 86400) * 1000
  assert.equal(first.grace_ends_at, new Date(cutoff).toISOString())
  assert.equal(first.processing_extension_until, status === "processing" ? new Date(cutoff + 48 * 3600000).toISOString() : null)
  assert.equal((await getCompanyAccess(f.workspaceId)).allowed, true)
  await syncWorkspaceBilling(f.workspaceId, f.client)
  assert.deepEqual(await extensionState(f.workspaceId), first, "a repeated observation cannot reset grace or extend processing")
  const effectiveCutoff = cutoff + (status === "processing" ? 48 * 3600000 : 0)
  t.mock.method(Date, "now", () => effectiveCutoff)
  assert.equal((await getCompanyAccess(f.workspaceId)).allowed, false, "local access expires even before reconciliation")
  await syncWorkspaceBilling(f.workspaceId, f.client)
  assert.equal((await extensionState(f.workspaceId))!.collection_paused, 1)
  assert.equal((invoice as typeof invoice & { auto_advance: boolean }).auto_advance, false)
  assert.deepEqual(f.state.subscriptions[0].pause_collection, { behavior: "keep_as_draft" })
  assert.equal(invoice.amount_remaining, 71500)
  assert.equal((await extensionState(f.workspaceId))!.grace_ends_at, first.grace_ends_at)
})

for (const status of ["requires_action", "processing"] as const) test(`late first observation of zero-attempt ${status} renewal enforces the original seven-day cutoff`, async () => {
  const f = await processingFixture()
  const original = Math.floor(Date.now() / 1000) - 8 * 86400
  Object.assign(f.state.invoices[0], { attempt_count: 0, created: original, auto_advance: true, status_transitions: { finalized_at: original, paid_at: null } })
  const retrieve = f.client.paymentIntents.retrieve
  f.client.paymentIntents.retrieve = (async (id: string) => ({ ...await retrieve(id), status })) as StripeBillingClient["paymentIntents"]["retrieve"]
  await syncWorkspaceBilling(f.workspaceId, f.client)
  const state = (await extensionState(f.workspaceId))!
  assert.equal(state.grace_ends_at, new Date((original + 7 * 86400) * 1000).toISOString())
  assert.equal(state.processing_extension_until, null)
  assert.equal(state.collection_paused, 1)
  assert.equal((await getCompanyAccess(f.workspaceId)).allowed, false)
})

test("zero-attempt renewal grace requires current, invoice-scoped payment evidence", async t => {
  const cases: Record<string, (payment: Stripe.InvoicePayment, intent: Stripe.PaymentIntent) => void> = {
    "wrong invoice": p => { p.invoice = "in_unrelated" },
    "wrong allocation mode": p => { p.livemode = true },
    "wrong allocation currency": p => { p.currency = "eur" },
    "canceled allocation": p => { p.status = "canceled" },
    "unsupported payment": p => { p.payment.type = "charge" },
    "wrong intent id": (_p, i) => { i.id = "pi_unrelated" },
    "wrong intent customer": (_p, i) => { i.customer = "cus_unrelated" },
    "wrong intent mode": (_p, i) => { i.livemode = true },
    "wrong intent currency": (_p, i) => { i.currency = "eur" },
    "stale expanded intent": (p, i) => { p.payment.payment_intent = { ...i, status: "requires_action" }; i.status = "requires_payment_method" },
  }
  for (const [name, change] of Object.entries(cases)) await t.test(name, async () => {
    const f = await processingFixture()
    f.state.invoices[0].attempt_count = 0
    const payments = (await f.client.invoicePayments.list({ invoice: f.state.invoices[0].id })).data
    const intent = await f.client.paymentIntents.retrieve(`pi_${f.state.invoices[0].id}`)
    intent.status = "requires_action"
    change(payments[0], intent)
    f.client.invoicePayments.list = (async () => ({ data: payments, has_more: false })) as unknown as StripeBillingClient["invoicePayments"]["list"]
    f.client.paymentIntents.retrieve = (async () => intent) as StripeBillingClient["paymentIntents"]["retrieve"]
    await syncWorkspaceBilling(f.workspaceId, f.client)
    assert.equal((await extensionState(f.workspaceId))!.grace_ends_at, null)
  })
})

for (const kind of ["no_card_trial", "draft", "unattempted_open", "initial_checkout", "unrelated_subscription"] as const) test(`${kind} does not acquire renewal grace from SCA evidence`, async () => {
  const f = await processingFixture()
  f.state.invoices[0].attempt_count = 0
  if (kind === "no_card_trial") {
    f.state.invoices = []; f.state.subscriptions = []
    await getDatabase().prepare("DELETE FROM workspace_billing_entitlements WHERE workspace_id=?").run(f.workspaceId)
    await getDatabase().prepare("DELETE FROM company_subscription_state WHERE workspace_id=?").run(f.workspaceId)
    await initializeCompanyTrial(f.workspaceId, 5)
  } else if (kind === "draft") f.state.invoices[0].status = "draft"
  else if (kind === "unattempted_open") f.state.processing = false
  else if (kind === "initial_checkout") {
    f.state.invoices[0].billing_reason = "subscription_create"
    f.state.subscriptions[0].status = "incomplete"
  } else f.state.invoices[0].parent.subscription_details.subscription = "sub_unrelated"
  const retrieve = f.client.paymentIntents.retrieve
  f.client.paymentIntents.retrieve = (async (id: string) => ({ ...await retrieve(id), status: "requires_action" })) as StripeBillingClient["paymentIntents"]["retrieve"]
  await syncWorkspaceBilling(f.workspaceId, f.client)
  assert.equal((await extensionState(f.workspaceId))!.grace_ends_at, null)
  if (kind === "no_card_trial") assert.equal((await getCompanyAccess(f.workspaceId)).status, "trial")
})

test("processing grant is fixed, revoked on failure, never regranted until verified full recovery",async()=>{
  const f=await processingFixture()
  await syncWorkspaceBilling(f.workspaceId,f.client)
  const first=(await extensionState(f.workspaceId))!
  assert.ok(first.processing_extension_granted_at)
  assert.equal(Date.parse(first.processing_extension_until!)-Date.parse(first.grace_ends_at),48*3600000)
  await syncWorkspaceBilling(f.workspaceId,f.client)
  assert.deepEqual(await extensionState(f.workspaceId),first)
  f.state.processing=false
  await syncWorkspaceBilling(f.workspaceId,f.client)
  assert.equal((await extensionState(f.workspaceId))!.processing_extension_until,null)
  f.state.processing=true
  await syncWorkspaceBilling(f.workspaceId,f.client)
  assert.equal((await extensionState(f.workspaceId))!.processing_extension_until,null)
  assert.equal((await extensionState(f.workspaceId))!.processing_extension_granted_at,first.processing_extension_granted_at)
  Object.assign(f.state.invoices[0],{status:"paid",amount_paid:71500,amount_remaining:0,status_transitions:{paid_at:Math.floor(Date.now()/1000)}})
  f.state.subscriptions[0].status="active"
  await syncWorkspaceBilling(f.workspaceId,f.client)
  assert.equal((await extensionState(f.workspaceId))!.processing_extension_granted_at,null)
  const start=Math.floor(Date.now()/1000)
  f.state.invoices.push({...f.state.invoices[0],id:`in_new_episode_${randomUUID()}`,status:"open",amount_paid:0,amount_remaining:71500,created:start,status_transitions:{finalized_at:start,paid_at:null}})
  await syncWorkspaceBilling(f.workspaceId,f.client)
  assert.ok((await extensionState(f.workspaceId))!.processing_extension_until)
})

test("every debt needs sufficient unique current processing allocations",async(t)=>{
  const cases:Record<string,(payments:Stripe.InvoicePayment[],intent:Stripe.PaymentIntent,f:Awaited<ReturnType<typeof processingFixture>>)=>void>={
    shortfall:p=>{p[0].amount_requested=71499},
    unknown:p=>{delete (p[0] as Partial<Stripe.InvoicePayment>).amount_requested},
    duplicate:p=>{p[0].amount_requested=40000;p.push({...p[0]})},
    "same intent twice":p=>{p[0].amount_requested=40000;p.push({...p[0],id:`${p[0].id}_duplicate`})},
    "wrong invoice":p=>{p[0].invoice="in_other"},
    "wrong allocation currency":p=>{p[0].currency="eur"},
    "wrong allocation mode":p=>{p[0].livemode=true},
    "canceled allocation":p=>{p[0].status="canceled"},
    "unsupported payment":p=>{p[0].payment.type="charge"},
    "wrong intent id":(_p,i)=>{i.id="pi_other"},
    "wrong customer":(_p,i)=>{i.customer="cus_other"},
    "wrong intent currency":(_p,i)=>{i.currency="eur"},
    "wrong intent mode":(_p,i)=>{i.livemode=true},
    "small intent":(_p,i)=>{i.amount=71499},
    "requires action":(_p,i)=>{i.status="requires_action"},
    "failed retry":(_p,i)=>{i.status="requires_payment_method"},
    "uncovered second debt":(_p,_i,f)=>{f.state.invoices.push({...f.state.invoices[0],id:`in_other_${randomUUID()}`,billing_reason:"subscription_update"})},
  }
  for(const [name,change] of Object.entries(cases)) await t.test(name,async()=>{
    const f=await processingFixture()
    const payments=(await f.client.invoicePayments.list({invoice:f.state.invoices[0].id})).data
    const intent=await f.client.paymentIntents.retrieve(`pi_${f.state.invoices[0].id}`)
    change(payments,intent,f)
    f.client.invoicePayments.list=(async(params:Stripe.InvoicePaymentListParams)=>({data:params.invoice && params.invoice!==f.state.invoices[0].id?[]:payments,has_more:false})) as unknown as StripeBillingClient["invoicePayments"]["list"]
    f.client.paymentIntents.retrieve=(async()=>intent) as StripeBillingClient["paymentIntents"]["retrieve"]
    await syncWorkspaceBilling(f.workspaceId,f.client)
    assert.equal((await extensionState(f.workspaceId))!.processing_extension_until,null,name)
  })
})

test("processing grant and expiry enforce exact absolute boundaries",async(t)=>{
  const f=await processingFixture()
  const cutoff=(f.state.invoices[0].created+7*86400)*1000
  t.mock.method(Date,"now",()=>cutoff)
  await syncWorkspaceBilling(f.workspaceId,f.client)
  assert.equal((await extensionState(f.workspaceId))!.processing_extension_until,null)
  assert.equal((await getCompanyAccess(f.workspaceId)).allowed,false)
  t.mock.restoreAll()
  const g=await processingFixture()
  const end=(g.state.invoices[0].created+7*86400)*1000
  let now=end-1
  t.mock.method(Date,"now",()=>now)
  await syncWorkspaceBilling(g.workspaceId,g.client)
  assert.ok((await extensionState(g.workspaceId))!.processing_extension_until)
  now=end+48*3600000-1
  assert.equal((await getCompanyAccess(g.workspaceId)).allowed,true)
  now=end+48*3600000
  assert.equal((await getCompanyAccess(g.workspaceId)).allowed,false)
  await syncWorkspaceBilling(g.workspaceId,g.client)
  assert.equal((await extensionState(g.workspaceId))!.collection_paused,1)
})

test("migration 0048 backfills active and expired grants but leaves ungranted episodes empty",async()=>{
  const client=new pg.Client({connectionString:database.databaseUrl})
  await client.connect()
  try {
    await client.query("BEGIN")
    await client.query("CREATE TEMP TABLE company_subscription_state (LIKE public.company_subscription_state INCLUDING DEFAULTS)")
    await client.query("ALTER TABLE pg_temp.company_subscription_state DROP COLUMN processing_extension_granted_at")
    const updated="2026-09-20T12:00:00.000Z"
    await client.query("INSERT INTO pg_temp.company_subscription_state(workspace_id,processing_extension_until,updated_at) VALUES ('active','2026-09-22T00:00:00.000Z',$1),('expired','2026-09-19T00:00:00.000Z',$1),('unused',NULL,$1)",[updated])
    await client.query(await readFile(new URL("../drizzle/0048_billing_recovery.sql",import.meta.url),"utf8"))
    const result=await client.query("SELECT workspace_id,processing_extension_granted_at FROM pg_temp.company_subscription_state ORDER BY workspace_id")
    assert.deepEqual(result.rows,[{workspace_id:"active",processing_extension_granted_at:updated},{workspace_id:"expired",processing_extension_granted_at:updated},{workspace_id:"unused",processing_extension_granted_at:null}])
  } finally { await client.query("ROLLBACK");await client.end() }
})

test("processing covers partial balances and all invoices with separate valid intents",async()=>{
  const f=await processingFixture()
  Object.assign(f.state.invoices[0],{amount_paid:61500,amount_remaining:10000})
  f.state.invoices.push({...f.state.invoices[0],id:`in_second_${randomUUID()}`,billing_reason:"subscription_update",amount_paid:0,amount_remaining:20000})
  await syncWorkspaceBilling(f.workspaceId,f.client)
  assert.ok((await extensionState(f.workspaceId))!.processing_extension_until)
})

test("expanded stale processing intents are retrieved and unknown provider coverage revokes a grant",async()=>{
  const f=await processingFixture()
  await syncWorkspaceBilling(f.workspaceId,f.client)
  const first=(await extensionState(f.workspaceId))!
  const list=f.client.invoicePayments.list
  f.client.invoicePayments.list=(async(params:Stripe.InvoicePaymentListParams)=>{
    const result=await list(params)
    for(const payment of result.data) payment.payment.payment_intent={id:`pi_${f.state.invoices[0].id}`,status:"processing"} as Stripe.PaymentIntent
    return result
  }) as StripeBillingClient["invoicePayments"]["list"]
  f.client.paymentIntents.retrieve=(async()=>{throw new Error("provider unavailable")}) as StripeBillingClient["paymentIntents"]["retrieve"]
  await syncWorkspaceBilling(f.workspaceId,f.client)
  assert.equal((await extensionState(f.workspaceId))!.processing_extension_until,null)
  assert.equal((await extensionState(f.workspaceId))!.processing_extension_granted_at,first.processing_extension_granted_at)
})

test("shared intents count allocations once and cannot overpromise across invoices",async(t)=>{
  for(const enough of [false,true]) await t.test(enough?"fully funded shared intent":"oversubscribed shared intent",async()=>{
    const f=await processingFixture()
    f.state.invoices.push({...f.state.invoices[0],id:`in_shared_${randomUUID()}`})
    const allocations=f.state.invoices.map(i=>({id:`ip_${i.id}`,invoice:i.id,status:"open",livemode:false,currency:"usd",amount_requested:71500,amount_paid:null,payment:{type:"payment_intent",payment_intent:"pi_shared"}}))
    let reads=0
    f.client.paymentIntents.retrieve=(async()=>{reads++;return{id:"pi_shared",status:"processing",customer:f.customerId,currency:"usd",livemode:false,amount:enough?143000:71500,amount_received:0}}) as unknown as StripeBillingClient["paymentIntents"]["retrieve"]
    f.client.invoicePayments.list=(async(params:Stripe.InvoicePaymentListParams)=>({data:allocations.filter(a=>!params.invoice || a.invoice===params.invoice),has_more:false})) as unknown as StripeBillingClient["invoicePayments"]["list"]
    await syncWorkspaceBilling(f.workspaceId,f.client)
    assert.equal(!!(await extensionState(f.workspaceId))!.processing_extension_until,enough)
    assert.equal(reads,1)
  })
})

test("processing cannot reopen a recorded pause even if the grace timestamp is in the future",async()=>{
  const f=await processingFixture()
  await getDatabase().prepare("UPDATE company_subscription_state SET collection_paused=1,last_paused_at=? WHERE workspace_id=?").run(nowIso(),f.workspaceId)
  await syncWorkspaceBilling(f.workspaceId,f.client)
  assert.equal((await extensionState(f.workspaceId))!.processing_extension_until,null)
})

test("processing failure after cutoff pauses immediately and retry cannot reopen the episode",async(t)=>{
  const f=await processingFixture()
  await syncWorkspaceBilling(f.workspaceId,f.client)
  const first=(await extensionState(f.workspaceId))!
  t.mock.method(Date,"now",()=>Date.parse(first.grace_ends_at)+1)
  const retrieve=f.client.paymentIntents.retrieve
  f.client.paymentIntents.retrieve=(async(id:string)=>({...await retrieve(id),status:"requires_payment_method"})) as StripeBillingClient["paymentIntents"]["retrieve"]
  await syncWorkspaceBilling(f.workspaceId,f.client)
  assert.equal((await getCompanyAccess(f.workspaceId)).allowed,false)
  assert.equal((await extensionState(f.workspaceId))!.collection_paused,1)
  f.client.paymentIntents.retrieve=retrieve
  await syncWorkspaceBilling(f.workspaceId,f.client)
  assert.equal((await getCompanyAccess(f.workspaceId)).allowed,false)
  assert.equal((await extensionState(f.workspaceId))!.processing_extension_granted_at,first.processing_extension_granted_at)
})

test("processing allocation pagination deduplicates repeated records without inflating coverage",async(t)=>{
  for(const amount of [40000,71500]) await t.test(String(amount),async()=>{
    const f=await processingFixture()
    const payment=(await f.client.invoicePayments.list({invoice:f.state.invoices[0].id})).data[0]
    payment.amount_requested=amount
    f.client.invoicePayments.list=(async(params:Stripe.InvoicePaymentListParams)=>({data:[payment],has_more:!params.starting_after})) as unknown as StripeBillingClient["invoicePayments"]["list"]
    await syncWorkspaceBilling(f.workspaceId,f.client)
    assert.equal(!!(await extensionState(f.workspaceId))!.processing_extension_until,amount===71500)
  })
})

test("unrelated allocations consume a shared intent budget and unavailable allocation reads revoke eligibility",async()=>{
  const f=await processingFixture()
  const original=f.state.invoices[0]
  const unrelated={...original,id:`in_unrelated_allocation_${randomUUID()}`,parent:{subscription_details:{subscription:"sub_unrelated"}}}
  f.state.invoices.push(unrelated)
  const list=f.client.invoicePayments.list
  f.client.invoicePayments.list=(async(params:Stripe.InvoicePaymentListParams)=>{
    const result=await list(params)
    if(params.payment?.payment_intent===`pi_${original.id}`) result.data.push({...result.data[0],id:`ip_${unrelated.id}`,invoice:unrelated.id,amount_requested:1})
    return result
  }) as StripeBillingClient["invoicePayments"]["list"]
  await syncWorkspaceBilling(f.workspaceId,f.client)
  assert.equal((await extensionState(f.workspaceId))!.processing_extension_until,null)
  f.client.invoicePayments.list=list
  await syncWorkspaceBilling(f.workspaceId,f.client)
  assert.ok((await extensionState(f.workspaceId))!.processing_extension_until)
  f.client.invoicePayments.list=(async()=>{throw new Error("allocation read unavailable")}) as unknown as StripeBillingClient["invoicePayments"]["list"]
  await syncWorkspaceBilling(f.workspaceId,f.client)
  assert.equal((await extensionState(f.workspaceId))!.processing_extension_until,null)
  assert.ok((await extensionState(f.workspaceId))!.processing_extension_granted_at)
})
test("cutoff disables open Fundlane invoice retries including canceled debt without forgiving or touching unrelated debt",async()=>{
  const f=await fixture();await syncWorkspaceBilling(f.workspaceId,f.client)
  const old=Math.floor(Date.now()/1000)-8*86400
  const debt=Object.assign(f.state.invoices[0],{status:"open",auto_advance:true,billing_reason:"subscription_cycle",amount_paid:10000,amount_remaining:61500,created:old,status_transitions:{finalized_at:old,paid_at:null}})
  const canceled=subscription(f.customerId,5,"canceled")
  f.state.subscriptions.push(canceled)
  const historical={...debt,id:`in_historical_${randomUUID()}`,parent:{subscription_details:{subscription:canceled.id}}}
  const unrelated={...debt,id:`in_unrelated_${randomUUID()}`,parent:{subscription_details:{subscription:"sub_unrelated"}}}
  f.state.invoices.push(historical,unrelated)
  await syncWorkspaceBilling(f.workspaceId,f.client)
  assert.equal(debt.auto_advance,false);assert.equal(historical.auto_advance,false);assert.equal(unrelated.auto_advance,true)
  assert.deepEqual(f.state.invoiceUpdates.map(i=>i.id).sort(),[debt.id,historical.id].sort())
  assert.ok(f.state.invoiceUpdates.every(i=>JSON.stringify(i.params)==='{"auto_advance":false}' && i.key))
  const grace=(await getCompanyAccess(f.workspaceId)).graceEndsAt
  const event={id:`evt_${randomUUID()}`,type:"invoice.payment_failed",livemode:false,data:{object:{customer:f.customerId}}} as unknown as Stripe.Event
  debt.attempt_count=8
  await processStripeBillingEvent(event,f.client);await processStripeBillingEvent(event,f.client)
  assert.equal(f.state.invoiceUpdates.length,2)
  assert.equal((await getCompanyAccess(f.workspaceId)).graceEndsAt,grace)
  assert.equal(debt.status,"open");assert.equal(debt.amount_remaining,61500);assert.equal(debt.amount_paid,10000)
})
test("cutoff sends retry controls and stable operation keys through the Stripe SDK HTTP contract",async()=>{
  const f=await fixture();await syncWorkspaceBilling(f.workspaceId,f.client)
  const http=await createStripeHttpFixture(),url=new URL(http.origin)
  const client=new Stripe("rk_test_fixture",{host:url.hostname,port:Number(url.port),protocol:"http",maxNetworkRetries:0})
  const old=Math.floor(Date.now()/1000)-8*86400
  const debt=Object.assign(f.state.invoices[0],{status:"open",auto_advance:true,billing_reason:"subscription_cycle",amount_paid:0,amount_remaining:71500,created:old,status_transitions:{finalized_at:old,paid_at:null}})
  http.subscriptions.set(f.customerId,f.state.subscriptions);http.invoices.set(f.customerId,f.state.invoices)
  try {
    await syncWorkspaceBilling(f.workspaceId,client)
    const invoiceCall=http.calls.find((c:{method:string;path:string})=>c.method==="POST"&&c.path===`/v1/invoices/${debt.id}`)
    const subscriptionCall=http.calls.find((c:{method:string;path:string})=>c.method==="POST"&&c.path===`/v1/subscriptions/${f.state.subscriptions[0].id}`)
    assert.equal(invoiceCall.body.get("auto_advance"),"false");assert.ok(invoiceCall.idempotencyKey)
    assert.equal(subscriptionCall.body.get("pause_collection[behavior]"),"keep_as_draft")
    assert.equal(subscriptionCall.body.has("pause_collection[resumes_at]"),false);assert.ok(subscriptionCall.idempotencyKey)
    assert.equal(debt.auto_advance,false);assert.equal(debt.amount_remaining,71500)
    assert.equal((await getCompanyAccess(f.workspaceId)).allowed,false)
  } finally {await http.close()}
})
test("cutoff repairs provider drift even when local collection is already paused",async()=>{
  const f=await fixture();await syncWorkspaceBilling(f.workspaceId,f.client)
  const old=Math.floor(Date.now()/1000)-8*86400
  const debt=Object.assign(f.state.invoices[0],{status:"open",auto_advance:true,billing_reason:"subscription_cycle",amount_paid:0,amount_remaining:71500,created:old,status_transitions:{finalized_at:old,paid_at:null}})
  await syncWorkspaceBilling(f.workspaceId,f.client)
  const grace=(await getCompanyAccess(f.workspaceId)).graceEndsAt
  f.state.subscriptions[0].pause_collection={behavior:"keep_as_draft",resumes_at:Math.floor(Date.now()/1000)+3600}
  debt.auto_advance=true
  await syncWorkspaceBilling(f.workspaceId,f.client)
  assert.deepEqual(f.state.subscriptions[0].pause_collection,{behavior:"keep_as_draft"})
  assert.equal(debt.auto_advance,false)
  assert.notEqual(f.state.invoiceUpdates[0].key,f.state.invoiceUpdates[1].key)
  assert.equal((await getCompanyAccess(f.workspaceId)).graceEndsAt,grace)
})
test("automatic collection continues before cutoff and canceled-only debt stops invoice retries",async()=>{
  const f=await fixture();await syncWorkspaceBilling(f.workspaceId,f.client)
  const original=Math.floor(Date.now()/1000)-6*86400
  const debt=Object.assign(f.state.invoices[0],{status:"open",auto_advance:true,billing_reason:"subscription_cycle",amount_paid:0,amount_remaining:71500,created:original,status_transitions:{finalized_at:original,paid_at:null}})
  await syncWorkspaceBilling(f.workspaceId,f.client)
  assert.equal(debt.auto_advance,true);assert.equal(f.state.updates.length,0)
  f.state.subscriptions[0].status="canceled"
  await getDatabase().prepare("UPDATE company_subscription_state SET grace_ends_at=? WHERE workspace_id=?").run(new Date(Date.now()-1).toISOString(),f.workspaceId)
  await syncWorkspaceBilling(f.workspaceId,f.client)
  assert.equal(debt.auto_advance,false);assert.equal(f.state.updates.length,0)
  assert.equal(debt.amount_remaining,71500)
})
test("paid recovery resumes a provider pause whose local transaction rolled back",async()=>{
  const f=await fixture();await syncWorkspaceBilling(f.workspaceId,f.client)
  const old=Math.floor(Date.now()/1000)-8*86400
  const debt=Object.assign(f.state.invoices[0],{status:"open",auto_advance:true,billing_reason:"subscription_cycle",amount_paid:0,amount_remaining:71500,created:old,status_transitions:{finalized_at:old,paid_at:null}})
  const since=new Date(old*1000).toISOString(),end=new Date((old+7*86400)*1000).toISOString()
  await getDatabase().prepare("UPDATE company_subscription_state SET delinquent_since=?,delinquent_invoice_id=?,grace_ends_at=? WHERE workspace_id=?").run(since,debt.id,end,f.workspaceId)
  let failing=true
  Object.assign(f.client.charges,{list:async()=>{if(failing)throw new Error("projection failure");return{data:[],has_more:false}}})
  await assert.rejects(syncWorkspaceBilling(f.workspaceId,f.client),/projection failure/)
  assert.equal((await getDatabase().prepare("SELECT collection_paused FROM company_subscription_state WHERE workspace_id=?").get(f.workspaceId))?.collection_paused,0)
  failing=false
  Object.assign(debt,{status:"paid",amount_paid:71500,amount_remaining:0,status_transitions:{finalized_at:old,paid_at:Math.floor(Date.now()/1000)}})
  await syncWorkspaceBilling(f.workspaceId,f.client)
  assert.equal(f.state.subscriptions[0].pause_collection,null)
  assert.equal((await getCompanyAccess(f.workspaceId)).allowed,true)
})
test("partial cutoff provider failures retry stable operations after rollback and still attempt independent controls",async()=>{
  for(const failure of ["invoice","subscription","local"] as const) {
    const f=await fixture();await syncWorkspaceBilling(f.workspaceId,f.client)
    const old=Math.floor(Date.now()/1000)-8*86400
    const debt=Object.assign(f.state.invoices[0],{status:"open",auto_advance:true,billing_reason:"subscription_cycle",amount_paid:0,amount_remaining:71500,created:old,status_transitions:{finalized_at:old,paid_at:null}})
    const updateInvoice=f.client.invoices.update.bind(f.client.invoices),updateSubscription=f.client.subscriptions.update.bind(f.client.subscriptions)
    const keys:string[]=[]
    let failing=true
    f.client.invoices.update=(async(...args:Parameters<typeof updateInvoice>)=>{keys.push(args[2]?.idempotencyKey??"");if(failing&&failure==="invoice")throw new Error("invoice outage");return updateInvoice(...args)}) as typeof updateInvoice
    f.client.subscriptions.update=(async(...args:Parameters<typeof updateSubscription>)=>{if(failing&&failure==="subscription")throw new Error("subscription outage");return updateSubscription(...args)}) as typeof updateSubscription
    if(failure==="local") Object.assign(f.client.charges,{list:async()=>{if(failing)throw new Error("projection failure");return{data:[],has_more:false}}})
    await assert.rejects(syncWorkspaceBilling(f.workspaceId,f.client),/outage|projection failure/)
    if(failure!=="invoice")assert.equal(debt.auto_advance,false)
    if(failure!=="subscription")assert.deepEqual(f.state.subscriptions[0].pause_collection,{behavior:"keep_as_draft"})
    failing=false
    await syncWorkspaceBilling(f.workspaceId,f.client)
    if(failure==="invoice")assert.equal(keys[0],keys[1])
    assert.equal(debt.auto_advance,false)
    assert.deepEqual(f.state.subscriptions[0].pause_collection,{behavior:"keep_as_draft"})
    assert.equal((await getCompanyAccess(f.workspaceId)).allowed,false)
    assert.equal(debt.amount_remaining,71500)
  }
})
test("voiding the delinquent invoice is not paid recovery",async()=>{
  const f=await fixture();await syncWorkspaceBilling(f.workspaceId,f.client)
  Object.assign(f.state.invoices[0],{status:"open",billing_reason:"subscription_cycle",amount_paid:0,amount_remaining:71500,created:Math.floor(Date.now()/1000)-8*86400,status_transitions:{finalized_at:Math.floor(Date.now()/1000)-8*86400}})
  f.state.subscriptions[0].status="past_due"
  await syncWorkspaceBilling(f.workspaceId,f.client)
  Object.assign(f.state.invoices[0],{status:"void",amount_remaining:0})
  f.state.subscriptions[0].status="active"
  await syncWorkspaceBilling(f.workspaceId,f.client)
  assert.equal((await getCompanyAccess(f.workspaceId)).allowed,false)
  assert.ok(!f.state.updates.some(update=>update.pause_collection===""))
})
test("unrelated subscriptions and standalone invoices cannot suspend Fundlane or restrict paid seats",async()=>{
  const f=await fixture();await syncWorkspaceBilling(f.workspaceId,f.client)
  const unrelated=subscription(f.customerId,1)
  unrelated.items.data[0].price.id="price_unrelated"
  f.state.subscriptions.push(unrelated)
  const old=Math.floor(Date.now()/1000)-10*86400
  for(const subscriptionId of [unrelated.id,""]) {
    f.state.invoices.push({...f.state.invoices[0],id:`in_unrelated_${randomUUID()}`,status:"open",billing_reason:"subscription_cycle",amount_paid:0,amount_remaining:71500,created:old,status_transitions:{finalized_at:old,paid_at:null},parent:{subscription_details:{subscription:subscriptionId}}})
  }
  const before=structuredClone(f.state.invoices)
  f.state.subscriptions[0].items.data[1].quantity=7
  await syncWorkspaceBilling(f.workspaceId,f.client)
  assert.equal((await getCompanyAccess(f.workspaceId)).allowed,true)
  assert.equal((await getCompanyAccess(f.workspaceId)).seatLimit,8)
  assert.equal((await getCompanyAccess(f.workspaceId)).graceEndsAt,null)
  assert.deepEqual(f.state.updates,[])
  assert.deepEqual(f.state.invoices,before)
})
test("partially paid debt from a canceled Fundlane subscription still blocks recovery",async()=>{
  const f=await fixture();await syncWorkspaceBilling(f.workspaceId,f.client)
  const previous=subscription(f.customerId,5,"canceled")
  f.state.subscriptions.push(previous)
  const old=Math.floor(Date.now()/1000)-10*86400
  const debt={...f.state.invoices[0],id:`in_previous_${randomUUID()}`,status:"open",billing_reason:"subscription_cycle",amount_paid:10000,amount_remaining:61500,created:old,status_transitions:{finalized_at:old,paid_at:null},parent:{subscription_details:{subscription:previous.id}}}
  f.state.invoices.push(debt)
  await syncWorkspaceBilling(f.workspaceId,f.client)
  assert.equal((await getCompanyAccess(f.workspaceId)).allowed,false)
  debt.amount_paid=70000;debt.amount_remaining=1500
  await syncWorkspaceBilling(f.workspaceId,f.client)
  assert.equal((await getCompanyAccess(f.workspaceId)).allowed,false)
  Object.assign(debt,{status:"paid",amount_paid:71500,amount_remaining:0,status_transitions:{finalized_at:old,paid_at:Math.floor(Date.now()/1000)}})
  await syncWorkspaceBilling(f.workspaceId,f.client)
  assert.equal((await getCompanyAccess(f.workspaceId)).allowed,true)
})
test("subscription ownership and mode are checked even when the product is unrelated",async()=>{
  for(const mismatch of ["customer","mode"] as const) {
    const f=await fixture();await syncWorkspaceBilling(f.workspaceId,f.client)
    const unrelated=subscription(mismatch==="customer"?"cus_other":f.customerId,1)
    unrelated.items.data[0].price.id="price_unrelated"
    unrelated.livemode=mismatch==="mode"
    f.state.subscriptions.push(unrelated)
    await assert.rejects(syncWorkspaceBilling(f.workspaceId,f.client),{code:"billing_customer_mismatch"})
    assert.deepEqual(f.state.updates,[])
    assert.equal((await getCompanyAccess(f.workspaceId)).allowed,true)
  }
})
test("unrelated unpaid invoices cannot prevent recovery of settled Fundlane debt",async()=>{
  const f=await fixture();await syncWorkspaceBilling(f.workspaceId,f.client)
  const invoice=f.state.invoices[0],old=Math.floor(Date.now()/1000)-8*86400
  Object.assign(invoice,{status:"open",billing_reason:"subscription_cycle",amount_paid:0,amount_remaining:71500,created:old,status_transitions:{finalized_at:old,paid_at:null}})
  await syncWorkspaceBilling(f.workspaceId,f.client)
  assert.equal((await getCompanyAccess(f.workspaceId)).allowed,false)
  const unrelated=subscription(f.customerId,1,"canceled")
  unrelated.items.data[0].price.id="price_unrelated"
  f.state.subscriptions.push(unrelated)
  const unrelatedInvoice={...invoice,id:`in_unrelated_${randomUUID()}`,parent:{subscription_details:{subscription:unrelated.id}}}
  f.state.invoices.push(unrelatedInvoice)
  Object.assign(invoice,{status:"paid",amount_paid:71500,amount_remaining:0,status_transitions:{finalized_at:old,paid_at:Math.floor(Date.now()/1000)}})
  await syncWorkspaceBilling(f.workspaceId,f.client)
  assert.equal((await getCompanyAccess(f.workspaceId)).allowed,true)
  assert.equal(unrelatedInvoice.amount_remaining,71500)
  assert.equal(unrelatedInvoice.status,"open")
})
test("missed-period drafts block recovery but ordinary future drafts do not",async()=>{
  for(const missed of [true,false]) {
    const f=await fixture();await syncWorkspaceBilling(f.workspaceId,f.client)
    const old=Math.floor(Date.now()/1000)-40*86400
    const invoice=f.state.invoices[0]
    Object.assign(invoice,{status:"open",billing_reason:"subscription_cycle",amount_paid:0,amount_remaining:71500,created:old,status_transitions:{finalized_at:old,paid_at:null}})
    await syncWorkspaceBilling(f.workspaceId,f.client)
    const periodStart=Math.floor(Date.now()/1000)+(missed?-10:10)*86400
    f.state.invoices.push(renewalDraft(f,periodStart))
    Object.assign(invoice,{status:"paid",amount_paid:71500,amount_remaining:0,status_transitions:{finalized_at:old,paid_at:Math.floor(Date.now()/1000)}})
    await syncWorkspaceBilling(f.workspaceId,f.client)
    assert.equal((await getCompanyAccess(f.workspaceId)).allowed,!missed)
    assert.equal(f.state.updates.some(update=>update.pause_collection===""),!missed)
  }
})
function renewalDraft(f: Awaited<ReturnType<typeof fixture>>, start: number, subscriptionId=f.state.subscriptions[0].id) {
  const id=`in_draft_${randomUUID()}`
  return {...f.state.invoices[0],id,status:"draft",amount_paid:0,amount_remaining:71500,created:Math.min(start,Math.floor(Date.now()/1000)),period_start:start-30*86400,period_end:start,attempt_count:0,
    parent:{subscription_details:{subscription:subscriptionId}},
    lines:{data:[{id:`il_${id}`,invoice:id,parent:{type:"subscription_item_details",subscription_item_details:{subscription:subscriptionId,subscription_item:"si_base",proration:false}},period:{start,end:start+30*86400}}],has_more:false}}
}
async function pausedRecoveryFixture() {
  const f=await fixture();await syncWorkspaceBilling(f.workspaceId,f.client)
  const old=Math.floor(Date.now()/1000)-70*86400
  const original=Object.assign(f.state.invoices[0],{status:"open",billing_reason:"subscription_cycle",amount_paid:0,amount_remaining:71500,created:old,status_transitions:{finalized_at:old,paid_at:null}})
  await syncWorkspaceBilling(f.workspaceId,f.client)
  Object.assign(original,{status:"paid",amount_paid:71500,amount_remaining:0,status_transitions:{finalized_at:old,paid_at:Math.floor(Date.now()/1000)}})
  return f
}
test("missed months finalize original line periods without auto charging and require every balance paid",async()=>{
  for(const manualPaused of [false,true]) {
    const f=await pausedRecoveryFixture(),now=Math.floor(Date.now()/1000)
    const drafts=[renewalDraft(f,now-40*86400),renewalDraft(f,now-10*86400)]
    f.state.invoices.push(...drafts)
    if(manualPaused)await setPlatformCompanyAccess(f.workspaceId,f.userId,{manualPaused:true,reason:"Investigation"})
    const reads=f.state.invoiceReads
    await syncWorkspaceBilling(f.workspaceId,f.client)
    assert.equal(f.state.invoiceReads,reads+2)
    assert.deepEqual(f.state.finalizations.map(i=>i.id),drafts.map(i=>i.id))
    assert.ok(f.state.finalizations.every(i=>JSON.stringify(i.params)==='{"auto_advance":false}'&&i.key))
    for(const draft of drafts) {
      assert.equal(draft.status,"open");assert.equal(draft.amount_due,71500);assert.equal(draft.amount_remaining,71500)
      const projected=await getDatabase().prepare("SELECT status,invoice_url,period_start,period_end FROM company_billing_invoices WHERE stripe_invoice_id=?").get(draft.id)
      assert.equal(projected?.status,"open");assert.equal(projected?.invoice_url,`https://invoice.stripe.com/i/${draft.id}`)
      assert.equal(projected?.period_start,new Date(draft.period_start*1000).toISOString())
      assert.equal(projected?.period_end,new Date(draft.period_end*1000).toISOString())
    }
    assert.equal((await getCompanyAccess(f.workspaceId)).allowed,false)
    Object.assign(drafts[0],{status:"paid",amount_paid:71500,amount_remaining:0})
    Object.assign(drafts[1],{amount_paid:71000,amount_remaining:500})
    await syncWorkspaceBilling(f.workspaceId,f.client)
    assert.ok((await getCompanyAccess(f.workspaceId)).graceEndsAt)
    assert.equal(f.state.updates.some(i=>i.pause_collection===""),false)
    Object.assign(drafts[1],{status:"paid",amount_paid:71500,amount_remaining:0})
    await syncWorkspaceBilling(f.workspaceId,f.client)
    assert.equal((await getCompanyAccess(f.workspaceId)).allowed,!manualPaused)
    assert.equal((await getCompanyAccess(f.workspaceId)).graceEndsAt,null)
    assert.equal(f.state.finalizations.length,2)
    assert.equal(f.state.subscriptions[0].pause_collection,null)
  }
})
test("draft eligibility excludes unrelated, pre-pause, future and canceled future service periods",async()=>{
  const f=await pausedRecoveryFixture(),now=Math.floor(Date.now()/1000)
  const sub=f.state.subscriptions[0]
  const eligible=renewalDraft(f,now-40*86400)
  const excluded=[renewalDraft(f,now-80*86400),renewalDraft(f,now+10*86400),renewalDraft(f,now-10*86400,"sub_unrelated"),renewalDraft(f,now-10*86400),{...renewalDraft(f,now-40*86400),created:now-80*86400}]
  // A request to cancel earlier is not the effective cancellation date.
  Object.assign(sub,{status:"canceled",ended_at:now-20*86400,canceled_at:now-50*86400,pause_collection:null})
  f.state.invoices.push(eligible,...excluded)
  await syncWorkspaceBilling(f.workspaceId,f.client)
  assert.deepEqual(f.state.finalizations.map(i=>i.id),[eligible.id])
  assert.ok(excluded.every(i=>i.status==="draft"))
  Object.assign(eligible,{status:"paid",amount_paid:71500,amount_remaining:0})
  await syncWorkspaceBilling(f.workspaceId,f.client)
  assert.equal((await getCompanyAccess(f.workspaceId)).graceEndsAt,null)
  assert.equal((await getCompanyAccess(f.workspaceId)).allowed,false)
  assert.equal(sub.status,"canceled")
  assert.equal(f.state.updates.some(i=>i.pause_collection===""),false)
})
test("partial finalization failures re-read debt and retry stable keys without restoring access",async()=>{
  const f=await pausedRecoveryFixture(),now=Math.floor(Date.now()/1000)
  const drafts=[renewalDraft(f,now-40*86400),renewalDraft(f,now-10*86400)]
  f.state.invoices.push(...drafts)
  const finalize=f.client.invoices.finalizeInvoice.bind(f.client.invoices)
  const keys:string[]=[];let failing=true
  f.client.invoices.finalizeInvoice=(async(...args:Parameters<typeof finalize>)=>{
    if(args[0]===drafts[1].id){keys.push(args[2]?.idempotencyKey??"");if(failing)throw new Error("finalization outage")}
    return finalize(...args)
  }) as typeof finalize
  const reads=f.state.invoiceReads
  await assert.rejects(syncWorkspaceBilling(f.workspaceId,f.client),/finalization outage/)
  assert.equal(f.state.invoiceReads,reads+2)
  assert.equal(drafts[0].status,"open");assert.equal(drafts[1].status,"draft")
  assert.equal((await getCompanyAccess(f.workspaceId)).allowed,false)
  failing=false
  await syncWorkspaceBilling(f.workspaceId,f.client)
  assert.equal(keys[0],keys[1]);assert.ok(keys[0])
  assert.equal(f.state.finalizations.filter(i=>i.id===drafts[0].id).length,1)
  assert.equal((await getCompanyAccess(f.workspaceId)).allowed,false)
})
test("fresh provider debt verification fails closed after finalization and before paid recovery",async()=>{
  for(const mode of ["read_failure","new_debt","still_draft"] as const) {
    const f=await pausedRecoveryFixture(),now=Math.floor(Date.now()/1000)
    const draft=renewalDraft(f,now-10*86400)
    if(mode!=="new_debt")f.state.invoices.push(draft)
    const list=f.client.invoices.list.bind(f.client.invoices)
    let reads=0
    f.client.invoices.list=(async(...args:Parameters<typeof list>)=>{
      if(++reads===2){
        if(mode==="read_failure")throw new Error("fresh invoice read outage")
        if(mode==="new_debt")f.state.invoices.push(draft)
        if(mode==="still_draft")draft.status="draft"
      }
      return list(...args)
    }) as typeof list
    if(mode==="read_failure")await assert.rejects(syncWorkspaceBilling(f.workspaceId,f.client),/fresh invoice read outage/)
    else await syncWorkspaceBilling(f.workspaceId,f.client)
    assert.equal(reads,2)
    assert.equal((await getCompanyAccess(f.workspaceId)).allowed,false)
    assert.equal(f.state.updates.some(i=>i.pause_collection===""),false)
  }
})
test("recovery finalization uses the Stripe SDK contract and retains its hosted invoice page",async()=>{
  const f=await pausedRecoveryFixture(),draft=renewalDraft(f,Math.floor(Date.now()/1000)-10*86400)
  f.state.invoices.push(draft)
  const http=await createStripeHttpFixture(),url=new URL(http.origin)
  const client=new Stripe("rk_test_fixture",{host:url.hostname,port:Number(url.port),protocol:"http",maxNetworkRetries:0})
  http.subscriptions.set(f.customerId,f.state.subscriptions);http.invoices.set(f.customerId,f.state.invoices)
  try {
    await syncWorkspaceBilling(f.workspaceId,client)
    const index=http.calls.findIndex((c:{method:string;path:string})=>c.method==="POST"&&c.path===`/v1/invoices/${draft.id}/finalize`)
    assert.ok(index>=0)
    assert.deepEqual([...http.calls[index].body.entries()],[["auto_advance","false"]])
    assert.ok(http.calls[index].idempotencyKey)
    assert.ok(http.calls.slice(index+1).some((c:{method:string;path:string})=>c.method==="GET"&&c.path==="/v1/invoices"))
    assert.equal((await getDatabase().prepare("SELECT invoice_url FROM company_billing_invoices WHERE stripe_invoice_id=?").get(draft.id))?.invoice_url,`https://invoice.stripe.com/i/${draft.id}`)
    assert.equal((await getCompanyAccess(f.workspaceId)).allowed,false)
  } finally {await http.close()}
})
test("ambiguous subscription service periods block recovery and complete line pagination is required",async()=>{
  for(const mode of ["missing","proration","mixed","paginated","pagination_failure"] as const) {
    const f=await pausedRecoveryFixture(),draft=renewalDraft(f,Math.floor(Date.now()/1000)-10*86400)
    if(mode==="missing")draft.lines.data=[]
    if(mode==="proration")draft.lines.data[0].parent.subscription_item_details.proration=true
    if(mode==="mixed")draft.lines.data.push({...draft.lines.data[0],id:"il_future",period:{start:Math.floor(Date.now()/1000)+86400,end:Math.floor(Date.now()/1000)+31*86400}})
    if(mode.startsWith("pagina")) {
      draft.lines.has_more=true
      Object.assign(f.client.invoices,{listLineItems:async(id:string,params:{starting_after:string})=>{
        assert.equal(id,draft.id);assert.equal(params.starting_after,draft.lines.data[0].id)
        if(mode==="pagination_failure")throw new Error("invoice line outage")
        return{data:[{...draft.lines.data[0],id:"il_seats"}],has_more:false}
      }})
    }
    f.state.invoices.push(draft)
    if(mode==="pagination_failure")await assert.rejects(syncWorkspaceBilling(f.workspaceId,f.client),/invoice line outage/)
    else await syncWorkspaceBilling(f.workspaceId,f.client)
    assert.equal(f.state.finalizations.length,mode==="paginated"?1:0)
    assert.equal((await getCompanyAccess(f.workspaceId)).allowed,false)
  }
})
test("finalization survives remote success with response loss or local rollback without repeating the mutation",async()=>{
  for(const mode of ["response_loss","local_rollback"] as const) {
    const f=await pausedRecoveryFixture(),draft=renewalDraft(f,Math.floor(Date.now()/1000)-10*86400)
    f.state.invoices.push(draft)
    const finalize=f.client.invoices.finalizeInvoice.bind(f.client.invoices)
    let failing=true
    if(mode==="response_loss") f.client.invoices.finalizeInvoice=(async(...args:Parameters<typeof finalize>)=>{
      const result=await finalize(...args)
      if(failing)throw new Error("lost finalization response")
      return result
    }) as typeof finalize
    else Object.assign(f.client.charges,{list:async()=>{if(failing)throw new Error("local projection outage");return{data:[],has_more:false}}})
    await assert.rejects(syncWorkspaceBilling(f.workspaceId,f.client),/lost finalization response|local projection outage/)
    assert.equal(draft.status,"open");assert.equal((await getCompanyAccess(f.workspaceId)).allowed,false)
    failing=false
    await syncWorkspaceBilling(f.workspaceId,f.client)
    assert.equal(f.state.finalizations.length,1)
    assert.equal((await getCompanyAccess(f.workspaceId)).allowed,false)
  }
})
test("uncollectible missed month is not settlement even when its remaining balance is zero",async()=>{
  const f=await pausedRecoveryFixture(),draft=renewalDraft(f,Math.floor(Date.now()/1000)-10*86400)
  f.state.invoices.push(draft)
  await syncWorkspaceBilling(f.workspaceId,f.client)
  Object.assign(draft,{status:"uncollectible",amount_remaining:0})
  await syncWorkspaceBilling(f.workspaceId,f.client)
  assert.equal((await getCompanyAccess(f.workspaceId)).allowed,false)
  assert.equal(f.state.updates.some(i=>i.pause_collection===""),false)
})
test("an active subscription without paid invoice evidence never activates a new trial company",async()=>{
  const f=await fixture();await getDatabase().prepare("DELETE FROM company_subscription_state WHERE workspace_id=?").run(f.workspaceId);await initializeCompanyTrial(f.workspaceId,5)
  f.state.invoices=[]
  const current=await syncWorkspaceBilling(f.workspaceId,f.client)
  assert.equal(current.status,"incomplete")
  assert.equal((await getCompanyAccess(f.workspaceId)).status,"trial")
})
test("an active subscriber whose first paid invoice is $0 from a coupon keeps access",async()=>{
  const f=await fixture()
  Object.assign(f.state.invoices[0],{amount_due:0,amount_paid:0,amount_remaining:0})
  const current=await syncWorkspaceBilling(f.workspaceId,f.client)
  assert.equal(current.status,"active")
  const access=await getCompanyAccess(f.workspaceId)
  assert.equal(access.allowed,true)
  assert.equal(access.status,"active")
})
test("outbox retries use a stable receiver idempotency key and deliver to the explicit owner",async()=>{
  const f=await fixture(false)
  await getDatabase().prepare("INSERT INTO workspace_owners (workspace_id,membership_id,updated_at) VALUES (?,?,?) ON CONFLICT(workspace_id) DO UPDATE SET membership_id=EXCLUDED.membership_id").run(f.workspaceId,f.membershipId,nowIso())
  const id=`billing:${f.workspaceId}:test`
  // Select this notification deterministically regardless of other billing fixtures' backlog.
  const availableAt="2000-01-01T00:00:00.000Z"
  await getDatabase().prepare("INSERT INTO company_billing_notifications (id,workspace_id,kind,data,available_at,created_at) VALUES (?,?,?,'{}',?,?)").run(id,f.workspaceId,"billing_paused",availableAt,nowIso())
  const keys: Array<string | undefined> = []
  const server=createServer((request,response)=>{ keys.push(request.headers["idempotency-key"] as string);request.resume();response.writeHead(keys.length===1?503:200);response.end() })
  await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve))
  const address=server.address()
  assert.ok(address && typeof address!=="string")
  process.env.MCA_EMAIL_WEBHOOK_URL=`http://127.0.0.1:${address.port}`
  try {
    await deliverBillingNotifications(1)
    assert.equal((await getDatabase().prepare("SELECT delivered_at FROM company_billing_notifications WHERE id=?").get(id))?.delivered_at,null)
    const frozen = await getDatabase().prepare<{delivery_payload:string}>("SELECT delivery_payload FROM company_billing_notifications WHERE id=?").get(id)
    assert.match(JSON.parse(frozen!.delivery_payload).content.text,/Monthly fees continue during suspension/)
    await getDatabase().prepare("UPDATE company_billing_notifications SET available_at=? WHERE id=?").run(availableAt,id)
    await deliverBillingNotifications(1)
    assert.ok((await getDatabase().prepare("SELECT delivered_at FROM company_billing_notifications WHERE id=?").get(id))?.delivered_at)
    assert.deepEqual(keys,[id,id])
    assert.equal((await getDatabase().prepare<{delivery_payload:string}>("SELECT delivery_payload FROM company_billing_notifications WHERE id=?").get(id))?.delivery_payload,frozen!.delivery_payload)
  } finally { delete process.env.MCA_EMAIL_WEBHOOK_URL;await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve())) }
})
test("signed duplicate and out-of-order events queue once; notification failures remain retryable",async()=>{
  const f=await fixture()
  const event={id:`evt_${randomUUID()}`,type:"invoice.payment_failed",livemode:false,data:{object:{customer:f.customerId}}} as unknown as Stripe.Event
  const stripe=new Stripe("sk_test_fixture")
  const body=JSON.stringify(event),signature=stripe.webhooks.generateTestHeaderString({payload:body,secret:"whsec_fixture"})
  assert.equal(verifyStripeBillingEvent(body,signature,stripe).id,event.id)
  assert.throws(()=>verifyStripeBillingEvent(body,"bad",stripe),/signature/)
  const queued=await processStripeBillingEvent(event,f.client)
  assert.ok("queued" in queued && queued.queued)
  assert.equal(queued.workspaceId,f.workspaceId)
  assert.ok(queued.jobId)
  assert.deepEqual(await processStripeBillingEvent(event,f.client),{duplicate:true})
  await syncWorkspaceBilling(f.workspaceId,f.client)
  assert.equal((await getCompanyAccess(f.workspaceId)).status,"active")
  delete process.env.MCA_EMAIL_WEBHOOK_URL
  await deliverBillingNotifications()
  const failures=await getDatabase().prepare<{count:number}>("SELECT count(*)::int count FROM company_billing_notifications WHERE delivered_at IS NULL AND attempts>0").get()
  assert.ok((failures?.count??0)>0)
})

test("manual pause and recovery while workers are offline invalidates only old approvals",async()=>{
  const f=await fixture(false)
  await getDatabase().prepare("INSERT INTO company_subscription_state(workspace_id,legacy_exempt,state_kind,selected_seats,updated_at) VALUES (?,1,'legacy_exempt',5,?)").run(f.workspaceId,nowIso())
  const oldApproval=new Date(Date.now()-10000).toISOString()
  await setPlatformCompanyAccess(f.workspaceId,f.userId,{manualPaused:true,reason:"Review"})
  await setPlatformCompanyAccess(f.workspaceId,f.userId,{manualPaused:false,reason:"Resolved"})
  assert.equal((await getCompanyAccess(f.workspaceId)).allowed,true)
  await assert.rejects(assertCompanyOutboundAllowed(f.workspaceId,oldApproval),{code:"company_outbound_reapproval_required"})
  await new Promise(resolve=>setTimeout(resolve,5))
  await assertCompanyOutboundAllowed(f.workspaceId,nowIso())
  const boundary=await getDatabase().prepare("SELECT last_paused_at FROM company_subscription_state WHERE workspace_id=?").get(f.workspaceId)
  await setPlatformCompanyAccess(f.workspaceId,f.userId,{manualPaused:false,reason:"Still resolved"})
  assert.deepEqual(await getDatabase().prepare("SELECT last_paused_at FROM company_subscription_state WHERE workspace_id=?").get(f.workspaceId),boundary)
})
test("expired trial conversion records original deadline; late observation of timely payment does not",async()=>{
  for(const late of [true,false]) {
    const f=await fixture()
    const start=new Date(Date.now()-20*86400000).toISOString(),end=new Date(Date.now()-6*86400000).toISOString()
    await getDatabase().prepare("DELETE FROM company_subscription_state WHERE workspace_id=?").run(f.workspaceId)
    await getDatabase().prepare("INSERT INTO company_subscription_state (workspace_id,trial_started_at,trial_ends_at,updated_at) VALUES (?,?,?,?)").run(f.workspaceId,start,end,nowIso())
    f.state.invoices[0].status_transitions.paid_at=Math.floor((late?Date.now():Date.parse(end)-86400000)/1000)
    await syncWorkspaceBilling(f.workspaceId,f.client)
    const saved=await getDatabase().prepare<{last_paused_at:string|null}>("SELECT last_paused_at FROM company_subscription_state WHERE workspace_id=?").get(f.workspaceId)
    assert.equal(saved?.last_paused_at,late?end:null)
    await syncWorkspaceBilling(f.workspaceId,f.client)
    assert.deepEqual(await getDatabase().prepare("SELECT last_paused_at FROM company_subscription_state WHERE workspace_id=?").get(f.workspaceId),saved)
    await assertCompanyOutboundAllowed(f.workspaceId,nowIso())
  }
})
test("grace recovery records expired deadline without an observed paused run and refreshes provider collection state",async()=>{
  const f=await fixture();await syncWorkspaceBilling(f.workspaceId,f.client)
  const end=new Date(Date.now()-86400000).toISOString()
  await getDatabase().prepare("UPDATE company_subscription_state SET delinquent_since=?,delinquent_invoice_id=?,grace_ends_at=?,collection_paused=1 WHERE workspace_id=?").run(new Date(Date.now()-8*86400000).toISOString(),f.state.invoices[0].id,end,f.workspaceId)
  f.state.subscriptions[0].pause_collection={behavior:"keep_as_draft"}
  f.state.invoices[0].status_transitions.paid_at=Math.floor(Date.now()/1000)
  const current=await syncWorkspaceBilling(f.workspaceId,f.client)
  assert.equal(current.paymentPastDue,false)
  assert.equal((await getDatabase().prepare("SELECT last_paused_at FROM company_subscription_state WHERE workspace_id=?").get(f.workspaceId))?.last_paused_at,end)
  await assert.rejects(assertCompanyOutboundAllowed(f.workspaceId,new Date(Date.parse(end)-1).toISOString()),{code:"company_outbound_reapproval_required"})
})
test("a late paid renewal first observed after recovery still records the seven-day boundary",async()=>{
  const f=await fixture();await syncWorkspaceBilling(f.workspaceId,f.client)
  const finalized=Math.floor(Date.now()/1000)-10*86400
  f.state.invoices.push({...f.state.invoices[0],id:`in_late_${f.workspaceId}`,billing_reason:"subscription_cycle",created:finalized,status_transitions:{finalized_at:finalized,paid_at:Math.floor(Date.now()/1000)}})
  await syncWorkspaceBilling(f.workspaceId,f.client)
  assert.equal((await getDatabase().prepare("SELECT last_paused_at FROM company_subscription_state WHERE workspace_id=?").get(f.workspaceId))?.last_paused_at,new Date((finalized+7*86400)*1000).toISOString())
})
test("an ended subscription and paid replacement first observed together preserve the cancellation gap",async()=>{
  const f=await fixture();await syncWorkspaceBilling(f.workspaceId,f.client)
  const ended=Math.floor(Date.now()/1000)-86400
  f.state.subscriptions[0].status="canceled";f.state.subscriptions[0].ended_at=ended
  const replacement={...subscription(f.customerId),start_date:Math.floor(Date.now()/1000)}
  f.state.subscriptions.push(replacement)
  f.state.invoices.push({...f.state.invoices[0],id:`in_replacement_${f.workspaceId}`,parent:{subscription_details:{subscription:replacement.id}}})
  await syncWorkspaceBilling(f.workspaceId,f.client)
  assert.equal((await getCompanyAccess(f.workspaceId)).allowed,true)
  assert.equal((await getDatabase().prepare("SELECT last_paused_at FROM company_subscription_state WHERE workspace_id=?").get(f.workspaceId))?.last_paused_at,new Date(ended*1000).toISOString())
  await assert.rejects(assertCompanyOutboundAllowed(f.workspaceId,new Date((ended-10)*1000).toISOString()),{code:"company_outbound_reapproval_required"})
})
test("a payment completed during its genuine processing extension does not acquire a false boundary on later sync",async()=>{
  const f=await fixture();await syncWorkspaceBilling(f.workspaceId,f.client)
  const finalized=Math.floor(Date.now()/1000)-8*86400
  const invoice={...f.state.invoices[0],id:`in_processing_${f.workspaceId}`,billing_reason:"subscription_cycle",created:finalized,status_transitions:{finalized_at:finalized,paid_at:Math.floor(Date.now()/1000)}}
  f.state.invoices.push(invoice)
  await getDatabase().prepare("UPDATE company_subscription_state SET delinquent_since=?,delinquent_invoice_id=?,grace_ends_at=?,processing_extension_until=? WHERE workspace_id=?").run(new Date(finalized*1000).toISOString(),invoice.id,new Date((finalized+7*86400)*1000).toISOString(),new Date((finalized+9*86400)*1000).toISOString(),f.workspaceId)
  await syncWorkspaceBilling(f.workspaceId,f.client)
  await syncWorkspaceBilling(f.workspaceId,f.client)
  assert.equal((await getDatabase().prepare("SELECT last_paused_at FROM company_subscription_state WHERE workspace_id=?").get(f.workspaceId))?.last_paused_at,null)
})
test("trial extensions preserve five seats even if a failed initial checkout cached one seat",()=>{
  const access=evaluateCompanyAccess({legacy_exempt:0,trial_ends_at:new Date(Date.now()-86400000).toISOString(),manual_paused:0,access_extended_until:new Date(Date.now()+86400000).toISOString(),grace_ends_at:null,processing_extension_until:null,pending_seats:null,status:"incomplete",period_end:null,seat_limit:1})
  assert.equal(access.status,"extended");assert.equal(access.seatLimit,5)
})
test("switching mode refuses historical test customer reuse without deleting data",async()=>{
  const f=await fixture()
  process.env.MCA_STRIPE_MODE="live"
  try { await assert.rejects(syncWorkspaceBilling(f.workspaceId,f.client),{code:"billing_mode_cutover_required"}) }
  finally { process.env.MCA_STRIPE_MODE="test" }
  assert.equal((await getDatabase().prepare("SELECT stripe_customer_id FROM workspace_stripe_customers WHERE workspace_id=?").get(f.workspaceId))?.stripe_customer_id,f.customerId)
})
test("billing UseSend fallback sends the documented API payload with a stable idempotency key",async()=>{
  const original=globalThis.fetch
  const requests:Array<{url:string;headers:Headers;body:string}>=[]
  process.env.MCA_USESEND_API_KEY="test-usesend-key"
  globalThis.fetch=async(input,init)=>{requests.push({url:String(input),headers:new Headers(init?.headers),body:String(init?.body)});return new Response(JSON.stringify({emailId:"mail_test"}),{status:200})}
  const message={recipient:"owner@example.test",actionUrl:"https://fundlane.example/settings/billing",expiresAt:"2030-01-01T00:00:00Z",data:{kind:"billing_paused"},transport:"usesend" as const,from:"Fundlane <billing@example.test>",retryUntil:new Date(Date.now()+3600000).toISOString()}
  try {
    await deliverBillingEmail(message,"billing-stable-key");await deliverBillingEmail(message,"billing-stable-key")
    assert.equal(requests[0].url,"https://app.usesend.com/api/v1/emails")
    assert.equal(requests[0].headers.get("idempotency-key"),"billing-stable-key")
    assert.equal(requests[0].body,requests[1].body)
    assert.match(JSON.parse(requests[0].body).text,/Outstanding invoices, including missed months, remain due even after cancellation/)
    await assert.rejects(deliverBillingEmail({...message,retryUntil:"2000-01-01T00:00:00Z"},"billing-stable-key"),{code:"billing_delivery_review_required"})
  } finally {globalThis.fetch=original;delete process.env.MCA_USESEND_API_KEY}
})
test("refund and dispute projections are provider-backed, reconcile resolutions, and audit only changed state",async()=>{
  const f=await fixture()
  const charge={id:`ch_${f.workspaceId}`,customer:f.customerId,livemode:false,payment_intent:"pi_adjustment"}
  const refund={id:`re_${f.workspaceId}`,status:"pending",amount:10000,currency:"usd",reason:"requested_by_customer",created:Math.floor(Date.now()/1000)}
  const dispute={id:`dp_${f.workspaceId}`,status:"needs_response",amount:71500,currency:"usd",reason:"fraudulent",created:Math.floor(Date.now()/1000)}
  Object.assign(f.client,{charges:{list:async()=>({data:[charge],has_more:false}),retrieve:async()=>charge},refunds:{list:async()=>({data:[refund],has_more:false})},disputes:{list:async()=>({data:[dispute],has_more:false})}})
  await syncWorkspaceBilling(f.workspaceId,f.client)
  let detail=await getPlatformCompanyBillingDetail(f.workspaceId)
  assert.equal(detail.adjustments.length,2)
  refund.status="succeeded";dispute.status="won"
  const event={id:`evt_${randomUUID()}`,type:"charge.dispute.closed",livemode:false,data:{object:{charge:charge.id}}} as unknown as Stripe.Event
  await processStripeBillingEvent(event,f.client)
  await syncWorkspaceBilling(f.workspaceId,f.client)
  detail=await getPlatformCompanyBillingDetail(f.workspaceId)
  assert.deepEqual(detail.adjustments.map(a=>a.status).sort(),["succeeded","won"])
  const before=await getDatabase().prepare<{count:number}>("SELECT count(*)::int count FROM audit_events WHERE workspace_id=? AND action LIKE 'billing.%'").get(f.workspaceId)
  await syncWorkspaceBilling(f.workspaceId,f.client)
  const after=await getDatabase().prepare<{count:number}>("SELECT count(*)::int count FROM audit_events WHERE workspace_id=? AND action LIKE 'billing.%'").get(f.workspaceId)
  assert.equal(after?.count,before?.count)
})
