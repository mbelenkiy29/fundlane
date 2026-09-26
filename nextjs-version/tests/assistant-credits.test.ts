import "./helpers/business-auth"
import test, { before, after } from "node:test"
import assert from "node:assert/strict"
import { createHmac } from "node:crypto"
import { Client } from "pg"
import type Stripe from "stripe"
import { createPostgresTestDatabase } from "./helpers/postgres-test-db.mjs"
import {
  closeDatabaseForTests,
  getDatabase,
  newId,
  nowIso,
} from "../src/lib/mca/db"
import { hashOpaqueToken } from "../src/lib/mca/crypto"
import {
  getCreditBalance,
  settleCredit,
  recordCreditBalanceChange,
  resolveCreditAllowance,
  releaseExpiredReservations,
} from "../src/lib/mca/assistant/credits"
import {
  processCreditAlerts,
  deliverCreditAlerts,
  listCreditNotifications,
  saveAlertSettings,
  markCreditNotificationRead,
} from "../src/lib/mca/assistant/alerts"
import {
  createCreditCheckout,
  purchasesAvailable,
  reconcileCreditPurchase,
  processCreditPaymentEvent,
} from "../src/lib/mca/assistant/purchases"
import {
  openConversation,
  createRun,
  cancelConversation,
  ownedConversation,
  finishRun,
} from "../src/lib/mca/assistant/repository"
import {
  authorize,
  searchAssistantDeals,
  selectAssistantDeal,
  writeAssistantDeal,
  guard,
  assistantDealFields,
  type OperationContext,
} from "../src/lib/mca/assistant/operations"
import { createDeal } from "../src/lib/mca/deals/service"
import { POST as checkoutRoute } from "../src/app/api/mca/assistant/credits/checkout/route"
import { PATCH as settingsRoute } from "../src/app/api/mca/assistant/credits/admin/route"
import { GET as notificationsRoute } from "../src/app/api/mca/assistant/notifications/route"
import { POST as stripeWebhook } from "../src/app/api/webhooks/stripe-credits/route"
import { GET as assistantCron } from "../src/app/api/cron/assistant/route"
let fixture: Awaited<ReturnType<typeof createPostgresTestDatabase>>
const sql = (s: string, ...v: unknown[]) =>
  getDatabase()
    .prepare(s)
    .run(...v)
const req = (id: string, body?: unknown) =>
  new Request("http://localhost/api/mca/assistant", {
    method: body ? "POST" : "GET",
    headers: {
      cookie: `mca_session=${id}`,
      origin: "http://localhost",
      "content-type": "application/json",
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  })
async function user(role = "rep", workspace = "credits-workspace") {
  const id = newId(),
    now = nowIso()
  await sql(
    "INSERT INTO users(id,email,name,application_identifier,created_at,updated_at) VALUES (?,?,?,?,?,?)",
    id,
    `${id}@example.test`,
    `Synthetic ${role}`,
    id,
    now,
    now
  )
  await sql(
    "INSERT INTO memberships(id,workspace_id,user_id,role,status,created_at,updated_at) VALUES (?,?,?,?,'active',?,?)",
    id,
    workspace,
    id,
    role,
    now,
    now
  )
  await sql(
    "INSERT INTO sessions(id,user_id,membership_id,token_hash,expires_at,created_at,last_seen_at) VALUES (?,?,?,?,?,?,?)",
    id,
    id,
    id,
    hashOpaqueToken(id),
    "2030-01-01T00:00:00Z",
    now,
    now
  )
  return { workspace_id: workspace, user_id: id }
}
async function task(owner: Awaited<ReturnType<typeof user>>) {
  const actor = await authorize(req(owner.user_id))
  const c = await openConversation(actor)
  return { c, run: await createRun(c, newId(), "Synthetic request") }
}
function ctx(
  c: Awaited<ReturnType<typeof openConversation>>,
  runId: string
): OperationContext {
  return {
    conversation: c,
    runId,
    request: req(c.user_id),
    signal: new AbortController().signal,
    progress: () => {},
  }
}
const fields = (patch: Record<string, unknown>) =>
  assistantDealFields.parse({
    legalName: null,
    dbaName: null,
    contactName: null,
    contactEmail: null,
    contactPhone: null,
    industry: null,
    monthlyRevenue: null,
    requestedAmount: null,
    fundingPurpose: null,
    ...patch,
  })
before(async () => {
  fixture = await createPostgresTestDatabase("assistant_credits")
  Object.assign(process.env, fixture.env())
  process.env.MCA_STRIPE_BILLING_ENABLED = "false"
  process.env.MCA_ASSISTANT_ENABLED = "true"
  process.env.MCA_APP_ORIGIN = "http://localhost"
  for (const id of ["credits-workspace", "other-credits-workspace"]) {
    const now = nowIso()
    await sql(
      "INSERT INTO workspaces(id,name,timezone,seat_limit,feature_flags,page_visibility,action_visibility,created_at,updated_at) VALUES (?,?,'UTC',100,'{}',?,?,?,?)",
      id,
      id,
      JSON.stringify({ deals: true }),
      JSON.stringify({ createDeal: true }),
      now,
      now
    )
  }
})
after(async () => {
  await closeDatabaseForTests()
  await fixture?.close()
})
test("concurrent last-credit reservations cannot overdraw; duplicate requests do not charge twice", async () => {
  const u = await user("admin"),
    actor = await authorize(req(u.user_id)),
    cs = await Promise.all(
      Array.from({ length: 11 }, () => openConversation(actor))
    )
  const attempts = await Promise.allSettled(
    cs.map((c) => createRun(c, newId(), "Review"))
  )
  assert.equal(attempts.filter((a) => a.status === "fulfilled").length, 10)
  const balance = await getCreditBalance(u)
  assert.equal(balance.total, 0)
  assert.equal(balance.reserved, 10)
  const first = attempts.find(
    (a) => a.status === "fulfilled"
  ) as PromiseFulfilledResult<Awaited<ReturnType<typeof createRun>>>
  await settleCredit(first.value.id, "charge")
  await settleCredit(first.value.id, "charge")
  const ledger = await getDatabase()
    .prepare<{ n: number }>(
      "SELECT count(*)::int n FROM mca_credit_ledger WHERE event_key=?"
    )
    .get(`charged:${first.value.id}`)
  assert.equal(ledger?.n, 1)
  for (const c of cs) await cancelConversation(c)
  assert.equal((await getCreditBalance(u)).total, 9)
})
test("request id replay is rejected without another reservation", async () => {
  const u = await user(),
    actor = await authorize(req(u.user_id)),
    c = await openConversation(actor),
    key = newId()
  await createRun(c, key, "One")
  await assert.rejects(createRun(c, key, "Replay"), {
    code: "request_already_recorded",
  })
  assert.equal((await getCreditBalance(u)).reserved, 1)
  await cancelConversation(c)
})
test("monthly grants, upgrades, removal and rejoining never refill spent allowances", async () => {
  const u = await user()
  assert.equal((await getCreditBalance(u, 10)).total, 10)
  const t = await task(u)
  await settleCredit(t.run.id, "charge")
  assert.equal((await getCreditBalance(u, 100)).total, 99)
  assert.equal((await getCreditBalance(u, 10)).total, 9)
  assert.equal((await getCreditBalance(u, 100)).total, 99)
  assert.equal((await getCreditBalance(u, 250)).total, 249)
  // Spend beyond the lower tier, then apply an effective downgrade and restore it.
  await sql(
    "UPDATE mca_credit_months SET remaining=130 WHERE account_id IN (SELECT id FROM mca_credit_accounts WHERE user_id=?)",
    u.user_id
  )
  assert.equal((await getCreditBalance(u, 100)).total, 0)
  assert.equal((await getCreditBalance(u, 250)).total, 130)
  await sql(
    "UPDATE memberships SET status='deactivated' WHERE user_id=?",
    u.user_id
  )
  await assert.rejects(getCreditBalance(u, 250), {
    code: "membership_inactive",
  })
  await sql("UPDATE memberships SET status='active' WHERE user_id=?", u.user_id)
  assert.equal((await getCreditBalance(u, 250)).total, 130)
  const next = new Date()
  next.setUTCMonth(next.getUTCMonth() + 1)
  next.setUTCDate(2)
  assert.equal((await getCreditBalance(u, 10, next)).total, 10)
})
test("definitive first-call rejection refunds once; expired reservations release; charged cancellations do not refund", async () => {
  const u = await user(),
    t = await task(u)
  await settleCredit(t.run.id, "charge")
  await settleCredit(t.run.id, "refund")
  await settleCredit(t.run.id, "refund")
  assert.equal((await getCreditBalance(u)).total, 10)
  const t2 = await task(u)
  await sql(
    "UPDATE mca_assistant_runs SET expires_at='2000-01-01' WHERE id=?",
    t2.run.id
  )
  await releaseExpiredReservations()
  assert.equal((await getCreditBalance(u)).reserved, 0)
  const t3 = await task(u)
  await settleCredit(t3.run.id, "charge")
  await cancelConversation(t3.c)
  assert.equal((await getCreditBalance(u)).total, 9)
})
test("assistant cron is disabled by default and replays expired credit maintenance once after restart", async () => {
  const enabled = process.env.MCA_ASSISTANT_MAINTENANCE_ENABLED
  const secret = process.env.CRON_SECRET
  const emailUrl = process.env.MCA_EMAIL_WEBHOOK_URL
  const experience = process.env.MCA_ASSISTANT_EXPERIENCE_ENABLED
  const u = await user("admin"), t = await task(u)
  await sql("UPDATE mca_assistant_runs SET expires_at='2000-01-01' WHERE id=?", t.run.id)
  await sql(`INSERT INTO mca_credit_balance_events
    (account_id,month,allowance,included,purchased,threshold_mode,threshold_value,created_at)
    SELECT a.id,m.month,10,10,0,'fixed',11,? FROM mca_credit_accounts a
    JOIN mca_credit_months m ON m.account_id=a.id WHERE a.user_id=? AND m.month=?`, nowIso(), u.user_id, new Date().toISOString().slice(0, 7))
  await sql("UPDATE mca_credit_accounts SET alert_dirty=1 WHERE user_id=?", u.user_id)
  const request = (token?: string) => new Request("http://localhost/api/cron/assistant", {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  })
  try {
    delete process.env.MCA_EMAIL_WEBHOOK_URL
    process.env.MCA_ASSISTANT_EXPERIENCE_ENABLED = "false"
    delete process.env.MCA_ASSISTANT_MAINTENANCE_ENABLED
    assert.deepEqual(await (await assistantCron(request())).json(), { enabled: false })
    assert.equal((await getCreditBalance(u)).reserved, 1)
    process.env.MCA_ASSISTANT_MAINTENANCE_ENABLED = "true"
    process.env.CRON_SECRET = "synthetic-assistant-cron-secret"
    assert.equal((await assistantCron(request("wrong"))).status, 401)
    assert.equal((await getCreditBalance(u)).reserved, 1)
    const first = await assistantCron(request(process.env.CRON_SECRET))
    assert.equal(first.status, 200)
    assert.equal((await getCreditBalance(u)).reserved, 0)
    const notifications = async () => Number((await getDatabase().prepare<{ count: string }>("SELECT count(*) AS count FROM mca_credit_notifications WHERE recipient_user_id=?").get(u.user_id))?.count)
    const firstCount = await notifications()
    assert.ok(firstCount > 0)
    const blocker = new Client({ connectionString: fixture.databaseUrl })
    await blocker.connect()
    try {
      await blocker.query("BEGIN")
      await blocker.query("SELECT pg_advisory_xact_lock(hashtext($1))", ["mca-assistant-maintenance"])
      const overlap = await assistantCron(request(process.env.CRON_SECRET))
      assert.equal(overlap.status, 200)
      assert.equal((await overlap.json()).claimed, false, "overlapping tick must not claim work")
    } finally {
      await blocker.query("ROLLBACK")
      await blocker.end()
    }
    await closeDatabaseForTests()
    const second = await assistantCron(request(process.env.CRON_SECRET))
    assert.equal(second.status, 200)
    const entries = await getDatabase().prepare<{ count: string }>("SELECT count(*) AS count FROM mca_credit_ledger WHERE event_key=? AND kind='released'").get(`released:${t.run.id}`)
    assert.equal(Number(entries?.count), 1)
    assert.equal(await notifications(), firstCount)
  } finally {
    if (enabled === undefined) delete process.env.MCA_ASSISTANT_MAINTENANCE_ENABLED
    else process.env.MCA_ASSISTANT_MAINTENANCE_ENABLED = enabled
    if (secret === undefined) delete process.env.CRON_SECRET
    else process.env.CRON_SECRET = secret
    if (emailUrl === undefined) delete process.env.MCA_EMAIL_WEBHOOK_URL
    else process.env.MCA_EMAIL_WEBHOOK_URL = emailUrl
    if (experience === undefined) delete process.env.MCA_ASSISTANT_EXPERIENCE_ENABLED
    else process.env.MCA_ASSISTANT_EXPERIENCE_ENABLED = experience
  }
})
test("unverified paid billing cannot grant allowances", async () => {
  const u = await user()
  process.env.MCA_STRIPE_BILLING_ENABLED = "true"
  const previousKey = process.env.STRIPE_SECRET_KEY
  delete process.env.STRIPE_SECRET_KEY
  await sql("INSERT INTO workspace_stripe_customers (workspace_id,stripe_customer_id,created_at) VALUES (?,?,?)",u.workspace_id,"cus_unverified_paid",nowIso())
  try {
    await assert.rejects(resolveCreditAllowance(u.workspace_id))
    const n = await getDatabase()
      .prepare("SELECT id FROM mca_credit_accounts WHERE user_id=?")
      .get(u.user_id)
    assert.equal(n, undefined)
  } finally {
    process.env.MCA_STRIPE_BILLING_ENABLED = "false"
    if (previousKey === undefined) delete process.env.STRIPE_SECRET_KEY; else process.env.STRIPE_SECRET_KEY = previousKey
    await sql("DELETE FROM workspace_stripe_customers WHERE stripe_customer_id=?","cus_unverified_paid")
  }
})
test("workspace chat creates and edits one deal, rejects forbidden fields and cross-deal changes", async () => {
  const u = await user("admin"),
    t = await task(u),
    context = ctx(t.c, t.run.id)
  const draft = await writeAssistantDeal(
    context,
    "create",
    fields({ legalName: "Synthetic Harbor Cafe" })
  )
  assert.ok(draft.id)
  assert.equal(draft.legalName, "Synthetic Harbor Cafe")
  const updated = await writeAssistantDeal(
    context,
    "update",
    fields({ monthlyRevenue: 55000 }),
    draft.version
  )
  assert.equal(updated.monthlyRevenue, 55000)
  await assert.rejects(
    writeAssistantDeal(
      context,
      "update",
      fields({ requestedAmount: 20000 }),
      draft.version
    )
  )
  assert.throws(() => fields({ ein: "not-permitted" }))
  const other = (
    await createDeal(await authorize(req(u.user_id)), {
      legalName: "Other synthetic",
      idempotencyKey: newId(),
    })
  ).deal
  await selectAssistantDeal(context, other.id)
  await assert.rejects(
    writeAssistantDeal(
      context,
      "update",
      fields({ monthlyRevenue: 1 }),
      other.version
    ),
    { code: "one_deal_per_request" }
  )
})
test("search and stored references enforce rep visibility and reject revoked history", async () => {
  const u = await user(),
    other = await user(),
    t = await task(u),
    context = ctx(t.c, t.run.id)
  const mine = (
    await createDeal(await authorize(req(u.user_id)), {
      legalName: "Visible synthetic",
      idempotencyKey: newId(),
    })
  ).deal
  await createDeal(await authorize(req(other.user_id)), {
    legalName: "Hidden synthetic",
    idempotencyKey: newId(),
  })
  const found = await searchAssistantDeals(context, "")
  assert.deepEqual(
    found.deals.map((d) => d.id),
    [mine.id]
  )
  await assert.rejects(
    ownedConversation(await authorize(req(other.user_id)), t.c.id),
    { code: "conversation_not_found" }
  )
  await sql("DELETE FROM deal_assignments WHERE deal_id=?", mine.id)
  await assert.rejects(guard(context))
  await assert.rejects(
    ownedConversation(await authorize(req(u.user_id)), t.c.id)
  )
})
test("alerts warn once, exhaust once, include purchased credits, and rearm after recovery", async () => {
  const admin = await user("admin"),
    u = await user()
  await getCreditBalance(u)
  const account = (await getDatabase()
    .prepare<{ id: string }>(
      "SELECT id FROM mca_credit_accounts WHERE user_id=?"
    )
    .get(u.user_id))!
  await sql(
    "UPDATE mca_credit_months SET remaining=2 WHERE account_id=?",
    account.id
  )
  await recordCreditBalanceChange(getDatabase(), account.id)
  await processCreditAlerts(u.workspace_id)
  await recordCreditBalanceChange(getDatabase(), account.id)
  await processCreditAlerts(u.workspace_id)
  let notices = (
    await listCreditNotifications(admin.workspace_id, admin.user_id)
  ).notifications.filter((n) => n.userId === u.user_id)
  assert.equal(notices.length, 1)
  assert.equal(notices[0].kind, "low")
  await markCreditNotificationRead(
    admin.workspace_id,
    admin.user_id,
    notices[0].id
  )
  assert.ok(
    (
      await listCreditNotifications(admin.workspace_id, admin.user_id)
    ).notifications.find((n) => n.id === notices[0].id)?.readAt
  )
  await sql(
    "UPDATE mca_credit_months SET remaining=0 WHERE account_id=?",
    account.id
  )
  await sql(
    "UPDATE mca_credit_accounts SET alert_dirty=1 WHERE id=?",
    account.id
  )
  await recordCreditBalanceChange(getDatabase(), account.id)
  await Promise.all([
    processCreditAlerts(u.workspace_id),
    processCreditAlerts(u.workspace_id),
  ])
  notices = (
    await listCreditNotifications(admin.workspace_id, admin.user_id)
  ).notifications.filter((n) => n.userId === u.user_id)
  assert.equal(notices.length, 2)
  await sql(
    "UPDATE mca_credit_accounts SET purchased_balance=100,alert_dirty=1 WHERE id=?",
    account.id
  )
  await recordCreditBalanceChange(getDatabase(), account.id)
  await processCreditAlerts(u.workspace_id)
  await sql(
    "UPDATE mca_credit_accounts SET purchased_balance=2,alert_dirty=1 WHERE id=?",
    account.id
  )
  await recordCreditBalanceChange(getDatabase(), account.id)
  await processCreditAlerts(u.workspace_id)
  assert.equal(
    (
      await listCreditNotifications(admin.workspace_id, admin.user_id)
    ).notifications.filter((n) => n.userId === u.user_id).length,
    3
  )
})
test("threshold settings are validated and apply on subsequent credit change", async () => {
  await assert.rejects(
    saveAlertSettings("credits-workspace", { mode: "percent", threshold: 101 })
  )
  await saveAlertSettings("credits-workspace", { mode: "fixed", threshold: 5 })
  const admin = await user("admin"),
    u = await user()
  await getCreditBalance(u)
  const account = (await getDatabase()
    .prepare<{ id: string }>(
      "SELECT id FROM mca_credit_accounts WHERE user_id=?"
    )
    .get(u.user_id))!
  await sql(
    "UPDATE mca_credit_months SET remaining=5 WHERE account_id=?",
    account.id
  )
  await recordCreditBalanceChange(getDatabase(), account.id)
  await processCreditAlerts(u.workspace_id)
  assert.equal(
    (
      await listCreditNotifications(admin.workspace_id, admin.user_id)
    ).notifications.filter((n) => n.userId === u.user_id)[0]?.total,
    5
  )
  await saveAlertSettings("credits-workspace", {
    mode: "percent",
    threshold: 20,
  })
})
test("email uncertainty is never retried, deactivated admins are skipped, alerts contain no chat data", async () => {
  const admin = await user("admin"),
    u = await user()
  await getCreditBalance(u)
  const account = (await getDatabase()
    .prepare<{ id: string }>(
      "SELECT id FROM mca_credit_accounts WHERE user_id=?"
    )
    .get(u.user_id))!
  await sql(
    "UPDATE mca_credit_months SET remaining=1 WHERE account_id IN (SELECT id FROM mca_credit_accounts WHERE user_id=?)",
    u.user_id
  )
  await recordCreditBalanceChange(getDatabase(), account.id)
  await processCreditAlerts(u.workspace_id)
  // Isolate this recipient's pending delivery from previous test notifications.
  await sql(
    "UPDATE mca_credit_alert_emails SET state='sent' WHERE id IN (SELECT id FROM mca_credit_notifications WHERE recipient_user_id<>?)",
    admin.user_id
  )
  let calls = 0
  await deliverCreditAlerts(u.workspace_id, {
    verifyRecipient: async () => "synthetic@example.test",
    send: async (message) => {
      calls++
      assert.equal(message.template, "ai_credit_alert")
      assert.equal("messages" in message.data!, false)
      throw new Error("Unknown transport result")
    },
  })
  await deliverCreditAlerts(u.workspace_id, {
    verifyRecipient: async () => "synthetic@example.test",
    send: async () => {
      calls++
      throw new Error("Must not retry")
    },
  })
  assert.equal(calls, 1)
  const notices = await listCreditNotifications(
    admin.workspace_id,
    admin.user_id
  )
  assert.equal(notices.notifications[0].emailState, "uncertain")
  await sql(
    "UPDATE mca_credit_alert_emails SET state='queued',next_attempt_at='2000-01-01' WHERE id=?",
    notices.notifications[0].id
  )
  await sql(
    "UPDATE memberships SET status='deactivated' WHERE user_id=?",
    admin.user_id
  )
  await deliverCreditAlerts(u.workspace_id, {
    verifyRecipient: async () => "synthetic@example.test",
    send: async () => {
      throw new Error("Should be skipped")
    },
  })
  assert.equal(
    (await listCreditNotifications(admin.workspace_id, admin.user_id))
      .notifications[0].emailState,
    "skipped"
  )
})
function paymentFixture() {
  let session: Record<string, unknown>,
    refunded = 0,
    dispute: string | null = null,
    creates = 0
  const fake = {
    checkout: {
      sessions: {
        create: async (
          params: Record<string, unknown>,
          options: { idempotencyKey: string }
        ) => {
          creates++
          assert.ok(options.idempotencyKey)
          assert.equal("payment_method_types" in params, false)
          session = {
            ...params,
            id: `cs_test_${newId()}`,
            url: "https://checkout.stripe.com/c/pay/test",
            status: "open",
            payment_status: "unpaid",
            amount_total: 1000,
            currency: "usd",
            payment_intent: `pi_${newId()}`,
          }
          return session
        },
        retrieve: async () => session,
      },
    },
    paymentIntents: {
      retrieve: async () => ({
        id: session.payment_intent,
        amount: 1000,
        currency: "usd",
        status: "succeeded",
        metadata: {
          purchase_id: (session.metadata as { purchase_id: string })
            .purchase_id,
        },
        latest_charge: {
          amount_refunded: refunded,
          disputed: Boolean(dispute),
        },
      }),
    },
    disputes: {
      list: async () => ({ data: dispute ? [{ status: dispute }] : [] }),
    },
  }
  return {
    stripe: fake as unknown as Stripe,
    paid: () => {
      session.payment_status = "paid"
      session.status = "complete"
    },
    expire: () => {
      session.status = "expired"
    },
    refund: (n: number) => {
      refunded = n
    },
    dispute: (s: string | null) => {
      dispute = s
    },
    session: () => session,
    creates: () => creates,
  }
}
test("checkout is admin-only and server priced; paid/replayed/concurrent events grant exactly once", async () => {
  const admin = await user("admin"),
    u = await user(),
    p = paymentFixture()
  process.env.MCA_AI_CREDIT_PURCHASES_ENABLED = "true"
  process.env.STRIPE_SECRET_KEY = "sk_test_synthetic"
  process.env.STRIPE_WEBHOOK_SECRET = "whsec_synthetic"
  await assert.rejects(
    createCreditCheckout(
      u.workspace_id,
      u.user_id,
      u.user_id,
      newId(),
      p.stripe
    ),
    { code: "admin_required" }
  )
  const requestId = newId(),
    purchase = await createCreditCheckout(
      admin.workspace_id,
      admin.user_id,
      u.user_id,
      requestId,
      p.stripe
    )
  await createCreditCheckout(
    admin.workspace_id,
    admin.user_id,
    u.user_id,
    requestId,
    p.stripe
  )
  assert.equal(p.creates(), 1)
  assert.equal(
    (await reconcileCreditPurchase(purchase.purchaseId, p.stripe)).state,
    "pending"
  )
  assert.equal((await getCreditBalance(u)).purchased, 0)
  p.paid()
  await Promise.all([
    reconcileCreditPurchase(purchase.purchaseId, p.stripe),
    reconcileCreditPurchase(purchase.purchaseId, p.stripe),
  ])
  await processCreditPaymentEvent(
    {
      type: "checkout.session.async_payment_succeeded",
      data: { object: p.session() },
    } as unknown as Stripe.Event,
    p.stripe
  )
  assert.equal((await getCreditBalance(u)).purchased, 100)
  const foreign = await user("admin", "other-credits-workspace")
  await assert.rejects(
    createCreditCheckout(
      admin.workspace_id,
      admin.user_id,
      foreign.user_id,
      newId(),
      p.stripe
    ),
    { code: "membership_inactive" }
  )
})
test("refunds, disputes and restorations reconcile purchased-credit debt without duplicating grants", async () => {
  const admin = await user("admin"),
    u = await user(),
    p = paymentFixture()
  const purchase = await createCreditCheckout(
    admin.workspace_id,
    admin.user_id,
    u.user_id,
    newId(),
    p.stripe
  )
  p.paid()
  await reconcileCreditPurchase(purchase.purchaseId, p.stripe)
  await sql(
    "UPDATE mca_credit_accounts SET purchased_balance=10 WHERE user_id=?",
    u.user_id
  )
  p.refund(500)
  await reconcileCreditPurchase(purchase.purchaseId, p.stripe)
  assert.equal((await getCreditBalance(u)).debt, 40)
  await reconcileCreditPurchase(purchase.purchaseId, p.stripe)
  assert.equal((await getCreditBalance(u)).debt, 40)
  p.dispute("under_review")
  await reconcileCreditPurchase(purchase.purchaseId, p.stripe)
  assert.equal((await getCreditBalance(u)).debt, 90)
  p.dispute("won")
  await reconcileCreditPurchase(purchase.purchaseId, p.stripe)
  assert.equal((await getCreditBalance(u)).debt, 40)
  const topup = paymentFixture()
  const next = await createCreditCheckout(
    admin.workspace_id,
    admin.user_id,
    u.user_id,
    newId(),
    topup.stripe
  )
  topup.paid()
  await reconcileCreditPurchase(next.purchaseId, topup.stripe)
  assert.equal((await getCreditBalance(u)).purchased, 60)
})
test("failed/abandoned checkout grants nothing and payment tampering is rejected", async () => {
  const admin = await user("admin"),
    u = await user(),
    p = paymentFixture()
  const purchase = await createCreditCheckout(
    admin.workspace_id,
    admin.user_id,
    u.user_id,
    newId(),
    p.stripe
  )
  p.expire()
  assert.equal(
    (await reconcileCreditPurchase(purchase.purchaseId, p.stripe)).state,
    "expired"
  )
  assert.equal((await getCreditBalance(u)).purchased, 0)
  await processCreditPaymentEvent(
    {
      type: "checkout.session.async_payment_failed",
      data: { object: p.session() },
    } as unknown as Stripe.Event,
    p.stripe
  )
  assert.equal(
    (
      await getDatabase()
        .prepare<{ state: string }>(
          "SELECT state FROM mca_credit_purchases WHERE id=?"
        )
        .get(purchase.purchaseId)
    )?.state,
    "failed"
  )
  p.session().amount_total = 1
  p.paid()
  await assert.rejects(reconcileCreditPurchase(purchase.purchaseId, p.stripe), {
    code: "payment_mismatch",
  })
})
test("credit HTTP endpoints enforce session, role, origin and webhook signature", async () => {
  const admin = await user("admin"),
    rep = await user()
  assert.equal((await notificationsRoute(req(rep.user_id))).status, 403)
  assert.equal(
    (
      await checkoutRoute(
        req(rep.user_id, { recipientUserId: rep.user_id, requestId: newId() })
      )
    ).status,
    403
  )
  const bad = new Request("http://localhost/api/mca/assistant/credits/admin", {
    method: "PATCH",
    headers: {
      cookie: `mca_session=${admin.user_id}`,
      origin: "https://untrusted.example",
      "content-type": "application/json",
    },
    body: JSON.stringify({ mode: "fixed", threshold: 5 }),
  })
  assert.equal((await settingsRoute(bad)).status, 403)
  assert.equal(
    (
      await stripeWebhook(
        new Request("http://localhost/api/webhooks/stripe-credits", {
          method: "POST",
          headers: { "stripe-signature": "bad" },
          body: "{}",
        })
      )
    ).status,
    400
  )
  assert.equal((await notificationsRoute(req("missing"))).status, 401)
})

test("delayed notification work preserves every low/exhausted/recovery episode in order", async () => {
  const admin = await user("admin"),
    u = await user()
  const tasks = await Promise.all(Array.from({ length: 10 }, () => task(u)))
  for (const t of tasks) await settleCredit(t.run.id, "charge")
  const account = (await getDatabase()
    .prepare<{ id: string }>(
      "SELECT id FROM mca_credit_accounts WHERE user_id=?"
    )
    .get(u.user_id))!
  await sql(
    "UPDATE mca_credit_accounts SET purchased_balance=100 WHERE id=?",
    account.id
  )
  await recordCreditBalanceChange(getDatabase(), account.id)
  await sql(
    "UPDATE mca_credit_accounts SET purchased_balance=2 WHERE id=?",
    account.id
  )
  await recordCreditBalanceChange(getDatabase(), account.id)
  // Later threshold changes must not rewrite the already-committed balance event.
  await saveAlertSettings(u.workspace_id, { mode: "fixed", threshold: 1 })
  await Promise.all([
    processCreditAlerts(u.workspace_id),
    processCreditAlerts(u.workspace_id),
  ])
  const notices = (
    await listCreditNotifications(admin.workspace_id, admin.user_id)
  ).notifications.filter((n) => n.userId === u.user_id)
  assert.equal(notices.filter((n) => n.kind === "low").length, 2)
  assert.equal(notices.filter((n) => n.kind === "exhausted").length, 1)
  await processCreditAlerts(u.workspace_id)
  assert.equal(
    (
      await listCreditNotifications(admin.workspace_id, admin.user_id)
    ).notifications.filter((n) => n.userId === u.user_id).length,
    3
  )
  await saveAlertSettings(u.workspace_id, { mode: "percent", threshold: 20 })
})

test("workspace conversations retain selected deal context across paid requests", async () => {
  const u = await user("admin"),
    t = await task(u),
    context = ctx(t.c, t.run.id)
  const deal = await writeAssistantDeal(
    context,
    "create",
    fields({ legalName: "Synthetic retained context" })
  )
  await settleCredit(t.run.id, "charge")
  await finishRun(t.c, t.run.id, "completed")
  const next = await createRun(t.c, newId(), "Update the same deal")
  assert.equal(next.selected_deal_id, deal.id)
  await cancelConversation(t.c)
})

test("simplified model email schema still rejects invalid email before changing records", async () => {
  const u = await user("admin"),
    t = await task(u)
  await assert.rejects(
    writeAssistantDeal(ctx(t.c, t.run.id), "create", {
      ...fields({ legalName: "Email validation fixture" }),
      contactEmail: "invalid-email",
    })
  )
  const deals = await searchAssistantDeals(
    ctx(t.c, t.run.id),
    "Email validation fixture"
  )
  assert.equal(deals.total, 0)
  await cancelConversation(t.c)
})

test("credit purchases default off without hiding balances or creating Checkout", async () => {
  const admin = await user("admin")
  const prior = process.env.MCA_AI_CREDIT_PURCHASES_ENABLED
  process.env.STRIPE_SECRET_KEY = "sk_test_synthetic"
  process.env.STRIPE_WEBHOOK_SECRET = "whsec_synthetic"
  try {
    for (const flag of [undefined, "false", "TRUE", "garbage"]) {
      if (flag === undefined) delete process.env.MCA_AI_CREDIT_PURCHASES_ENABLED
      else process.env.MCA_AI_CREDIT_PURCHASES_ENABLED = flag
      assert.equal(purchasesAvailable(), false)
      const response = await checkoutRoute(req(admin.user_id, {
        recipientUserId: admin.user_id,
        requestId: newId(),
      }))
      assert.equal(response.status, 503)
      assert.equal((await response.json()).error.code, "purchases_disabled")
      await assert.rejects(
        createCreditCheckout(admin.workspace_id, admin.user_id, admin.user_id, newId()),
        { code: "purchases_disabled" },
      )
    }
    delete process.env.STRIPE_SECRET_KEY
    await assert.rejects(
      createCreditCheckout(admin.workspace_id, admin.user_id, admin.user_id, newId()),
      { code: "purchases_disabled" },
    )
    process.env.STRIPE_SECRET_KEY = "sk_test_synthetic"
    process.env.MCA_AI_CREDIT_PURCHASES_ENABLED = "true"
    assert.equal(purchasesAvailable(), true)
    delete process.env.STRIPE_WEBHOOK_SECRET
    assert.equal(purchasesAvailable(), false)
  } finally {
    if (prior === undefined) delete process.env.MCA_AI_CREDIT_PURCHASES_ENABLED
    else process.env.MCA_AI_CREDIT_PURCHASES_ENABLED = prior
    process.env.STRIPE_SECRET_KEY = "sk_test_synthetic"
    process.env.STRIPE_WEBHOOK_SECRET = "whsec_synthetic"
  }
})

test("turning purchases off still reconciles a previously paid session", async () => {
  const admin = await user("admin"), p = paymentFixture()
  const prior = process.env.MCA_AI_CREDIT_PURCHASES_ENABLED
  process.env.MCA_AI_CREDIT_PURCHASES_ENABLED = "true"
  process.env.STRIPE_SECRET_KEY = "sk_test_synthetic"
  process.env.STRIPE_WEBHOOK_SECRET = "whsec_synthetic"
  try {
    const purchase = await createCreditCheckout(
      admin.workspace_id, admin.user_id, admin.user_id, newId(), p.stripe,
    )
    assert.equal(p.creates(), 1)
    process.env.MCA_AI_CREDIT_PURCHASES_ENABLED = "false"
    p.paid()
    await processCreditPaymentEvent({
      type: "checkout.session.completed",
      data: { object: p.session() },
    } as unknown as Stripe.Event, p.stripe)
    assert.equal((await getCreditBalance(admin)).purchased, 100)
    assert.equal((await reconcileCreditPurchase(purchase.purchaseId, p.stripe)).state, "paid")
    assert.equal(p.creates(), 1)
    assert.equal((await stripeWebhook(new Request("http://localhost/api/webhooks/stripe-credits", {
      method: "POST", headers: { "stripe-signature": "invalid" }, body: "{}",
    }))).status, 400)
    const payload = JSON.stringify({ id: "evt_existing", type: "unhandled.synthetic", data: { object: {} } })
    const timestamp = Math.floor(Date.now() / 1000)
    const signature = createHmac("sha256", "whsec_synthetic")
      .update(`${timestamp}.${payload}`).digest("hex")
    assert.equal((await stripeWebhook(new Request("http://localhost/api/webhooks/stripe-credits", {
      method: "POST",
      headers: { "stripe-signature": `t=${timestamp},v1=${signature}` },
      body: payload,
    }))).status, 200)
  } finally {
    if (prior === undefined) delete process.env.MCA_AI_CREDIT_PURCHASES_ENABLED
    else process.env.MCA_AI_CREDIT_PURCHASES_ENABLED = prior
  }
})
