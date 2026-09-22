import "./helpers/business-auth"
import test, { before, after } from "node:test"
import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { createPostgresTestDatabase } from "./helpers/postgres-test-db.mjs"
import { getDatabase, nowIso, closeDatabaseForTests } from "../src/lib/mca/db"
import { createWorkspaceWithAdmin } from "../src/lib/mca/workspaces"
import { hashOpaqueToken } from "../src/lib/mca/crypto"
import { createApiKey } from "../src/lib/mca/api-keys"
import { requireWorkspaceAccess } from "../src/lib/mca/auth"
import { getCompanyAccess } from "../src/lib/mca/company-access"
import { isCompanyRecoveryApi, isCompanyRecoveryPage } from "../src/lib/mca/company-recovery"
import { claimBackgroundJob, currentJobActor, enqueueBackgroundJob, failBackgroundJob } from "../src/lib/mca/jobs/queue"
import { ingestApplication } from "../src/lib/mca/intake/service"
import { deliverSubmission } from "../src/lib/mca/submissions/deliver"
import { googleRequest, type Connection } from "../src/lib/mca/calendar/google"
import { assistantContext } from "../src/lib/mca/assistant/chatkit-context"
import { AppError } from "../src/lib/mca/errors"
import { assertOutboundFresh } from "../src/lib/mca/outbound-freshness"
import { assertOutboundDispatch, withOutboundApproval } from "../src/lib/mca/outbound-approval"
import { withTransaction } from "../src/lib/mca/db"
import type { MembershipContext } from "../src/lib/mca/types"
import type { DealActor } from "../src/lib/mca/deals/schema"
import type { SubmissionJob } from "../src/lib/mca/submissions/contracts"

let database: Awaited<ReturnType<typeof createPostgresTestDatabase>>
before(async () => {
  database = await createPostgresTestDatabase("company_pause")
  Object.assign(process.env, database.env())
})
after(async () => { await closeDatabaseForTests(); await database?.close() })

async function fixture() {
  const f = await createWorkspaceWithAdmin({ workspaceName: "Pause test", adminName: "Owner", adminEmail: `${randomUUID()}@example.test`, password: "Fixture password 123!", role: "admin" })
  const token = randomUUID(), now = nowIso(), sessionId = randomUUID()
  await getDatabase().prepare("INSERT INTO sessions(id,user_id,membership_id,token_hash,expires_at,created_at,last_seen_at) VALUES(?,?,?,?,?,?,?)")
    .run(sessionId, f.userId, f.membershipId, hashOpaqueToken(token), "2099-01-01", now, now)
  const context: MembershipContext = { authType: "session", userId: f.userId, membershipId: f.membershipId, workspaceId: f.workspaceId, role: "admin", scopes: [], sessionId }
  const actor: DealActor = { ...context, source: "system", managedMembershipIds: [], activeMembershipIds: [f.membershipId], correlationId: randomUUID() }
  const request = (path: string) => new Request(`https://app.example.test${path}`, { headers: { cookie: `mca_session=${token}` } })
  const pause = async () => { await getDatabase().prepare("INSERT INTO company_subscription_state(workspace_id,legacy_exempt,manual_paused,updated_at) VALUES(?,1,1,?) ON CONFLICT(workspace_id) DO UPDATE SET manual_paused=1").run(f.workspaceId, nowIso()) }
  const resume = async () => { await getDatabase().prepare("UPDATE company_subscription_state SET manual_paused=0 WHERE workspace_id=?").run(f.workspaceId) }
  return { ...f, context, actor, request, pause, resume }
}

test("paused sessions and API keys reject business access while recovery remains authenticated and role-scoped", async () => {
  const f = await fixture()
  const key = await createApiKey(f.context, { name: "Pause key", scopes: ["deals:read"], rateLimitPerMinute: 60 })
  assert.equal((await requireWorkspaceAccess(f.request("/api/mca/deals"))).workspaceId, f.workspaceId)
  await f.pause()
  await assert.rejects(requireWorkspaceAccess(f.request("/api/mca/deals")), { status: 402, code: "company_paused" })
  for (const path of ["/api/billing", "/api/billing/checkout", "/api/billing/portal", "/api/billing/sync"]) {
    assert.equal((await requireWorkspaceAccess(f.request(path), { roles: ["admin"] })).workspaceId, f.workspaceId)
    await assert.rejects(requireWorkspaceAccess(new Request(`https://app.example.test${path}`, { headers: { authorization: `Bearer ${key.secret}` } }), { allowPaused: true }), { code: "company_paused" })
  }
  await assert.rejects(requireWorkspaceAccess(f.request("/api/billing-export")), { code: "company_paused" })
  await assert.rejects(requireWorkspaceAccess(f.request("/api/billing/portal/extra")), { code: "company_paused" })
  assert.equal((await requireWorkspaceAccess(f.request("/api/auth/session"), { sessionOnly: true, allowPaused: true })).workspaceId, f.workspaceId)
  await getDatabase().prepare("UPDATE memberships SET role='rep' WHERE id=?").run(f.membershipId)
  await assert.rejects(requireWorkspaceAccess(f.request("/api/billing"), { roles: ["admin"], allowPaused: true }), { code: "permission_denied" })
  await assert.rejects(requireWorkspaceAccess(f.request("/api/billing")), { code: "company_paused" })
  await getDatabase().prepare("UPDATE memberships SET status='deactivated' WHERE id=?").run(f.membershipId)
  await assert.rejects(requireWorkspaceAccess(f.request("/api/billing"), { allowPaused: true }), { code: "authentication_required" })
  assert.equal(isCompanyRecoveryApi("/api/billingish"), false)
  assert.equal(isCompanyRecoveryPage("/settings/billing"), true)
  assert.equal(isCompanyRecoveryPage("/settings/billing/other"), false)
})

test("queue skips paused companies without consuming retries and halts queued outbound intent", async () => {
  const paused = await fixture(), active = await fixture()
  const pending = await enqueueBackgroundJob({ actor: paused.actor, kind: "draft_extract", resourceId: "draft", idempotencyKey: randomUUID() })
  const outbound = await enqueueBackgroundJob({ actor: paused.actor, kind: "application_invitation_email", resourceId: "delivery", idempotencyKey: randomUUID() })
  const runnable = await enqueueBackgroundJob({ actor: active.actor, kind: "draft_extract", resourceId: "draft", idempotencyKey: randomUUID() })
  await paused.pause()
  assert.equal((await claimBackgroundJob())?.id, runnable.id)
  const row = await getDatabase().prepare<{ state: string; attempts: number }>("SELECT state,attempts FROM mca_background_jobs WHERE id=?").get(pending.id)
  assert.deepEqual(row, { state: "queued", attempts: 0 })
  assert.deepEqual(await getDatabase().prepare("SELECT state,attempts,error_code FROM mca_background_jobs WHERE id=?").get(outbound.id), { state: "failed", attempts: 0, error_code: "company_paused" })
  await assert.rejects(currentJobActor(paused.actor), { code: "company_paused" })
  await paused.resume()
  assert.equal((await claimBackgroundJob())?.id, pending.id)
  assert.equal((await getDatabase().prepare<{ state: string }>("SELECT state FROM mca_background_jobs WHERE id=?").get(outbound.id))?.state, "failed")
})

test("a pause after claim returns processing work without exhausting attempts; outbound stays halted", async () => {
  const f = await fixture()
  const job = await enqueueBackgroundJob({ actor: f.actor, kind: "draft_extract", resourceId: "draft", idempotencyKey: randomUUID() })
  const claimed = await claimBackgroundJob()
  assert.equal(claimed?.id, job.id)
  await f.pause()
  await failBackgroundJob(claimed!, new AppError(402, "company_paused", "Paused"))
  assert.deepEqual(await getDatabase().prepare("SELECT state,attempts,error_code FROM mca_background_jobs WHERE id=?").get(job.id), { state: "queued", attempts: 0, error_code: "company_paused" })
  assert.equal(await claimBackgroundJob(), undefined)
})

test("expired trial rejects system/delegated dispatch immediately and retains inbound applications", async () => {
  const f = await fixture()
  await getDatabase().prepare("INSERT INTO company_subscription_state(workspace_id,trial_ends_at,updated_at) VALUES(?,?,?)").run(f.workspaceId, "2000-01-01T00:00:00.000Z", nowIso())
  assert.equal((await getCompanyAccess(f.workspaceId)).allowed, false)
  await assert.rejects(deliverSubmission({ workspaceId: f.workspaceId } as SubmissionJob), { code: "company_paused" })
  await assert.rejects(googleRequest({ workspace_id: f.workspaceId } as Connection, "/calendars"), { code: "company_paused" })
  await assert.rejects(assistantContext(f.context), { code: "company_paused" })
  const result = await ingestApplication(f.actor, { schemaVersion: 1, provider: "custom", eventId: randomUUID(), application: { legalName: "Retained applicant" } })
  assert.equal(result.state, "error")
  assert.equal(result.dealId, null)
  assert.equal((await getDatabase().prepare<{ error_code: string }>("SELECT error_code FROM intake_events WHERE id=?").get(result.intakeId))?.error_code, "company_paused")
  assert.equal((await getDatabase().prepare<{ count: number }>("SELECT count(*)::int count FROM deals WHERE workspace_id=?").get(f.workspaceId))?.count, 0)
})

test("offline recovery invalidates original approvals across transactional delivery conversion", async () => {
  const f = await fixture()
  const old = new Date(Date.now() - 2000).toISOString()
  const boundary = new Date(Date.now() - 1000).toISOString()
  await getDatabase().prepare("INSERT INTO company_subscription_state(workspace_id,legacy_exempt,manual_paused,last_paused_at,updated_at) VALUES(?,1,0,?,?)").run(f.workspaceId, boundary, nowIso())
  assert.equal((await getCompanyAccess(f.workspaceId)).allowed, true)
  await assert.rejects(withOutboundApproval(f.workspaceId, old, async () => assert.fail("stale dispatch")), { code: "company_outbound_reapproval_required" })
  const reviewed = nowIso()
  await withOutboundApproval(f.workspaceId, reviewed, async () => {
    await withTransaction(async () => {
      await getDatabase().prepare("UPDATE company_subscription_state SET last_paused_at=? WHERE workspace_id=?").run(reviewed, f.workspaceId)
      await assert.rejects(assertOutboundDispatch(f.workspaceId, nowIso()), { code: "company_outbound_reapproval_required" })
    })
  })
})

test("old outbound approvals require review instead of catch-up dispatch", () => {
  const now = Date.now()
  assert.doesNotThrow(() => assertOutboundFresh(new Date(now - 1000).toISOString(), now))
  assert.throws(() => assertOutboundFresh(new Date(now - 86400001).toISOString(), now), { code: "outbound_review_required" })
  assert.throws(() => assertOutboundFresh("invalid", now), { code: "outbound_review_required" })
})
