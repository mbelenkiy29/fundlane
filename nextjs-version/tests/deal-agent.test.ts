import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { closeDatabaseForTests, getDatabase } from "../src/lib/mca/db"
import { createDeal } from "../src/lib/mca/deals/service"
import { retryDocumentScan, storeDocument } from "../src/lib/mca/documents/service"
import { setDocumentScannerForTests } from "../src/lib/mca/documents/scanner"
import { setDocumentStorageForTests } from "../src/lib/mca/documents/storage"
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
