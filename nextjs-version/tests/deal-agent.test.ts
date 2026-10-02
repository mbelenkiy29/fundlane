import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { closeDatabaseForTests, getDatabase } from "../src/lib/mca/db"
import { createDeal } from "../src/lib/mca/deals/service"
import { retryDocumentScan, storeDocument } from "../src/lib/mca/documents/service"
import { setDocumentScannerForTests } from "../src/lib/mca/documents/scanner"
import { setDocumentStorageForTests } from "../src/lib/mca/documents/storage"
import { documentProposals, processDealAgentJob, upsertProposals } from "../src/lib/mca/deal-agent/run"
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
  return (await createDeal(adminActor(workspaceId), { idempotencyKey: key, legalName: "Agent Merchant LLC", entityType: "llc", address: { line1: "1 Main St", city: "New York", state: "NY", postalCode: "10001" }, startDate: "2020-01-01", industry: "restaurants", naicsCode: "722511", monthlyRevenue: 20_000, ficoScore: 680, requestedAmount: 50_000, requestedTermMonths: 12, fundingPurpose: "working capital", contactPhone: "2125550100", owners: [{ firstName: "Ada", lastName: "Cole", ownershipPercent: 100, isPrimary: true }] })).deal.id
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
type ActionRow = { id: string; kind: string; target_key: string; fingerprint: string; status: string; payload_json: string; preview_id: string | null; error_code: string | null; decided_by_user_id: string | null }
const runsFor = (dealId: string) => getDatabase().prepare<RunRow>("SELECT id,state,steps_json,error_code,created_at FROM mca_deal_agent_runs WHERE deal_id=? ORDER BY created_at").all(dealId)
const actionsFor = (dealId: string) => getDatabase().prepare<ActionRow>("SELECT id,kind,target_key,fingerprint,status,payload_json,preview_id,error_code,decided_by_user_id FROM mca_deal_agent_actions WHERE deal_id=? ORDER BY created_at,target_key").all(dealId)

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
  assert.equal(results.length, 3)
  const runs = await runsFor(dealId)
  assert.equal(runs.length, 1)
  assert.equal(runs[0].state, "completed")
  assert.deepEqual(results.filter(result => result.skipped === "unchanged").length, 2)
  assert.equal((await actionsFor(dealId)).filter(action => action.kind === "request_documents").length, 1)
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
