import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { closeDatabaseForTests, getDatabase } from "../src/lib/mca/db"
import { createDeal } from "../src/lib/mca/deals/service"
import { retryDocumentScan, storeDocument } from "../src/lib/mca/documents/service"
import { setDocumentScannerForTests } from "../src/lib/mca/documents/scanner"
import { setDocumentStorageForTests } from "../src/lib/mca/documents/storage"
import { documentProposals, processDealAgentJob, upsertProposals } from "../src/lib/mca/deal-agent/run"
import { decideDealAgentAction, listDealAgent } from "../src/lib/mca/deal-agent/actions"
import type { DealActor } from "../src/lib/mca/deals/schema"
import { setClosingTransportForTests } from "../src/lib/mca/closing/delivery"
import { encryptSensitive } from "../src/lib/mca/crypto"
import { setSenderDeliveryFetchForTests } from "../src/lib/mca/senders/delivery"
import { setEmailDeliveryFetchForTests } from "../src/lib/mca/submissions/email-templates"
import { documentScanActor } from "../src/lib/mca/documents/scan-job"
import { AppError } from "../src/lib/mca/errors"
import type { BackgroundJob } from "../src/lib/mca/jobs/queue"
import { setStatementExtractionProviderForTests } from "../src/lib/mca/underwriting/statement-extraction"
import { runNextBackgroundJob } from "../src/lib/mca/jobs/worker"
import { createFunder } from "../src/lib/mca/funders/directory"
import { publishFunderCriteria } from "../src/lib/mca/funders/criteria"
import { closedLookbackMonths } from "../src/lib/mca/underwriting/lookback"
import { getWorkspaceSettings } from "../src/lib/mca/workspaces"
import { createPostgresTestDatabase } from "./helpers/postgres-test-db.mjs"

let database: Awaited<ReturnType<typeof createPostgresTestDatabase>>
const previousEnv = { ...process.env }
const memory = new Map<string, Uint8Array>()

before(async () => {
  database = await createPostgresTestDatabase("deal_agent")
  process.env.DATABASE_URL = database.databaseUrl
  delete process.env.MCA_BACKGROUND_JOBS
  delete process.env.VERCEL
  delete process.env.MCA_DEAL_AGENT_ENABLED
  setDocumentStorageForTests({ name: "memory", async putImmutable(key, bytes) { memory.set(key, new Uint8Array(bytes)) }, async get(key) { const bytes = memory.get(key); if (!bytes) throw Error("missing"); return bytes } })
  setDocumentScannerForTests({ name: "clean", async scan() { return { status: "clean", provider: "clean", evidence: { engineVerified: true } } } })
})

after(async () => {
  setDocumentStorageForTests()
  setDocumentScannerForTests()
  await closeDatabaseForTests()
  await database.close()
  for (const key of Object.keys(process.env)) if (!(key in previousEnv)) delete process.env[key]
  Object.assign(process.env, previousEnv)
})

async function withAgentEnv<T>(value: string | undefined, callback: () => Promise<T>): Promise<T> {
  const previous = process.env.MCA_DEAL_AGENT_ENABLED
  if (value === undefined) delete process.env.MCA_DEAL_AGENT_ENABLED
  else process.env.MCA_DEAL_AGENT_ENABLED = value
  try { return await callback() } finally {
    if (previous === undefined) delete process.env.MCA_DEAL_AGENT_ENABLED
    else process.env.MCA_DEAL_AGENT_ENABLED = previous
  }
}

function pdf(label: string): Uint8Array {
  return new Uint8Array(Buffer.from(`%PDF-1.4\n% ${label}\n1 0 obj<</Type/Catalog>>endobj\n%%EOF\n`))
}

async function upload(workspaceId: string, dealId: string, category: string, label = `${category}-${++seq}`, extra: Record<string, unknown> = {}) {
  return storeDocument(adminActor(workspaceId), { dealId, idempotencyKey: `upload-${label}-${++seq}`, filename: `${label}.pdf`, mimeType: "application/pdf", bytes: pdf(label), category, source: "test", ...extra } as Parameters<typeof storeDocument>[1])
}

async function agentJobs(dealId: string) {
  return getDatabase().prepare<{ id: string; resource_id: string; available_at: string; created_at: string; state: string }>("SELECT id,resource_id,available_at,created_at,state FROM mca_background_jobs WHERE kind='deal_agent' AND resource_id=? ORDER BY created_at").all(dealId)
}

let seq = 0
async function seedWorkspace(featureFlags: Record<string, boolean> = {}): Promise<string> {
  const id = `da-ws-${++seq}`
  const now = new Date().toISOString()
  await getDatabase().prepare(`INSERT INTO workspaces (id,name,timezone,seat_limit,feature_flags,page_visibility,action_visibility,created_at,updated_at)
    VALUES (?,?,'America/New_York',5,?,'{}','{"createDeal":true}',?,?)`).run(id, `Deal agent ${seq}`, JSON.stringify(featureFlags), now, now)
  return id
}

function adminActor(workspaceId: string) {
  return { workspaceId, userId: null, membershipId: null, role: "admin", managedMembershipIds: [], activeMembershipIds: [], source: "system", correlationId: "deal-agent-test" } as const
}

async function seedBareDeal(workspaceId: string): Promise<string> {
  const key = `da-deal-${++seq}`
  return (await createDeal(adminActor(workspaceId), { idempotencyKey: key, legalName: "Agent Merchant LLC", entityType: "llc", address: { line1: "1 Main St", city: "New York", state: "NY", postalCode: "10001" }, startDate: "2020-01-01", industry: "restaurants", naicsCode: "722511", monthlyRevenue: 20_000, ficoScore: 680, requestedAmount: 50_000, requestedTermMonths: 12, fundingPurpose: "working capital", contactPhone: "2125550100", contactName: "Mira", contactEmail: "merchant@example.test", owners: [{ firstName: "Ada", lastName: "Cole", ownershipPercent: 100, isPrimary: true }] })).deal.id
}

test("migration creates deal agent tables with open-action uniqueness", async () => {
  const workspaceId = await seedWorkspace()
  const dealId = await seedBareDeal(workspaceId)
  const now = new Date().toISOString()
  await getDatabase().prepare(`INSERT INTO mca_deal_agent_runs (id,workspace_id,deal_id,input_key,state,created_at,updated_at)
    VALUES ('run-1',?,?,'key','completed',?,?)`).run(workspaceId, dealId, now, now)
  const insert = (id: string, status: string, fingerprint: string) => getDatabase().prepare(`INSERT INTO mca_deal_agent_actions
    (id,workspace_id,deal_id,run_id,kind,target_key,fingerprint,payload_json,status,created_at,updated_at)
    VALUES (?,?,?,'run-1','request_documents','request_documents',?,'{}',?,?,?)`).run(id, workspaceId, dealId, fingerprint, status, now, now)
  await insert("a-dismissed", "dismissed", "c1")
  await insert("a-pending", "pending", "c2")
  await assert.rejects(insert("a-pending-2", "pending", "c3"), { code: "23505" })
})

test("legacy workspace feature flags default dealAgent to false", async () => {
  const workspaceId = await seedWorkspace()
  const settings = await getWorkspaceSettings(workspaceId)
  assert.equal(settings.featureFlags.dealAgent, false)
})

test("flag off: clean upload enqueues no deal_agent job", async () => {
  const workspaceId = await seedWorkspace({ dealAgent: true })
  const dealId = await seedBareDeal(workspaceId)
  await withAgentEnv(undefined, () => upload(workspaceId, dealId, "application"))
  assert.equal((await agentJobs(dealId)).length, 0)
})

test("workspace flag off: no job even with env on", async () => {
  const workspaceId = await seedWorkspace()
  const dealId = await seedBareDeal(workspaceId)
  await withAgentEnv("true", () => upload(workspaceId, dealId, "application"))
  assert.equal((await agentJobs(dealId)).length, 0)
})

test("enabled: clean upload enqueues one deal_agent job, available ~120s later", async () => {
  const workspaceId = await seedWorkspace({ dealAgent: true })
  const dealId = await seedBareDeal(workspaceId)
  const document = await withAgentEnv("true", () => upload(workspaceId, dealId, "application"))
  const jobs = await agentJobs(dealId)
  assert.equal(jobs.length, 1)
  assert.equal(jobs[0].resource_id, dealId)
  assert.ok(Date.parse(jobs[0].available_at) - Date.parse(jobs[0].created_at) >= 110_000)
  await withAgentEnv("true", () => retryDocumentScan(adminActor(workspaceId), document.id))
  assert.equal((await agentJobs(dealId)).length, 1)
})

async function runAgent(dealId: string): Promise<Array<Record<string, unknown>>> {
  await getDatabase().prepare("UPDATE mca_background_jobs SET available_at=? WHERE kind='deal_agent' AND resource_id=? AND state='queued'").run("2000-01-01T00:00:00.000Z", dealId)
  return withAgentEnv("true", async () => {
    while (await runNextBackgroundJob(["deal_agent"])) { /* drain due jobs */ }
    const rows = await getDatabase().prepare<{ result_json: string | null }>("SELECT result_json FROM mca_background_jobs WHERE kind='deal_agent' AND resource_id=? ORDER BY created_at").all(dealId)
    return rows.map(row => JSON.parse(row.result_json ?? "null"))
  })
}

type RunRow = { id: string; state: string; steps_json: string; error_code: string | null; created_at: string }
type ActionRow = { id: string; kind: string; target_key: string; fingerprint: string; status: string; payload_json: string; next_fingerprint: string | null; next_payload_json: string | null; preview_id: string | null; result_json: string | null; error_code: string | null; decided_by_user_id: string | null }
const runsFor = (dealId: string) => getDatabase().prepare<RunRow>("SELECT id,state,steps_json,error_code,created_at FROM mca_deal_agent_runs WHERE deal_id=? ORDER BY created_at").all(dealId)
const actionsFor = (dealId: string) => getDatabase().prepare<ActionRow>("SELECT id,kind,target_key,fingerprint,status,payload_json,next_fingerprint,next_payload_json,preview_id,result_json,error_code,decided_by_user_id FROM mca_deal_agent_actions WHERE deal_id=? ORDER BY created_at,target_key").all(dealId)

async function enabledDeal(): Promise<{ workspaceId: string; dealId: string }> {
  const workspaceId = await seedWorkspace({ dealAgent: true })
  return { workspaceId, dealId: await seedBareDeal(workspaceId) }
}

test("incomplete deal: run records steps and queues request_documents + schedule_follow_up with reasons", async () => {
  const { workspaceId, dealId } = await enabledDeal()
  await withAgentEnv("true", () => upload(workspaceId, dealId, "application"))
  const [result] = await runAgent(dealId)
  const [run] = await runsFor(dealId)
  assert.equal(run.state, "completed")
  assert.equal(result.runId, run.id)
  const steps = JSON.parse(run.steps_json) as Array<{ step: string; outcome: string; code?: string; summary: string }>
  assert.deepEqual(steps.map(step => step.step), ["statements", "completeness", "lender_fit", "proposals", "write"])
  assert.equal(steps[0].outcome, "skipped")
  assert.equal(steps[0].code, "provider_unavailable")
  const actions = await actionsFor(dealId)
  assert.deepEqual(actions.map(action => [action.kind, action.status]).sort(), [["request_documents", "pending"], ["schedule_follow_up", "pending"]])
  const request = JSON.parse(actions.find(action => action.kind === "request_documents")!.payload_json) as { items: Array<{ category: string; label: string; code: string }> }
  assert.ok(request.items.some(item => item.category === "driver_license"))
  assert.ok(request.items.some(item => item.category === "voided_check"))
  assert.ok(!request.items.some(item => item.category === "application"))
  const statements = request.items.filter(item => item.category === "statement")
  assert.ok(statements.length > 0)
  for (const item of statements) assert.match(item.label, /^Business bank statement for \d{4}-\d{2}$/)
  const followUp = JSON.parse(actions.find(action => action.kind === "schedule_follow_up")!.payload_json) as { title: string; dueInDays: number }
  assert.match(followUp.title, /^Follow up: missing documents for /)
  assert.equal(followUp.dueInDays, 2)
})

test("run produces no external effects", async () => {
  const { workspaceId, dealId } = await enabledDeal()
  await withAgentEnv("true", () => upload(workspaceId, dealId, "application"))
  await runAgent(dealId)
  assert.equal((await runsFor(dealId))[0].state, "completed")
  for (const table of ["mca_closing_stipulations", "mca_closing_previews", "mca_closing_deliveries", "mca_submission_jobs", "mca_calendar_activities"]) {
    const row = await getDatabase().prepare<{ n: number }>(`SELECT count(*)::int n FROM ${table} WHERE workspace_id=?`).get(workspaceId)
    assert.equal(row?.n, 0, table)
  }
})

test("documentProposals maps findings to stipulation categories", () => {
  const proposals = documentProposals({ dealId: "d", ready: false, version: 3, ruleSnapshot: "{}", checkedAt: "", findings: [
    { code: "missing_statement_2026-08", message: "Missing checking statement for 2026-08.", period: "2026-08" },
    { code: "period_mismatch", message: "Mismatch.", documentId: "doc" },
  ] }, { displayId: "D-1" })
  assert.deepEqual(proposals.map(proposal => [proposal.kind, proposal.targetKey, proposal.fingerprint]), [["request_documents", "request_documents", "c3"], ["schedule_follow_up", "follow_up", "c3"]])
  assert.deepEqual(proposals[0].payload, { items: [{ category: "statement", label: "Business bank statement for 2026-08", code: "missing_statement_2026-08", period: "2026-08" }], otherFindings: ["Mismatch."] })
  assert.deepEqual(documentProposals({ dealId: "d", ready: false, version: 4, ruleSnapshot: "{}", checkedAt: "", findings: [{ code: "period_mismatch", message: "Mismatch.", documentId: "doc" }] }, { displayId: "D-1" }), [])
  assert.deepEqual(documentProposals({ dealId: "d", ready: true, version: 5, ruleSnapshot: "{}", checkedAt: "", findings: [] }, { displayId: "D-1" }), [])
})

const metric = (value: number) => JSON.stringify({ value, unknown: false, confidence: 1 })

/** A deal that passes completeness with matched lenders; statement months and aggregate are seeded directly. */
async function completeDeal(options: { funders?: number; topN?: number; aggregate?: boolean } = {}) {
  const { workspaceId, dealId } = await enabledDeal()
  const admin = adminActor(workspaceId)
  const funderIds: string[] = []
  for (let index = 0; index < (options.funders ?? 3); index += 1) {
    const funder = (await createFunder(admin, { idempotencyKey: `funder-${++seq}`, legalName: `Agent Capital ${index}`, routes: [{ kind: "manual_portal", label: "Portal", destination: `https://portal${index}.example.test/submit`, documentExceptions: [], active: true }] })).funder
    await publishFunderCriteria(admin, funder.id, [{ field: "requested_amount", operator: "max", unit: "usd", value: 100000 + index * 50000, sourceText: "Synthetic deal agent fixture; not lender policy", sourceAsOf: "2026-01-01", unspecified: false }])
    funderIds.push(funder.id)
  }
  const now = new Date().toISOString()
  if (options.topN) await getDatabase().prepare(`INSERT INTO mca_analysis_settings (workspace_id,mode,top_n,review_notification_channel,automatic_send_enabled,updated_at)
    VALUES (?,'review_first',?,'none',0,?)`).run(workspaceId, options.topN, now)
  for (const category of ["application", "driver_license", "voided_check"]) await upload(workspaceId, dealId, category)
  for (const period of closedLookbackMonths(3, "America/New_York")) {
    const document = await upload(workspaceId, dealId, "statement", `statement-${period}-${++seq}`)
    await getDatabase().prepare(`INSERT INTO mca_statement_months (id,workspace_id,deal_id,document_id,account_kind,period,deposits,deposit_count,average_daily_balance,nsf_count,negative_days,ending_balance,extraction_version,created_at,updated_at)
      VALUES (?,?,?,?,'checking',?,'20000','12','8000','0','0','8000',1,?,?)`).run(`month-${document.id}`, workspaceId, dealId, document.id, period, now, now)
  }
  if (options.aggregate !== false) await getDatabase().prepare(`INSERT INTO mca_underwriting_aggregates (workspace_id,deal_id,version,monthly_revenue,average_daily_balance,nsf_count,negative_days,deposit_count,worst_month_nsf,position_count,stale,source_fingerprint,computed_at)
    VALUES (?,?,1,?,?,?,?,?,?,0,0,'synthetic-deal-agent',?)`).run(workspaceId, dealId, metric(20000), metric(8000), metric(0), metric(0), metric(12), metric(0), now)
  return { workspaceId, dealId, funderIds }
}

async function enqueueFor(workspaceId: string, dealId: string, documentId = `manual-${++seq}`) {
  await withAgentEnv("true", async () => (await import("../src/lib/mca/deal-agent/run")).enqueueDealAgentRun({ id: documentId, workspaceId, dealId }))
}

const stepsOf = (run: RunRow) => JSON.parse(run.steps_json) as Array<{ step: string; outcome: string; code?: string; summary: string }>

test("complete deal: queues submit_to_funder for top N matched funders with rank, score and reasons", async () => {
  const { workspaceId, dealId } = await completeDeal({ funders: 3, topN: 2 })
  await enqueueFor(workspaceId, dealId)
  await runAgent(dealId)
  const [run] = await runsFor(dealId)
  assert.equal(run.state, "completed", run.steps_json)
  const actions = await actionsFor(dealId)
  assert.ok(!actions.some(action => action.kind === "request_documents"))
  const submits = actions.filter(action => action.kind === "submit_to_funder").map(action => JSON.parse(action.payload_json) as { funderId: string; rank: number; score: number; reasons: string[]; disclaimer: string })
  assert.equal(submits.length, 2, run.steps_json)
  for (const payload of submits) {
    assert.equal(typeof payload.score, "number")
    assert.equal(typeof payload.rank, "number")
    assert.ok(payload.reasons.length > 0)
    assert.ok(payload.disclaimer)
  }
  assert.deepEqual(submits.map(payload => payload.rank).sort(), [1, 2])
  assert.ok(actions.filter(action => action.kind === "submit_to_funder").every(action => action.target_key.startsWith("submit:") && action.fingerprint.startsWith("s")))
})

test("skips funder with an existing sent submission and records why", async () => {
  const { workspaceId, dealId, funderIds } = await completeDeal({ funders: 2 })
  const now = new Date().toISOString()
  await getDatabase().prepare(`INSERT INTO mca_submission_jobs (id,workspace_id,deal_id,funder_id,display_funder_name,route_kind,route_json,state,confirmation_key,attempt_key,deal_version,document_versions_json,package_json,preflight_errors_json,created_at,updated_at)
    VALUES (?,?,?,?,'Agent Capital 0','manual_portal','{}','sent',?,?,1,'[]','{}','[]',?,?)`).run(`job-${++seq}`, workspaceId, dealId, funderIds[0], `confirm-${seq}`, `attempt-${seq}`, now, now)
  await enqueueFor(workspaceId, dealId)
  await runAgent(dealId)
  const [run] = await runsFor(dealId)
  const actions = await actionsFor(dealId)
  assert.ok(!actions.some(action => action.target_key === `submit:${funderIds[0]}`))
  assert.ok(actions.some(action => action.target_key === `submit:${funderIds[1]}`))
  assert.match(stepsOf(run).find(step => step.step === "proposals")!.summary, /already_submitted/)
})

test("never sends even when automatic_send and auto_submit are configured", async () => {
  const { workspaceId, dealId } = await completeDeal({ funders: 2 })
  const now = new Date().toISOString()
  await getDatabase().prepare(`INSERT INTO mca_analysis_settings (workspace_id,mode,top_n,review_notification_channel,automatic_send_enabled,updated_at)
    VALUES (?,'automatic_send',3,'none',1,?)`).run(workspaceId, now)
  await getDatabase().prepare(`INSERT INTO mca_auto_submit_settings (workspace_id,mode,min_match_score,max_funders_per_deal,eligible_funder_ids,updated_at)
    VALUES (?,'auto_submit',0,3,'[]',?)`).run(workspaceId, now)
  await enqueueFor(workspaceId, dealId)
  process.env.MCA_AUTO_SUBMIT_ENABLED = "true"
  try { await runAgent(dealId) } finally { delete process.env.MCA_AUTO_SUBMIT_ENABLED }
  assert.equal((await runsFor(dealId))[0].state, "completed")
  assert.ok((await actionsFor(dealId)).some(action => action.kind === "submit_to_funder"))
  assert.equal((await getDatabase().prepare<{ n: number }>("SELECT count(*)::int n FROM mca_submission_jobs WHERE deal_id=?").get(dealId))?.n, 0)
  // The agent's completeness check must not hand the deal to auto-submit either.
  assert.equal((await getDatabase().prepare<{ n: number }>("SELECT count(*)::int n FROM mca_background_jobs WHERE workspace_id=? AND kind='auto_submit'").get(workspaceId))?.n, 0)
})

test("lender fit without underwriting data is recorded and does not fail the run", async () => {
  // scoreDeal tolerates a missing aggregate: lenders are not matched rather than an error.
  const { workspaceId, dealId } = await completeDeal({ funders: 1, aggregate: false })
  await enqueueFor(workspaceId, dealId)
  await runAgent(dealId)
  const [run] = await runsFor(dealId)
  assert.equal(run.state, "completed")
  const fit = stepsOf(run).find(step => step.step === "lender_fit")!
  assert.match(fit.summary, /^0 matched lender/, JSON.stringify(fit))
  assert.equal((await actionsFor(dealId)).filter(action => action.kind === "submit_to_funder").length, 0)
})

async function incompleteDealWithRun() {
  const { workspaceId, dealId } = await enabledDeal()
  await withAgentEnv("true", () => upload(workspaceId, dealId, "application", "app-original"))
  await runAgent(dealId)
  return { workspaceId, dealId }
}

test("retrying the same job creates no new run or actions", async () => {
  const { workspaceId, dealId } = await incompleteDealWithRun()
  const before = await actionsFor(dealId)
  const job = await getDatabase().prepare<BackgroundJob>("SELECT * FROM mca_background_jobs WHERE kind='deal_agent' AND resource_id=?").get(dealId)
  const result = await withAgentEnv("true", () => processDealAgentJob(job!, documentScanActor({ workspaceId, dealId, id: "retry" })))
  assert.deepEqual(result, { skipped: "unchanged" })
  assert.equal((await runsFor(dealId)).length, 1)
  assert.deepEqual((await actionsFor(dealId)).map(action => action.id), before.map(action => action.id))
})

test("identical re-upload is a no-op", async () => {
  const { workspaceId, dealId } = await incompleteDealWithRun()
  await withAgentEnv("true", () => upload(workspaceId, dealId, "application", "app-original"))
  const results = await runAgent(dealId)
  assert.deepEqual(results[1], { skipped: "unchanged" })
  assert.equal((await runsFor(dealId)).length, 1)
})

test("changed inputs supersede pending action", async () => {
  const { workspaceId, dealId } = await incompleteDealWithRun()
  const [oldRequest] = (await actionsFor(dealId)).filter(action => action.kind === "request_documents")
  await withAgentEnv("true", () => upload(workspaceId, dealId, "driver_license"))
  await runAgent(dealId)
  const actions = await actionsFor(dealId)
  assert.equal(actions.find(action => action.id === oldRequest.id)?.status, "superseded")
  const pending = actions.filter(action => action.kind === "request_documents" && action.status === "pending")
  assert.equal(pending.length, 1)
  assert.notEqual(pending[0].fingerprint, oldRequest.fingerprint)
  const items = (JSON.parse(pending[0].payload_json) as { items: Array<{ category: string }> }).items
  assert.ok(!items.some(item => item.category === "driver_license"))
  assert.ok(items.some(item => item.category === "voided_check"))
  assert.equal(actions.filter(action => action.kind === "schedule_follow_up" && action.status === "pending").length, 1)
})

test("burst uploads coalesce to one run", async () => {
  const { workspaceId, dealId } = await enabledDeal()
  for (const category of ["application", "driver_license", "voided_check"]) await withAgentEnv("true", () => upload(workspaceId, dealId, category))
  const results = await runAgent(dealId)
  assert.equal(results.length, 1)
  const runs = await runsFor(dealId)
  assert.equal(runs.length, 1)
  assert.equal(runs[0].state, "completed")
  assert.equal(results.filter(result => result.skipped === "unchanged").length, 0)
  assert.equal((await actionsFor(dealId)).filter(action => action.kind === "request_documents").length, 1)
})

test("debounce: uploads push the queued job later, capped 10 minutes after it was created", async () => {
  const { workspaceId, dealId } = await enabledDeal()
  await withAgentEnv("true", () => upload(workspaceId, dealId, "application"))
  const [first] = await agentJobs(dealId)
  await new Promise(resolve => setTimeout(resolve, 20))
  for (const category of ["driver_license", "voided_check"]) await withAgentEnv("true", () => upload(workspaceId, dealId, category))
  const jobs = await agentJobs(dealId)
  assert.equal(jobs.length, 1)
  assert.equal(jobs[0].id, first.id)
  assert.equal(jobs[0].state, "queued")
  assert.ok(jobs[0].available_at > first.available_at)
  // A job created 9 minutes ago can only move to its 10-minute cap, not now + 120s.
  const created = new Date(Date.now() - 9 * 60_000).toISOString()
  await getDatabase().prepare("UPDATE mca_background_jobs SET created_at=?,available_at=? WHERE id=?").run(created, created, first.id)
  await withAgentEnv("true", () => upload(workspaceId, dealId, "other_stip"))
  const [capped] = await agentJobs(dealId)
  assert.equal((await agentJobs(dealId)).length, 1)
  assert.equal(capped.available_at, new Date(Date.parse(created) + 10 * 60_000).toISOString())
})

test("concurrent runs keep one open action per target", async () => {
  const { workspaceId, dealId } = await enabledDeal()
  const now = new Date().toISOString()
  for (const id of ["concurrent-a", "concurrent-b"]) await getDatabase().prepare(`INSERT INTO mca_deal_agent_runs (id,workspace_id,deal_id,input_key,state,created_at,updated_at)
    VALUES (?,?,?,?,'running',?,?)`).run(`${id}-${dealId}`, workspaceId, dealId, id, now, now)
  const actor = documentScanActor({ workspaceId, dealId, id: "concurrent" })
  const proposal = (fingerprint: string) => [{ kind: "request_documents" as const, targetKey: "request_documents", fingerprint, payload: {} }]
  await Promise.all([
    upsertProposals(actor, dealId, `concurrent-a-${dealId}`, proposal("c1")),
    upsertProposals(actor, dealId, `concurrent-b-${dealId}`, proposal("c2")),
  ])
  assert.equal((await actionsFor(dealId)).filter(action => action.status === "pending").length, 1)
})

test("dismissed proposal is not re-proposed for unchanged inputs", async () => {
  const { workspaceId, dealId } = await incompleteDealWithRun()
  await getDatabase().prepare("UPDATE mca_deal_agent_actions SET status='dismissed' WHERE deal_id=?").run(dealId)
  // A new document that does not change completeness: new run, same completeness fingerprint.
  await withAgentEnv("true", () => upload(workspaceId, dealId, "other_stip"))
  await runAgent(dealId)
  assert.equal((await runsFor(dealId)).length, 2)
  const actions = await actionsFor(dealId)
  assert.equal(actions.length, 2)
  assert.ok(actions.every(action => action.status === "dismissed"))
})

test("failed run is reclaimed on retry", async () => {
  const { workspaceId, dealId } = await enabledDeal()
  let calls = 0
  setStatementExtractionProviderForTests({ name: "flaky", async extractStatement() {
    calls += 1
    if (calls === 1) throw new Error("transient provider crash")
    throw new AppError(422, "statement_unreadable", "Synthetic unreadable statement.")
  } })
  try {
    await withAgentEnv("true", () => upload(workspaceId, dealId, "statement"))
    await runAgent(dealId)
    const [failed] = await runsFor(dealId)
    assert.equal(failed.state, "failed")
    await runAgent(dealId)
    const runs = await runsFor(dealId)
    assert.equal(runs.length, 1)
    assert.equal(runs[0].id, failed.id)
    assert.equal(runs[0].state, "completed")
    assert.equal(stepsOf(runs[0])[0].code, "statement_unreadable")
  } finally { setStatementExtractionProviderForTests() }
})

async function seedMember(workspaceId: string, role: "admin" | "manager" | "rep"): Promise<DealActor> {
  const now = new Date().toISOString()
  const userId = `da-user-${++seq}`
  const membershipId = `da-mem-${seq}`
  await getDatabase().prepare(`INSERT INTO users (id,email,password_hash,name,phone,application_identifier,created_at,updated_at) VALUES (?,?,NULL,?,NULL,?,?,?)`)
    .run(userId, `${userId}@example.test`, `Broker ${seq}`, `APP-DA-${seq}`, now, now)
  await getDatabase().prepare(`INSERT INTO memberships (id,workspace_id,user_id,role,manager_membership_id,status,sender_association,created_at,updated_at) VALUES (?,?,?,?,NULL,'active',NULL,?,?)`)
    .run(membershipId, workspaceId, userId, role, now, now)
  return { workspaceId, userId, membershipId, role, managedMembershipIds: [], activeMembershipIds: [membershipId], source: "user", sessionId: `session-${seq}`, scopes: [], correlationId: `corr-${seq}` }
}

const decide = (actor: DealActor, dealId: string, actionId: string, decision: "review" | "approve" | "dismiss", extra: { senderId?: string; note?: string; previewId?: string } = {}) =>
  withAgentEnv("true", () => decideDealAgentAction(actor, { dealId, actionId, decision, origin: "https://app.example.test", ...extra }))

test("dismiss records decider, time and note", async () => {
  const { workspaceId, dealId } = await incompleteDealWithRun()
  const broker = await seedMember(workspaceId, "admin")
  const request = (await actionsFor(dealId)).find(action => action.kind === "request_documents")!
  await decide(broker, dealId, request.id, "dismiss", { note: "Merchant is sending by courier" })
  const row = await getDatabase().prepare<{ status: string; decided_by_user_id: string; decided_at: string; decision_note: string }>("SELECT status,decided_by_user_id,decided_at,decision_note FROM mca_deal_agent_actions WHERE id=?").get(request.id)
  assert.equal(row?.status, "dismissed")
  assert.equal(row?.decided_by_user_id, broker.userId)
  assert.ok(row?.decided_at)
  assert.equal(row?.decision_note, "Merchant is sending by courier")
  assert.equal((await getDatabase().prepare<{ n: number }>("SELECT count(*)::int n FROM audit_events WHERE workspace_id=? AND action='deal_agent.action_dismissed' AND resource_id=?").get(workspaceId, request.id))?.n, 1)
  const view = await listDealAgent(broker, dealId)
  assert.equal(view.runs.length, 1)
  const listed = view.actions.find(action => action.id === request.id)!
  assert.equal(listed.decidedBy, (await getDatabase().prepare<{ name: string }>("SELECT name FROM users WHERE id=?").get(broker.userId))?.name)
  assert.equal(listed.decisionNote, "Merchant is sending by courier")
  assert.equal(view.actions[0].status, "pending")
})

test("tenant isolation: other workspace cannot list or decide", async () => {
  const { dealId } = await incompleteDealWithRun()
  const outsider = await seedMember(await seedWorkspace({ dealAgent: true }), "admin")
  const [action] = await actionsFor(dealId)
  await assert.rejects(listDealAgent(outsider, dealId), { status: 404 })
  await assert.rejects(decide(outsider, dealId, action.id, "dismiss"), { status: 404 })
  assert.equal((await actionsFor(dealId)).find(row => row.id === action.id)?.status, "pending")
})

test("rep without deal visibility gets 404", async () => {
  const { workspaceId, dealId } = await incompleteDealWithRun()
  const rep = await seedMember(workspaceId, "rep")
  const [action] = await actionsFor(dealId)
  await assert.rejects(listDealAgent(rep, dealId), { status: 404, code: "deal_not_found" })
  await assert.rejects(decide(rep, dealId, action.id, "dismiss"), { status: 404, code: "deal_not_found" })
})

test("actionId from another deal of the same workspace returns 404", async () => {
  const { workspaceId, dealId } = await incompleteDealWithRun()
  const otherDealId = await seedBareDeal(workspaceId)
  const broker = await seedMember(workspaceId, "admin")
  const [action] = await actionsFor(dealId)
  await assert.rejects(decide(broker, otherDealId, action.id, "dismiss"), { status: 404, code: "action_not_found" })
})

test("deciding a non-pending action returns 409 action_not_pending", async () => {
  const { workspaceId, dealId } = await incompleteDealWithRun()
  const broker = await seedMember(workspaceId, "admin")
  const [action] = await actionsFor(dealId)
  await decide(broker, dealId, action.id, "dismiss")
  await assert.rejects(decide(broker, dealId, action.id, "dismiss"), { status: 409, code: "action_not_pending" })
})

async function completeDealWithSubmitAction() {
  const fixture = await completeDeal({ funders: 1 })
  await enqueueFor(fixture.workspaceId, fixture.dealId)
  await runAgent(fixture.dealId)
  const action = (await actionsFor(fixture.dealId)).find(row => row.kind === "submit_to_funder")!
  assert.ok(action, "submit_to_funder proposed")
  return { ...fixture, action, broker: await seedMember(fixture.workspaceId, "admin") }
}

async function withQueuedDelivery<T>(callback: () => Promise<T>): Promise<T> {
  process.env.MCA_BACKGROUND_JOBS = "enabled"
  try { return await callback() } finally { delete process.env.MCA_BACKGROUND_JOBS }
}

const outboundFetches: string[] = []
before(() => {
  setEmailDeliveryFetchForTests(async (url) => { outboundFetches.push(String(url)); return new Response("ok") })
  setSenderDeliveryFetchForTests(async (url) => { outboundFetches.push(String(url)); return new Response("ok") })
})
after(() => { setEmailDeliveryFetchForTests(); setSenderDeliveryFetchForTests(); setClosingTransportForTests() })

async function seedMerchantSender(workspaceId: string, broker: DealActor): Promise<string> {
  const now = new Date().toISOString()
  const senderId = `merchant-sender-${++seq}`
  await getDatabase().prepare("INSERT INTO mca_email_senders (id,workspace_id,provider,purpose,from_name,from_address,signature,credential_cipher,state,is_default,verified_at,last_error,created_by_user_id,created_at,updated_at) VALUES (?,?,'smtp','merchant','Closer','closer@example.test',NULL,?,'verified',1,?,NULL,?,?,?)")
    .run(senderId, workspaceId, encryptSensitive(JSON.stringify({ kind: "smtp", host: "smtp.example.test", port: 587, username: "u", password: "secret", secure: false }), workspaceId), now, broker.userId, now, now)
  return senderId
}

const submissionJobs = (dealId: string) => getDatabase().prepare<{ state: string; confirmation_key: string }>("SELECT state,confirmation_key FROM mca_submission_jobs WHERE deal_id=?").all(dealId)

test("approve before review is rejected", async () => {
  const { dealId, action, broker } = await completeDealWithSubmitAction()
  await assert.rejects(decide(broker, dealId, action.id, "approve"), { status: 409, code: "review_required" })
  assert.equal((await submissionJobs(dealId)).length, 0)
  assert.equal((await actionsFor(dealId)).find(row => row.id === action.id)?.status, "pending")
})

test("review then approve hands off to confirmSubmissions", async () => {
  const { dealId, action, broker, funderIds } = await completeDealWithSubmitAction()
  const fetchesBefore = outboundFetches.length
  const reviewed = await decide(broker, dealId, action.id, "review")
  const preview = reviewed.preview as { id: string; destinations: Array<{ funderId: string }> }
  assert.equal(preview.destinations[0].funderId, funderIds[0])
  assert.equal((await actionsFor(dealId)).find(row => row.id === action.id)?.preview_id, preview.id)
  assert.equal((await actionsFor(dealId)).find(row => row.id === action.id)?.status, "pending")
  await withQueuedDelivery(() => decide(broker, dealId, action.id, "approve", { previewId: preview.id }))
  assert.equal((await actionsFor(dealId)).find(row => row.id === action.id)?.status, "approved")
  const jobs = await submissionJobs(dealId)
  assert.equal(jobs.length, 1)
  assert.equal(jobs[0].confirmation_key, preview.id)
  assert.equal(jobs[0].state, "queued")
  assert.equal(outboundFetches.length, fetchesBefore)
  await assert.rejects(decide(broker, dealId, action.id, "approve", { previewId: preview.id }), { status: 409, code: "action_not_pending" })
  assert.equal((await getDatabase().prepare<{ n: number }>("SELECT count(*)::int n FROM audit_events WHERE action='deal_agent.action_approved' AND resource_id=?").get(action.id))?.n, 1)
})

test("stale submission preview returns action to pending", async () => {
  const { dealId, action, broker } = await completeDealWithSubmitAction()
  const reviewed = await decide(broker, dealId, action.id, "review")
  await getDatabase().prepare("UPDATE deals SET version=version+1 WHERE id=?").run(dealId)
  await assert.rejects(withQueuedDelivery(() => decide(broker, dealId, action.id, "approve", { previewId: (reviewed.preview as { id: string }).id })), { status: 409, code: "submission_preview_stale" })
  const row = (await actionsFor(dealId)).find(item => item.id === action.id)!
  assert.equal(row.status, "pending")
  assert.equal(row.error_code, "submission_preview_stale")
  assert.equal((await submissionJobs(dealId)).length, 0)
})

test("api-key actor cannot review a submission", async () => {
  const { workspaceId, dealId, action } = await completeDealWithSubmitAction()
  const apiKey: DealActor = { workspaceId, userId: null, membershipId: null, role: null, managedMembershipIds: [], activeMembershipIds: [], source: "api_key", apiKeyId: "key", scopes: ["deals:write"], correlationId: "api" }
  await assert.rejects(decide(apiKey, dealId, action.id, "review"), { status: 403, code: "broker_review_required" })
})

test("request_documents review creates stipulations and a closing preview; approve sends once via sendRequestPreview", async () => {
  const { workspaceId, dealId } = await incompleteDealWithRun()
  const broker = await seedMember(workspaceId, "admin")
  const senderId = await seedMerchantSender(workspaceId, broker)
  const action = (await actionsFor(dealId)).find(row => row.kind === "request_documents")!
  const items = (JSON.parse(action.payload_json) as { items: unknown[] }).items
  await assert.rejects(decide(broker, dealId, action.id, "review"), { status: 422, code: "sender_required" })
  const reviewed = await decide(broker, dealId, action.id, "review", { senderId })
  const preview = reviewed.preview as { id: string; body: string; recipient: string }
  assert.equal((await getDatabase().prepare<{ n: number }>("SELECT count(*)::int n FROM mca_closing_stipulations WHERE deal_id=? AND status='open'").get(dealId))?.n, items.length)
  const again = await decide(broker, dealId, action.id, "review", { senderId })
  assert.equal((again.preview as { id: string }).id, preview.id)
  assert.equal((await getDatabase().prepare<{ n: number }>("SELECT count(*)::int n FROM mca_closing_stipulations WHERE deal_id=?").get(dealId))?.n, items.length)
  await getDatabase().prepare("UPDATE deals SET dba_name='Renamed Merchant',version=version+1 WHERE id=?").run(dealId)
  const edited = (await decide(broker, dealId, action.id, "review", { senderId })).preview as { id: string; body: string }
  assert.notEqual(edited.id, preview.id)
  assert.match(edited.body, /Renamed Merchant/)
  const delivered: string[] = []
  setClosingTransportForTests({ async deliver(request) { delivered.push(request.body ?? ""); return { state: "sent", correlationId: request.correlationId, externalId: "agent-mail-1" } } })
  try {
    await assert.rejects(decide(broker, dealId, action.id, "approve", { previewId: preview.id }), { status: 409, code: "preview_changed" })
    assert.equal(delivered.length, 0)
    await decide(broker, dealId, action.id, "approve", { previewId: edited.id })
    assert.equal((await actionsFor(dealId)).find(row => row.id === action.id)?.status, "approved")
  } finally { setClosingTransportForTests() }
  assert.equal(delivered.length, 1)
  assert.match(delivered[0], /\/merchant-upload\//)
  assert.equal((await getDatabase().prepare<{ n: number }>("SELECT count(*)::int n FROM mca_closing_deliveries WHERE workspace_id=?").get(workspaceId))?.n, 1)
})

test("approve schedule_follow_up creates one calendar followup assigned to approver", async () => {
  const { workspaceId, dealId } = await incompleteDealWithRun()
  const broker = await seedMember(workspaceId, "admin")
  const action = (await actionsFor(dealId)).find(row => row.kind === "schedule_follow_up")!
  await decide(broker, dealId, action.id, "approve")
  assert.equal((await actionsFor(dealId)).find(row => row.id === action.id)?.status, "approved")
  const rows = await getDatabase().prepare<{ kind: string; assignee_id: string; all_day: number; starts_at: string }>("SELECT kind,assignee_id,all_day,starts_at FROM mca_calendar_activities WHERE deal_id=?").all(dealId)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].kind, "followup")
  assert.equal(rows[0].assignee_id, broker.membershipId)
  assert.equal(Number(rows[0].all_day), 1)
  assert.match(rows[0].starts_at, /^\d{4}-\d{2}-\d{2}$/)
})

test("superseded proposal is revived when proposed again", async () => {
  const { workspaceId, dealId } = await incompleteDealWithRun()
  await getDatabase().prepare("UPDATE mca_deal_agent_actions SET status='superseded' WHERE deal_id=?").run(dealId)
  await withAgentEnv("true", () => upload(workspaceId, dealId, "other_stip"))
  await runAgent(dealId)
  const actions = await actionsFor(dealId)
  assert.equal(actions.length, 2)
  assert.ok(actions.every(action => action.status === "pending"))
})

test("statement months are not requested while uploaded statements have unknown periods", () => {
  const [request] = documentProposals({ dealId: "d", ready: false, version: 6, ruleSnapshot: "{}", checkedAt: "", findings: [
    { code: "missing_driver_license", message: "Upload a ready driver license." },
    { code: "missing_statement_2026-08", message: "Missing checking statement for 2026-08.", period: "2026-08" },
    { code: "unknown_statement_period", message: "The statement period could not be determined.", documentId: "doc" },
  ] }, { displayId: "D-1" })
  assert.deepEqual((request.payload.items as Array<{ category: string }>).map(item => item.category), ["driver_license"])
  assert.deepEqual(request.payload.otherFindings, ["Missing checking statement for 2026-08.", "The statement period could not be determined."])
})

test("document request reuses open stipulations from an earlier request", async () => {
  const { workspaceId, dealId } = await incompleteDealWithRun()
  const broker = await seedMember(workspaceId, "admin")
  const senderId = await seedMerchantSender(workspaceId, broker)
  const first = (await actionsFor(dealId)).find(row => row.kind === "request_documents")!
  await decide(broker, dealId, first.id, "review", { senderId })
  // A sent request frees the target; its stipulations stay open until the merchant uploads.
  await getDatabase().prepare("UPDATE mca_deal_agent_actions SET status='approved' WHERE id=?").run(first.id)
  const stipulations = async () => (await getDatabase().prepare<{ n: number }>("SELECT count(*)::int n FROM mca_closing_stipulations WHERE deal_id=?").get(dealId))?.n
  const before = await stipulations()
  await withAgentEnv("true", () => upload(workspaceId, dealId, "driver_license"))
  await runAgent(dealId)
  const second = (await actionsFor(dealId)).find(row => row.kind === "request_documents" && row.status === "pending")!
  assert.notEqual(second.id, first.id)
  await decide(broker, dealId, second.id, "review", { senderId })
  assert.equal(await stipulations(), before)
})

test("dismissing a request waives only the stipulations it created", async () => {
  const { workspaceId, dealId } = await incompleteDealWithRun()
  const broker = await seedMember(workspaceId, "admin")
  const senderId = await seedMerchantSender(workspaceId, broker)
  const first = (await actionsFor(dealId)).find(row => row.kind === "request_documents")!
  await decide(broker, dealId, first.id, "review", { senderId })
  await getDatabase().prepare("UPDATE mca_deal_agent_actions SET status='approved' WHERE id=?").run(first.id)
  // The voided check is no longer open from the first request, so the second creates its own.
  await getDatabase().prepare("UPDATE mca_closing_stipulations SET status='waived' WHERE deal_id=? AND document_category='voided_check'").run(dealId)
  await withAgentEnv("true", () => upload(workspaceId, dealId, "driver_license"))
  await runAgent(dealId)
  const second = (await actionsFor(dealId)).find(row => row.kind === "request_documents" && row.status === "pending")!
  await decide(broker, dealId, second.id, "review", { senderId })
  const stips = () => getDatabase().prepare<{ id: string; status: string; idempotency_key: string; document_category: string }>("SELECT id,status,idempotency_key,document_category FROM mca_closing_stipulations WHERE deal_id=?").all(dealId)
  const own = (await stips()).filter(row => row.idempotency_key.startsWith(`deal-agent:${second.id}:`))
  assert.deepEqual(own.map(row => [row.document_category, row.status]), [["voided_check", "open"]])
  const reused = (await stips()).filter(row => row.idempotency_key.startsWith(`deal-agent:${first.id}:`) && row.status === "open")
  assert.ok(reused.length > 0)
  await decide(broker, dealId, second.id, "dismiss")
  const after = await stips()
  assert.equal(after.find(row => row.id === own[0].id)?.status, "waived")
  assert.ok(reused.every(row => after.find(item => item.id === row.id)?.status === "open"))
  assert.equal((await getDatabase().prepare<{ n: number }>("SELECT count(*)::int n FROM audit_events WHERE action='closing.stipulation_waived' AND resource_id=?").get(own[0].id))?.n, 1)
})

const STALE = () => new Date(Date.now() - 16 * 60_000).toISOString()
const setExecuting = (actionId: string, updatedAt: string, decidedBy: string | null = null) => getDatabase()
  .prepare("UPDATE mca_deal_agent_actions SET status='executing',result_json=NULL,error_code=NULL,decided_by_user_id=?,updated_at=? WHERE id=?").run(decidedBy, updatedAt, actionId)
const actionRow = async (dealId: string, id: string) => (await actionsFor(dealId)).find(row => row.id === id)!
const recoveredOutcomes = async (actionId: string) => (await getDatabase().prepare<{ outcome: string }>("SELECT metadata::jsonb->>'outcome' AS outcome FROM audit_events WHERE action='deal_agent.action_recovered' AND resource_id=? ORDER BY created_at").all(actionId)).map(row => row.outcome)

test("recovery: stale submit_to_funder returns to pending, or approved once the preview was confirmed", async () => {
  const { dealId, action, broker } = await completeDealWithSubmitAction()
  const preview = (await decide(broker, dealId, action.id, "review")).preview as { id: string }
  await setExecuting(action.id, STALE(), broker.userId)
  await listDealAgent(broker, dealId)
  let row = await actionRow(dealId, action.id)
  assert.deepEqual([row.status, row.error_code, row.preview_id, row.decided_by_user_id], ["pending", "interrupted", preview.id, null])
  // Approving again is safe: confirm is idempotent on the stored preview.
  await withQueuedDelivery(() => decide(broker, dealId, action.id, "approve", { previewId: preview.id }))
  await setExecuting(action.id, STALE(), broker.userId)
  await listDealAgent(broker, dealId)
  row = await actionRow(dealId, action.id)
  assert.equal(row.status, "approved")
  assert.deepEqual((JSON.parse(row.result_json!) as { jobs: Array<{ jobId: string }> }).jobs.length, 1)
  assert.equal((await submissionJobs(dealId)).length, 1)
  assert.deepEqual(await recoveredOutcomes(action.id), ["pending", "approved"])
})

test("recovery: stale request_documents follows the closing preview state; a row inside the window is left alone", async () => {
  const { workspaceId, dealId } = await incompleteDealWithRun()
  const broker = await seedMember(workspaceId, "admin")
  const senderId = await seedMerchantSender(workspaceId, broker)
  const action = (await actionsFor(dealId)).find(row => row.kind === "request_documents")!
  const preview = (await decide(broker, dealId, action.id, "review", { senderId })).preview as { id: string }
  await setExecuting(action.id, new Date().toISOString(), broker.userId)
  await listDealAgent(broker, dealId)
  assert.equal((await actionRow(dealId, action.id)).status, "executing")
  await setExecuting(action.id, STALE(), broker.userId)
  await listDealAgent(broker, dealId)
  assert.deepEqual([(await actionRow(dealId, action.id)).status, (await actionRow(dealId, action.id)).error_code], ["pending", "interrupted"])
  const previewState = (state: string) => getDatabase().prepare("UPDATE mca_closing_previews SET state=? WHERE id=?").run(state, preview.id)
  await previewState("sent")
  await setExecuting(action.id, STALE(), broker.userId)
  await listDealAgent(broker, dealId)
  assert.equal((await actionRow(dealId, action.id)).status, "approved")
  await previewState("failed")
  await setExecuting(action.id, STALE(), broker.userId)
  await listDealAgent(broker, dealId)
  assert.deepEqual([(await actionRow(dealId, action.id)).status, (await actionRow(dealId, action.id)).error_code], ["failed", "delivery_failed"])
  assert.deepEqual(await recoveredOutcomes(action.id), ["pending", "approved", "failed"])
})

test("recovery: stale schedule_follow_up is approved only when the approver's follow-up exists", async () => {
  const { workspaceId, dealId } = await incompleteDealWithRun()
  const broker = await seedMember(workspaceId, "admin")
  const action = (await actionsFor(dealId)).find(row => row.kind === "schedule_follow_up")!
  await setExecuting(action.id, STALE(), broker.userId)
  await listDealAgent(broker, dealId)
  assert.deepEqual([(await actionRow(dealId, action.id)).status, (await actionRow(dealId, action.id)).error_code], ["pending", "interrupted"])
  await decide(broker, dealId, action.id, "approve")
  assert.equal((await actionRow(dealId, action.id)).decided_by_user_id, broker.userId)
  await setExecuting(action.id, STALE(), broker.userId)
  await listDealAgent(broker, dealId)
  assert.equal((await actionRow(dealId, action.id)).status, "approved")
  assert.deepEqual(await recoveredOutcomes(action.id), ["pending", "approved"])
})

test("stale executing row is recovered by the next run, which then proposes for the target", async () => {
  const { workspaceId, dealId } = await incompleteDealWithRun()
  const action = (await actionsFor(dealId)).find(row => row.kind === "schedule_follow_up")!
  await setExecuting(action.id, STALE())
  await withAgentEnv("true", () => upload(workspaceId, dealId, "driver_license"))
  await runAgent(dealId)
  const followUps = (await actionsFor(dealId)).filter(row => row.kind === "schedule_follow_up")
  assert.equal(followUps.find(row => row.id === action.id)?.status, "superseded")
  assert.equal(followUps.filter(row => row.status === "pending").length, 1)
  assert.deepEqual(await recoveredOutcomes(action.id), ["pending"])
})

async function reviewedRequestWithNewerRun() {
  const { workspaceId, dealId } = await incompleteDealWithRun()
  const broker = await seedMember(workspaceId, "admin")
  const senderId = await seedMerchantSender(workspaceId, broker)
  const before = await actionsFor(dealId)
  const reviewed = before.find(row => row.kind === "request_documents")!
  const preview = (await decide(broker, dealId, reviewed.id, "review", { senderId })).preview as { id: string }
  await withAgentEnv("true", () => upload(workspaceId, dealId, "driver_license"))
  await runAgent(dealId)
  return { workspaceId, dealId, broker, senderId, reviewed, preview, oldFollowUp: before.find(row => row.kind === "schedule_follow_up")! }
}

test("a reviewed request survives a newer run: kept with its preview, newer proposal parked, unreviewed follow-up superseded", async () => {
  const { dealId, reviewed, preview, oldFollowUp } = await reviewedRequestWithNewerRun()
  const runs = await runsFor(dealId)
  assert.equal(runs.length, 2)
  assert.ok(runs.every(run => run.state === "completed"), JSON.stringify(runs))
  const actions = await actionsFor(dealId)
  const row = actions.find(item => item.id === reviewed.id)!
  assert.deepEqual([row.status, row.preview_id, row.fingerprint, row.error_code], ["pending", preview.id, reviewed.fingerprint, "inputs_changed"])
  assert.ok(row.next_fingerprint && row.next_fingerprint !== reviewed.fingerprint)
  assert.ok(!(JSON.parse(row.next_payload_json!) as { items: Array<{ category: string }> }).items.some(item => item.category === "driver_license"))
  assert.equal(actions.filter(item => item.kind === "request_documents" && item.status === "pending").length, 1)
  assert.equal(actions.find(item => item.id === oldFollowUp.id)?.status, "superseded")
  assert.equal(actions.filter(item => item.kind === "schedule_follow_up" && item.status === "pending").length, 1)
})

test("dismissing a reviewed request promotes the parked proposal to a new pending row", async () => {
  const { dealId, broker, reviewed } = await reviewedRequestWithNewerRun()
  const parked = (await actionRow(dealId, reviewed.id))
  await decide(broker, dealId, reviewed.id, "dismiss")
  const pending = (await actionsFor(dealId)).filter(item => item.kind === "request_documents" && item.status === "pending")
  assert.equal(pending.length, 1)
  assert.notEqual(pending[0].id, reviewed.id)
  assert.equal(pending[0].fingerprint, parked.next_fingerprint)
  assert.equal(pending[0].payload_json, parked.next_payload_json)
  assert.equal(pending[0].preview_id, null)
})

test("approving a reviewed request sends what was reviewed and clears the parked proposal", async () => {
  const { dealId, broker, reviewed, preview } = await reviewedRequestWithNewerRun()
  setClosingTransportForTests({ async deliver(request) { return { state: "sent", correlationId: request.correlationId, externalId: "agent-mail-parked" } } })
  try { await decide(broker, dealId, reviewed.id, "approve", { previewId: preview.id }) } finally { setClosingTransportForTests() }
  const row = await actionRow(dealId, reviewed.id)
  assert.deepEqual([row.status, row.fingerprint, row.next_fingerprint, row.next_payload_json, row.error_code], ["approved", reviewed.fingerprint, null, null, null])
})

test("reviewing again promotes the parked proposal before building the preview", async () => {
  const { dealId, broker, senderId, reviewed, preview } = await reviewedRequestWithNewerRun()
  const parked = await actionRow(dealId, reviewed.id)
  const fresh = (await decide(broker, dealId, reviewed.id, "review", { senderId })).preview as { id: string; body: string }
  const row = await actionRow(dealId, reviewed.id)
  assert.deepEqual([row.status, row.fingerprint, row.payload_json, row.next_fingerprint, row.error_code, row.preview_id], ["pending", parked.next_fingerprint, parked.next_payload_json, null, null, fresh.id])
  assert.notEqual(fresh.id, preview.id)
  assert.doesNotMatch(fresh.body, /Driver license/)
})

test("a reviewed row whose target is no longer proposed is kept with no_longer_suggested", async () => {
  const { workspaceId, dealId } = await enabledDeal()
  const now = new Date().toISOString()
  const runId = `nls-${dealId}`
  await getDatabase().prepare(`INSERT INTO mca_deal_agent_runs (id,workspace_id,deal_id,input_key,state,created_at,updated_at) VALUES (?,?,?,?,'running',?,?)`).run(runId, workspaceId, dealId, runId, now, now)
  const actor = documentScanActor({ workspaceId, dealId, id: "nls" })
  await upsertProposals(actor, dealId, runId, [{ kind: "request_documents", targetKey: "request_documents", fingerprint: "c1", payload: {} }, { kind: "submit_to_funder", targetKey: "submit:f1", fingerprint: "s1", payload: {} }])
  await getDatabase().prepare("UPDATE mca_deal_agent_actions SET preview_id='reviewed-preview',next_fingerprint='c0',next_payload_json='{}' WHERE deal_id=? AND target_key='request_documents'").run(dealId)
  await upsertProposals(actor, dealId, runId, [])
  const actions = await actionsFor(dealId)
  const kept = actions.find(row => row.target_key === "request_documents")!
  assert.deepEqual([kept.status, kept.error_code, kept.next_fingerprint, kept.preview_id], ["pending", "no_longer_suggested", null, "reviewed-preview"])
  assert.equal(actions.find(row => row.target_key === "submit:f1")?.status, "superseded")
  // Proposed again with the reviewed fingerprint: the row is current and the note clears.
  await upsertProposals(actor, dealId, runId, [{ kind: "request_documents", targetKey: "request_documents", fingerprint: "c1", payload: {} }])
  assert.equal((await actionsFor(dealId)).find(row => row.target_key === "request_documents")?.error_code, null)
})

test("an older run does not overwrite proposals while a newer run is in flight", async () => {
  const { workspaceId, dealId } = await enabledDeal()
  for (const [id, createdAt] of [["older", "2026-01-01T00:00:00.000Z"], ["newer", "2026-01-01T00:01:00.000Z"]]) await getDatabase().prepare(`INSERT INTO mca_deal_agent_runs (id,workspace_id,deal_id,input_key,state,created_at,updated_at)
    VALUES (?,?,?,?,'running',?,?)`).run(`${id}-${dealId}`, workspaceId, dealId, id, createdAt, createdAt)
  const result = await upsertProposals(documentScanActor({ workspaceId, dealId, id: "race" }), dealId, `older-${dealId}`, [{ kind: "request_documents", targetKey: "request_documents", fingerprint: "c1", payload: {} }])
  assert.deepEqual(result, { skipped: "newer_run" })
})
