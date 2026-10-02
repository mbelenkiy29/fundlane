import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { closeDatabaseForTests, getDatabase } from "../src/lib/mca/db"
import { createDeal } from "../src/lib/mca/deals/service"
import { retryDocumentScan, storeDocument } from "../src/lib/mca/documents/service"
import { setDocumentScannerForTests } from "../src/lib/mca/documents/scanner"
import { setDocumentStorageForTests } from "../src/lib/mca/documents/storage"
import { documentProposals } from "../src/lib/mca/deal-agent/run"
import { runNextBackgroundJob } from "../src/lib/mca/jobs/worker"
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
