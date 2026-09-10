import "./helpers/business-auth";
import test, { after, before } from "node:test"
import assert from "node:assert/strict"
import { randomBytes } from "node:crypto"
import { closeDatabaseForTests, getDatabase } from "../src/lib/mca/db"
import { hashOpaqueToken } from "../src/lib/mca/crypto"
import type { DealActor } from "../src/lib/mca/deals/schema"
import { createDeal } from "../src/lib/mca/deals/service"
import { commitSpreadsheetImport, previewSpreadsheetImport } from "../src/lib/mca/imports/service"
import {
  formatPurchaseCost,
  parsePurchaseCostInput,
} from "../src/lib/mca/leads/contracts"
import {
  assignDealAcquisition,
  attachImportRunAcquisitions,
  commitPurchasedPackage,
  createLeadProvider,
  createPurchaseBatch,
  ingestApplicationWithAcquisition,
  latestAcquisitionForDeal,
  listDealAcquisitionHistory,
  listLeadWorkspace,
  previewPurchasedPackage,
  updateLeadProvider,
  updatePurchaseBatch,
} from "../src/lib/mca/leads/service"
import { GET as getLeads } from "../src/app/api/mca/leads/route"
import { POST as createProviderRoute } from "../src/app/api/mca/leads/providers/route"
import { PATCH as patchProviderRoute } from "../src/app/api/mca/leads/providers/[id]/route"
import { POST as createBatchRoute } from "../src/app/api/mca/leads/batches/route"
import { PATCH as patchBatchRoute } from "../src/app/api/mca/leads/batches/[id]/route"
import { POST as assignRoute } from "../src/app/api/mca/leads/assignments/route"
import { createPostgresTestDatabase } from "./helpers/postgres-test-db.mjs"

const now = "2026-09-08T15:00:00.000Z"
const ids = {
  workspaceA: "ws-leads-a",
  workspaceB: "ws-leads-b",
  adminUserA: "user-leads-admin-a",
  adminA: "member-leads-admin-a",
  repUserA: "user-leads-rep-a",
  repA: "member-leads-rep-a",
  adminUserB: "user-leads-admin-b",
  adminB: "member-leads-admin-b",
}
const adminA: DealActor = {
  workspaceId: ids.workspaceA, userId: ids.adminUserA, membershipId: ids.adminA, role: "admin",
  managedMembershipIds: [], activeMembershipIds: [ids.adminA, ids.repA], source: "user", correlationId: "leads-admin-a",
}
const repA: DealActor = {
  workspaceId: ids.workspaceA, userId: ids.repUserA, membershipId: ids.repA, role: "rep",
  managedMembershipIds: [], activeMembershipIds: [ids.adminA, ids.repA], source: "user", correlationId: "leads-rep-a",
}
const adminB: DealActor = {
  workspaceId: ids.workspaceB, userId: ids.adminUserB, membershipId: ids.adminB, role: "admin",
  managedMembershipIds: [], activeMembershipIds: [ids.adminB], source: "user", correlationId: "leads-admin-b",
}

let fixture: Awaited<ReturnType<typeof createPostgresTestDatabase>>
const priorEncryption = process.env.MCA_DATA_ENCRYPTION_KEY

async function seed() {
  const database = getDatabase()
  const flags = JSON.stringify({ reports: true, payments: true, integrations: true })
  const pages = JSON.stringify({ dashboard: true, deals: true, users: true, reports: true, payments: true, workspace: true, integrations: true })
  const actions = JSON.stringify({ createDeal: true, exportDeals: true, inviteUsers: true, manageApiKeys: true, viewPaymentTable: true, viewCompanyFinancials: true })
  await database.prepare(`INSERT INTO workspaces (id,name,timezone,seat_limit,feature_flags,page_visibility,action_visibility,created_at,updated_at) VALUES
    (?,?,'America/New_York',10,?,?,?,?,?),(?,?,'America/New_York',10,?,?,?,?,?)`).run(
    ids.workspaceA, "Leads Workspace A", flags, pages, actions, now, now,
    ids.workspaceB, "Leads Workspace B", flags, pages, actions, now, now,
  )
  await database.prepare(`INSERT INTO users (id,email,name,application_identifier,created_at,updated_at) VALUES
    (?,?,?,'LEAD-A1',?,?),(?,?,?,'LEAD-A2',?,?),(?,?,?,'LEAD-B1',?,?)`).run(
    ids.adminUserA, "leads-admin-a@example.test", "Leads Admin A", now, now,
    ids.repUserA, "leads-rep-a@example.test", "Leads Rep A", now, now,
    ids.adminUserB, "leads-admin-b@example.test", "Leads Admin B", now, now,
  )
  await database.prepare(`INSERT INTO memberships (id,workspace_id,user_id,role,status,created_at,updated_at) VALUES
    (?,?,?,'admin','active',?,?),(?,?,?,'rep','active',?,?),(?,?,?,'admin','active',?,?)`).run(
    ids.adminA, ids.workspaceA, ids.adminUserA, now, now,
    ids.repA, ids.workspaceA, ids.repUserA, now, now,
    ids.adminB, ids.workspaceB, ids.adminUserB, now, now,
  )
  await database.prepare(`INSERT INTO sessions (id,user_id,membership_id,token_hash,expires_at,created_at,last_seen_at) VALUES
    ('session-leads-admin',?,?,?,'2027-09-08T00:00:00.000Z',?,?),
    ('session-leads-rep',?,?,?,'2027-09-08T00:00:00.000Z',?,?)`).run(
    ids.adminUserA, ids.adminA, hashOpaqueToken("leads-admin-session"), now, now,
    ids.repUserA, ids.repA, hashOpaqueToken("leads-rep-session"), now, now,
  )
}

function request(path: string, init: { method?: string; cookie: string; body?: unknown } = { cookie: "" }) {
  const headers: Record<string, string> = { cookie: `mca_session=${init.cookie}` }
  if (init.body !== undefined) {
    headers["content-type"] = "application/json"
    headers.origin = "https://app.example.test"
  }
  return new Request(`https://app.example.test${path}`, {
    method: init.method ?? "GET",
    headers,
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  })
}

before(async () => {
  fixture = await createPostgresTestDatabase("milestone06_leads")
  Object.assign(process.env, fixture.env())
  process.env.MCA_DATA_ENCRYPTION_KEY = randomBytes(32).toString("base64url")
  await seed()
})

after(async () => {
  await closeDatabaseForTests()
  await fixture.close()
  if (priorEncryption === undefined) delete process.env.MCA_DATA_ENCRYPTION_KEY
  else process.env.MCA_DATA_ENCRYPTION_KEY = priorEncryption
})

test("MIC-110 treats blank cost as missing and zero as a real zero", () => {
  assert.deepEqual(parsePurchaseCostInput(""), { ok: true, costCents: null })
  assert.deepEqual(parsePurchaseCostInput("0"), { ok: true, costCents: 0 })
  assert.deepEqual(parsePurchaseCostInput("0.00"), { ok: true, costCents: 0 })
  assert.deepEqual(parsePurchaseCostInput("$250.50"), { ok: true, costCents: 25050 })
  assert.equal(parsePurchaseCostInput("12.345").ok, false)
  assert.equal(parsePurchaseCostInput("-1").ok, false)
  assert.equal(formatPurchaseCost(null), "Not set")
  assert.equal(formatPurchaseCost(0), "$0.00")
  assert.equal(formatPurchaseCost(25000), "$250.00")
})

test("MIC-110 importing a purchased package attaches every created deal to the chosen batch", async () => {
  const source = await createLeadProvider(adminA, { name: "Excel buyer pack" })
  const batch = await createPurchaseBatch(adminA, {
    sourceId: source.id, name: "September pack", purchasedOn: "2026-09-01", costCents: 125000,
  })
  assert.equal(batch.costCents, 125000)
  assert.equal(batch.purchasedOn, "2026-09-01")
  const preview = await previewPurchasedPackage(adminA, {
    sourceId: source.id, batchId: batch.id, filename: "pack.csv",
    bytes: Buffer.from("Business Name\nNorth Star Funding LLC\nHarbor Grill LLC"),
  })
  assert.equal(preview.batchId, batch.id)
  assert.equal(preview.rows.length, 2)
  const committed = await commitPurchasedPackage(adminA, { runId: preview.runId, expectedPreviewRevision: preview.previewRevision })
  assert.equal(committed.created, 2)
  assert.equal(committed.attachedDealIds.length, 2)
  assert.equal(committed.failed, 0)
  const events = await Promise.all(committed.attachedDealIds.map((dealId) => latestAcquisitionForDeal(adminA, dealId)))
  for (const event of events) {
    assert.equal(event?.batchId, batch.id)
    assert.equal(event?.sourceId, source.id)
    assert.equal(event?.costCents, 125000)
    assert.equal(event?.purchasedOn, "2026-09-01")
  }
  const retried = await commitPurchasedPackage(adminA, { runId: preview.runId, expectedPreviewRevision: preview.previewRevision })
  assert.deepEqual(retried.acquisitionEventIds.sort(), committed.acquisitionEventIds.sort())
  assert.equal((await getDatabase().prepare<{ count: number }>("SELECT count(*)::int AS count FROM deals WHERE workspace_id=? AND legal_name IN ('North Star Funding LLC','Harbor Grill LLC')").get(ids.workspaceA))!.count, 2)
})

test("MIC-110 a source in another workspace cannot be selected", async () => {
  const foreign = await createLeadProvider(adminB, { name: "Foreign lead shop" })
  const localDeal = (await createDeal(adminA, { idempotencyKey: "leads-foreign-deal", legalName: "Local Merchant LLC" })).deal
  await assert.rejects(
    () => createPurchaseBatch(adminA, { sourceId: foreign.id, name: "Should fail" }),
    (error: { code?: string }) => error.code === "cross_workspace_source",
  )
  const local = await createLeadProvider(adminA, { name: "Local shop" })
  const batch = await createPurchaseBatch(adminA, { sourceId: local.id, name: "Local batch", costCents: 0 })
  await assert.rejects(
    () => assignDealAcquisition(adminA, { dealId: localDeal.id, sourceId: foreign.id, batchId: batch.id, correlationId: "acq:manual:cross-source" }),
    (error: { code?: string }) => error.code === "cross_workspace_source",
  )
  await assert.rejects(
    () => previewPurchasedPackage(adminA, { sourceId: foreign.id, batchId: batch.id, filename: "x.csv", bytes: Buffer.from("Business Name\nNope LLC") }),
    (error: { code?: string }) => error.code === "cross_workspace_source",
  )
})

test("MIC-110 inactive sources cannot be selected and historical rows remain after batch corrections", async () => {
  const source = await createLeadProvider(adminA, { name: "Sunset media" })
  const batch = await createPurchaseBatch(adminA, { sourceId: source.id, name: "August pack", purchasedOn: "2026-08-15", costCents: 40000 })
  const deal = (await createDeal(adminA, { idempotencyKey: "leads-historical-deal", legalName: "Historical Cafe LLC" })).deal
  const assigned = await assignDealAcquisition(adminA, {
    dealId: deal.id, sourceId: source.id, batchId: batch.id, correlationId: "acq:manual:historical-cafe",
  })
  assert.equal(assigned.costCents, 40000)
  const renamed = await updatePurchaseBatch(adminA, batch.id, { name: "August pack corrected", costCents: 50000 })
  assert.equal(renamed.dealCount, 1)
  assert.equal(renamed.costCents, 50000)
  const snapshot = await latestAcquisitionForDeal(adminA, deal.id)
  assert.equal(snapshot?.id, assigned.id)
  assert.equal(snapshot?.batchId, batch.id)
  assert.equal(snapshot?.costCents, 40000)
  await updateLeadProvider(adminA, source.id, { active: false })
  await updatePurchaseBatch(adminA, batch.id, { inactive: true })
  await assert.rejects(
    () => createPurchaseBatch(adminA, { sourceId: source.id, name: "After deactivate" }),
    (error: { code?: string }) => error.code === "inactive_lead_source",
  )
  await assert.rejects(
    () => assignDealAcquisition(adminA, { dealId: deal.id, sourceId: source.id, batchId: batch.id, correlationId: "acq:manual:after-inactive" }),
    (error: { code?: string }) => error.code === "inactive_lead_source",
  )
  const history = await listDealAcquisitionHistory(adminA, deal.id)
  assert.equal(history.length, 1)
  assert.equal(history[0].batchId, batch.id)
  const workspace = await listLeadWorkspace(adminA)
  assert.equal(workspace.unassignedDeals.some((item) => item.id === deal.id), false)
  assert.equal(workspace.selectable.providerIds.includes(source.id), false)
  assert.equal(workspace.selectable.batchIds.includes(batch.id), false)
})

test("MIC-110 missing cost stays null, zero is stored, and intake plus import-run attach keep identity", async () => {
  const source = await createLeadProvider(adminA, { name: "Unknown-cost shop" })
  const missing = await createPurchaseBatch(adminA, { sourceId: source.id, name: "Unknown pack" })
  assert.equal(missing.costCents, null)
  const zero = await createPurchaseBatch(adminA, { sourceId: source.id, name: "Zero pack", costCents: 0 })
  assert.equal(zero.costCents, 0)
  const intake = await ingestApplicationWithAcquisition(adminA, {
    schemaVersion: 1, provider: "import", eventId: "intake-zero-1",
    application: { legalName: "Intake Zero LLC" }, sourceReference: "intake:test",
  }, { sourceId: source.id, batchId: zero.id })
  assert.equal(intake.created, true)
  assert.equal(intake.event?.costCents, 0)
  const replay = await ingestApplicationWithAcquisition(adminA, {
    schemaVersion: 1, provider: "import", eventId: "intake-zero-1",
    application: { legalName: "Intake Zero LLC" }, sourceReference: "intake:test",
  }, { sourceId: source.id, batchId: zero.id })
  assert.equal(replay.created, false)
  assert.equal(replay.event?.id, intake.event?.id)
  const preview = await previewSpreadsheetImport(adminA, {
    sourceId: source.id, batchId: missing.id, filename: "legacy.csv",
    bytes: Buffer.from("Business Name\nLegacy Attach LLC"),
  })
  const imported = await commitSpreadsheetImport(adminA, { runId: preview.runId, expectedPreviewRevision: 1 })
  assert.equal(imported.created, 1)
  const firstAttach = await attachImportRunAcquisitions(adminA, preview.runId)
  const secondAttach = await attachImportRunAcquisitions(adminA, preview.runId)
  assert.equal(firstAttach.length, 1)
  assert.equal(firstAttach[0].costCents, null)
  assert.deepEqual(secondAttach.map((event) => event.id), firstAttach.map((event) => event.id))
})

test("MIC-110 reconciliation lists unassigned deals and assignment retries keep the same event", async () => {
  const source = await createLeadProvider(adminA, { name: "Reconcile shop" })
  const batch = await createPurchaseBatch(adminA, { sourceId: source.id, name: "Reconcile pack", costCents: 9900 })
  const deal = (await createDeal(adminA, { idempotencyKey: "leads-unassigned", legalName: "Unassigned Deli LLC" })).deal
  const before = await listLeadWorkspace(adminA)
  assert.equal(before.unassignedDeals.some((item) => item.id === deal.id), true)
  const first = await assignDealAcquisition(adminA, {
    dealId: deal.id, sourceId: source.id, batchId: batch.id, correlationId: "acq:manual:unassigned-deli",
  })
  const second = await assignDealAcquisition(adminA, {
    dealId: deal.id, sourceId: source.id, batchId: batch.id, correlationId: "acq:manual:unassigned-deli",
  })
  assert.equal(second.id, first.id)
  const after = await listLeadWorkspace(adminA)
  assert.equal(after.unassignedDeals.some((item) => item.id === deal.id), false)
  const audits = await getDatabase().prepare<{ metadata: string }>("SELECT metadata FROM audit_events WHERE workspace_id=? AND action='lead.acquisition_recorded' AND resource_id=?").all(ids.workspaceA, deal.id)
  for (const row of audits) {
    assert.equal(row.metadata.includes("Unassigned Deli"), false)
    assert.equal(row.metadata.includes("ssn"), false)
  }
})

test("MIC-110 API permissions match the admin UI and reject a representative cost edit", async () => {
  await assert.rejects(() => listLeadWorkspace(repA), (error: { code?: string }) => error.code === "permission_denied")
  await assert.rejects(() => createLeadProvider(repA, { name: "Rep source" }), (error: { code?: string }) => error.code === "permission_denied")
  const denied = await getLeads(request("/api/mca/leads", { cookie: "leads-rep-session" }))
  assert.equal(denied.status, 403)
  assert.equal((await denied.json()).error.code, "permission_denied")
  const created = await createProviderRoute(request("/api/mca/leads/providers", {
    method: "POST", cookie: "leads-admin-session", body: { name: "API shop", kind: "spreadsheet" },
  }))
  assert.equal(created.status, 201)
  const provider = await created.json() as { id: string }
  const batchResponse = await createBatchRoute(request("/api/mca/leads/batches", {
    method: "POST", cookie: "leads-admin-session", body: { sourceId: provider.id, name: "API pack", purchasedOn: "2026-09-02", costCents: 100 },
  }))
  assert.equal(batchResponse.status, 201)
  const batch = await batchResponse.json() as { id: string; costCents: number | null }
  assert.equal(batch.costCents, 100)
  const repCost = await patchBatchRoute(request(`/api/mca/leads/batches/${batch.id}`, {
    method: "PATCH", cookie: "leads-rep-session", body: { costCents: 1 },
  }), { params: Promise.resolve({ id: batch.id }) })
  assert.equal(repCost.status, 403)
  const adminCost = await patchBatchRoute(request(`/api/mca/leads/batches/${batch.id}`, {
    method: "PATCH", cookie: "leads-admin-session", body: { costCents: 0 },
  }), { params: Promise.resolve({ id: batch.id }) })
  assert.equal(adminCost.status, 200)
  assert.equal((await adminCost.json() as { costCents: number | null }).costCents, 0)
  const nullCost = await patchBatchRoute(request(`/api/mca/leads/batches/${batch.id}`, {
    method: "PATCH", cookie: "leads-admin-session", body: { costCents: null },
  }), { params: Promise.resolve({ id: batch.id }) })
  assert.equal((await nullCost.json() as { costCents: number | null }).costCents, null)
  const repAssign = await assignRoute(request("/api/mca/leads/assignments", {
    method: "POST", cookie: "leads-rep-session", body: { dealId: "x", sourceId: provider.id, batchId: batch.id, correlationId: "acq:manual:rep" },
  }))
  assert.equal(repAssign.status, 403)
  const deactivated = await patchProviderRoute(request(`/api/mca/leads/providers/${provider.id}`, {
    method: "PATCH", cookie: "leads-admin-session", body: { active: false },
  }), { params: Promise.resolve({ id: provider.id }) })
  assert.equal(deactivated.status, 200)
  const snapshot = await getLeads(request("/api/mca/leads", { cookie: "leads-admin-session" }))
  assert.equal(snapshot.status, 200)
  const body = await snapshot.json() as { selectable: { providerIds: string[] }; canEditCost: boolean }
  assert.equal(body.canEditCost, true)
  assert.equal(body.selectable.providerIds.includes(provider.id), false)
})
