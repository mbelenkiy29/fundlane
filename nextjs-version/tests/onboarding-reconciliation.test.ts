import test, { before, after } from "node:test"
import assert from "node:assert/strict"
import type Stripe from "stripe"
import { createPostgresTestDatabase } from "./helpers/postgres-test-db.mjs"
import {
  closeDatabaseForTests,
  getDatabase,
  withTransaction,
  nowIso,
  newId,
} from "../src/lib/mca/db"
import { startEnrollmentCheckout } from "../src/lib/mca/onboarding/checkout"
import {
  captureEnrollmentStripeEvent,
  reconcileEnrollment,
} from "../src/lib/mca/onboarding/reconcile"
import {
  attachEnrollmentBilling,
  createEnrollmentBillingPortal,
  compensateEnrollment,
} from "../src/lib/mca/onboarding/billing"
import { findEnrollment } from "../src/lib/mca/onboarding/store"
import { runEnrollmentMaintenance } from "../src/lib/mca/onboarding/maintenance"
import { getCompanyAccess } from "../src/lib/mca/company-access"
import {
  enrollmentTestEnv,
  resumeSecret,
  stripeFixture,
} from "./helpers/onboarding-billing"
let database: Awaited<ReturnType<typeof createPostgresTestDatabase>>
const env = { ...process.env }
before(async () => {
  database = await createPostgresTestDatabase("enrollment_reconcile")
  Object.assign(process.env, enrollmentTestEnv, {
    DATABASE_URL: database.databaseUrl,
  })
})
after(async () => {
  await closeDatabaseForTests()
  await database?.close()
  for (const k of Object.keys(process.env))
    if (!(k in env)) delete process.env[k]
  Object.assign(process.env, env)
})
async function fixture() {
  const f = stripeFixture(),
    r = await startEnrollmentCheckout(
      { resumeSecret: resumeSecret() },
      f.client
    )
  f.complete()
  return { ...f, id: r.enrollmentId }
}
function event(f: Awaited<ReturnType<typeof fixture>>, id = newId()) {
  return {
    id,
    type: "checkout.session.completed",
    livemode: false,
    created: Math.floor(Date.now() / 1000),
    data: { object: [...f.state.sessions.values()][0] },
  } as unknown as Stripe.Event
}
test("early, duplicate and reordered signed events retain one receipt and converge through provider reads", async () => {
  const f = await fixture()
  const e = event(f)
  assert.equal((await captureEnrollmentStripeEvent(e)).handled, true)
  await captureEnrollmentStripeEvent(e)
  assert.equal((await findEnrollment(f.id))?.activatedAt, null)
  const row = await reconcileEnrollment(f.id, f.client)
  assert.equal(row.billingState, "trialing")
  assert.equal(
    row.trialEndsAt,
    new Date(f.state.subscription.trial_end * 1000).toISOString()
  )
  assert.equal(row.workspaceId, null)
  assert.deepEqual(
    await getDatabase().queryOne(
      "SELECT count(*)::int count FROM stripe_billing_events WHERE enrollment_id=?",
      [f.id]
    ),
    { count: 1 }
  )
  assert.deepEqual(
    await getDatabase().queryOne(
      "SELECT count(*)::int count FROM mca_onboarding_service_emails WHERE enrollment_id=?",
      [f.id]
    ),
    { count: 2 }
  )
  const stale = {
    ...e,
    id: newId(),
    type: "customer.subscription.deleted",
    data: { object: { ...f.state.subscription, status: "canceled" } },
  } as unknown as Stripe.Event
  await captureEnrollmentStripeEvent(stale)
  assert.equal(
    (await reconcileEnrollment(f.id, f.client)).billingState,
    "trialing"
  )
})
test("wrong account, mode, customer, price, generation, card or trial dates cannot activate", async () => {
  for (const mutation of [
    "account",
    "mode",
    "customer",
    "price",
    "generation",
    "card",
    "dates",
  ]) {
    const f = await fixture()
    if (mutation === "account") f.state.account = "acct_foreign"
    if (mutation === "mode") f.state.subscription.livemode = true
    if (mutation === "customer") f.state.subscription.customer = "cus_foreign"
    if (mutation === "price")
      f.state.subscription.items.data[0].price.id = "price_foreign"
    if (mutation === "generation")
      f.state.subscription.metadata.request_generation = "999"
    if (mutation === "card") f.state.method.type = "us_bank_account"
    if (mutation === "dates") f.state.subscription.trial_end++
    await assert.rejects(reconcileEnrollment(f.id, f.client), mutation)
    assert.equal((await findEnrollment(f.id))?.activatedAt, null)
  }
})
test("delayed converted claims require paid invoice evidence and never restart the provider trial", async () => {
  const f = await fixture()
  f.state.subscription.status = "active"
  f.state.invoices = [f.invoice()]
  let row = await reconcileEnrollment(f.id, f.client)
  assert.equal(row.billingState, "incomplete")
  const original = row.trialEndsAt
  f.state.invoices.push(f.invoice(0, "subscription_cycle"))
  row = await reconcileEnrollment(f.id, f.client)
  assert.equal(row.billingState, "active")
  assert.equal(row.trialEndsAt, original)
  const workspaceId = newId()
  await withTransaction(async (db) => {
    await db.execute(
      "INSERT INTO workspaces(id,name,feature_flags,page_visibility,created_at,updated_at) VALUES (?,?,'{}','{}',?,?)",
      [workspaceId, "Verified billing", nowIso(), nowIso()]
    )
    await attachEnrollmentBilling(db, workspaceId, row)
  })
  assert.equal((await getCompanyAccess(workspaceId)).allowed, true)
  assert.deepEqual(
    await getDatabase().queryOne(
      "SELECT trial_started_at,trial_ends_at,selected_seats FROM company_subscription_state WHERE workspace_id=?",
      [workspaceId]
    ),
    { trial_started_at: null, trial_ends_at: null, selected_seats: 1 }
  )
})
test("provider failure keeps durable retry and creation rollback leaves existing recovery enabled", async () => {
  const f = await fixture()
  await reconcileEnrollment(f.id, f.client)
  f.state.failRead = true
  await assert.rejects(reconcileEnrollment(f.id, f.client))
  assert.ok((await findEnrollment(f.id))?.nextReconcileAt)
  f.state.failRead = false
  process.env.MCA_STRIPE_FIRST_ONBOARDING_ENABLED = "false"
  try {
    assert.equal(
      (await reconcileEnrollment(f.id, f.client)).billingState,
      "trialing"
    )
    assert.ok(await runEnrollmentMaintenance({ limit: 0, client: f.client }))
  } finally {
    process.env.MCA_STRIPE_FIRST_ONBOARDING_ENABLED = "true"
  }
})
test("portal reloads server association and rejects forged provider IDs", async () => {
  const f = await fixture(),
    row = await reconcileEnrollment(f.id, f.client)
  await createEnrollmentBillingPortal(row, f.client)
  assert.equal(f.state.portalCustomer, row.customerId)
  assert.equal(
    f.state.portalReturnUrl,
    `http://localhost:3000/enrollment?enrollment=${row.id}`
  )
  await assert.rejects(
    createEnrollmentBillingPortal(
      { ...row, customerId: "cus_foreign" },
      f.client
    )
  )
})
test("compensation cancels only a blocked exact uncharged trial, verifies response loss, and escalates conversion", async () => {
  const f = await fixture()
  await reconcileEnrollment(f.id, f.client)
  await assert.rejects(compensateEnrollment(f.id, f.client))
  assert.equal(f.state.cancelCalls, 0)
  await getDatabase().execute(
    "UPDATE mca_enrollments SET claim_state='blocked',finalization_state='blocked',recovery_state='pending',revision=revision+1 WHERE id=?",
    [f.id]
  )
  f.state.cancelLoss = true
  await compensateEnrollment(f.id, f.client)
  assert.equal(f.state.cancelCalls, 1)
  assert.equal((await findEnrollment(f.id))?.recoveryState, "canceled")
  const late = await fixture()
  await reconcileEnrollment(late.id, late.client)
  await getDatabase().execute(
    "UPDATE mca_enrollments SET claim_state='blocked',finalization_state='blocked',recovery_state='pending',revision=revision+1 WHERE id=?",
    [late.id]
  )
  late.state.subscription.status = "active"
  late.state.invoices = [late.invoice(39900, "subscription_cycle")]
  await compensateEnrollment(late.id, late.client)
  assert.equal(late.state.cancelCalls, 0)
  assert.equal(
    (await findEnrollment(late.id))?.recoveryState,
    "operator_required"
  )
})
test("receipt before create response persists and obsolete generations cannot bind the current enrollment", async () => {
  const f = stripeFixture(),
    secret = resumeSecret()
  f.state.onCreate = async () => {
    const session = f.complete()
    await captureEnrollmentStripeEvent({
      id: newId(),
      type: "checkout.session.completed",
      livemode: false,
      data: { object: session },
    } as unknown as Stripe.Event)
  }
  await assert.rejects(
    startEnrollmentCheckout({ resumeSecret: secret }, f.client),
    { code: "enrollment_checkout_pending" }
  )
  const id = [...f.state.sessions.values()][0].metadata!.enrollment_id
  assert.equal(
    (await reconcileEnrollment(id, f.client)).billingState,
    "trialing"
  )
  const g = stripeFixture(),
    binding = resumeSecret(),
    first = await startEnrollmentCheckout({ resumeSecret: binding }, g.client)
  const old = [...g.state.sessions.values()][0]
  old.status = "expired"
  await startEnrollmentCheckout({ resumeSecret: binding }, g.client)
  await captureEnrollmentStripeEvent({
    id: newId(),
    type: "checkout.session.completed",
    livemode: false,
    data: {
      object: {
        ...old,
        status: "complete",
        subscription: "sub_old",
        customer: "cus_old",
      },
    },
  } as unknown as Stripe.Event)
  await reconcileEnrollment(first.enrollmentId, g.client)
  assert.equal((await findEnrollment(first.enrollmentId))?.activatedAt, null)
})
test("SQL attachment rolls back atomically, refuses existing tenants, and uses local provider expiry", async () => {
  const f = await fixture()
  f.state.subscription.trial_start -= 15 * 86400
  f.state.subscription.trial_end -= 15 * 86400
  const row = await reconcileEnrollment(f.id, f.client),
    workspaceId = newId()
  const insert = async (db: import("../src/lib/mca/db").DbExecutor) =>
    db.execute(
      "INSERT INTO workspaces(id,name,feature_flags,page_visibility,created_at,updated_at) VALUES (?,?,'{}','{}',?,?)",
      [workspaceId, "Atomic billing", nowIso(), nowIso()]
    )
  await assert.rejects(
    withTransaction(async (db) => {
      await insert(db)
      await attachEnrollmentBilling(db, workspaceId, row)
      throw new Error("rollback finalization")
    }),
    /rollback/
  )
  assert.equal(
    await getDatabase().queryOne("SELECT id FROM workspaces WHERE id=?", [
      workspaceId,
    ]),
    undefined
  )
  assert.equal(
    await getDatabase().queryOne(
      "SELECT workspace_id FROM workspace_stripe_customers WHERE stripe_customer_id=?",
      [row.customerId]
    ),
    undefined
  )
  await withTransaction(async (db) => {
    await insert(db)
    await attachEnrollmentBilling(db, workspaceId, row)
  })
  assert.equal((await getCompanyAccess(workspaceId)).allowed, false)
  await assert.rejects(
    withTransaction((db) => attachEnrollmentBilling(db, workspaceId, row)),
    { code: "enrollment_existing_billing" }
  )
})
test("a stale lease cannot commit provider evidence and failed fresh reads prevent attachment", async () => {
  const f = await fixture()
  const original = f.client.subscriptions.retrieve
  f.client.subscriptions.retrieve = (async (
    ...args: Parameters<typeof original>
  ) => {
    await getDatabase().execute(
      "UPDATE mca_enrollments SET claim_token=?,lease_until=?,revision=revision+1 WHERE id=?",
      [newId(), new Date(Date.now() + 600000).toISOString(), f.id]
    )
    return original(...args)
  }) as typeof original
  await assert.rejects(reconcileEnrollment(f.id, f.client), {
    code: "enrollment_busy",
  })
  assert.equal((await findEnrollment(f.id))?.activatedAt, null)
  const g = await fixture(),
    row = await reconcileEnrollment(g.id, g.client)
  g.state.failRead = true
  await assert.rejects(reconcileEnrollment(g.id, g.client))
  await assert.rejects(
    withTransaction((db) => attachEnrollmentBilling(db, newId(), row)),
    { code: "enrollment_evidence_stale" }
  )
})
test("unclaimed canceled trial history blocks reuse of original email after contact recovery", async () => {
  const f = await fixture(),
    row = await reconcileEnrollment(f.id, f.client),
    email = [...f.state.sessions.values()][0].customer_details!.email!
  await getDatabase().execute(
    "UPDATE mca_enrollments SET billing_state='canceled',claim_state='blocked',recovery_state='canceled',email_hash=?,revision=revision+1 WHERE id=?",
    ["recovered_contact", f.id]
  )
  process.env.MCA_TRIAL_ABUSE_LIMITS_ENABLED = "true"
  try {
    const { trialAllowedForIdentity } =
      await import("../src/lib/mca/trial-abuse")
    assert.equal(
      await withTransaction((db) =>
        trialAllowedForIdentity({ email }, { enrollmentId: newId() }, db)
      ),
      false
    )
    assert.equal(
      await withTransaction((db) =>
        trialAllowedForIdentity({ email }, { enrollmentId: row.id }, db)
      ),
      true
    )
  } finally {
    delete process.env.MCA_TRIAL_ABUSE_LIMITS_ENABLED
  }
})
test("active subscriptions with foreign or unpaid invoices never gain paid access", async () => {
  const unpaid = await fixture()
  unpaid.state.subscription.status = "active"
  unpaid.state.invoices = [
    {
      ...unpaid.invoice(39900, "subscription_cycle"),
      status: "open",
      amount_paid: 0,
      amount_remaining: 39900,
    },
  ]
  assert.equal(
    (await reconcileEnrollment(unpaid.id, unpaid.client)).billingState,
    "incomplete"
  )
  const foreign = await fixture()
  foreign.state.subscription.status = "active"
  foreign.state.invoices = [
    {
      ...foreign.invoice(39900, "subscription_cycle"),
      customer: "cus_foreign",
    },
  ]
  await assert.rejects(reconcileEnrollment(foreign.id, foreign.client))
  assert.equal((await findEnrollment(foreign.id))?.activatedAt, null)
})
test("ambiguous cancellation acceptance and payment already processing require an operator", async () => {
  for (const failure of ["response", "payment"]) {
    const f = await fixture()
    await reconcileEnrollment(f.id, f.client)
    await getDatabase().execute(
      "UPDATE mca_enrollments SET claim_state='blocked',finalization_state='blocked',recovery_state='pending',revision=revision+1 WHERE id=?",
      [f.id]
    )
    if (failure === "response")
      f.client.subscriptions.cancel = (async () => {
        throw new Error("timeout")
      }) as typeof f.client.subscriptions.cancel
    else
      f.client.paymentIntents.list = (async () => ({
        data: [{ id: "pi_processing", status: "processing" }],
        has_more: false,
      })) as typeof f.client.paymentIntents.list
    await compensateEnrollment(f.id, f.client)
    assert.equal(
      (await findEnrollment(f.id))?.recoveryState,
      "operator_required"
    )
    assert.equal(f.state.cancelCalls, 0)
  }
})
test("company portal permits only exact committed enrollment mapping and grant transfer stays deduplicated", async () => {
  const f = await fixture(),
    row = await reconcileEnrollment(f.id, f.client),
    workspaceId = newId(),
    userId = newId(),
    providerId = newId(),
    memberId = newId(),
    email = [...f.state.sessions.values()][0].customer_details!.email!
  const { createBillingPortal } = await import("../src/lib/mca/billing"),
    { workspaceOwnsStripeCustomer } =
      await import("../src/lib/mca/billing-customer-binding")
  assert.equal(
    await workspaceOwnsStripeCustomer(
      workspaceId,
      f.state.customer as unknown as Stripe.Customer,
      false
    ),
    false
  )
  await withTransaction(async (db) => {
    await db.execute(
      "INSERT INTO workspaces(id,name,feature_flags,page_visibility,created_at,updated_at) VALUES (?,'Committed billing','{}','{}',?,?)",
      [workspaceId, nowIso(), nowIso()]
    )
    await db.execute(
      "INSERT INTO users(id,supabase_user_id,email,name,application_identifier,created_at,updated_at) VALUES (?,?,?,'Owner',?,?,?)",
      [userId, providerId, email, userId, nowIso(), nowIso()]
    )
    await db.execute(
      "INSERT INTO memberships(id,workspace_id,user_id,role,status,created_at,updated_at) VALUES (?,?,?,'admin','active',?,?)",
      [memberId, workspaceId, userId, nowIso(), nowIso()]
    )
    await db.execute(
      "INSERT INTO workspace_owners(workspace_id,membership_id,updated_at) VALUES (?,?,?)",
      [workspaceId, memberId, nowIso()]
    )
    await attachEnrollmentBilling(db, workspaceId, row)
    const { recordEnrollmentTrialGrant } =
      await import("../src/lib/mca/onboarding/billing")
    await recordEnrollmentTrialGrant(db, workspaceId, row, {
      userId,
      providerUserId: providerId,
      email,
    })
    await db.execute(
      "UPDATE mca_enrollments SET user_id=?,claimed_provider_user_id=?,workspace_id=?,claim_state='claimed',finalization_state='complete',revision=revision+1 WHERE id=?",
      [userId, providerId, workspaceId, row.id]
    )
  })
  assert.equal(
    (await createBillingPortal(workspaceId, false, f.client)).url,
    "https://billing.stripe.com/p/session/test"
  )
  assert.equal(
    await workspaceOwnsStripeCustomer(
      newId(),
      f.state.customer as unknown as Stripe.Customer,
      false
    ),
    false
  )
  const oldAccount = f.state.account
  f.state.account = "acct_other"
  await assert.rejects(createBillingPortal(workspaceId, false, f.client), {
    code: "enrollment_account_mismatch",
  })
  f.state.account = oldAccount
  f.state.customer.metadata.workspace_id = newId()
  await assert.rejects(createBillingPortal(workspaceId, false, f.client), {
    code: "billing_customer_mismatch",
  })
  delete f.state.customer.metadata.workspace_id
  process.env.MCA_TRIAL_ABUSE_LIMITS_ENABLED = "true"
  process.env.MCA_TRIAL_LIMIT_PER_EMAIL = "2"
  process.env.MCA_TRIAL_LIMIT_PER_USER = "2"
  try {
    const { trialAllowedForIdentity } =
      await import("../src/lib/mca/trial-abuse")
    assert.equal(
      await withTransaction((db) =>
        trialAllowedForIdentity(
          { userId, providerUserId: providerId, email },
          { enrollmentId: newId() },
          db
        )
      ),
      true,
      "transferred provider trial must count once"
    )
  } finally {
    delete process.env.MCA_TRIAL_ABUSE_LIMITS_ENABLED
    delete process.env.MCA_TRIAL_LIMIT_PER_EMAIL
    delete process.env.MCA_TRIAL_LIMIT_PER_USER
  }
})
test("a conversion that races compensation remains operator-required after cancellation", async () => {
  const f = await fixture()
  await reconcileEnrollment(f.id, f.client)
  await getDatabase().execute(
    "UPDATE mca_enrollments SET claim_state='blocked',finalization_state='blocked',recovery_state='pending',revision=revision+1 WHERE id=?",
    [f.id]
  )
  f.client.subscriptions.cancel = (async () => {
    f.state.cancelCalls++
    f.state.subscription.status = "canceled"
    f.state.invoices.push(f.invoice(39900, "subscription_cycle"))
    return f.state.subscription
  }) as unknown as typeof f.client.subscriptions.cancel
  await compensateEnrollment(f.id, f.client)
  assert.equal((await findEnrollment(f.id))?.recoveryState, "operator_required")
  assert.equal(f.state.cancelCalls, 1)
})
test("unsigned events fail verification and foreign signed account/session events cannot activate", async () => {
  const { verifyStripeBillingEvent, getStripeClient } =
    await import("../src/lib/mca/billing")
  const f = await fixture(),
    e = event(f),
    body = JSON.stringify(e)
  assert.throws(() => verifyStripeBillingEvent(body, null), {
    code: "billing_webhook_signature_invalid",
  })
  assert.throws(() => verifyStripeBillingEvent(body, "t=1,v1=bad"), {
    code: "billing_webhook_signature_invalid",
  })
  const signature = getStripeClient().webhooks.generateTestHeaderString({
    payload: body,
    secret: "whsec_fixture",
  })
  assert.equal(verifyStripeBillingEvent(body, signature).id, e.id)
  await assert.rejects(
    captureEnrollmentStripeEvent({ ...e, account: "acct_foreign" }),
    { code: "enrollment_account_mismatch" }
  )
  await assert.rejects(captureEnrollmentStripeEvent({ ...e, livemode: true }), {
    code: "billing_mode_mismatch",
  })
  await assert.rejects(
    captureEnrollmentStripeEvent({
      ...e,
      data: { object: { ...e.data.object, id: "cs_foreign" } },
    } as Stripe.Event),
    { code: "enrollment_session_mismatch" }
  )
  assert.equal((await findEnrollment(f.id))?.activatedAt, null)
})
test("current billing evidence is encrypted, account-bound, revisioned and separately RLS-protected", async () => {
  const f = await fixture()
  const before = await reconcileEnrollment(f.id, f.client)
  const stored = await getDatabase().queryOne<{
    snapshot_cipher: string
    revision: number
  }>(
    "SELECT snapshot_cipher,revision FROM mca_enrollment_billing_evidence WHERE enrollment_id=?",
    [f.id]
  )
  assert.ok(stored)
  assert.ok(!stored.snapshot_cipher.includes(f.state.subscription.id))
  assert.equal(stored.revision, 1)
  await assert.rejects(
    getDatabase().execute(
      "UPDATE mca_enrollment_billing_evidence SET revision=revision+2 WHERE enrollment_id=?",
      [f.id]
    ),
    /revision/
  )
  await assert.rejects(
    getDatabase().execute(
      "UPDATE mca_enrollment_billing_evidence SET provider_account_id='acct_other',revision=revision+1 WHERE enrollment_id=?",
      [f.id]
    ),
    /revision/
  )
  await reconcileEnrollment(f.id, f.client)
  assert.equal(
    (await findEnrollment(f.id))?.providerSnapshotCipher,
    before.providerSnapshotCipher
  )
  assert.equal(
    (
      await getDatabase().queryOne<{ revision: number }>(
        "SELECT revision FROM mca_enrollment_billing_evidence WHERE enrollment_id=?",
        [f.id]
      )
    )?.revision,
    2
  )
  assert.deepEqual(
    await getDatabase().queryOne(
      "SELECT relrowsecurity FROM pg_class WHERE relname='mca_enrollment_billing_evidence'"
    ),
    { relrowsecurity: true }
  )
})
