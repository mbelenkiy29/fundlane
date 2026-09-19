import test, { after, before } from "node:test"
import assert from "node:assert/strict"
import { closeDatabaseForTests, getDatabase, newId } from "../src/lib/mca/db"
import { createPostgresTestDatabase } from "./helpers/postgres-test-db.mjs"
import { createDeal } from "../src/lib/mca/deals/service"
import type { DealActor } from "../src/lib/mca/deals/schema"
import { evaluateUnderwritingSendGates } from "../src/lib/mca/underwriting/send-gates"
import { queueSubmissions } from "../src/lib/mca/underwriting/submission-port"

let testDatabase: Awaited<ReturnType<typeof createPostgresTestDatabase>>

const actor = (workspaceId: string): DealActor => ({
  workspaceId,
  userId: "user-send-gates",
  membershipId: null,
  role: "admin",
  managedMembershipIds: [],
  activeMembershipIds: [],
  source: "system",
  correlationId: `corr-${workspaceId}`,
})

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

async function seedCompleteness(workspaceId: string, dealId: string, ready: boolean, version = 1) {
  const now = new Date().toISOString()
  await exec(
    `INSERT INTO mca_completeness_results
      (id, workspace_id, deal_id, ready, version, rule_snapshot, findings_json, findings_fingerprint, checked_at)
     VALUES (?, ?, ?, ?, ?, '{"requiredStatementMonths":3}', '[]', ?, ?)`,
    newId(), workspaceId, dealId, ready ? 1 : 0, version, `gate-${version}-${ready ? "ready" : "not"}`, now,
  )
}

async function seedPosition(workspaceId: string, dealId: string, status: "proposed" | "confirmed" | "dismissed") {
  const now = new Date().toISOString()
  await exec(
    `INSERT INTO mca_existing_positions
      (id, workspace_id, deal_id, document_id, label, estimated_payment, evidence, status, corrected, correction_reason, corrected_by_user_id, corrected_at, created_at, updated_at)
     VALUES (?, ?, ?, NULL, ?, NULL, 'fixture', ?, 0, NULL, NULL, NULL, ?, ?)`,
    newId(), workspaceId, dealId, `${status} position`, status, now, now,
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
  return created.deal
}

before(async () => {
  testDatabase = await createPostgresTestDatabase("underwriting_send_gates")
  Object.assign(process.env, testDatabase.env())
})

after(async () => {
  await closeDatabaseForTests()
  await testDatabase.close()
})

test("send gates ok only when latest completeness is ready and proposedPositionCount is 0", async () => {
  const workspaceId = `ws-gate-ok-${newId().slice(0, 8)}`
  await addWorkspace(workspaceId)
  const deal = await merchantDeal(workspaceId, "ok")
  await seedCompleteness(workspaceId, deal.id, true)
  await seedPosition(workspaceId, deal.id, "confirmed")
  await seedPosition(workspaceId, deal.id, "dismissed")
  const gate = await evaluateUnderwritingSendGates(actor(workspaceId), deal.id)
  assert.equal(gate.ok, true)
  assert.equal(gate.completenessReady, true)
  assert.equal(gate.proposedPositionCount, 0)
  assert.deepEqual(gate.reasons, [])
})

test("send gates reason completeness_not_ready when latest completeness is missing or not ready", async () => {
  const workspaceId = `ws-gate-comp-${newId().slice(0, 8)}`
  await addWorkspace(workspaceId)
  const missing = await merchantDeal(workspaceId, "missing")
  const missingGate = await evaluateUnderwritingSendGates(actor(workspaceId), missing.id)
  assert.equal(missingGate.ok, false)
  assert.equal(missingGate.completenessReady, false)
  assert.equal(missingGate.proposedPositionCount, 0)
  assert.deepEqual(missingGate.reasons, ["completeness_not_ready"])

  const notReady = await merchantDeal(workspaceId, "not-ready")
  await seedCompleteness(workspaceId, notReady.id, false)
  const notReadyGate = await evaluateUnderwritingSendGates(actor(workspaceId), notReady.id)
  assert.equal(notReadyGate.ok, false)
  assert.equal(notReadyGate.completenessReady, false)
  assert.deepEqual(notReadyGate.reasons, ["completeness_not_ready"])
})

test("send gates reason positions_unconfirmed when proposed positions remain", async () => {
  const workspaceId = `ws-gate-pos-${newId().slice(0, 8)}`
  await addWorkspace(workspaceId)
  const deal = await merchantDeal(workspaceId, "proposed")
  await seedCompleteness(workspaceId, deal.id, true)
  await seedPosition(workspaceId, deal.id, "proposed")
  await seedPosition(workspaceId, deal.id, "proposed")
  const gate = await evaluateUnderwritingSendGates(actor(workspaceId), deal.id)
  assert.equal(gate.ok, false)
  assert.equal(gate.completenessReady, true)
  assert.equal(gate.proposedPositionCount, 2)
  assert.deepEqual(gate.reasons, ["positions_unconfirmed"])
})

test("send gates include both frozen reasons when completeness is not ready and proposed positions remain", async () => {
  const workspaceId = `ws-gate-both-${newId().slice(0, 8)}`
  await addWorkspace(workspaceId)
  const deal = await merchantDeal(workspaceId, "both")
  await seedCompleteness(workspaceId, deal.id, false)
  await seedPosition(workspaceId, deal.id, "proposed")
  const gate = await evaluateUnderwritingSendGates(actor(workspaceId), deal.id)
  assert.equal(gate.ok, false)
  assert.equal(gate.completenessReady, false)
  assert.equal(gate.proposedPositionCount, 1)
  assert.deepEqual(gate.reasons, ["completeness_not_ready", "positions_unconfirmed"])
})

test("submission-port refuses queue with frozen reason codes when send gates fail", async () => {
  const workspaceId = `ws-gate-port-${newId().slice(0, 8)}`
  await addWorkspace(workspaceId)
  const incomplete = await merchantDeal(workspaceId, "port-incomplete")
  await seedPosition(workspaceId, incomplete.id, "proposed")
  await assert.rejects(
    () => queueSubmissions({ actor: actor(workspaceId), dealId: incomplete.id, funderIds: ["funder-a"] }),
    (error: { status?: number; code?: string; extra?: { reasons?: string[] } }) =>
      error.status === 422
      && error.code === "completeness_not_ready"
      && Boolean(error.extra?.reasons?.includes("completeness_not_ready"))
      && Boolean(error.extra?.reasons?.includes("positions_unconfirmed")),
  )

  const proposed = await merchantDeal(workspaceId, "port-proposed")
  await seedCompleteness(workspaceId, proposed.id, true)
  await seedPosition(workspaceId, proposed.id, "proposed")
  await assert.rejects(
    () => queueSubmissions({ actor: actor(workspaceId), dealId: proposed.id, funderIds: ["funder-a"] }),
    (error: { status?: number; code?: string }) => error.status === 422 && error.code === "positions_unconfirmed",
  )
})
