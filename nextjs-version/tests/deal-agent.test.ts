import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { closeDatabaseForTests, getDatabase } from "../src/lib/mca/db"
import { createDeal } from "../src/lib/mca/deals/service"
import { getWorkspaceSettings } from "../src/lib/mca/workspaces"
import { createPostgresTestDatabase } from "./helpers/postgres-test-db.mjs"

let database: Awaited<ReturnType<typeof createPostgresTestDatabase>>
const previousDatabaseUrl = process.env.DATABASE_URL

before(async () => {
  database = await createPostgresTestDatabase("deal_agent")
  process.env.DATABASE_URL = database.databaseUrl
})

after(async () => {
  await closeDatabaseForTests()
  await database.close()
  if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL
  else process.env.DATABASE_URL = previousDatabaseUrl
})

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
