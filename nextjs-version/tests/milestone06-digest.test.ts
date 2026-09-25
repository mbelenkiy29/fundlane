import "./helpers/business-auth";
import test, { after, before, beforeEach } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { closeDatabaseForTests, getDatabase, newId } from "../src/lib/mca/db"
import { createPostgresTestDatabase } from "./helpers/postgres-test-db.mjs"
import { hashOpaqueToken } from "../src/lib/mca/crypto"
import { createDeal, updateDealRecord } from "../src/lib/mca/deals/service"
import type { DealActor } from "../src/lib/mca/deals/schema"
import type { Role } from "../src/lib/mca/types"
import { createSender, testSend } from "../src/lib/mca/senders/service"
import { runCommsJobs } from "../src/lib/mca/comms/jobs"
import {
  DEFAULT_DIGEST_LOCAL_SEND_HOUR,
  digestWindowFor,
  runDailyDigests,
  setDigestDeliveryFetchForTests,
  setDigestTransportForTests,
  updateDigestSubscription,
  type DigestDeliveryMessage,
  type DigestStage,
} from "../src/lib/mca/comms/digest"
import { GET as digestGet, PATCH as digestPatch } from "../src/app/api/mca/comms/digest/route"
import { GET as digestPreviewGet } from "../src/app/api/mca/comms/digest/preview/route"
import { POST as jobsPost } from "../src/app/api/mca/comms/jobs/run/route"

let testDatabase: Awaited<ReturnType<typeof createPostgresTestDatabase>>

const SMTP_PASSWORD = "smtp-digest-password-never-leak"
const WEBHOOK_TOKEN = "digest-hook-token-never-leak"
const NOW = "2026-01-15T11:00:00.000Z"
const WINDOW_START = "2026-01-14T11:00:00.000Z"
const IN_WINDOW = "2026-01-14T18:00:00.000Z"
const IN_WINDOW_EDIT = "2026-01-15T10:00:00.000Z"
const FUNDED_OLD = "2026-01-12T11:00:00.000Z"
const BEFORE_SEND = "2026-01-15T10:59:59.000Z"

const ids = {
  workspace: "workspace-m06-digest",
  otherWorkspace: "workspace-m06-digest-other",
  adminUser: "digest-admin-user",
  adminMember: "digest-admin-member",
  repUser: "digest-rep-user",
  repMember: "digest-rep-member",
  otherRepUser: "digest-other-rep-user",
  otherRepMember: "digest-other-rep-member",
  suspendedUser: "digest-suspended-user",
  suspendedMember: "digest-suspended-member",
  otherUser: "digest-other-user",
  otherMember: "digest-other-member",
}

const actor = (workspaceId = ids.workspace, role: Role | null = "admin"): DealActor => {
  const membershipId = workspaceId === ids.otherWorkspace
    ? ids.otherMember
    : role === "rep"
      ? ids.repMember
      : ids.adminMember
  return {
    workspaceId,
    userId: workspaceId === ids.otherWorkspace ? ids.otherUser : role === "rep" ? ids.repUser : ids.adminUser,
    membershipId,
    role,
    managedMembershipIds: [],
    activeMembershipIds: workspaceId === ids.otherWorkspace ? [ids.otherMember] : [ids.adminMember, ids.repMember, ids.otherRepMember],
    source: role ? "user" : "api_key",
    correlationId: `corr-${workspaceId}-${role ?? "key"}`,
  }
}

const delivered: DigestDeliveryMessage[] = []
const webhookBodies: string[] = []
let dealCounter = 0

type ErrorBody = { error: { code: string; message: string; fieldErrors?: Record<string, string[]> } }
type DigestView = {
  membershipId: string
  enabled: boolean
  timezone: string
  localSendHour: number
  defaultTimezone: string
  defaultLocalSendHour: number
  preview: {
    empty: boolean
    window: { windowStart: string; windowEnd: string; timezone: string; due: boolean }
    groups: Array<{ stage: DigestStage; deals: Array<{ dealId: string; displayId: string; legalName: string; href: string }> }>
  }
  lastDelivery?: { id: string; state: string; windowStart: string; correlationId: string }
}

async function seed() {
  const database = getDatabase()
  const now = new Date().toISOString()
  const visibility = JSON.stringify({ dashboard: true, deals: true, users: true, reports: true, payments: true, workspace: true, integrations: true })
  const actions = JSON.stringify({ createDeal: true, exportDeals: true, inviteUsers: true, manageApiKeys: true, viewPaymentTable: true, viewCompanyFinancials: true })
  const flags = JSON.stringify({ reports: true, payments: true, integrations: true })
  for (const [id, name] of [[ids.workspace, "Digest Test"], [ids.otherWorkspace, "Other Workspace"]] as const) {
    await database.prepare(`INSERT INTO workspaces (id,name,timezone,seat_limit,feature_flags,page_visibility,action_visibility,created_at,updated_at)
      VALUES (?, ?, 'America/New_York', 8, ?, ?, ?, ?, ?)`).run(id, name, flags, visibility, actions, now, now)
  }
  for (const [userId, memberId, email, workspaceId, role, status] of [
    [ids.adminUser, ids.adminMember, "digest-admin@example.test", ids.workspace, "admin", "active"],
    [ids.repUser, ids.repMember, "digest-rep@example.test", ids.workspace, "rep", "active"],
    [ids.otherRepUser, ids.otherRepMember, "digest-empty@example.test", ids.workspace, "rep", "active"],
    [ids.suspendedUser, ids.suspendedMember, "digest-suspended@example.test", ids.workspace, "rep", "deactivated"],
    [ids.otherUser, ids.otherMember, "digest-other@example.test", ids.otherWorkspace, "admin", "active"],
  ] as const) {
    await database.prepare(`INSERT INTO users (id,email,password_hash,name,phone,application_identifier,created_at,updated_at)
      VALUES (?, ?, NULL, ?, NULL, ?, ?, ?)`).run(userId, email, email, `APP-${userId}`, now, now)
    await database.prepare(`INSERT INTO memberships (id,workspace_id,user_id,role,manager_membership_id,status,sender_association,created_at,updated_at)
      VALUES (?, ?, ?, ?, NULL, ?, NULL, ?, ?)`).run(memberId, workspaceId, userId, role, status, now, now)
  }
  await database.prepare(`INSERT INTO sessions (id,user_id,membership_id,token_hash,expires_at,created_at,last_seen_at)
    VALUES (?, ?, ?, ?, '2099-01-01T00:00:00.000Z', ?, ?)`).run("digest-admin-session", ids.adminUser, ids.adminMember, hashOpaqueToken("admin-session-token"), now, now)
  await database.prepare(`INSERT INTO sessions (id,user_id,membership_id,token_hash,expires_at,created_at,last_seen_at)
    VALUES (?, ?, ?, ?, '2099-01-01T00:00:00.000Z', ?, ?)`).run("digest-rep-session", ids.repUser, ids.repMember, hashOpaqueToken("rep-session-token"), now, now)
  await database.prepare(`INSERT INTO sessions (id,user_id,membership_id,token_hash,expires_at,created_at,last_seen_at)
    VALUES (?, ?, ?, ?, '2099-01-01T00:00:00.000Z', ?, ?)`).run("digest-other-session", ids.otherUser, ids.otherMember, hashOpaqueToken("other-session-token"), now, now)
  const addKey = async (id: string, secret: string, scopes: string[], workspaceId: string) => {
    await database.prepare(`INSERT INTO api_keys
      (id,workspace_id,name,prefix,secret_hash,scopes,expires_at,last_used_at,revoked_at,rate_limit_per_minute,created_by,created_at)
      VALUES (?, ?, ?, 'mca_test', ?, ?, NULL, NULL, NULL, 60, ?, ?)`).run(id, workspaceId, id, hashOpaqueToken(`mca_${secret}`), JSON.stringify(scopes), ids.adminUser, now)
  }
  await addKey("digest-intake-key", "intake-secret", ["intake:write"], ids.workspace)
  await addKey("digest-read-key", "read-secret", ["deals:read"], ids.workspace)
  await addKey("digest-write-key", "write-secret", ["deals:write"], ids.workspace)
}

before(async () => {
  testDatabase = await createPostgresTestDatabase("m06_digest")
  Object.assign(process.env, testDatabase.env())
  delete process.env.MCA_EMAIL_WEBHOOK_URL
  delete process.env.MCA_EMAIL_WEBHOOK_TOKEN
  await seed()
  const sender = await createSender(actor(), {
    provider: "smtp",
    purpose: "merchant",
    fromName: "Digest Desk",
    fromAddress: "digest@example.test",
    isDefault: true,
    smtp: { host: "smtp.example.test", port: 587, username: "digest", password: SMTP_PASSWORD },
  })
  await testSend(actor(), sender.id, { to: "ops@example.test" })
})

beforeEach(async () => {
  delivered.length = 0
  webhookBodies.length = 0
  delete process.env.MCA_EMAIL_WEBHOOK_URL
  delete process.env.MCA_EMAIL_WEBHOOK_TOKEN
  setDigestDeliveryFetchForTests()
  setDigestTransportForTests(async (message) => {
    delivered.push(message)
    return { delivery: "sent" }
  })
  const database = getDatabase()
  await database.prepare("DELETE FROM mca_digest_deliveries").run()
  await database.prepare("DELETE FROM mca_digest_subscriptions").run()
})

after(async () => {
  setDigestTransportForTests()
  setDigestDeliveryFetchForTests()
  await closeDatabaseForTests()
  await testDatabase.close()
})

function cookieRequest(path: string, token: string, init: RequestInit = {}) {
  return new Request(`http://localhost${path}`, {
    ...init,
    headers: {
      cookie: `mca_session=${token}`,
      origin: "http://localhost",
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...init.headers,
    },
  })
}

function bearerRequest(path: string, secret: string, init: RequestInit = {}) {
  return new Request(`http://localhost${path}`, {
    ...init,
    headers: {
      authorization: `Bearer mca_${secret}`,
      origin: "http://localhost",
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...init.headers,
    },
  })
}

function assertNoSecret(value: unknown) {
  const text = typeof value === "string" ? value : JSON.stringify(value)
  assert.equal(text.includes(SMTP_PASSWORD), false)
  assert.equal(text.includes(WEBHOOK_TOKEN), false)
  assert.equal(text.includes("credentialCipher"), false)
  assert.equal(text.includes("credential_cipher"), false)
}

async function optIn(membershipId: string, timezone = "America/New_York") {
  const database = getDatabase()
  const now = new Date().toISOString()
  await database.prepare(`INSERT INTO mca_digest_subscriptions
    (id, workspace_id, membership_id, enabled, timezone, local_send_hour, created_at, updated_at)
    VALUES (?, ?, ?, 1, ?, ?, ?, ?)`).run(`sub-${membershipId}`, ids.workspace, membershipId, timezone, DEFAULT_DIGEST_LOCAL_SEND_HOUR, now, now)
}

async function seedDeal(assignments: Array<{ membershipId: string; kind: "originator" | "closer" }>) {
  dealCounter += 1
  return (await createDeal(actor(), {
    idempotencyKey: `digest-deal-${dealCounter}`,
    legalName: `Digest Merchant ${dealCounter} LLC`,
    requestedAmount: 50_000,
    assignments,
  })).deal
}

async function stampCreated(dealId: string, at: string) {
  await getDatabase().prepare("UPDATE deal_activity SET created_at = ? WHERE deal_id = ? AND action = 'created'").run(at, dealId)
  await getDatabase().prepare("UPDATE deals SET created_at = ?, updated_at = ? WHERE id = ?").run(at, at, dealId)
}

async function insertStatusChange(dealId: string, from: string, to: string, at: string) {
  await getDatabase().prepare(`INSERT INTO deal_activity
    (id, workspace_id, deal_id, action, actor_user_id, source, summary, from_status, to_status, record_version, correlation_id, created_at)
    VALUES (?, ?, ?, 'status_changed', ?, 'manual', ?, ?, ?, 2, ?, ?)`).run(
    newId(),
    ids.workspace,
    dealId,
    ids.adminUser,
    `Status changed: ${from} → ${to}`,
    from,
    to,
    `corr-${dealId}-${to}-${at}`,
    at,
  )
  await getDatabase().prepare("UPDATE deals SET status = ?, updated_at = ? WHERE id = ?").run(to, at, dealId)
}

function both() {
  return [
    { membershipId: ids.repMember, kind: "originator" as const, isPrimary: true },
    { membershipId: ids.adminMember, kind: "closer" as const, isPrimary: true },
  ]
}

function groupIds(message: DigestDeliveryMessage | undefined, stage: DigestStage): string[] {
  return (message?.groups.find((group) => group.stage === stage)?.deals.map((deal) => deal.dealId) ?? []).sort()
}

function messageFor(membershipId: string): DigestDeliveryMessage | undefined {
  return delivered.find((item) => item.membershipId === membershipId)
}

test("MIC-146: event timestamps, visibility, grouping, and replay-safe window", async () => {
  const winter = digestWindowFor(NOW, "America/New_York", 6)
  assert.equal(winter?.windowStart, WINDOW_START)
  assert.equal(winter?.windowEnd, NOW)
  assert.equal(winter?.due, true)
  const summer = digestWindowFor("2026-07-15T10:00:00.000Z", "America/New_York", 6)
  assert.equal(summer?.windowEnd, "2026-07-15T10:00:00.000Z")
  assert.equal(summer?.windowStart, "2026-07-14T10:00:00.000Z")
  const early = digestWindowFor(BEFORE_SEND, "America/New_York", 6)
  assert.equal(early?.due, false)
  assert.equal(early?.windowEnd, NOW)

  await optIn(ids.adminMember)
  await optIn(ids.repMember)
  await optIn(ids.otherRepMember)

  const created = await seedDeal(both())
  await stampCreated(created.id, IN_WINDOW)

  const submitted = await seedDeal(both())
  await insertStatusChange(submitted.id, "ready_to_submit", "submitted", IN_WINDOW)

  const approved = await seedDeal(both())
  await insertStatusChange(approved.id, "submitted", "offer", IN_WINDOW)

  const funded = await seedDeal(both())
  await insertStatusChange(funded.id, "contract", "funded", IN_WINDOW)

  const staleFunded = await seedDeal(both())
  await insertStatusChange(staleFunded.id, "contract", "funded", FUNDED_OLD)
  const edited = await updateDealRecord(actor(), staleFunded.id, {
    expectedVersion: staleFunded.version,
    legalName: "Edited today LLC",
  })
  await getDatabase().prepare("UPDATE deals SET updated_at = ? WHERE id = ?").run(IN_WINDOW_EDIT, edited.id)
  await getDatabase().prepare("UPDATE deal_activity SET created_at = ? WHERE deal_id = ? AND action = 'updated'").run(IN_WINDOW_EDIT, edited.id)

  const duplicate = await seedDeal(both())
  await insertStatusChange(duplicate.id, "ready_to_submit", "submitted", IN_WINDOW)
  await insertStatusChange(duplicate.id, "resubmitting", "submitted", "2026-01-14T20:00:00.000Z")

  const multi = await seedDeal(both())
  await stampCreated(multi.id, IN_WINDOW)
  await insertStatusChange(multi.id, "ready_to_submit", "submitted", "2026-01-14T19:00:00.000Z")

  const repOnly = await seedDeal([{ membershipId: ids.repMember, kind: "originator" }])
  await stampCreated(repOnly.id, IN_WINDOW)

  const adminOnly = await seedDeal([{ membershipId: ids.adminMember, kind: "originator" }])
  await stampCreated(adminOnly.id, IN_WINDOW)

  const earlyRun = await runDailyDigests({ actor: actor(), nowIso: BEFORE_SEND })
  assert.equal(earlyRun.sent, 0)
  assert.equal(delivered.length, 0)
  assert.ok(earlyRun.outcomes.every((item) => item.reason === "not_due"))

  const first = await runDailyDigests({ actor: actor(), nowIso: NOW })
  assert.equal(first.sent, 2)
  assert.equal(first.failed, 0)
  assert.equal(delivered.length, 2)

  const adminMail = messageFor(ids.adminMember)
  const repMail = messageFor(ids.repMember)
  const emptyMail = messageFor(ids.otherRepMember)
  assert.ok(adminMail)
  assert.ok(repMail)
  assert.equal(emptyMail, undefined)
  assert.equal(adminMail.windowStart, WINDOW_START)
  assert.equal(adminMail.windowEnd, NOW)
  assert.equal(adminMail.to, "digest-admin@example.test")
  assert.match(adminMail.subject, /Daily deal activity/)
  assert.match(adminMail.body, /New \(/)
  assert.equal(adminMail.body.includes(SMTP_PASSWORD), false)
  assertNoSecret(adminMail)

  assert.deepEqual(groupIds(adminMail, "funded").sort(), [funded.id].sort())
  assert.equal(groupIds(adminMail, "funded").includes(staleFunded.id), false)
  assert.equal(groupIds(adminMail, "funded").includes(edited.id), false)
  assert.deepEqual(groupIds(adminMail, "submitted").sort(), [submitted.id, duplicate.id, multi.id].sort())
  assert.equal(groupIds(adminMail, "submitted").filter((id) => id === duplicate.id).length, 1)
  assert.ok(groupIds(adminMail, "new").includes(created.id))
  assert.ok(groupIds(adminMail, "new").includes(multi.id))
  assert.ok(groupIds(adminMail, "new").includes(repOnly.id))
  assert.ok(groupIds(adminMail, "new").includes(adminOnly.id))
  assert.ok(groupIds(adminMail, "approved").includes(approved.id))
  assert.ok(adminMail.groups.find((group) => group.stage === "new")?.deals.every((deal) => deal.href.includes(`deal=${deal.dealId}`)))

  assert.equal(groupIds(repMail, "new").includes(adminOnly.id), false)
  assert.ok(groupIds(repMail, "new").includes(repOnly.id))
  assert.ok(groupIds(repMail, "funded").includes(funded.id))
  assert.equal(groupIds(repMail, "funded").includes(staleFunded.id), false)

  const emptyOutcome = first.outcomes.find((item) => item.membershipId === ids.otherRepMember)
  assert.equal(emptyOutcome?.state, "skipped")
  assert.equal(emptyOutcome?.reason, "empty")

  const replay = await runDailyDigests({ actor: actor(), nowIso: NOW })
  assert.equal(replay.sent, 0)
  assert.equal(delivered.length, 2)
  assert.ok(replay.outcomes.every((item) => item.reason === "already_delivered"))
  const rows = await getDatabase().prepare<{ count: number }>(
    "SELECT count(*)::int count FROM mca_digest_deliveries WHERE workspace_id = ? AND window_start = ?",
  ).get(ids.workspace, WINDOW_START)
  assert.equal(rows?.count, 3)

  const jobs = await jobsPost(cookieRequest("/api/mca/comms/jobs/run", "admin-session-token", {
    method: "POST",
    body: JSON.stringify({ nowIso: NOW, kinds: ["digest"] }),
  }))
  assert.equal(jobs.status, 200)
  const jobsBody = await jobs.json() as { digests: { attempted: number; sent: number; skipped: number } }
  assert.equal(jobsBody.digests.sent, 0)
  assert.equal(delivered.length, 2)
})

test("MIC-146: timezone/DST, suspended members, and failed send is not a successful digest", async () => {
  const spring = digestWindowFor("2026-03-08T10:00:00.000Z", "America/New_York", 6)
  assert.equal(spring?.windowEnd, "2026-03-08T10:00:00.000Z")
  const fall = digestWindowFor("2026-11-01T11:00:00.000Z", "America/New_York", 6)
  assert.equal(fall?.windowEnd, "2026-11-01T11:00:00.000Z")
  assert.equal(digestWindowFor(NOW, "Not/AZone", 6), undefined)

  await optIn(ids.adminMember)
  await optIn(ids.suspendedMember)
  await getDatabase().prepare(
    "INSERT INTO mca_digest_subscriptions (id, workspace_id, membership_id, enabled, timezone, local_send_hour, created_at, updated_at) VALUES (?, ?, ?, 1, 'Not/AZone', 6, ?, ?)",
  ).run("sub-bad-tz", ids.workspace, ids.otherRepMember, new Date().toISOString(), new Date().toISOString())

  const funded = await seedDeal(both())
  await insertStatusChange(funded.id, "contract", "funded", IN_WINDOW)

  setDigestTransportForTests(async () => ({ delivery: "failed", error: "The email provider did not accept the digest." }))
  const failed = await runDailyDigests({ actor: actor(), nowIso: NOW })
  const adminFailed = failed.outcomes.find((item) => item.membershipId === ids.adminMember)
  const suspended = failed.outcomes.find((item) => item.membershipId === ids.suspendedMember)
  const badTz = failed.outcomes.find((item) => item.membershipId === ids.otherRepMember)
  assert.equal(adminFailed?.state, "failed")
  assert.equal(adminFailed?.reason, "send_failed")
  assert.equal(failed.sent, 0)
  assert.equal(failed.failed, 1)
  assert.equal(delivered.length, 0)
  assert.equal(suspended?.state, "skipped")
  assert.equal(suspended?.reason, "suspended")
  assert.equal(badTz?.reason, "invalid_timezone")
  const failedRow = await getDatabase().prepare<{ state: string; correlation_id: string; id: string }>(
    "SELECT state, correlation_id, id FROM mca_digest_deliveries WHERE membership_id = ?",
  ).get(ids.adminMember)
  assert.equal(failedRow?.state, "failed")

  setDigestTransportForTests(async (message) => {
    delivered.push(message)
    return { delivery: "sent" }
  })
  const retried = await runDailyDigests({ actor: actor(), nowIso: NOW })
  const adminSent = retried.outcomes.find((item) => item.membershipId === ids.adminMember)
  assert.equal(retried.sent, 1)
  assert.equal(adminSent?.state, "sent")
  assert.equal(adminSent?.deliveryId, failedRow?.id)
  assert.equal(adminSent?.correlationId, failedRow?.correlation_id)
  assert.equal(delivered.length, 1)
  assert.ok(groupIds(delivered[0], "funded").includes(funded.id))

  const replay = await runCommsJobs({ actor: actor(), nowIso: NOW, kinds: ["digest"] })
  assert.equal(replay.digests.sent, 0)
  assert.equal(delivered.length, 1)
})

test("MIC-146: profile opt-in API matches the UI, validation and permissions, secrets stay out of JSON", async () => {
  const source = readFileSync(resolve(process.cwd(), "src/components/mca/comms/digest-settings.tsx"), "utf8")
  assert.match(source, /Loading digest settings/)
  assert.match(source, /Daily digest is off/)
  assert.match(source, /Choose a valid IANA timezone/)
  assert.match(source, /Daily digest enabled/)
  assert.match(source, /role="alert"/)
  assert.match(source, /No deal activity in the current digest window/)
  assert.match(source, /Enable daily reports/)
  assert.match(source, /role-appropriate/)

  const initial = await digestGet(cookieRequest(`/api/mca/comms/digest?nowIso=${encodeURIComponent(NOW)}`, "admin-session-token"))
  assert.equal(initial.status, 200)
  const initialBody = await initial.json() as DigestView
  assert.equal(initialBody.enabled, false)
  assert.equal(initialBody.timezone, "America/New_York")
  assert.equal(initialBody.localSendHour, 6)
  assert.equal(initialBody.preview.window.windowStart, WINDOW_START)
  assert.equal(initialBody.preview.window.windowEnd, NOW)

  const invalidTz = await digestPatch(cookieRequest("/api/mca/comms/digest", "admin-session-token", {
    method: "PATCH",
    body: JSON.stringify({ enabled: true, timezone: "Not/AZone" }),
  }))
  assert.equal(invalidTz.status, 422)
  assert.equal((await invalidTz.json() as ErrorBody).error.fieldErrors?.timezone?.[0], "Choose a valid IANA timezone.")

  const blankHour = await digestPatch(cookieRequest("/api/mca/comms/digest", "admin-session-token", {
    method: "PATCH",
    body: JSON.stringify({ enabled: true, localSendHour: 24 }),
  }))
  assert.equal(blankHour.status, 400)

  const invalidJson = await digestPatch(cookieRequest("/api/mca/comms/digest", "admin-session-token", {
    method: "PATCH",
    body: "{",
  }))
  assert.equal(invalidJson.status, 400)

  const saved = await digestPatch(cookieRequest(`/api/mca/comms/digest?nowIso=${encodeURIComponent(NOW)}`, "admin-session-token", {
    method: "PATCH",
    body: JSON.stringify({ enabled: true, timezone: "America/New_York", localSendHour: 6 }),
  }))
  assert.equal(saved.status, 200)
  const savedBody = await saved.json() as DigestView
  assert.equal(savedBody.enabled, true)
  assert.equal(savedBody.localSendHour, 6)
  assertNoSecret(savedBody)

  const preview = await digestPreviewGet(cookieRequest(`/api/mca/comms/digest/preview?nowIso=${encodeURIComponent(NOW)}`, "admin-session-token"))
  assert.equal(preview.status, 200)
  const previewBody = await preview.json() as DigestView["preview"]
  assert.equal(previewBody.window.windowEnd, NOW)

  const intake = await digestGet(bearerRequest("/api/mca/comms/digest", "intake-secret"))
  assert.equal(intake.status, 403)
  const readKey = await digestGet(bearerRequest("/api/mca/comms/digest", "read-secret"))
  assert.equal(readKey.status, 403)
  const writeKey = await digestPatch(bearerRequest("/api/mca/comms/digest", "write-secret", {
    method: "PATCH",
    body: JSON.stringify({ enabled: true }),
  }))
  assert.equal(writeKey.status, 403)

  const repGet = await digestGet(cookieRequest("/api/mca/comms/digest", "rep-session-token"))
  assert.equal(repGet.status, 200)
  const repSave = await digestPatch(cookieRequest("/api/mca/comms/digest", "rep-session-token", {
    method: "PATCH",
    body: JSON.stringify({ enabled: true, timezone: "America/Chicago", localSendHour: 6 }),
  }))
  assert.equal(repSave.status, 200)
  const repBody = await repSave.json() as DigestView
  assert.equal(repBody.timezone, "America/Chicago")
  assert.equal(repBody.membershipId, ids.repMember)

  const other = await digestGet(cookieRequest("/api/mca/comms/digest", "other-session-token"))
  assert.equal(other.status, 200)
  const otherBody = await other.json() as DigestView
  assert.equal(otherBody.enabled, false)
  assert.equal(otherBody.membershipId, ids.otherMember)

  process.env.MCA_EMAIL_WEBHOOK_URL = "https://email-webhook.example.test/digest"
  process.env.MCA_EMAIL_WEBHOOK_TOKEN = WEBHOOK_TOKEN
  setDigestTransportForTests()
  setDigestDeliveryFetchForTests(async (_input, init) => {
    webhookBodies.push(typeof init?.body === "string" ? init.body : "")
    return new Response("accepted", { status: 202 })
  })
  const created = await seedDeal(both())
  await stampCreated(created.id, IN_WINDOW)
  const hooked = await runDailyDigests({ actor: actor(), nowIso: NOW })
  assert.equal(hooked.sent, 1)
  assert.equal(webhookBodies.length, 1)
  assertNoSecret(webhookBodies[0])
  assert.equal(webhookBodies[0]?.includes(WEBHOOK_TOKEN), false)
  assert.match(webhookBodies[0] ?? "", /deal_activity_digest/)
})
