import "./helpers/business-auth"
import test, { after, before } from "node:test"
import assert from "node:assert/strict"
import { closeDatabaseForTests, getDatabase } from "../src/lib/mca/db"
import { createPostgresTestDatabase } from "./helpers/postgres-test-db.mjs"
import { hashOpaqueToken } from "../src/lib/mca/crypto"
import { AppError } from "../src/lib/mca/errors"
import type { DealActor } from "../src/lib/mca/deals/schema"
import { createDeal, getDealForDocument } from "../src/lib/mca/deals/service"
import { csvEscape } from "../src/lib/mca/exports/csv"
import { createExportJob, redeemExportDownload } from "../src/lib/mca/exports/service"
import {
  commitCsvUpdate,
  createImportSource,
  createLeadBatch,
  ensureBulkUpdateRegistry,
  previewCsvUpdate,
} from "../src/lib/mca/imports/service"
import { GET as listExports, POST as createExport } from "../src/app/api/mca/exports/route"
import { GET as templateGet } from "../src/app/api/mca/imports/update/template/route"
import { POST as workspacePost } from "../src/app/api/mca/imports/update/workspace/route"
import { POST as previewUpdatePost } from "../src/app/api/mca/imports/update/preview/route"
import { POST as commitUpdatePost } from "../src/app/api/mca/imports/update/[id]/commit/route"

process.env.MCA_DATA_ENCRYPTION_KEY = Buffer.alloc(32, 9).toString("base64url")

let fixture: Awaited<ReturnType<typeof createPostgresTestDatabase>>

const ids = {
  workspace: "ws-issue76",
  otherWorkspace: "ws-issue76-other",
  adminUser: "user-issue76-admin",
  adminMember: "member-issue76-admin",
  managerUser: "user-issue76-manager",
  managerMember: "member-issue76-manager",
  repUser: "user-issue76-rep",
  repMember: "member-issue76-rep",
  otherUser: "user-issue76-other",
  otherMember: "member-issue76-other",
}

const now = "2026-09-25T12:00:00.000Z"
const FORMULA_NAME = "=CMD()"

const admin: DealActor = {
  workspaceId: ids.workspace, userId: ids.adminUser, membershipId: ids.adminMember, role: "admin",
  managedMembershipIds: [], activeMembershipIds: [ids.adminMember, ids.managerMember, ids.repMember],
  source: "user", correlationId: "corr-issue76-admin",
}
const manager: DealActor = {
  ...admin, userId: ids.managerUser, membershipId: ids.managerMember, role: "manager",
  managedMembershipIds: [ids.repMember], correlationId: "corr-issue76-manager",
}
const rep: DealActor = {
  ...admin, userId: ids.repUser, membershipId: ids.repMember, role: "rep",
  managedMembershipIds: [], correlationId: "corr-issue76-rep",
}

const seeded = { visibleDealId: "", hiddenDealId: "", sourceId: "", batchId: "" }

function cookieRequest(path: string, token: string, init: RequestInit = {}) {
  return new Request(`http://localhost${path}`, {
    ...init,
    headers: {
      cookie: `mca_session=${token}`,
      origin: "http://localhost",
      ...(init.body && !(init.body instanceof FormData) ? { "content-type": "application/json" } : {}),
      ...init.headers,
    },
  })
}

function params(id: string) {
  return { params: Promise.resolve({ id }) }
}

async function seed() {
  const db = getDatabase()
  const visibility = JSON.stringify({ dashboard: true, deals: true, users: true, reports: true, payments: true, workspace: true, integrations: true })
  const actions = JSON.stringify({ createDeal: true, exportDeals: true, inviteUsers: true, manageApiKeys: true, viewPaymentTable: true, viewCompanyFinancials: true })
  const flags = JSON.stringify({ reports: true, payments: true, integrations: true })
  for (const [id, name] of [[ids.workspace, "Issue 76"], [ids.otherWorkspace, "Other 76"]] as const) {
    await db.prepare(`INSERT INTO workspaces (id,name,timezone,seat_limit,feature_flags,page_visibility,action_visibility,created_at,updated_at)
      VALUES (?, ?, 'America/New_York', 8, ?, ?, ?, ?, ?)`).run(id, name, flags, visibility, actions, now, now)
  }
  for (const [userId, memberId, email, workspaceId, role, managerId] of [
    [ids.adminUser, ids.adminMember, "issue76-admin@example.test", ids.workspace, "admin", null],
    [ids.managerUser, ids.managerMember, "issue76-manager@example.test", ids.workspace, "manager", null],
    [ids.repUser, ids.repMember, "issue76-rep@example.test", ids.workspace, "rep", ids.managerMember],
    [ids.otherUser, ids.otherMember, "issue76-other@example.test", ids.otherWorkspace, "admin", null],
  ] as const) {
    await db.prepare(`INSERT INTO users (id,email,password_hash,name,phone,application_identifier,created_at,updated_at)
      VALUES (?, ?, NULL, ?, NULL, ?, ?, ?)`).run(userId, email, email, `APP-${userId.slice(-6)}`, now, now)
    await db.prepare(`INSERT INTO memberships (id,workspace_id,user_id,role,manager_membership_id,status,sender_association,created_at,updated_at)
      VALUES (?, ?, ?, ?, ?, 'active', NULL, ?, ?)`).run(memberId, workspaceId, userId, role, managerId, now, now)
  }
  await db.prepare(`INSERT INTO sessions (id,user_id,membership_id,token_hash,expires_at,created_at,last_seen_at)
    VALUES (?, ?, ?, ?, '2099-01-01T00:00:00.000Z', ?, ?)`).run("issue76-admin-session", ids.adminUser, ids.adminMember, hashOpaqueToken("admin-session-token"), now, now)
  await db.prepare(`INSERT INTO sessions (id,user_id,membership_id,token_hash,expires_at,created_at,last_seen_at)
    VALUES (?, ?, ?, ?, '2099-01-01T00:00:00.000Z', ?, ?)`).run("issue76-manager-session", ids.managerUser, ids.managerMember, hashOpaqueToken("manager-session-token"), now, now)
  await db.prepare(`INSERT INTO sessions (id,user_id,membership_id,token_hash,expires_at,created_at,last_seen_at)
    VALUES (?, ?, ?, ?, '2099-01-01T00:00:00.000Z', ?, ?)`).run("issue76-rep-session", ids.repUser, ids.repMember, hashOpaqueToken("rep-session-token"), now, now)

  const visible = await createDeal(admin, {
    idempotencyKey: "issue76-visible",
    legalName: FORMULA_NAME,
    requestedAmount: 50000,
    assignments: [{ membershipId: ids.repMember, kind: "originator", isPrimary: true }],
  })
  const hidden = await createDeal(admin, {
    idempotencyKey: "issue76-hidden",
    legalName: "Admin Only Merchant",
    assignments: [{ membershipId: ids.adminMember, kind: "originator", isPrimary: true }],
  })
  seeded.visibleDealId = visible.deal.id
  seeded.hiddenDealId = hidden.deal.id
  const source = await createImportSource(admin, { name: "Issue 76 updates" })
  const batch = await createLeadBatch(admin, { sourceId: source.id, name: "September" })
  seeded.sourceId = source.id
  seeded.batchId = batch.id
}

before(async () => {
  fixture = await createPostgresTestDatabase("issue76_csv")
  Object.assign(process.env, fixture.env())
  await seed()
})

after(async () => {
  await closeDatabaseForTests()
  await fixture.close()
})

test("issue 76: CSV formula prefixes are escaped in exports", () => {
  assert.equal(csvEscape("=CMD()"), "'=CMD()")
  assert.equal(csvEscape("+1+1"), "'+1+1")
  assert.equal(csvEscape("-SUM(A1)"), "'-SUM(A1)")
  assert.equal(csvEscape("@SUM(1,1)"), "\"'@SUM(1,1)\"")
})

test("issue 76: filtered exports respect role visibility and record audit events", async () => {
  const repExport = await createExportJob(rep, { kind: "deals", correlationId: "issue76-rep-deals" })
  const file = await redeemExportDownload(rep, repExport.download!.url.split("/").pop() ?? "")
  assert.equal(file.csv.includes(FORMULA_NAME) || file.csv.includes("'=CMD()"), true)
  assert.match(file.csv, /'=CMD\(\)/)
  assert.equal(file.csv.includes(seeded.visibleDealId), true)
  assert.equal(file.csv.includes("Admin Only Merchant"), false)

  await assert.rejects(
    () => createExportJob(rep, { kind: "all_deals_owners", correlationId: "issue76-rep-owners" }),
    (error: unknown) => error instanceof AppError && error.code === "permission_denied",
  )
  await assert.rejects(
    () => createExportJob(manager, { kind: "all_deals_owners", correlationId: "issue76-manager-owners" }),
    (error: unknown) => error instanceof AppError && error.code === "permission_denied",
  )

  const adminExport = await createExportJob(admin, { kind: "all_deals_owners", correlationId: "issue76-admin-owners" })
  const owners = await redeemExportDownload(admin, adminExport.download!.url.split("/").pop() ?? "")
  assert.equal(owners.csv.includes("Admin Only Merchant"), true)
  assert.match(owners.csv, /'=CMD\(\)/)

  const audits = await getDatabase().prepare<{ action: string }>(
    "SELECT action FROM audit_events WHERE workspace_id = ? AND resource_type = 'export_job'",
  ).all(ids.workspace)
  assert.ok(audits.some((row) => row.action === "export.created"))
  assert.ok(audits.some((row) => row.action === "export.downloaded"))
})

test("issue 76: only admins can preview and commit CSV bulk updates; commits are audited", async () => {
  const csv = Buffer.from(`dealId,expectedVersion,legalName\n${seeded.visibleDealId},1,Renamed Harbor LLC`)
  await assert.rejects(
    () => previewCsvUpdate(rep, { sourceId: seeded.sourceId, batchId: seeded.batchId, filename: "denied.csv", bytes: csv }),
    (error: unknown) => error instanceof AppError && error.code === "permission_denied",
  )
  await assert.rejects(
    () => previewCsvUpdate(manager, { sourceId: seeded.sourceId, batchId: seeded.batchId, filename: "denied.csv", bytes: csv }),
    (error: unknown) => error instanceof AppError && error.code === "permission_denied",
  )
  await assert.rejects(
    () => ensureBulkUpdateRegistry(rep),
    (error: unknown) => error instanceof AppError && error.code === "permission_denied",
  )

  const preview = await previewCsvUpdate(admin, {
    sourceId: seeded.sourceId, batchId: seeded.batchId, filename: "updates.csv", bytes: csv,
  })
  assert.equal(preview.rows[0].errors.length, 0)
  assert.equal(preview.rows[0].before.legalName, FORMULA_NAME)
  assert.equal(preview.rows[0].changes.legalName, "Renamed Harbor LLC")

  const committed = await commitCsvUpdate(admin, { runId: preview.runId, expectedPreviewRevision: preview.previewRevision })
  assert.equal(committed.created, 1)
  assert.equal((await getDealForDocument(admin, seeded.visibleDealId)).legalName, "Renamed Harbor LLC")

  const registry = await ensureBulkUpdateRegistry(admin)
  assert.equal(registry.source.name, "Deal bulk updates")
  assert.equal(registry.batch.name, "Updates")

  const audits = await getDatabase().prepare<{ action: string; resource_id: string }>(
    "SELECT action, resource_id FROM audit_events WHERE workspace_id = ? AND action IN ('import.update_previewed','import.update_committed','deal.bulk_updated')",
  ).all(ids.workspace)
  assert.ok(audits.some((row) => row.action === "import.update_previewed" && row.resource_id === preview.runId))
  assert.ok(audits.some((row) => row.action === "import.update_committed" && row.resource_id === preview.runId))
  assert.ok(audits.some((row) => row.action === "deal.bulk_updated" && row.resource_id === seeded.visibleDealId))
})

test("issue 76: HTTP routes enforce the same export and bulk-update permissions", async () => {
  const unauth = await listExports(new Request("http://localhost/api/mca/exports"))
  assert.equal(unauth.status, 401)

  const repOwners = await createExport(cookieRequest("/api/mca/exports", "rep-session-token", {
    method: "POST",
    body: JSON.stringify({ kind: "all_deals_owners", correlationId: "issue76-http-rep-owners" }),
  }))
  assert.equal(repOwners.status, 403)
  assert.equal(((await repOwners.json()) as { error: { code: string } }).error.code, "permission_denied")

  const repDeals = await createExport(cookieRequest("/api/mca/exports", "rep-session-token", {
    method: "POST",
    body: JSON.stringify({ kind: "deals", correlationId: "issue76-http-rep-deals" }),
  }))
  assert.equal(repDeals.status, 201)

  const templateDenied = await templateGet(cookieRequest("/api/mca/imports/update/template", "rep-session-token"))
  assert.equal(templateDenied.status, 403)
  const managerTemplate = await templateGet(cookieRequest("/api/mca/imports/update/template", "manager-session-token"))
  assert.equal(managerTemplate.status, 403)
  const workspaceDenied = await workspacePost(cookieRequest("/api/mca/imports/update/workspace", "rep-session-token", {
    method: "POST",
    body: "{}",
  }))
  assert.equal(workspaceDenied.status, 403)
  const workspace = await workspacePost(cookieRequest("/api/mca/imports/update/workspace", "admin-session-token", {
    method: "POST",
    body: "{}",
  }))
  assert.equal(workspace.status, 200)
  assert.equal(((await workspace.json()) as { source: { name: string } }).source.name, "Deal bulk updates")

  const form = new FormData()
  form.set("file", new File([`dealId,expectedVersion,legalName\n${seeded.hiddenDealId},1,Should Fail`], "denied.csv", { type: "text/csv" }))
  form.set("sourceId", seeded.sourceId)
  form.set("batchId", seeded.batchId)
  const repPreview = await previewUpdatePost(cookieRequest("/api/mca/imports/update/preview", "rep-session-token", {
    method: "POST",
    body: form,
  }))
  assert.equal(repPreview.status, 403)

  const adminForm = new FormData()
  adminForm.set("file", new File([`dealId,expectedVersion,legalName\n${seeded.hiddenDealId},1,Admin Renamed LLC`], "admin.csv", { type: "text/csv" }))
  adminForm.set("sourceId", seeded.sourceId)
  adminForm.set("batchId", seeded.batchId)
  const adminPreview = await previewUpdatePost(cookieRequest("/api/mca/imports/update/preview", "admin-session-token", {
    method: "POST",
    body: adminForm,
  }))
  assert.equal(adminPreview.status, 201, await adminPreview.clone().text())
  const previewBody = await adminPreview.json() as { runId: string; previewRevision: number }
  const adminCommit = await commitUpdatePost(cookieRequest(`/api/mca/imports/update/${previewBody.runId}/commit`, "admin-session-token", {
    method: "POST",
    body: JSON.stringify({ expectedPreviewRevision: previewBody.previewRevision }),
  }), params(previewBody.runId))
  assert.equal(adminCommit.status, 200, await adminCommit.clone().text())
  assert.equal((await getDealForDocument(admin, seeded.hiddenDealId)).legalName, "Admin Renamed LLC")

  const repCommit = await commitUpdatePost(cookieRequest(`/api/mca/imports/update/${previewBody.runId}/commit`, "rep-session-token", {
    method: "POST",
    body: JSON.stringify({ expectedPreviewRevision: previewBody.previewRevision }),
  }), params(previewBody.runId))
  assert.equal(repCommit.status, 403)
})
