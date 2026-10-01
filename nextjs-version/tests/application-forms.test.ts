import "./helpers/business-auth"
import test, { before, after } from "node:test"
import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { createPostgresTestDatabase } from "./helpers/postgres-test-db.mjs"
import { closeDatabaseForTests, getDatabase, nowIso } from "../src/lib/mca/db"
import { hashOpaqueToken } from "../src/lib/mca/crypto"
import type { DealActor } from "../src/lib/mca/deals/schema"
import { setDocumentScannerForTests } from "../src/lib/mca/documents/scanner"
import { availableApplicationForms, copyApplicationLink, createApplicationInvitation, listApplicationInvitations } from "../src/lib/mca/applications/service"
import { saveApplicationDraft, getApplicationSession } from "../src/lib/mca/applications/draft"
import { stageInvitationFile } from "../src/lib/mca/applications/files"
import { submitFundlaneApplication } from "../src/lib/mca/applications/submit"
import { processInvitationReminder, scheduleDueInvitationReminders } from "../src/lib/mca/applications/reminders"
import { GET as listRoute, POST as createRoute } from "../src/app/api/mca/applications/route"
import { GET as sessionGet, PATCH as sessionPatch } from "../src/app/api/applications/session/route"
import { POST as submitRoute } from "../src/app/api/applications/submit/route"
import type { BackgroundJob } from "../src/lib/mca/jobs/queue"

let fixture: Awaited<ReturnType<typeof createPostgresTestDatabase>> | undefined
const origin = "https://fundlane.example.test"
const workspace = "forms-workspace"
const actions = { createDeal: true, exportDeals: true, inviteUsers: true, manageApiKeys: true, viewPaymentTable: true, viewCompanyFinancials: true }
const actor = (name: string, role: DealActor["role"] = "rep"): DealActor => ({
  workspaceId: workspace, userId: `user-${name}`, membershipId: `member-${name}`, role, source: "user",
  managedMembershipIds: [], activeMembershipIds: ["member-admin", "member-ada"], correlationId: "forms-test", sessionId: `session-${name}`,
})
const admin = actor("admin", "admin"), ada = actor("ada"), bob = actor("bob")
const pdf = Uint8Array.from(Buffer.from("%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n"))
const answers = {
  legalName: "Harbor Bakery LLC",
  entityType: "llc",
  ein: "12-3456789",
  address: { line1: "1 Main St", city: "Austin", state: "TX", postalCode: "78701", country: "US" },
  startDate: "2019-04-01",
  industry: "Food service",
  monthlyRevenue: 42000,
  requestedAmount: 75000,
  fundingPurpose: "Expansion",
  contactName: "Alex Harbor",
  contactPhone: "5125550100",
  owners: [{ firstName: "Alex", lastName: "Harbor", ownershipPercent: 100, isPrimary: true }],
}

before(async () => {
  process.env.MCA_APPLICATION_INVITATION_EMAIL_ENABLED = "true"
  process.env.MCA_EMAIL_SENDER_VERIFIED = "true"
  fixture = await createPostgresTestDatabase("forms")
  Object.assign(process.env, fixture.env())
  delete process.env.MCA_BACKGROUND_JOBS
  delete process.env.VERCEL
  setDocumentScannerForTests({ name: "test", scan: async () => ({ status: "clean", provider: "test", evidence: {} }) })
  const db = getDatabase(), at = nowIso()
  await db.prepare(`INSERT INTO workspaces(id,name,timezone,seat_limit,feature_flags,page_visibility,action_visibility,created_at,updated_at) VALUES (?,?,'America/New_York',10,?,?,?,?,?)`).run(
    workspace, workspace, JSON.stringify({ reports: true, payments: true, integrations: true }),
    JSON.stringify({ dashboard: true, deals: true, users: true, reports: true, payments: true, workspace: true, integrations: true }),
    JSON.stringify(actions), at, at,
  )
  for (const a of [admin, ada, bob]) {
    await db.prepare("INSERT INTO users(id,email,name,application_identifier,created_at,updated_at) VALUES (?,?,?,?,?,?)").run(a.userId, `${a.userId}@example.test`, a.userId, a.userId, at, at)
    await db.prepare("INSERT INTO memberships(id,workspace_id,user_id,role,status,created_at,updated_at) VALUES (?,?,?,?,'active',?,?)").run(a.membershipId, a.workspaceId, a.userId, a.role, at, at)
    await db.prepare("INSERT INTO sessions(id,user_id,membership_id,token_hash,expires_at,created_at,last_seen_at) VALUES (?,?,?,?,?,?,?)").run(a.sessionId, a.userId, a.membershipId, hashOpaqueToken(a.membershipId!), new Date(Date.now() + 86400000).toISOString(), at, at)
  }
})
after(async () => {
  setDocumentScannerForTests()
  await closeDatabaseForTests(); await fixture?.close()
})

function request(path: string, a: DealActor | null, method = "GET", body?: unknown) {
  return new Request(`${origin}${path}`, { method, headers: { ...(a ? { cookie: `mca_session=${a.membershipId}` } : {}), ...(body ? { "content-type": "application/json" } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) })
}

async function invite() {
  const forms = await availableApplicationForms(ada)
  const fundlane = forms.find(form => form.provider === "fundlane")
  assert.ok(fundlane)
  const created = await createApplicationInvitation(ada, { clientName: "Harbor Bakery", email: "harbor@example.test", integrationId: fundlane.id, requestKey: randomUUID() })
  const link = await copyApplicationLink(ada, created.id, origin)
  const token = new URL(link.url).searchParams.get("mca_invite")!
  return { ...created, token, form: fundlane }
}

test("auto-provisions a Fundlane form so invitations do not require Jotform", async () => {
  const forms = await availableApplicationForms(ada)
  assert.equal(forms.some(form => form.provider === "fundlane"), true)
  const listed = await listRoute(request("/api/mca/applications", ada))
  assert.equal(listed.status, 200)
  const body = await listed.json() as { forms: Array<{ provider: string }> }
  assert.equal(body.forms[0]?.provider, "fundlane")
  const created = await createRoute(request("/api/mca/applications", ada, "POST", { clientName: "No Jotform", email: "none@example.test", integrationId: forms[0].id, requestKey: randomUUID() }))
  assert.equal(created.status, 201)
})

test("draft save/resume denormalizes requested amount and rejects expired tokens", async () => {
  const invitation = await invite()
  const saved = await saveApplicationDraft(invitation.token, "requestedAmount", { ...answers, requestedAmount: 88000 })
  assert.equal(saved.answers.requestedAmount, 88000)
  assert.equal(saved.step, "requestedAmount")
  const listed = await listApplicationInvitations(ada)
  const row = listed.find(item => item.id === invitation.id)
  assert.equal(row?.requestedAmountCents, 8800000)
  assert.equal(row?.businessName, "Harbor Bakery LLC")
  const again = await getApplicationSession(invitation.token)
  assert.equal(again.answers.legalName, "Harbor Bakery LLC")
  await getDatabase().prepare("UPDATE mca_application_invitations SET expires_at='2000-01-01T00:00:00.000Z' WHERE id=?").run(invitation.id)
  await assert.rejects(saveApplicationDraft(invitation.token, "legalName", answers), (error: { code?: string }) => error.code === "invitation_inactive")
})

test("files scan, submit claims the invitation, and a second submit is quarantined", async () => {
  const invitation = await invite()
  await saveApplicationDraft(invitation.token, "review", answers)
  for (let index = 0; index < 3; index += 1) {
    await stageInvitationFile({ token: invitation.token, idempotencyKey: `stmt-${index}`, category: "statement", filename: `statement-${index}.pdf`, mimeType: "application/pdf", bytes: pdf })
  }
  const submitted = await submitFundlaneApplication(invitation.token)
  assert.equal(submitted.submitted, true)
  const row = (await listApplicationInvitations(ada)).find(item => item.id === invitation.id)
  assert.ok(row?.dealId)
  assert.equal(row?.requestedAmountCents, 7500000)
  await assert.rejects(submitFundlaneApplication(invitation.token), (error: { code?: string }) => error.code === "invitation_inactive" || error.code === "invitation_quarantined")
})

test("reminders wait two hours, cap at three, and skip completed applications", async () => {
  const invitation = await invite()
  await saveApplicationDraft(invitation.token, "legalName", { legalName: "Reminder Co" })
  assert.equal(await scheduleDueInvitationReminders(origin, new Date()), 0)
  const past = new Date(Date.now() - 3 * 3600_000).toISOString()
  await getDatabase().prepare("UPDATE mca_application_invitations SET last_activity_at=?, started_at=? WHERE id=?").run(past, past, invitation.id)
  assert.equal(await scheduleDueInvitationReminders(origin, new Date()), 1)
  const job = await getDatabase().prepare<BackgroundJob>("SELECT * FROM mca_background_jobs WHERE kind='application_invitation_reminder' ORDER BY created_at DESC LIMIT 1").get()
  assert.ok(job)
  await getDatabase().prepare("UPDATE mca_background_jobs SET state='running',lease_token='forms-lease' WHERE id=?").run(job.id)
  const result = await processInvitationReminder({ ...job, state: "running", lease_token: "forms-lease" })
  assert.ok(result.delivery === "preview" || result.delivery === "sent")
  const after = (await listApplicationInvitations(ada)).find(item => item.id === invitation.id)
  assert.equal(after?.reminderCount, 1)
  await getDatabase().prepare("UPDATE mca_application_invitations SET submitted_at=? WHERE id=?").run(nowIso(), invitation.id)
  await getDatabase().prepare("UPDATE mca_application_invitations SET last_activity_at=?, reminder_count=1 WHERE id=?").run(new Date(Date.now() - 30 * 3600_000).toISOString(), invitation.id)
  assert.equal(await scheduleDueInvitationReminders(origin, new Date()), 0)
})

test("public session routes accept the invitation token without a login", async () => {
  const invitation = await invite()
  const opened = await sessionGet(request(`/api/applications/session?token=${invitation.token}`, null))
  assert.equal(opened.status, 200)
  const patched = await sessionPatch(request("/api/applications/session", null, "PATCH", { token: invitation.token, step: "legalName", answers: { legalName: "Route Bakery" } }))
  assert.equal(patched.status, 200)
  const rejected = await submitRoute(request("/api/applications/submit", null, "POST", { token: invitation.token }))
  assert.equal(rejected.status, 422)
})

test("revoked, rebound and disabled invitations reject public drafts and uploads", async () => {
  for (const condition of ["revoked", "rebound", "disabled"] as const) {
    const invitation = await invite()
    const db = getDatabase()
    if (condition === "revoked") await db.prepare("UPDATE mca_application_invitations SET revoked_at=? WHERE id=?").run(nowIso(), invitation.id)
    if (condition === "rebound") await db.prepare("UPDATE mca_application_invitations SET form_id='wrong-form' WHERE id=?").run(invitation.id)
    if (condition === "disabled") await db.prepare("UPDATE intake_integrations SET enabled=0 WHERE id=?").run(invitation.form.id)
    const session = await sessionGet(request(`/api/applications/session?token=${invitation.token}`, null))
    assert.equal(session.status, 410, condition)
    await assert.rejects(saveApplicationDraft(invitation.token, "legalName", answers), (error: { code?: string }) => error.code === "invitation_inactive")
    await assert.rejects(stageInvitationFile({ token: invitation.token, idempotencyKey: randomUUID(), category: "statement", filename: "synthetic.pdf", mimeType: "application/pdf", bytes: pdf }), (error: { code?: string }) => error.code === "invitation_inactive")
    if (condition === "disabled") await db.prepare("UPDATE intake_integrations SET enabled=1 WHERE id=?").run(invitation.form.id)
  }
})

test("server submit rejects invalid required details without consuming invitation", async () => {
  for (const invalid of [
    { startDate: "2025-02-30" }, { contactPhone: "bad-number" },
    { address: { ...answers.address, postalCode: "abc" } },
    { owners: [{ firstName: "A", lastName: "B", ownershipPercent: -10 }, { firstName: "C", lastName: "D", ownershipPercent: 110 }] },
  ]) {
    const invitation = await invite()
    await saveApplicationDraft(invitation.token, "review", { ...answers, ...invalid })
    const response = await submitRoute(request("/api/applications/submit", null, "POST", { token: invitation.token }))
    assert.equal(response.status, 422)
    const body = await response.json()
    assert.equal(body.error.code, "application_incomplete")
    const row = (await listApplicationInvitations(ada)).find(item => item.id === invitation.id)
    assert.equal(row?.submittedAt, null)
    assert.equal(row?.dealId, null)
  }
})

test("server does not treat pending or quarantined statements as accepted", async () => {
  try {
    for (const status of ["unavailable", "infected"] as const) {
      const invitation = await invite()
      await saveApplicationDraft(invitation.token, "review", answers)
      setDocumentScannerForTests({ name: "blocked-fixture", scan: async () => ({ status, provider: "blocked-fixture", evidence: {} }) })
      const upload = () => stageInvitationFile({ token: invitation.token, idempotencyKey: randomUUID(), category: "statement", filename: "blocked.pdf", mimeType: "application/pdf", bytes: pdf })
      if (status === "infected") await assert.rejects(upload(), (error: { code?: string }) => error.code === "file_quarantined")
      else await upload()
      setDocumentScannerForTests({ name: "test", scan: async () => ({ status: "clean", provider: "test", evidence: {} }) })
      for (let index = 0; index < 3; index++) await stageInvitationFile({ token: invitation.token, idempotencyKey: randomUUID(), category: "statement", filename: `clean-${index}.pdf`, mimeType: "application/pdf", bytes: pdf })
      await assert.rejects(submitFundlaneApplication(invitation.token), (error: { code?: string }) => error.code === "file_not_ready")
      const row = (await listApplicationInvitations(ada)).find(item => item.id === invitation.id)
      assert.equal(row?.submittedAt, null)
      assert.equal(row?.dealId, null)
    }
  } finally { setDocumentScannerForTests({ name: "test", scan: async () => ({ status: "clean", provider: "test", evidence: {} }) }) }
})

test("tenant and employee scope prevent unauthorized invitation access", async () => {
  const invitation = await invite()
  const at = nowIso()
  await getDatabase().prepare(`INSERT INTO workspaces(id,name,timezone,seat_limit,feature_flags,page_visibility,action_visibility,created_at,updated_at) VALUES (?,?,'America/New_York',10,?,?,?,?,?)`).run(
    "other-tenant", "Other synthetic company", JSON.stringify({ reports: true }), JSON.stringify({ deals: true }), JSON.stringify(actions), at, at,
  )
  await getDatabase().prepare("INSERT INTO memberships(id,workspace_id,user_id,role,status,created_at,updated_at) VALUES (?,?,?,'admin','active',?,?)").run("other-admin", "other-tenant", admin.userId, at, at)
  const otherTenant = { ...admin, workspaceId: "other-tenant", membershipId: "other-admin" }
  const { ownedInvitation, claimInvitationSubmission } = await import("../src/lib/mca/applications/service")
  await assert.rejects(ownedInvitation(otherTenant, invitation.id), (error: { status?: number; code?: string }) => error.status === 404 && error.code === "invitation_not_found")
  await assert.rejects(ownedInvitation({ ...admin, role: "rep" }, invitation.id), (error: { status?: number; code?: string }) => error.status === 403 && error.code === "membership_changed")
  await assert.rejects(ownedInvitation(bob, invitation.id), (error: { status?: number }) => error.status === 404)
  await assert.rejects(claimInvitationSubmission(invitation.token, "other-tenant", invitation.form.id, randomUUID()), (error: { code?: string }) => error.code === "invitation_quarantined")
})
