import test, { after, before } from "node:test"
import assert from "node:assert/strict"
import { closeDatabaseForTests, getDatabase, newId } from "../src/lib/mca/db"
import { createPostgresTestDatabase } from "./helpers/postgres-test-db.mjs"
import { createDeal } from "../src/lib/mca/deals/service"
import type { DealActor } from "../src/lib/mca/deals/schema"
import { hashOpaqueToken } from "../src/lib/mca/crypto"
import type { EligibilityRule } from "../src/lib/mca/funders/contracts"
import {
  analysisQueueCallsForTests,
  getAnalysisSettings,
  getDealAnalysis,
  requireAnalysisActor,
  resetAnalysisQueueCallsForTests,
  runAnalysis,
  runAnalysisIfReady,
  updateAnalysisSettings,
} from "../src/lib/mca/underwriting/analysis"
import { GET as getSettings, POST as postSettings } from "../src/app/api/mca/underwriting/analysis/route"
import { GET as getDealAnalysisRoute, POST as postDealAnalysisRoute } from "../src/app/api/mca/underwriting/analysis/[dealId]/route"

let testDatabase: Awaited<ReturnType<typeof createPostgresTestDatabase>>

const actor = (workspaceId: string, role: DealActor["role"] = "admin"): DealActor => ({
  workspaceId,
  userId: "user-analysis",
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

async function seedReadyCompleteness(workspaceId: string, dealId: string, version = 1) {
  const now = new Date().toISOString()
  await exec(
    `INSERT INTO mca_completeness_results
      (id, workspace_id, deal_id, ready, version, rule_snapshot, findings_json, findings_fingerprint, checked_at)
     VALUES (?, ?, ?, 1, ?, '{"requiredStatementMonths":3}', '[]', ?, ?)`,
    newId(), workspaceId, dealId, version, `ready-${version}`, now,
  )
  await exec(
    `INSERT INTO mca_readiness_events
      (id, workspace_id, deal_id, completeness_version, ready, findings_fingerprint, created_at)
     VALUES (?, ?, ?, ?, 1, ?, ?)`,
    newId(), workspaceId, dealId, version, `ready-${version}`, now,
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

function dqStateRules(): EligibilityRule[] {
  return [
    ...fitRules().filter((rule) => rule.field !== "state"),
    { id: "r-st-in", funderId: "", field: "state", operator: "in", unit: "state", value: ["CA", "TX"], unspecified: false },
  ]
}

before(async () => {
  testDatabase = await createPostgresTestDatabase("underwriting_analysis")
  Object.assign(process.env, testDatabase.env())
})

after(async () => {
  await closeDatabaseForTests()
  await testDatabase.close()
})

test("MIC-148 default is review_first and analyze_only never sends or changes selection", async () => {
  const workspaceId = `ws-analysis-only-${newId().slice(0, 8)}`
  await addWorkspace(workspaceId)
  resetAnalysisQueueCallsForTests()
  const settings = await getAnalysisSettings(actor(workspaceId))
  assert.equal(settings.mode, "review_first")
  assert.equal(settings.topN, 5)
  assert.equal(settings.reviewNotificationChannel, "both")
  assert.equal(settings.automaticSendEnabled, false)

  const deal = await merchantDeal(workspaceId, "analyze-only")
  const fitId = await seedFunder(workspaceId, "ao-fit", fitRules())
  await seedFunder(workspaceId, "ao-dq", dqStateRules())

  const reviewed = await runAnalysis(actor(workspaceId), deal.id)
  assert.equal(reviewed.run.mode, "review_first")
  assert.equal(reviewed.run.state, "review_pending")
  assert.deepEqual(reviewed.run.selectedFunderIds, [fitId])
  assert.equal(analysisQueueCallsForTests().length, 0)

  const analyzed = await runAnalysis(actor(workspaceId), deal.id, { mode: "analyze_only" })
  assert.equal(analyzed.run.mode, "analyze_only")
  assert.equal(analyzed.run.state, "scored")
  assert.deepEqual(analyzed.run.selectedFunderIds, [])
  assert.equal(analysisQueueCallsForTests().length, 0)
  assert.equal(analyzed.destinations.some((row) => row.funderId === fitId && row.outcome === "excluded"), true)
  assert.equal(analyzed.destinations.some((row) => row.outcome === "blocked" && row.reason.toLowerCase().includes("state")), true)
  assert.equal((await getAnalysisSettings(actor(workspaceId))).mode, "review_first")
})

test("MIC-148 review_first records destinations, skips DQ, and email_only does not pre-select", async () => {
  const workspaceId = `ws-analysis-review-${newId().slice(0, 8)}`
  await addWorkspace(workspaceId)
  resetAnalysisQueueCallsForTests()
  const deal = await merchantDeal(workspaceId, "review")
  const first = await seedFunder(workspaceId, "rv-a", fitRules())
  const second = await seedFunder(workspaceId, "rv-b", fitRules())
  const dq = await seedFunder(workspaceId, "rv-dq", dqStateRules())

  const both = await runAnalysis(actor(workspaceId), deal.id, { mode: "review_first", topN: 1, reviewNotificationChannel: "both" })
  assert.equal(both.run.state, "review_pending")
  assert.equal(both.run.selectedFunderIds.length, 1)
  assert.equal(both.run.selectedFunderIds.includes(dq), false)
  assert.equal(both.destinations.find((row) => row.funderId === dq)?.outcome, "blocked")
  const selected = both.destinations.filter((row) => row.outcome === "selected")
  const excludedFit = both.destinations.filter((row) => row.outcome === "excluded")
  assert.equal(selected.length, 1)
  assert.equal(excludedFit.some((row) => row.funderId === first || row.funderId === second), true)
  assert.equal(analysisQueueCallsForTests().length, 0)

  const emailed = await runAnalysis(actor(workspaceId), deal.id, { mode: "review_first", topN: 2, reviewNotificationChannel: "email_only" })
  assert.equal(emailed.run.state, "review_pending")
  assert.deepEqual(emailed.run.selectedFunderIds, [])
  assert.equal(emailed.destinations.filter((row) => row.outcome === "selected").length, 2)
})

test("MIC-148 automatic_send requires admin enablement, snapshots settings, and queues independent jobs", async () => {
  const workspaceId = `ws-analysis-send-${newId().slice(0, 8)}`
  await addWorkspace(workspaceId)
  resetAnalysisQueueCallsForTests()
  const deal = await merchantDeal(workspaceId, "autosend")
  const fitId = await seedFunder(workspaceId, "as-fit", fitRules())

  await assert.rejects(
    () => updateAnalysisSettings(actor(workspaceId), { mode: "automatic_send" }),
    (error: { code?: string; status?: number }) => error.code === "automatic_send_disabled" && error.status === 409,
  )
  await assert.rejects(
    () => updateAnalysisSettings({ ...actor(workspaceId), role: "rep", source: "user" }, { automaticSendEnabled: true }),
    (error: { code?: string; status?: number }) => error.code === "permission_denied" && error.status === 403,
  )

  const blocked = await runAnalysis(actor(workspaceId), deal.id, { mode: "automatic_send" })
  assert.equal(blocked.run.state, "blocked")
  assert.equal(blocked.run.reason, "automatic_send_disabled")
  assert.equal(blocked.run.settingsSnapshot.automaticSendEnabled, false)
  assert.equal(analysisQueueCallsForTests().length, 0)

  const enabled = await updateAnalysisSettings(actor(workspaceId), { automaticSendEnabled: true, mode: "automatic_send", topN: 3 })
  assert.equal(enabled.automaticSendEnabled, true)
  assert.equal(enabled.mode, "automatic_send")

  const sent = await runAnalysis(actor(workspaceId), deal.id)
  assert.equal(sent.run.mode, "automatic_send")
  assert.equal(sent.run.state, "queued")
  assert.equal(sent.run.reason, "queued")
  assert.deepEqual(sent.run.selectedFunderIds, [fitId])
  assert.equal(sent.run.settingsSnapshot.mode, "automatic_send")
  assert.equal(sent.run.settingsSnapshot.topN, 3)
  assert.equal(sent.run.settingsSnapshot.automaticSendEnabled, true)
  assert.equal(analysisQueueCallsForTests().length, 1)
  assert.deepEqual(analysisQueueCallsForTests()[0]?.funderIds, [fitId])
  assert.equal(analysisQueueCallsForTests()[0]?.analysisRunId, sent.run.id)
  assert.equal(analysisQueueCallsForTests()[0]?.dealId, deal.id)
})

test("MIC-148 run override leaves workspace defaults and retries keep identity without duplicate sends", async () => {
  const workspaceId = `ws-analysis-override-${newId().slice(0, 8)}`
  await addWorkspace(workspaceId)
  resetAnalysisQueueCallsForTests()
  await updateAnalysisSettings(actor(workspaceId), { automaticSendEnabled: true, mode: "automatic_send", topN: 4 })
  const deal = await merchantDeal(workspaceId, "override")
  await seedFunder(workspaceId, "ov-fit", fitRules())

  const overridden = await runAnalysis(actor(workspaceId), deal.id, { mode: "review_first", topN: 1, reviewNotificationChannel: "select_only" })
  assert.equal(overridden.run.mode, "review_first")
  assert.equal(overridden.run.topN, 1)
  const defaults = await getAnalysisSettings(actor(workspaceId))
  assert.equal(defaults.mode, "automatic_send")
  assert.equal(defaults.topN, 4)
  assert.equal(defaults.reviewNotificationChannel, "both")

  const retryOverride = await runAnalysis(actor(workspaceId), deal.id, { mode: "review_first", topN: 1, reviewNotificationChannel: "select_only" })
  assert.equal(retryOverride.run.id, overridden.run.id)

  const firstSend = await runAnalysis(actor(workspaceId), deal.id)
  assert.equal(firstSend.run.mode, "automatic_send")
  assert.equal(firstSend.run.state, "queued")
  assert.equal(analysisQueueCallsForTests().length, 1)
  const secondSend = await runAnalysis(actor(workspaceId), deal.id)
  assert.equal(secondSend.run.id, firstSend.run.id)
  assert.equal(analysisQueueCallsForTests().length, 1)
})

test("MIC-148 no-qualified-funder is first-class and readiness trigger fires once per completeness version", async () => {
  const workspaceId = `ws-analysis-ready-${newId().slice(0, 8)}`
  await addWorkspace(workspaceId)
  resetAnalysisQueueCallsForTests()
  const emptyDeal = await merchantDeal(workspaceId, "no-fit")
  await seedFunder(workspaceId, "nf-dq", dqStateRules())
  const none = await runAnalysis(actor(workspaceId), emptyDeal.id, { mode: "review_first" })
  assert.equal(none.run.state, "blocked")
  assert.equal(none.run.reason, "no_qualified_funder")
  assert.deepEqual(none.run.selectedFunderIds, [])
  assert.equal(none.destinations.every((row) => row.outcome === "blocked"), true)

  const readyDeal = await merchantDeal(workspaceId, "ready-run")
  await seedFunder(workspaceId, "rd-fit", fitRules())
  const skipped = await runAnalysisIfReady(actor(workspaceId), emptyDeal.id)
  assert.equal(skipped.ran, false)

  const first = await runAnalysisIfReady(actor(workspaceId), readyDeal.id)
  assert.equal(first.ran, true)
  assert.equal(first.run?.state, "review_pending")
  assert.equal(first.run?.trigger, "readiness")
  const second = await runAnalysisIfReady(actor(workspaceId), readyDeal.id)
  assert.equal(second.ran, false)
  assert.equal(second.run?.id, first.run?.id)
  assert.equal(analysisQueueCallsForTests().length, 0)
})

test("MIC-148 deals:read lists, deals:write runs, intake:write is 403, foreign workspace is 404", async () => {
  const workspaceId = `ws-analysis-http-${newId().slice(0, 8)}`
  const otherId = `ws-analysis-other-${newId().slice(0, 8)}`
  await addWorkspace(workspaceId)
  await addWorkspace(otherId)
  const deal = await merchantDeal(workspaceId, "http-analysis")
  await seedFunder(workspaceId, "http-fit", fitRules())
  const now = new Date().toISOString()
  const creatorId = `analysis-user-${workspaceId}`
  try {
    await exec(
      `INSERT INTO users (id,email,password_hash,name,phone,application_identifier,created_at,updated_at)
       VALUES (?, ?, NULL, 'Analysis Fixture', NULL, ?, ?, ?)`,
      creatorId, `${creatorId}@example.test`, `APP-${creatorId.slice(-8)}`, now, now,
    )
  } catch { /* users table or unique email may already exist */ }
  const addKey = async (id: string, secret: string, scopes: string[], ws = workspaceId) => {
    await exec(
      `INSERT INTO api_keys (id,workspace_id,name,prefix,secret_hash,scopes,expires_at,last_used_at,revoked_at,rate_limit_per_minute,created_by,created_at)
       VALUES (?, ?, ?, 'mca_test', ?, ?, NULL, NULL, NULL, 60, ?, ?)`,
      id, ws, id, hashOpaqueToken(`mca_${secret}`), JSON.stringify(scopes), creatorId, now,
    )
  }
  const readSecret = `analysis-read-${workspaceId}`
  const writeSecret = `analysis-write-${workspaceId}`
  const intakeSecret = `analysis-intake-${workspaceId}`
  const otherSecret = `analysis-other-${otherId}`
  await addKey(`analysis-read-${workspaceId}`, readSecret, ["deals:read"])
  await addKey(`analysis-write-${workspaceId}`, writeSecret, ["deals:write"])
  await addKey(`analysis-intake-${workspaceId}`, intakeSecret, ["intake:write"])
  await addKey(`analysis-other-${otherId}`, otherSecret, ["deals:write"], otherId)

  const params = { params: Promise.resolve({ dealId: deal.id }) }
  const request = (secret: string, method = "GET", body?: string) => new Request(`http://localhost/api/mca/underwriting/analysis/${deal.id}`, {
    method,
    headers: { authorization: `Bearer mca_${secret}` },
    ...(body ? { body } : {}),
  })

  await assert.rejects(() => requireAnalysisActor(request(intakeSecret), "read"), (error: { code?: string }) => error.code === "scope_required")
  assert.equal((await getDealAnalysisRoute(request(intakeSecret), params)).status, 403)
  assert.equal((await postDealAnalysisRoute(request(intakeSecret, "POST", "{}"), params)).status, 403)
  assert.equal((await postDealAnalysisRoute(request(readSecret, "POST", "{}"), params)).status, 403)
  assert.equal((await postSettings(new Request("http://localhost/api/mca/underwriting/analysis", {
    method: "POST",
    headers: { authorization: `Bearer mca_${writeSecret}` },
    body: JSON.stringify({ mode: "analyze_only" }),
  }))).status, 403)

  const empty = await getDealAnalysisRoute(request(readSecret), params)
  assert.equal(empty.status, 200)
  const emptyBody = await empty.json() as { run: null; settings: { mode: string } }
  assert.equal(emptyBody.run, null)
  assert.equal(emptyBody.settings.mode, "review_first")

  const listedSettings = await getSettings(new Request("http://localhost/api/mca/underwriting/analysis", { headers: { authorization: `Bearer mca_${readSecret}` } }))
  assert.equal(listedSettings.status, 200)

  const posted = await postDealAnalysisRoute(request(writeSecret, "POST", JSON.stringify({ mode: "analyze_only" })), params)
  assert.equal(posted.status, 200)
  const postedBody = await posted.json() as { run: { id: string; mode: string; state: string; selectedFunderIds: string[] } }
  assert.equal(postedBody.run.mode, "analyze_only")
  assert.equal(postedBody.run.state, "scored")
  assert.deepEqual(postedBody.run.selectedFunderIds, [])

  const loaded = await getDealAnalysis(actor(workspaceId), deal.id)
  assert.equal(loaded.run?.id, postedBody.run.id)

  const other = await postDealAnalysisRoute(request(otherSecret, "POST", "{}"), params)
  assert.equal(other.status, 404)
  await assert.rejects(
    () => getDealAnalysis(actor(otherId), deal.id),
    (error: { status?: number; code?: string }) => error.status === 404 && error.code === "deal_not_found",
  )
})
