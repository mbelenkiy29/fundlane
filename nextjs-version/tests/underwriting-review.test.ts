import test, { after, before } from "node:test"
import assert from "node:assert/strict"
import { closeDatabaseForTests, getDatabase, newId } from "../src/lib/mca/db"
import { createPostgresTestDatabase } from "./helpers/postgres-test-db.mjs"
import { createDeal } from "../src/lib/mca/deals/service"
import type { DealActor } from "../src/lib/mca/deals/schema"
import { hashOpaqueToken } from "../src/lib/mca/crypto"
import type { EligibilityRule } from "../src/lib/mca/funders/contracts"
import { runAnalysis } from "../src/lib/mca/underwriting/analysis"
import {
  confirmAnalysisReview,
  getDealReview,
  getReviewByToken,
  getReviewSettings,
  sendAnalysisReview,
  updateReviewSettings,
} from "../src/lib/mca/underwriting/review-mail"
import { GET as getReviewSettingsRoute, POST as postReviewRoute } from "../src/app/api/mca/underwriting/review/route"
import { GET as getReviewTokenRoute, POST as postReviewTokenRoute } from "../src/app/api/mca/underwriting/review/[token]/route"
import { GET as getDealReviewRoute, POST as postDealReviewRoute } from "../src/app/api/mca/underwriting/review/deal/[dealId]/route"
import { POST as postReviewSettingsRoute } from "../src/app/api/mca/underwriting/review/settings/route"

let testDatabase: Awaited<ReturnType<typeof createPostgresTestDatabase>>

const actor = (workspaceId: string, role: DealActor["role"] = "admin"): DealActor => ({
  workspaceId,
  userId: `review-user-${workspaceId}-admin`,
  membershipId: null,
  role,
  managedMembershipIds: [],
  activeMembershipIds: [],
  source: "system",
  correlationId: `corr-${workspaceId}`,
})

function fitRules(): EligibilityRule[] {
  return [
    { id: "r-rev", funderId: "", field: "revenue", operator: "min", unit: "usd_annual", value: 120_000, unspecified: false },
    { id: "r-fico", funderId: "", field: "fico", operator: "min", unit: "fico", value: 600, unspecified: false },
    { id: "r-tib", funderId: "", field: "time_in_business", operator: "min", unit: "months", value: 12, unspecified: false },
    { id: "r-pos", funderId: "", field: "positions", operator: "max", unit: "count", value: 3, unspecified: false },
    { id: "r-amt", funderId: "", field: "requested_amount", operator: "max", unit: "usd", value: 250_000, unspecified: false },
    { id: "r-adb", funderId: "", field: "average_daily_balance", operator: "min", unit: "usd", value: 5_000, unspecified: false },
    { id: "r-nsf", funderId: "", field: "nsf", operator: "max", unit: "count", value: 4, unspecified: false },
    { id: "r-neg", funderId: "", field: "negative_days", operator: "max", unit: "days", value: 4, unspecified: false },
    { id: "r-def", funderId: "", field: "default_status", operator: "eq", unit: "boolean", value: false, unspecified: false },
    { id: "r-ent", funderId: "", field: "entity", operator: "in", unit: "entity", value: ["llc", "corp"], unspecified: false },
    { id: "r-st", funderId: "", field: "state", operator: "not_in", unit: "state", value: ["NV", "SD"], unspecified: false },
    { id: "r-ind", funderId: "", field: "industry", operator: "not_in", unit: "naics", value: ["713210"], unspecified: false },
  ]
}

function dqStateRules(): EligibilityRule[] {
  return [
    ...fitRules().filter((rule) => rule.field !== "state"),
    { id: "r-st-in", funderId: "", field: "state", operator: "in", unit: "state", value: ["CA", "TX"], unspecified: false },
  ]
}

async function exec(sql: string, ...values: unknown[]) {
  return getDatabase().prepare(sql).run(...values)
}

async function addWorkspace(id: string) {
  const now = new Date().toISOString()
  await exec(
    `INSERT INTO workspaces (id,name,timezone,seat_limit,feature_flags,page_visibility,action_visibility,created_at,updated_at)
     VALUES (?, ?, 'America/New_York', 5, ?, ?, ?, ?, ?)
     ON CONFLICT (id) DO NOTHING`,
    id, id,
    JSON.stringify({ reports: true, payments: true, integrations: true }),
    JSON.stringify({ dashboard: true, deals: true, users: true, reports: true, payments: true, workspace: true, integrations: true }),
    JSON.stringify({ createDeal: true, exportDeals: true, inviteUsers: true, manageApiKeys: true, viewPaymentTable: true, viewCompanyFinancials: true }),
    now, now,
  )
}

async function seedMember(workspaceId: string, role: "admin" | "manager" | "rep" | "super_admin", status: "active" | "deactivated" = "active") {
  const now = new Date().toISOString()
  const userId = `review-user-${workspaceId}-${role}-${status}`
  const membershipId = `review-mem-${workspaceId}-${role}-${status}`
  const email = `${userId}@example.test`
  await exec(
    `INSERT INTO users (id,email,password_hash,name,phone,application_identifier,created_at,updated_at)
     VALUES (?, ?, NULL, ?, NULL, ?, ?, ?)
     ON CONFLICT (email) DO NOTHING`,
    userId, email, `${role} ${status}`, `APP-${userId.slice(-24)}`, now, now,
  )
  await exec(
    `INSERT INTO memberships (id, workspace_id, user_id, role, manager_membership_id, status, sender_association, created_at, updated_at)
     VALUES (?, ?, ?, ?, NULL, ?, NULL, ?, ?)
     ON CONFLICT (id) DO NOTHING`,
    membershipId, workspaceId, userId, role, status, now, now,
  )
  return { userId, membershipId, email, role, status }
}

async function seedFunder(workspaceId: string, key: string, rules: EligibilityRule[]) {
  const now = new Date().toISOString()
  const id = newId()
  await exec(
    `INSERT INTO mca_funders (id, workspace_id, idempotency_key, legal_name, domains, products, active, contacts, routes, criteria_version, profile_version, created_at, updated_at)
     VALUES (?, ?, ?, ?, '[]', '[]', 1, '[]', '[]', 2, 1, ?, ?)`,
    id, workspaceId, key, `${key} Capital LLC`, now, now,
  )
  for (const [index, rule] of rules.entries()) {
    await exec(
      `INSERT INTO mca_funder_criteria (id, workspace_id, funder_id, field, operator, unit, value_json, source_text, unspecified, position, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      newId(), workspaceId, id, rule.field, rule.operator, rule.unit,
      rule.unspecified ? null : JSON.stringify(rule.value), rule.sourceText ?? null, rule.unspecified ? 1 : 0, index, now, now,
    )
  }
  return id
}

async function seedAggregate(workspaceId: string, dealId: string) {
  const metric = (value: number) => JSON.stringify({ value, unknown: false, confidence: 0.95, text: String(value) })
  await exec(
    `INSERT INTO mca_underwriting_aggregates
      (workspace_id, deal_id, version, monthly_revenue, average_daily_balance, nsf_count, negative_days, position_count, stale, source_fingerprint, computed_at)
     VALUES (?, ?, 1, ?, ?, ?, ?, 0, 0, 'fixture', '2026-09-08T00:00:00.000Z')
     ON CONFLICT (workspace_id, deal_id) DO UPDATE SET version = excluded.version, monthly_revenue = excluded.monthly_revenue, stale = excluded.stale`,
    workspaceId, dealId, metric(20_000), metric(8_000), metric(1), metric(0),
  )
}

async function seedReadyCompleteness(workspaceId: string, dealId: string, version = 1, ready = 1) {
  const now = new Date().toISOString()
  await exec(
    `INSERT INTO mca_completeness_results
      (id, workspace_id, deal_id, ready, version, rule_snapshot, findings_json, findings_fingerprint, checked_at)
     VALUES (?, ?, ?, ?, ?, '{"requiredStatementMonths":3}', '[]', ?, ?)`,
    newId(), workspaceId, dealId, ready, version, `ready-${version}-${ready}`, now,
  )
  await exec(
    `INSERT INTO mca_readiness_events
      (id, workspace_id, deal_id, completeness_version, ready, findings_fingerprint, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    newId(), workspaceId, dealId, version, ready, `ready-${version}-${ready}`, now,
  )
}

async function merchantDeal(workspaceId: string, key: string) {
  const created = await createDeal(actor(workspaceId), {
    idempotencyKey: key,
    legalName: `${key} Merchant LLC`,
    entityType: "llc",
    address: { line1: "1 Harbor St", city: "Brooklyn", state: "NY", postalCode: "11201" },
    startDate: "2020-01-01",
    industry: "restaurants",
    naicsCode: "722511",
    monthlyRevenue: 20_000,
    ficoScore: 680,
    requestedAmount: 50_000,
    fundingPurpose: "working capital",
  })
  await seedAggregate(workspaceId, created.deal.id)
  await seedReadyCompleteness(workspaceId, created.deal.id)
  return created.deal
}

async function reviewedDeal(workspaceId: string, key: string) {
  const deal = await merchantDeal(workspaceId, key)
  const fitId = await seedFunder(workspaceId, `${key}-fit`, fitRules())
  const dqId = await seedFunder(workspaceId, `${key}-dq`, dqStateRules())
  const analyzed = await runAnalysis(actor(workspaceId), deal.id, { mode: "review_first", topN: 5, reviewNotificationChannel: "both" })
  return { deal, fitId, dqId, run: analyzed.run, snapshot: analyzed.snapshot }
}

before(async () => {
  testDatabase = await createPostgresTestDatabase("underwriting_review")
  Object.assign(process.env, testDatabase.env())
})

after(async () => {
  await closeDatabaseForTests()
  await testDatabase.close()
})

test("MIC-150 recipients come from membership roles and CC, and send uses a 5-minute HMAC review link", async () => {
  const workspaceId = `ws-review-mail-${newId().slice(0, 8)}`
  await addWorkspace(workspaceId)
  const admin = await seedMember(workspaceId, "admin")
  const manager = await seedMember(workspaceId, "manager")
  const rep = await seedMember(workspaceId, "rep")
  const deactivated = await seedMember(workspaceId, "admin", "deactivated")
  const { deal, fitId, dqId } = await reviewedDeal(workspaceId, "mail")
  const ccEmail = `cc-${workspaceId}@example.test`

  const defaults = await getReviewSettings(actor(workspaceId))
  assert.deepEqual(defaults.recipientRoles.sort(), ["admin", "manager", "super_admin"])
  assert.deepEqual(defaults.ccEmails, [])

  const saved = await updateReviewSettings(actor(workspaceId), {
    recipientRoles: ["admin", "manager"],
    ccEmails: [ccEmail],
  })
  assert.deepEqual(saved.recipientRoles.sort(), ["admin", "manager"])
  assert.deepEqual(saved.ccEmails, [ccEmail])

  const captured: Array<{ recipient: string; template: string; actionUrl: string; expiresAt: string }> = []
  const originalFetch = globalThis.fetch
  const previousWebhook = process.env.MCA_EMAIL_WEBHOOK_URL
  process.env.MCA_EMAIL_WEBHOOK_URL = "https://mail.example.test/webhook"
  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    captured.push(JSON.parse(String(init?.body)) as (typeof captured)[number])
    return new Response("ok", { status: 200 })
  }) as typeof fetch
  try {
    const sent = await sendAnalysisReview(actor(workspaceId), deal.id, {
      origin: "https://mca.example.test",
      now: 1_000,
    })
    assert.equal(new Date(sent.expiresAt).getTime(), 301_000)
    assert.equal(sent.actionUrl.startsWith("https://mca.example.test/review/"), true)
    assert.equal(sent.token.includes("."), true)
    const emails = sent.recipients.map((row) => row.email).sort()
    assert.deepEqual(emails, [admin.email, ccEmail, manager.email].sort())
    assert.equal(emails.includes(rep.email), false)
    assert.equal(emails.includes(deactivated.email), false)
    assert.equal(captured.length, 3)
    assert.equal(captured.every((row) => row.template === "funder_analysis_review"), true)
    assert.equal(captured.every((row) => row.actionUrl === sent.actionUrl), true)
    assert.equal(sent.deliveries.every((row) => row.delivery === "sent"), true)
  } finally {
    globalThis.fetch = originalFetch
    if (previousWebhook === undefined) delete process.env.MCA_EMAIL_WEBHOOK_URL
    else process.env.MCA_EMAIL_WEBHOOK_URL = previousWebhook
  }

  const loaded = await getDealReview(actor(workspaceId), deal.id)
  assert.equal(loaded.run?.state, "review_pending")
  assert.equal(loaded.candidates.some((row) => row.funderId === fitId && row.eligible), true)
  assert.equal(loaded.candidates.some((row) => row.funderId === dqId && !row.eligible), true)
  assert.equal(loaded.disclaimer.includes("fit"), true)
})

test("MIC-150 expired or foreign-workspace token cannot submit", async () => {
  const workspaceId = `ws-review-exp-${newId().slice(0, 8)}`
  const otherId = `ws-review-other-${newId().slice(0, 8)}`
  await addWorkspace(workspaceId)
  await addWorkspace(otherId)
  await seedMember(workspaceId, "admin")
  await seedMember(otherId, "admin")
  const { deal, fitId } = await reviewedDeal(workspaceId, "exp")
  const sent = await sendAnalysisReview(actor(workspaceId), deal.id, { origin: "https://mca.example.test", now: 5_000 })
  const token = sent.token

  await assert.rejects(
    () => confirmAnalysisReview(actor(workspaceId), { token, selectedFunderIds: [fitId], now: 5_000 + 5 * 60_000 + 1 }),
    (error: { status?: number; code?: string }) => error.status === 404 && error.code === "review_link_invalid",
  )
  await assert.rejects(
    () => getReviewByToken(actor(workspaceId), token, 5_000 + 5 * 60_000 + 1),
    (error: { status?: number; code?: string }) => error.status === 404 && error.code === "review_link_invalid",
  )
  await assert.rejects(
    () => getReviewByToken(actor(otherId), token, 5_000),
    (error: { status?: number; code?: string }) => error.status === 404 && error.code === "review_link_invalid",
  )
  await assert.rejects(
    () => confirmAnalysisReview(actor(otherId), { token, selectedFunderIds: [fitId], now: 5_000 }),
    (error: { status?: number; code?: string }) => error.status === 404 && error.code === "review_link_invalid",
  )
  const tampered = `${token.slice(0, -2)}aa`
  await assert.rejects(
    () => confirmAnalysisReview(actor(workspaceId), { token: tampered, selectedFunderIds: [fitId], now: 5_000 }),
    (error: { status?: number; code?: string }) => error.status === 404 && error.code === "review_link_invalid",
  )

  const fresh = await getReviewByToken(actor(workspaceId), token, 5_000)
  assert.equal(fresh.dealId, deal.id)
  assert.equal(fresh.tokenValid, true)
})

test("MIC-150 confirm revalidates completeness ready and score freshness", async () => {
  const workspaceId = `ws-review-reval-${newId().slice(0, 8)}`
  await addWorkspace(workspaceId)
  await seedMember(workspaceId, "admin")
  const { deal, fitId } = await reviewedDeal(workspaceId, "reval")
  const sent = await sendAnalysisReview(actor(workspaceId), deal.id, { now: 10_000 })

  await exec(`UPDATE mca_completeness_results SET ready = 0 WHERE workspace_id = ? AND deal_id = ?`, workspaceId, deal.id)
  await assert.rejects(
    () => confirmAnalysisReview(actor(workspaceId), { token: sent.token, selectedFunderIds: [fitId], now: 10_000 }),
    (error: { status?: number; code?: string }) => error.status === 409 && error.code === "deal_not_ready",
  )
  await exec(`UPDATE mca_completeness_results SET ready = 1 WHERE workspace_id = ? AND deal_id = ?`, workspaceId, deal.id)

  await exec(`UPDATE mca_funders SET criteria_version = criteria_version + 1 WHERE workspace_id = ?`, workspaceId)
  await assert.rejects(
    () => confirmAnalysisReview(actor(workspaceId), { token: sent.token, selectedFunderIds: [fitId], now: 10_000 }),
    (error: { status?: number; code?: string }) => error.status === 409 && error.code === "scores_stale",
  )
})

test("MIC-150 approval binds to that snapshot only and retries keep identity", async () => {
  const workspaceId = `ws-review-bind-${newId().slice(0, 8)}`
  await addWorkspace(workspaceId)
  await seedMember(workspaceId, "admin")
  const first = await reviewedDeal(workspaceId, "bind")
  const sent = await sendAnalysisReview(actor(workspaceId), first.deal.id, { now: 20_000 })
  const approved = await confirmAnalysisReview(actor(workspaceId), {
    token: sent.token,
    selectedFunderIds: [first.fitId],
    now: 20_000,
  })
  assert.equal(approved.run.state, "approved")
  assert.equal(approved.run.snapshotId, first.run.snapshotId)
  assert.deepEqual(approved.approval.selectedFunderIds, [first.fitId])

  const retried = await confirmAnalysisReview(actor(workspaceId), {
    token: sent.token,
    selectedFunderIds: [first.fitId],
    now: 20_000,
  })
  assert.equal(retried.approval.id, approved.approval.id)
  assert.equal(retried.run.id, approved.run.id)

  await seedReadyCompleteness(workspaceId, first.deal.id, 2)
  const later = await runAnalysis(actor(workspaceId), first.deal.id, { mode: "review_first", topN: 5, reviewNotificationChannel: "both" })
  assert.notEqual(later.run.id, first.run.id)
  assert.notEqual(later.run.snapshotId, first.run.snapshotId)
  assert.equal(later.run.state, "review_pending")

  const original = await getDealReview(actor(workspaceId), first.deal.id)
  assert.equal(original.run?.id, later.run.id)
  const bound = await getReviewByToken(actor(workspaceId), sent.token, 20_000)
  assert.equal(bound.run?.id, first.run.id)
  assert.equal(bound.approval?.id, approved.approval.id)
  assert.deepEqual(bound.approval?.selectedFunderIds, [first.fitId])
  assert.equal(bound.run?.snapshotId, first.run.snapshotId)

  const laterConfirm = await confirmAnalysisReview(actor(workspaceId), {
    dealId: first.deal.id,
    selectedFunderIds: [first.fitId],
  })
  assert.equal(laterConfirm.run.id, later.run.id)
  assert.notEqual(laterConfirm.approval.id, approved.approval.id)
  const stillBound = await getReviewByToken(actor(workspaceId), sent.token, 20_000)
  assert.equal(stillBound.approval?.id, approved.approval.id)
  assert.deepEqual(stillBound.approval?.selectedFunderIds, [first.fitId])
})

test("MIC-150 disqualified funders cannot be confirmed and empty selection is rejected", async () => {
  const workspaceId = `ws-review-dq-${newId().slice(0, 8)}`
  await addWorkspace(workspaceId)
  await seedMember(workspaceId, "admin")
  const { deal, fitId, dqId } = await reviewedDeal(workspaceId, "dq")
  await assert.rejects(
    () => confirmAnalysisReview(actor(workspaceId), { dealId: deal.id, selectedFunderIds: [] }),
    (error: { status?: number; code?: string; fieldErrors?: Record<string, string[]> }) =>
      error.status === 422 && error.code === "validation_failed" && Boolean(error.fieldErrors?.selectedFunderIds?.[0]),
  )
  await assert.rejects(
    () => confirmAnalysisReview(actor(workspaceId), { dealId: deal.id, selectedFunderIds: [dqId] }),
    (error: { status?: number; code?: string; fieldErrors?: Record<string, string[]> }) =>
      error.status === 422 && error.code === "validation_failed" && Boolean(error.fieldErrors?.selectedFunderIds?.[0]),
  )
  const ok = await confirmAnalysisReview(actor(workspaceId), { dealId: deal.id, selectedFunderIds: [fitId] })
  assert.equal(ok.run.state, "approved")
  assert.deepEqual(ok.approval.selectedFunderIds, [fitId])
})

test("MIC-150 deals:read loads, deals:write confirms, intake:write is 403, foreign workspace is 404", async () => {
  const workspaceId = `ws-review-http-${newId().slice(0, 8)}`
  const otherId = `ws-review-http-other-${newId().slice(0, 8)}`
  await addWorkspace(workspaceId)
  await addWorkspace(otherId)
  await seedMember(workspaceId, "admin")
  const { deal, fitId } = await reviewedDeal(workspaceId, "http")
  const now = new Date().toISOString()
  const creatorId = `review-user-${workspaceId}-admin-active`
  const addKey = async (id: string, secret: string, scopes: string[], ws = workspaceId) => {
    await exec(
      `INSERT INTO api_keys (id,workspace_id,name,prefix,secret_hash,scopes,expires_at,last_used_at,revoked_at,rate_limit_per_minute,created_by,created_at)
       VALUES (?, ?, ?, 'mca_test', ?, ?, NULL, NULL, NULL, 60, ?, ?)`,
      id, ws, id, hashOpaqueToken(`mca_${secret}`), JSON.stringify(scopes), creatorId, now,
    )
  }
  const readSecret = `review-read-${workspaceId}`
  const writeSecret = `review-write-${workspaceId}`
  const intakeSecret = `review-intake-${workspaceId}`
  const otherSecret = `review-other-${otherId}`
  await addKey(`review-read-${workspaceId}`, readSecret, ["deals:read"])
  await addKey(`review-write-${workspaceId}`, writeSecret, ["deals:write"])
  await addKey(`review-intake-${workspaceId}`, intakeSecret, ["intake:write"])
  await addKey(`review-other-${otherId}`, otherSecret, ["deals:read", "deals:write"], otherId)

  const sent = await sendAnalysisReview(actor(workspaceId), deal.id)
  const tokenParams = { params: Promise.resolve({ token: sent.token }) }
  const dealParams = { params: Promise.resolve({ dealId: deal.id }) }
  const request = (secret: string, url: string, method = "GET", body?: string) => new Request(url, {
    method,
    headers: { authorization: `Bearer mca_${secret}` },
    ...(body ? { body } : {}),
  })

  assert.equal((await getDealReviewRoute(request(intakeSecret, `http://localhost/api/mca/underwriting/review/deal/${deal.id}`), dealParams)).status, 403)
  assert.equal((await postDealReviewRoute(request(intakeSecret, `http://localhost/api/mca/underwriting/review/deal/${deal.id}`, "POST", JSON.stringify({ selectedFunderIds: [fitId] })), dealParams)).status, 403)
  assert.equal((await getReviewTokenRoute(request(intakeSecret, `http://localhost/api/mca/underwriting/review/${sent.token}`), tokenParams)).status, 403)
  assert.equal((await postReviewTokenRoute(request(readSecret, `http://localhost/api/mca/underwriting/review/${sent.token}`, "POST", JSON.stringify({ selectedFunderIds: [fitId] })), tokenParams)).status, 403)
  assert.equal((await postReviewRoute(request(readSecret, "http://localhost/api/mca/underwriting/review", "POST", JSON.stringify({ dealId: deal.id })))).status, 403)
  assert.equal((await postReviewSettingsRoute(request(writeSecret, "http://localhost/api/mca/underwriting/review/settings", "POST", JSON.stringify({ recipientRoles: ["admin"] })))).status, 403)

  const emptySettings = await getReviewSettingsRoute(request(readSecret, "http://localhost/api/mca/underwriting/review"))
  assert.equal(emptySettings.status, 200)

  const viewed = await getDealReviewRoute(request(readSecret, `http://localhost/api/mca/underwriting/review/deal/${deal.id}`), dealParams)
  assert.equal(viewed.status, 200)
  const viewedBody = await viewed.json() as { run: { state: string } | null }
  assert.equal(viewedBody.run?.state, "review_pending")

  const tokenView = await getReviewTokenRoute(request(readSecret, `http://localhost/api/mca/underwriting/review/${encodeURIComponent(sent.token)}`), tokenParams)
  assert.equal(tokenView.status, 200)

  const confirmed = await postReviewTokenRoute(request(writeSecret, `http://localhost/api/mca/underwriting/review/${encodeURIComponent(sent.token)}`, "POST", JSON.stringify({ selectedFunderIds: [fitId] })), tokenParams)
  assert.equal(confirmed.status, 200)
  const confirmedBody = await confirmed.json() as { run: { state: string; snapshotId: string }; approval: { id: string } }
  assert.equal(confirmedBody.run.state, "approved")
  assert.equal(confirmedBody.run.snapshotId, sent.snapshotId)

  const foreign = await postReviewTokenRoute(request(otherSecret, `http://localhost/api/mca/underwriting/review/${encodeURIComponent(sent.token)}`, "POST", JSON.stringify({ selectedFunderIds: [fitId] })), tokenParams)
  assert.equal(foreign.status, 404)
  const foreignDeal = await getDealReviewRoute(request(otherSecret, `http://localhost/api/mca/underwriting/review/deal/${deal.id}`), dealParams)
  assert.equal(foreignDeal.status, 404)
})
