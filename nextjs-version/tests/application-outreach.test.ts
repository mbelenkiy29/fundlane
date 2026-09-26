import "./helpers/business-auth"
import test, { before, after } from "node:test"
import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { createPostgresTestDatabase } from "./helpers/postgres-test-db.mjs"
import { closeDatabaseForTests, getDatabase, newId, nowIso } from "../src/lib/mca/db"
import { hashOpaqueToken } from "../src/lib/mca/crypto"
import type { DealActor } from "../src/lib/mca/deals/schema"
import type { MembershipContext } from "../src/lib/mca/types"
import { getDeal } from "../src/lib/mca/deals/service"
import { configureIntegration, createJotformRepLink } from "../src/lib/mca/intake/configuration"
import { ingestProviderDelivery } from "../src/lib/mca/intake/ingress"
import { createApplicationInvitation, copyApplicationLink, invitationEmailEnabled, listApplicationInvitations, ownedInvitation, processInvitationEmail, queueInvitationEmail, resolveApplicationInvitation, trackApplicationInvitation } from "../src/lib/mca/applications/service"
import { getApplicationOutreachReport } from "../src/lib/mca/applications/report"
import { OUTREACH_METRICS } from "../src/lib/mca/applications/contracts"
import { invitationStatus } from "../src/components/mca/applications/invitation-status"
import { claimBackgroundJob, completeBackgroundJob, failBackgroundJob, type BackgroundJob } from "../src/lib/mca/jobs/queue"
import { GET as listRoute, POST as createRoute } from "../src/app/api/mca/applications/route"
import { POST as sendRoute } from "../src/app/api/mca/applications/[invitationId]/send/route"
import { POST as reconcileRoute } from "../src/app/api/mca/applications/[invitationId]/reconcile/route"
import { POST as linkRoute } from "../src/app/api/mca/applications/[invitationId]/link/route"
import { POST as trackRoute } from "../src/app/api/applications/track/route"
import { GET as reportRoute } from "../src/app/api/mca/reports/application-outreach/route"

let fixture: Awaited<ReturnType<typeof createPostgresTestDatabase>> | undefined
let connection: Awaited<ReturnType<typeof configureIntegration>>
let otherConnection: Awaited<ReturnType<typeof configureIntegration>>
const originalFetch = globalThis.fetch
process.env.MCA_APPLICATION_INVITATION_EMAIL_ENABLED = "true"
process.env.MCA_EMAIL_SENDER_VERIFIED = "true"
const originalEmailUrl = process.env.MCA_EMAIL_WEBHOOK_URL
const origin = "https://fundlane.example.test"
const workspace = "outreach-workspace", otherWorkspace = "outreach-other"
const actions = { createDeal: true, exportDeals: true, inviteUsers: true, manageApiKeys: true, viewPaymentTable: true, viewCompanyFinancials: true }
const actor = (name: string, role: DealActor["role"] = "rep", ws = workspace): DealActor => ({ workspaceId: ws, userId: `user-${name}`, membershipId: `member-${name}`, role, source: "user", managedMembershipIds: [], activeMembershipIds: ["member-admin", "member-ada", "member-beau", "member-manager"], correlationId: "outreach-test", sessionId: `session-${name}` })
const admin = actor("admin", "admin"), ada = actor("ada"), beau = actor("beau"), manager = actor("manager", "manager"), other = actor("other", "admin", otherWorkspace)
const context = (a: DealActor): MembershipContext => ({ authType: "session", workspaceId: a.workspaceId, userId: a.userId!, membershipId: a.membershipId!, role: a.role!, scopes: [], sessionId: a.sessionId! })
const code = (expected: string) => (error: unknown) => (error as { code?: string }).code === expected

before(async () => {
  delete process.env.MCA_EMAIL_WEBHOOK_URL
  fixture = await createPostgresTestDatabase("outreach")
  Object.assign(process.env, fixture.env())
  const db = getDatabase(), at = nowIso()
  for (const ws of [workspace, otherWorkspace]) {
    await db.prepare(`INSERT INTO workspaces(id,name,timezone,seat_limit,feature_flags,page_visibility,action_visibility,created_at,updated_at) VALUES (?,?,'America/New_York',10,?,?,?,?,?)`).run(ws, ws, JSON.stringify({ reports: true, payments: true, integrations: true }), JSON.stringify({ dashboard: true, deals: true, users: true, reports: true, payments: true, workspace: true, integrations: true }), JSON.stringify(actions), at, at)
  }
  for (const a of [admin, ada, beau, manager, other]) {
    await db.prepare("INSERT INTO users(id,email,name,application_identifier,created_at,updated_at) VALUES (?,?,?,?,?,?)").run(a.userId, `${a.userId}@example.test`, a.userId, a.userId, at, at)
    await db.prepare("INSERT INTO memberships(id,workspace_id,user_id,role,status,created_at,updated_at) VALUES (?,?,?,?,'active',?,?)").run(a.membershipId, a.workspaceId, a.userId, a.role, at, at)
    await db.prepare("INSERT INTO sessions(id,user_id,membership_id,token_hash,expires_at,created_at,last_seen_at) VALUES (?,?,?,?,?,?,?)").run(a.sessionId, a.userId, a.membershipId, hashOpaqueToken(a.membershipId!), new Date(Date.now() + 86400000).toISOString(), at, at)
  }
  connection = await configureIntegration(context(admin), { provider: "jotform", displayName: "Funding application", formId: "240000000001234", credential: "fixture-only", mapping: { legalName: "business", contactEmail: "email" }, allowedHosts: [] })
  otherConnection = await configureIntegration(context(other), { provider: "jotform", displayName: "Other company", formId: "240000000005678", credential: "fixture-only", mapping: { legalName: "business", contactEmail: "email" }, allowedHosts: [] })
})
after(async () => {
  globalThis.fetch = originalFetch
  if (originalEmailUrl === undefined) delete process.env.MCA_EMAIL_WEBHOOK_URL; else process.env.MCA_EMAIL_WEBHOOK_URL = originalEmailUrl
  await closeDatabaseForTests(); await fixture?.close()
})
async function invite(a = ada, name = `Client ${randomUUID()}`) {
  const created = await createApplicationInvitation(a, { clientName: name, email: "client@example.test", integrationId: connection.status.id, requestKey: randomUUID() })
  const link = await copyApplicationLink(a, created.id, origin)
  const token = new URL(link.url).searchParams.get("mca_invite")!
  return { ...created, token, url: link.url }
}
async function deliver(token: string, eventId = randomUUID(), integration = connection, business = "Harbor Bakery") {
  const rawBody = JSON.stringify({ formID: integration.status.binding, submissionID: eventId, rawRequest: JSON.stringify({ business, email: "client@example.test", mca_invite: token }) })
  return ingestProviderDelivery({ provider: "jotform", integrationId: integration.status.id, rawBody, request: new Request(`${origin}/hook`, { method: "POST", headers: { authorization: `Bearer ${integration.admissionSecret}` }, body: rawBody }) })
}
function request(path: string, a: DealActor | null, method = "GET", body?: unknown) {
  return new Request(`${origin}${path}`, { method, headers: { ...(a ? { cookie: `mca_session=${a.membershipId}` } : {}), ...(body ? { "content-type": "application/json" } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) })
}
async function runningJob(id: string) {
  await getDatabase().prepare("UPDATE mca_background_jobs SET state='running',attempts=attempts+1,lease_token='outreach-lease' WHERE id=?").run(id)
  return (await getDatabase().prepare<BackgroundJob>("SELECT * FROM mca_background_jobs WHERE id=?").get(id))!
}

test("invitation creation is idempotent, rejects forged sender fields, and keeps independent client links", async () => {
  const input = { clientName: "First client", email: "first@example.test", integrationId: connection.status.id, requestKey: randomUUID() }
  const first = await createApplicationInvitation(ada, input)
  assert.equal((await createApplicationInvitation(ada, input)).id, first.id)
  await assert.rejects(createApplicationInvitation(ada, { ...input, clientName: "Different client" }), code("invitation_conflict"))
  await assert.rejects(createApplicationInvitation(ada, { ...input, membershipId: beau.membershipId }), code("invalid_invitation"))
  const link = await copyApplicationLink(ada, first.id, origin)
  const second = await invite()
  assert.notEqual(link.url, second.url)
  assert.ok(await resolveApplicationInvitation(new URL(link.url).searchParams.get("mca_invite")!))
  const row = await ownedInvitation(ada, first.id)
  assert.equal(Date.parse(row.expires_at) - Date.parse(row.created_at), 30 * 86400000)
  assert.ok(!row.token_cipher.includes(new URL(link.url).searchParams.get("mca_invite")!))
  assert.equal(row.sent_at, null)
})

test("public observations deduplicate and tolerate a start arriving before its open", async () => {
  const invitation = await invite()
  await trackApplicationInvitation(invitation.token, "started")
  const first = await ownedInvitation(ada, invitation.id)
  await Promise.all([trackApplicationInvitation(invitation.token, "opened"), trackApplicationInvitation(invitation.token, "started")])
  const updated = await ownedInvitation(ada, invitation.id)
  assert.equal(first.opened_at, updated.opened_at)
  assert.equal(first.started_at, updated.started_at)
  const events = await getDatabase().prepare("SELECT * FROM mca_application_invitation_events WHERE invitation_id=?").all(invitation.id)
  assert.equal(events.length, 2)
  assert.equal(updated.sent_at, null)
  assert.equal(updated.submitted_at, null)
  assert.equal((await trackRoute(request("/api/applications/track", null, "POST", { token: invitation.token, kind: "opened" }))).status, 200)
  await assert.rejects(trackApplicationInvitation("bad-token", "opened"), code("invitation_inactive"))
})

test("two reps share a form; submission attribution is atomic, idempotent, and immutable after reassignment", async () => {
  const a = await invite(ada, "Attribution A"), b = await invite(beau, "Attribution B")
  const submissionId = randomUUID()
  const results = await Promise.all([deliver(a.token, submissionId), deliver(a.token, submissionId)])
  assert.equal(results[0].dealId, results[1].dealId)
  const aDeal = results[0].dealId!
  assert.equal((await getDeal(admin, aDeal)).assignments[0].membershipId, ada.membershipId)
  const bResult = await deliver(b.token)
  assert.equal((await getDeal(admin, bResult.dealId!)).assignments[0].membershipId, beau.membershipId)
  await getDatabase().prepare("UPDATE deal_assignments SET membership_id=? WHERE workspace_id=? AND deal_id=?").run(beau.membershipId, workspace, aDeal)
  assert.equal((await deliver(a.token, submissionId)).dealId, aDeal)
  assert.equal((await ownedInvitation(admin, a.id)).membership_id, ada.membershipId)
  await assert.rejects(deliver(a.token), code("invitation_quarantined"))
  await assert.rejects(deliver(a.token, submissionId, connection, "Changed payload"), code("intake_event_conflict"))
  assert.equal((await ownedInvitation(admin, a.id)).deal_id, aDeal)
  // Future expiry and deactivation do not prevent reconciliation of an already accepted event.
  await getDatabase().prepare("UPDATE mca_application_invitations SET expires_at='2000-01-01T00:00:00.000Z' WHERE id=?").run(a.id)
  assert.equal((await deliver(a.token, submissionId)).dealId, aDeal)
  await assert.rejects(copyApplicationLink(ada, a.id, origin), code("invitation_inactive"))
})

test("competing different submissions consume one invitation once and place the loser in review", async () => {
  const invitation = await invite()
  const outcomes = await Promise.allSettled([deliver(invitation.token), deliver(invitation.token)])
  assert.equal(outcomes.filter(result => result.status === "fulfilled").length, 1)
  const rejected = outcomes.find(result => result.status === "rejected") as PromiseRejectedResult
  assert.equal(rejected.reason.code, "invitation_quarantined")
  assert.ok((await ownedInvitation(ada, invitation.id)).deal_id)
})

test("cross-company tokens, expired/revoked links, and disabled members or forms fail closed", async () => {
  const invitation = await invite()
  await assert.rejects(deliver(invitation.token, randomUUID(), otherConnection), code("invitation_quarantined"))
  await assert.rejects(deliver(`${invitation.token.slice(0, -1)}!`), code("invitation_quarantined"))
  for (const patch of ["expires_at='2000-01-01T00:00:00.000Z'", "revoked_at='2026-01-01T00:00:00.000Z'"]) {
    const link = await invite()
    await getDatabase().prepare(`UPDATE mca_application_invitations SET ${patch} WHERE id=?`).run(link.id)
    await assert.rejects(deliver(link.token), code("invitation_quarantined"))
    await assert.rejects(trackApplicationInvitation(link.token, "started"), code("invitation_inactive"))
  }
  await getDatabase().prepare("UPDATE memberships SET status='deactivated' WHERE id=?").run(ada.membershipId)
  try { await assert.rejects(deliver(invitation.token), code("invitation_quarantined")) } finally { await getDatabase().prepare("UPDATE memberships SET status='active' WHERE id=?").run(ada.membershipId) }
  await getDatabase().prepare("UPDATE intake_integrations SET enabled=0 WHERE id=?").run(connection.status.id)
  try { await assert.rejects(trackApplicationInvitation(invitation.token, "opened"), code("invitation_inactive")) } finally { await getDatabase().prepare("UPDATE intake_integrations SET enabled=1 WHERE id=?").run(connection.status.id) }
  await getDatabase().prepare("UPDATE intake_integrations SET form_id='240000000009999' WHERE id=?").run(connection.status.id)
  try {
    await assert.rejects(copyApplicationLink(ada, invitation.id, origin), code("invitation_inactive"))
    await assert.rejects(trackApplicationInvitation(invitation.token, "opened"), code("invitation_inactive"))
    assert.equal((await ownedInvitation(ada, invitation.id)).form_id, connection.status.binding)
  } finally { await getDatabase().prepare("UPDATE intake_integrations SET form_id=? WHERE id=?").run(connection.status.binding, connection.status.id) }
})

test("direct APIs enforce authentication, ownership, admin reporting, and mutation permissions", async () => {
  const invitation = await invite()
  assert.equal((await listRoute(request("/api/mca/applications", null))).status, 401)
  for (const unauthorized of [beau, manager, other]) {
    await assert.rejects(copyApplicationLink(unauthorized, invitation.id, origin), code("invitation_not_found"))
    const response = await linkRoute(request(`/api/mca/applications/${invitation.id}/link`, unauthorized, "POST"), { params: Promise.resolve({ invitationId: invitation.id }) })
    assert.equal(response.status, 404)
  }
  assert.equal((await reportRoute(request("/api/mca/reports/application-outreach", ada))).status, 403)
  assert.equal((await reportRoute(request("/api/mca/reports/application-outreach", admin))).status, 200)
  const response = await listRoute(request("/api/mca/applications", beau))
  const data = await response.json()
  assert.ok(data.invitations.every((row: { membershipId: string }) => row.membershipId === beau.membershipId))
  assert.equal(JSON.stringify(data).includes("token_cipher"), false)
  assert.equal(JSON.stringify(data).includes("mca_invite"), false)
  const forged = await createRoute(request("/api/mca/applications", ada, "POST", { clientName: "Forged", email: "x@example.test", integrationId: connection.status.id, membershipId: beau.membershipId, requestKey: randomUUID() }))
  assert.equal(forged.status, 400)
  await getDatabase().prepare("UPDATE workspaces SET action_visibility=? WHERE id=?").run(JSON.stringify({ ...actions, createDeal: false }), workspace)
  try {
    const denied = await sendRoute(request(`/api/mca/applications/${invitation.id}/send`, ada, "POST", { requestKey: randomUUID() }), { params: Promise.resolve({ invitationId: invitation.id }) })
    assert.equal(denied.status, 403)
  } finally { await getDatabase().prepare("UPDATE workspaces SET action_visibility=? WHERE id=?").run(JSON.stringify(actions), workspace) }
})

test("email previews do not count; retry and resend delivery preserve identities without inflating invitations", async () => {
  const invitation = await invite()
  const firstKey = randomUUID()
  const previewQueued = await queueInvitationEmail(ada, invitation.id, firstKey, origin)
  const duplicateQueue = await queueInvitationEmail(ada, invitation.id, firstKey, origin)
  assert.equal(previewQueued.jobId, duplicateQueue.jobId)
  const previewJob = await runningJob(previewQueued.jobId)
  assert.equal((await processInvitationEmail(ada, previewJob)).delivery, "preview")
  await completeBackgroundJob(previewJob, { delivery: "preview" })
  assert.equal((await ownedInvitation(ada, invitation.id)).sent_at, null)
  assert.equal((await queueInvitationEmail(ada, invitation.id, firstKey, origin)).jobId, previewJob.id)

  process.env.MCA_EMAIL_WEBHOOK_URL = "https://mail.example.test/webhook"
  const keys: string[] = [], messages: Record<string, unknown>[] = []
  let simulateFailure = true
  const priorRuntime = process.env.MCA_JOB_RUNTIME
  process.env.MCA_JOB_RUNTIME = "vercel_cron"
  globalThis.fetch = async (_url, init) => {
    keys.push(new Headers(init?.headers).get("idempotency-key")!)
    messages.push(JSON.parse(String(init?.body)))
    return new Response("", { status: simulateFailure ? 503 : 200 })
  }
  try {
    const queued = await queueInvitationEmail(ada, invitation.id, randomUUID(), origin)
    const failedJob = await runningJob(queued.jobId)
    let failure: unknown
    try { await processInvitationEmail(ada, failedJob) } catch (error) { failure = error }
    assert.ok(failure)
    await failBackgroundJob({ ...failedJob, attempts: 3 }, failure)
    assert.equal((await ownedInvitation(ada, invitation.id)).sent_at, null)
    await assert.rejects(queueInvitationEmail(ada, invitation.id, randomUUID(), origin), { code: "delivery_uncertain" })
    const listed = (await listApplicationInvitations(ada)).find(row => row.id === invitation.id)!
    assert.equal(listed.deliveries[0].requiresReconciliation, true)
    assert.equal(invitationStatus(listed), "Email needs reconciliation")
    assert.equal(invitationStatus({ ...listed, sentAt: nowIso() }), "Email needs reconciliation")
    const reconciliationPath = `/api/mca/applications/${invitation.id}/reconcile`
    const reconciliation = { deliveryId: listed.deliveries[0].id, outcome: "accepted", evidence: "provider-receipt-accepted-123" }
    assert.equal((await reconcileRoute(request(reconciliationPath, ada, "POST", reconciliation), { params: Promise.resolve({ invitationId: invitation.id }) })).status, 403)
    assert.equal((await reconcileRoute(request(reconciliationPath, other, "POST", reconciliation), { params: Promise.resolve({ invitationId: invitation.id }) })).status, 404)
    assert.equal((await reconcileRoute(request(reconciliationPath, admin, "POST", { ...reconciliation, evidence: "short" }), { params: Promise.resolve({ invitationId: invitation.id }) })).status, 400)
    simulateFailure = false
    const retryJob = await runningJob(queued.jobId)
    await assert.rejects(processInvitationEmail(ada, retryJob), { code: "delivery_uncertain" })
    assert.equal(keys.length, 1)
    assert.equal(messages[0].template, "application_invitation")
    assert.equal(messages[0].actionUrl, invitation.url)
    assert.equal((await ownedInvitation(ada, invitation.id)).sent_at, null)
    await getDatabase().prepare("UPDATE mca_background_jobs SET state='failed' WHERE id=?").run(queued.jobId)
    assert.equal((await reconcileRoute(request(reconciliationPath, admin, "POST", reconciliation), { params: Promise.resolve({ invitationId: invitation.id }) })).status, 200)
    assert.equal((await reconcileRoute(request(reconciliationPath, admin, "POST", reconciliation), { params: Promise.resolve({ invitationId: invitation.id }) })).status, 409)
    assert.equal(keys.length, 1)
    assert.ok((await ownedInvitation(ada, invitation.id)).sent_at)
    assert.equal((await getDatabase().prepare<{ state: string }>("SELECT state FROM mca_background_jobs WHERE id=?").get(queued.jobId))?.state, "complete")
    assert.equal((await listApplicationInvitations(ada)).find(row => row.id === invitation.id)!.deliveries[0].requiresReconciliation, false)
    const audit = await getDatabase().prepare<{ metadata: string }>("SELECT metadata FROM audit_events WHERE resource_id=? AND action='application_invitation_delivery_reconciled'").get(reconciliation.deliveryId)
    assert.equal(JSON.parse(audit!.metadata).evidence, reconciliation.evidence)
  } finally { globalThis.fetch = originalFetch; delete process.env.MCA_EMAIL_WEBHOOK_URL; if (priorRuntime === undefined) delete process.env.MCA_JOB_RUNTIME; else process.env.MCA_JOB_RUNTIME = priorRuntime }
})

test("provider-confirmed absence requeues the same invitation identity once", async () => {
  const invitation = await invite()
  const priorRuntime = process.env.MCA_JOB_RUNTIME
  process.env.MCA_JOB_RUNTIME = "vercel_cron"
  process.env.MCA_EMAIL_WEBHOOK_URL = "https://mail.example.test/webhook"
  const keys: string[] = []
  let fail = true
  globalThis.fetch = async (_url, init) => {
    keys.push(new Headers(init?.headers).get("idempotency-key")!)
    return new Response("", { status: fail ? 503 : 200 })
  }
  try {
    const queued = await queueInvitationEmail(ada, invitation.id, randomUUID(), origin)
    const first = await runningJob(queued.jobId)
    await assert.rejects(processInvitationEmail(ada, first))
    await failBackgroundJob({ ...first, attempts: 3 }, new Error("provider unavailable"))
    delete process.env.MCA_JOB_RUNTIME
    assert.equal((await listApplicationInvitations(ada)).find(row => row.id === invitation.id)!.deliveries[0].requiresReconciliation, true)
    await assert.rejects(queueInvitationEmail(ada, invitation.id, randomUUID(), origin), code("delivery_uncertain"))
    process.env.MCA_JOB_RUNTIME = "vercel_cron"
    const delivery = (await listApplicationInvitations(admin)).find(row => row.id === invitation.id)!.deliveries[0]
    const path = `/api/mca/applications/${invitation.id}/reconcile`
    const input = { deliveryId: delivery.id, outcome: "not_sent", evidence: "provider-lookup-empty-456" }
    assert.equal((await reconcileRoute(request(path, admin, "POST", input), { params: Promise.resolve({ invitationId: invitation.id }) })).status, 200)
    assert.equal((await reconcileRoute(request(path, admin, "POST", input), { params: Promise.resolve({ invitationId: invitation.id }) })).status, 409)
    const requeued = await getDatabase().prepare<{ state: string; attempts: number; actor_json: string }>("SELECT state,attempts,actor_json FROM mca_background_jobs WHERE id=?").get(queued.jobId)
    assert.equal(requeued?.state, "queued")
    assert.equal(requeued?.attempts, 0)
    assert.equal(JSON.parse(requeued!.actor_json).userId, admin.userId)
    fail = false
    const retried = await runningJob(queued.jobId)
    assert.equal((await processInvitationEmail(admin, retried)).delivery, "sent")
    await completeBackgroundJob(retried, { delivery: "sent" })
    assert.deepEqual(keys, [delivery.id, delivery.id])
    assert.ok((await ownedInvitation(ada, invitation.id)).sent_at)
  } finally { globalThis.fetch = originalFetch; delete process.env.MCA_EMAIL_WEBHOOK_URL; if (priorRuntime === undefined) delete process.env.MCA_JOB_RUNTIME; else process.env.MCA_JOB_RUNTIME = priorRuntime }
})

test("a paused invitation with no send attempt can be approved again after recovery", async () => {
  const invitation = await invite()
  const firstKey = randomUUID()
  const first = await queueInvitationEmail(ada, invitation.id, firstKey, origin)
  const priorRuntime = process.env.MCA_JOB_RUNTIME
  process.env.MCA_JOB_RUNTIME = "vercel_cron"
  process.env.MCA_EMAIL_WEBHOOK_URL = "https://mail.example.test/webhook"
  let sends = 0
  globalThis.fetch = async () => { sends++; return new Response("", { status: 200 }) }
  try {
    const pausedAt = nowIso()
    await getDatabase().prepare("INSERT INTO company_subscription_state(workspace_id,legacy_exempt,manual_paused,last_paused_at,updated_at) VALUES (?,1,1,?,?) ON CONFLICT(workspace_id) DO UPDATE SET manual_paused=1,last_paused_at=EXCLUDED.last_paused_at").run(workspace, pausedAt, nowIso())
    assert.equal(await claimBackgroundJob(["application_invitation_email"]), undefined)
    const failed = (await getDatabase().prepare<BackgroundJob>("SELECT * FROM mca_background_jobs WHERE id=?").get(first.jobId))!
    assert.equal(failed.state, "failed")
    assert.equal(failed.error_code, "company_paused")
    assert.equal(failed.attempts, 0)
    assert.equal(sends, 0)

    await getDatabase().prepare("UPDATE company_subscription_state SET manual_paused=0 WHERE workspace_id=?").run(workspace)
    assert.equal((await queueInvitationEmail(ada, invitation.id, firstKey, origin)).jobId, first.jobId)
    const renewed = await queueInvitationEmail(ada, invitation.id, randomUUID(), origin)
    assert.notEqual(renewed.jobId, first.jobId)
    const job = await runningJob(renewed.jobId)
    assert.equal((await processInvitationEmail(ada, job)).delivery, "sent")
    await completeBackgroundJob(job, { delivery: "sent" })
    assert.equal(sends, 1)
    assert.equal((await getDatabase().prepare<{ state: string }>("SELECT state FROM mca_background_jobs WHERE id=?").get(first.jobId))?.state, "failed")
    assert.ok((await ownedInvitation(ada, invitation.id)).sent_at)
  } finally {
    await getDatabase().prepare("DELETE FROM company_subscription_state WHERE workspace_id=?").run(workspace)
    globalThis.fetch = originalFetch
    delete process.env.MCA_EMAIL_WEBHOOK_URL
    if (priorRuntime === undefined) delete process.env.MCA_JOB_RUNTIME; else process.env.MCA_JOB_RUNTIME = priorRuntime
  }
})

test("a pause after an earlier invitation send attempt still requires reconciliation", async () => {
  const invitation = await invite()
  const queued = await queueInvitationEmail(ada, invitation.id, randomUUID(), origin)
  const priorRuntime = process.env.MCA_JOB_RUNTIME
  process.env.MCA_JOB_RUNTIME = "vercel_cron"
  try {
    await getDatabase().prepare("UPDATE mca_background_jobs SET attempts=1 WHERE id=?").run(queued.jobId)
    await getDatabase().prepare("INSERT INTO company_subscription_state(workspace_id,legacy_exempt,manual_paused,updated_at) VALUES (?,1,1,?) ON CONFLICT(workspace_id) DO UPDATE SET manual_paused=1").run(workspace, nowIso())
    assert.equal(await claimBackgroundJob(["application_invitation_email"]), undefined)
    await getDatabase().prepare("UPDATE company_subscription_state SET manual_paused=0 WHERE workspace_id=?").run(workspace)
    await assert.rejects(queueInvitationEmail(ada, invitation.id, randomUUID(), origin), code("delivery_uncertain"))
  } finally {
    await getDatabase().prepare("DELETE FROM company_subscription_state WHERE workspace_id=?").run(workspace)
    if (priorRuntime === undefined) delete process.env.MCA_JOB_RUNTIME; else process.env.MCA_JOB_RUNTIME = priorRuntime
  }
})

test("outreach cohort report reconciles to drilldowns and keeps funded credit with the original sender", async () => {
  const invitation = await invite(ada, "Report client")
  const abandoned = await invite(beau, "Awaiting client")
  await trackApplicationInvitation(invitation.token, "started")
  await trackApplicationInvitation(abandoned.token, "opened")
  const created = await deliver(invitation.token)
  const db = getDatabase(), at = nowIso(), dealId = created.dealId!
  await db.prepare("UPDATE mca_application_invitations SET created_at='2026-03-02T04:30:00.000Z' WHERE id IN (?,?)").run(invitation.id, abandoned.id)
  await db.prepare("UPDATE deal_assignments SET membership_id=? WHERE workspace_id=? AND deal_id=?").run(beau.membershipId, workspace, dealId)
  for (let i = 0; i < 5; i++) await db.prepare("INSERT INTO deal_submissions(id,workspace_id,deal_id,funder_name,status) VALUES (?,?,?,?,'sent')").run(newId(), workspace, dealId, `Funder ${i}`)
  await db.prepare("INSERT INTO mca_offers(id,workspace_id,deal_id,funder_name,source,current_revision_id,created_at,updated_at) VALUES ('outreach-offer',?,?,'Funder','manual','outreach-revision',?,?)").run(workspace, dealId, at, at)
  await db.prepare("INSERT INTO mca_offer_revisions(id,workspace_id,offer_id,revision_number,state,amount_cents,effective_at,expires_at,created_at) VALUES ('outreach-revision',?,'outreach-offer',1,'funded',5000000,?,?,?)").run(workspace, at, new Date(Date.parse(at) + 14 * 86_400_000).toISOString(), at)
  await db.prepare("INSERT INTO mca_advances(id,workspace_id,funding_event_id,deal_id,offer_id,offer_revision_id,funded_at,principal_cents,source,status,created_at,updated_at) VALUES ('outreach-advance',?,'outreach-funding',?,'outreach-offer','outreach-revision',?,5000000,'live','active',?,?)").run(workspace, dealId, at, at, at)
  await db.prepare("INSERT INTO mca_funding_events(id,workspace_id,deal_id,offer_id,offer_revision_id,advance_id,idempotency_key,funded_at,amount_cents,source,state,created_at) VALUES ('outreach-funding',?,?,'outreach-offer','outreach-revision','outreach-advance','outreach-funding',?,5000000,'live','committed',?)").run(workspace, dealId, at, at)
  const query = new URLSearchParams({ from: "2026-03-01", to: "2026-03-01" })
  const report = await getApplicationOutreachReport(admin, query)
  assert.equal(report.totals.counts.created, 2)
  assert.equal(report.totals.counts.received, 1)
  assert.equal(report.totals.counts.incomplete, 1)
  assert.equal(report.totals.counts.submitted, 1)
  assert.equal(report.totals.counts.approved, 1)
  assert.equal(report.totals.counts.funded, 1)
  assert.equal(report.totals.fundedAmountCents, 5000000)
  assert.equal(report.totals.conversions.emailedToOpened, null)
  assert.equal(report.totals.conversions.openedToReceived, 0.5)
  assert.equal(report.totals.conversions.receivedToFunded, 1)
  assert.equal(report.reps.find(row => row.membershipId === ada.membershipId)?.counts.funded, 1)
  assert.equal(report.reps.find(row => row.membershipId === beau.membershipId)?.counts.funded, 0)
  for (const metric of OUTREACH_METRICS) assert.equal(report.totals.counts[metric], report.invitations.filter(row => row.stages.includes(metric)).length)
  assert.equal((await getApplicationOutreachReport(admin, new URLSearchParams({ ...Object.fromEntries(query), membershipId: beau.membershipId! }))).totals.counts.created, 1)
  await assert.rejects(getApplicationOutreachReport(admin, new URLSearchParams({ membershipId: other.membershipId! })), code("invalid_employee"))
  await assert.rejects(getApplicationOutreachReport(admin, new URLSearchParams({ from: "2026-02-30" })), code("invalid_period"))
  await db.prepare("UPDATE workspaces SET action_visibility=? WHERE id=?").run(JSON.stringify({ ...actions, viewCompanyFinancials: false }), workspace)
  try {
    const restricted = await getApplicationOutreachReport(admin, query)
    assert.equal(restricted.financialsVisible, false)
    assert.equal(restricted.totals.fundedAmountCents, null)
    assert.ok(restricted.invitations.every(row => row.fundedAmountCents === null))
    assert.ok(restricted.reps.every(row => row.fundedAmountCents === null))
  } finally { await db.prepare("UPDATE workspaces SET action_visibility=? WHERE id=?").run(JSON.stringify(actions), workspace) }
})

test("legacy shared rep links continue to create deals without invented outreach history", async () => {
  const beforeCount = (await listApplicationInvitations(admin)).length
  const link = await createJotformRepLink(context(admin), connection.status.id, ada.membershipId!, origin)
  const rawBody = JSON.stringify({ formID: connection.status.binding, submissionID: randomUUID(), rawRequest: JSON.stringify({ business: "Legacy client", mca_rep: link.token }) })
  const result = await ingestProviderDelivery({ provider: "jotform", integrationId: connection.status.id, rawBody, request: new Request(`${origin}/hook`, { method: "POST", headers: { authorization: `Bearer ${connection.admissionSecret}` }, body: rawBody }) })
  assert.ok(result.dealId)
  assert.equal((await listApplicationInvitations(admin)).length, beforeCount)
})

test("production without invitation email enabled disables Send and tells users to copy the link", async () => {
  const listed = await listRoute(request("/api/mca/applications", ada))
  assert.equal(listed.status, 200)
  const body = await listed.json()
  assert.equal(body.invitationEmailEnabled, invitationEmailEnabled())
  assert.equal(typeof body.invitationEmailEnabled, "boolean")

  const env = process.env as { NODE_ENV?: string }
  const originalNodeEnv = env.NODE_ENV
  const originalFlag = process.env.MCA_APPLICATION_INVITATION_EMAIL_ENABLED
  const originalWebhook = process.env.MCA_EMAIL_WEBHOOK_URL
  const originalWebhookToken = process.env.MCA_EMAIL_WEBHOOK_TOKEN
  try {
    env.NODE_ENV = "production"
    process.env.MCA_EMAIL_WEBHOOK_URL = "https://mail.example.test/webhook"
    process.env.MCA_EMAIL_WEBHOOK_TOKEN = "synthetic-receiver-secret"
    delete process.env.MCA_APPLICATION_INVITATION_EMAIL_ENABLED
    assert.equal(invitationEmailEnabled(), false)

    process.env.MCA_APPLICATION_INVITATION_EMAIL_ENABLED = "true"
    assert.equal(invitationEmailEnabled(), true)

    delete process.env.MCA_EMAIL_WEBHOOK_URL
    assert.equal(invitationEmailEnabled(), false)
  } finally {
    env.NODE_ENV = originalNodeEnv
    if (originalFlag === undefined) delete process.env.MCA_APPLICATION_INVITATION_EMAIL_ENABLED
    else process.env.MCA_APPLICATION_INVITATION_EMAIL_ENABLED = originalFlag
    if (originalWebhook === undefined) delete process.env.MCA_EMAIL_WEBHOOK_URL
    else process.env.MCA_EMAIL_WEBHOOK_URL = originalWebhook
    if (originalWebhookToken === undefined) delete process.env.MCA_EMAIL_WEBHOOK_TOKEN
    else process.env.MCA_EMAIL_WEBHOOK_TOKEN = originalWebhookToken
  }

  const routeSource = readFileSync(resolve(process.cwd(), "src/app/api/mca/applications/route.ts"), "utf8")
  const workspaceUi = readFileSync(resolve(process.cwd(), "src/components/mca/applications/applications-workspace.tsx"), "utf8")
  const tableUi = readFileSync(resolve(process.cwd(), "src/components/mca/applications/invitations-table.tsx"), "utf8")
  assert.match(routeSource, /invitationEmailEnabled/)
  assert.match(workspaceUi, /invitationEmailEnabled/)
  assert.match(tableUi, /invitationEmailEnabled/)
  assert.match(tableUi, /!invitationEmailEnabled/)
  assert.match(`${workspaceUi}\n${tableUi}`, /copy the link/i)
})

test("calendar and credit UI stay honest when sync and purchases are unavailable", () => {
  const calendar = readFileSync(resolve(process.cwd(), "src/components/mca/calendar/calendar-workspace.tsx"), "utf8")
  assert.match(calendar, /Google Calendar sync is not running in this environment\./)
  assert.doesNotMatch(calendar, /Google Calendar setup is awaiting administrator activation/)

  const credits = readFileSync(resolve(process.cwd(), "src/components/mca/assistant/credit-balance.tsx"), "utf8")
  assert.match(credits, /purchasesAvailable/)
  assert.match(credits, /Buy a credit pack/)
  const buyPackBranch = credits.match(/purchasesAvailable[\s\S]{0,200}Buy a credit pack|Buy a credit pack[\s\S]{0,200}purchasesAvailable/)
  assert.ok(buyPackBranch, "Buy a credit pack must be gated on purchasesAvailable")
})
