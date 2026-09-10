import "./helpers/business-auth";
import test, { after, before, beforeEach } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { closeDatabaseForTests, getDatabase, newId } from "../src/lib/mca/db"
import { createPostgresTestDatabase } from "./helpers/postgres-test-db.mjs"
import { hashOpaqueToken } from "../src/lib/mca/crypto"
import { createDeal } from "../src/lib/mca/deals/service"
import type { DealActor } from "../src/lib/mca/deals/schema"
import type { Role } from "../src/lib/mca/types"
import { createSender, testSend } from "../src/lib/mca/senders/service"
import { createMessageTemplate, publishMessageTemplate } from "../src/lib/mca/comms/templates"
import { recordSmsConsent } from "../src/lib/mca/sms/service"
import { runCommsJobs } from "../src/lib/mca/comms/jobs"
import {
  createFollowupPolicy,
  followupOccurrenceFor,
  previewFollowupPolicy,
  runFollowups,
  setFollowupDeliveryFetchForTests,
  setFollowupTransportForTests,
  testFollowupPolicy,
  updateFollowupPolicy,
  type FollowupDeliveryMessage,
  type FollowupPolicyView,
} from "../src/lib/mca/comms/followups"
import { GET as followupsGet, POST as followupsPost } from "../src/app/api/mca/comms/followups/route"
import { GET as followupGet, PATCH as followupPatch } from "../src/app/api/mca/comms/followups/[id]/route"
import { GET as previewGet, POST as previewPost } from "../src/app/api/mca/comms/followups/preview/route"
import { POST as testPost } from "../src/app/api/mca/comms/followups/[id]/test/route"
import { POST as jobsPost } from "../src/app/api/mca/comms/jobs/run/route"

let testDatabase: Awaited<ReturnType<typeof createPostgresTestDatabase>>

const SMTP_PASSWORD = "smtp-followup-password-never-leak"
const WEBHOOK_TOKEN = "followup-hook-token-never-leak"
const NOW = "2026-01-15T11:00:00.000Z"
const BEFORE_SEND = "2026-01-15T10:59:59.000Z"
const RETRY_NOW = "2026-01-15T11:20:00.000Z"
const MERCHANT_PHONE = "(555) 123-4567"
const MERCHANT_E164 = "+15551234567"

const ids = {
  workspace: "workspace-m06-followups",
  otherWorkspace: "workspace-m06-followups-other",
  adminUser: "follow-admin-user",
  adminMember: "follow-admin-member",
  repUser: "follow-rep-user",
  repMember: "follow-rep-member",
  otherUser: "follow-other-user",
  otherMember: "follow-other-member",
}

const actor = (workspaceId = ids.workspace, role: Role | null = "admin"): DealActor => {
  const membershipId = workspaceId === ids.otherWorkspace ? ids.otherMember : role === "rep" ? ids.repMember : ids.adminMember
  return {
    workspaceId,
    userId: workspaceId === ids.otherWorkspace ? ids.otherUser : role === "rep" ? ids.repUser : ids.adminUser,
    membershipId,
    role,
    managedMembershipIds: [],
    activeMembershipIds: workspaceId === ids.otherWorkspace ? [ids.otherMember] : [ids.adminMember, ids.repMember],
    source: role ? "user" : "api_key",
    correlationId: `corr-${workspaceId}-${role ?? "key"}`,
  }
}

type ErrorBody = { error: { code: string; message: string; fieldErrors?: Record<string, string[]> } }

const delivered: FollowupDeliveryMessage[] = []
const webhookBodies: string[] = []
let dealCounter = 0
let emailTemplateId = ""
let smsTemplateId = ""
let renewalTemplateId = ""

async function seed() {
  const database = getDatabase()
  const now = new Date().toISOString()
  const visibility = JSON.stringify({ dashboard: true, deals: true, users: true, reports: true, payments: true, workspace: true, integrations: true })
  const actions = JSON.stringify({ createDeal: true, exportDeals: true, inviteUsers: true, manageApiKeys: true, viewPaymentTable: true, viewCompanyFinancials: true })
  const flags = JSON.stringify({ reports: true, payments: true, integrations: true })
  for (const [id, name] of [[ids.workspace, "Followup Test"], [ids.otherWorkspace, "Other Workspace"]] as const) {
    await database.prepare(`INSERT INTO workspaces (id,name,timezone,seat_limit,feature_flags,page_visibility,action_visibility,created_at,updated_at)
      VALUES (?, ?, 'America/New_York', 8, ?, ?, ?, ?, ?)`).run(id, name, flags, visibility, actions, now, now)
  }
  for (const [userId, memberId, email, name, phone, workspaceId, role] of [
    [ids.adminUser, ids.adminMember, "follow-admin@example.test", "Admin User", "(555) 000-0001", ids.workspace, "admin"],
    [ids.repUser, ids.repMember, "follow-rep@example.test", "Rep User", "(555) 000-0002", ids.workspace, "rep"],
    [ids.otherUser, ids.otherMember, "follow-other@example.test", "Other Admin", "(555) 000-0003", ids.otherWorkspace, "admin"],
  ] as const) {
    await database.prepare(`INSERT INTO users (id,email,password_hash,name,phone,application_identifier,created_at,updated_at)
      VALUES (?, ?, NULL, ?, ?, ?, ?, ?)`).run(userId, email, name, phone, `APP-${userId.slice(-6)}`, now, now)
    await database.prepare(`INSERT INTO memberships (id,workspace_id,user_id,role,manager_membership_id,status,sender_association,created_at,updated_at)
      VALUES (?, ?, ?, ?, NULL, 'active', NULL, ?, ?)`).run(memberId, workspaceId, userId, role, now, now)
  }
  await database.prepare(`INSERT INTO sessions (id,user_id,membership_id,token_hash,expires_at,created_at,last_seen_at)
    VALUES (?, ?, ?, ?, '2099-01-01T00:00:00.000Z', ?, ?)`).run("follow-admin-session", ids.adminUser, ids.adminMember, hashOpaqueToken("admin-session-token"), now, now)
  await database.prepare(`INSERT INTO sessions (id,user_id,membership_id,token_hash,expires_at,created_at,last_seen_at)
    VALUES (?, ?, ?, ?, '2099-01-01T00:00:00.000Z', ?, ?)`).run("follow-rep-session", ids.repUser, ids.repMember, hashOpaqueToken("rep-session-token"), now, now)
  await database.prepare(`INSERT INTO sessions (id,user_id,membership_id,token_hash,expires_at,created_at,last_seen_at)
    VALUES (?, ?, ?, ?, '2099-01-01T00:00:00.000Z', ?, ?)`).run("follow-other-session", ids.otherUser, ids.otherMember, hashOpaqueToken("other-session-token"), now, now)
  const addKey = async (id: string, secret: string, scopes: string[], workspaceId: string) => {
    await database.prepare(`INSERT INTO api_keys
      (id,workspace_id,name,prefix,secret_hash,scopes,expires_at,last_used_at,revoked_at,rate_limit_per_minute,created_by,created_at)
      VALUES (?, ?, ?, 'mca_test', ?, ?, NULL, NULL, NULL, 60, ?, ?)`).run(id, workspaceId, id, hashOpaqueToken(`mca_${secret}`), JSON.stringify(scopes), ids.adminUser, now)
  }
  await addKey("follow-intake-key", "intake-secret", ["intake:write"], ids.workspace)
  await addKey("follow-read-key", "read-secret", ["deals:read"], ids.workspace)
  await addKey("follow-write-key", "write-secret", ["deals:write"], ids.workspace)
}

before(async () => {
  testDatabase = await createPostgresTestDatabase("m06_followups")
  Object.assign(process.env, testDatabase.env())
  delete process.env.MCA_EMAIL_WEBHOOK_URL
  delete process.env.MCA_EMAIL_WEBHOOK_TOKEN
  await seed()
  const sender = await createSender(actor(), {
    provider: "smtp",
    purpose: "merchant",
    fromName: "Followup Desk",
    fromAddress: "followups@example.test",
    isDefault: true,
    smtp: { host: "smtp.example.test", port: 587, username: "followups", password: SMTP_PASSWORD },
  })
  await testSend(actor(), sender.id, { to: "ops@example.test" })
  const email = await createMessageTemplate(actor(), {
    name: "Missing documents follow-up",
    channel: "email",
    scope: "followup",
    subject: "Docs needed for {{business_name}}",
    body: "Hi {{owner_first_name}}, we still need: {{missing_docs}} Upload: {{auto_upload_url}}",
  })
  emailTemplateId = (await publishMessageTemplate(actor(), email.id)).id
  const sms = await createMessageTemplate(actor(), {
    name: "Approved offer SMS",
    channel: "sms",
    scope: "followup",
    body: "Great news {{owner_first_name}}! Highest offer: {{highest_offer_funding_amount}}",
  })
  smsTemplateId = (await publishMessageTemplate(actor(), sms.id)).id
  const renewal = await createMessageTemplate(actor(), {
    name: "Renewal follow-up",
    channel: "email",
    scope: "merchant",
    subject: "Time to renew {{business_name}}",
    body: "Hi {{owner_first_name}}, send latest statements: {{statements_upload_url}}",
  })
  renewalTemplateId = (await publishMessageTemplate(actor(), renewal.id)).id
})

beforeEach(async () => {
  delivered.length = 0
  webhookBodies.length = 0
  delete process.env.MCA_EMAIL_WEBHOOK_URL
  delete process.env.MCA_EMAIL_WEBHOOK_TOKEN
  setFollowupDeliveryFetchForTests()
  setFollowupTransportForTests(async (message) => {
    delivered.push(message)
    return { delivery: "sent", providerMessageId: `prov-${message.occurrenceId}` }
  })
  const database = getDatabase()
  await database.prepare("DELETE FROM mca_followup_occurrences").run()
  await database.prepare("DELETE FROM mca_followup_policies").run()
  await database.prepare("DELETE FROM mca_sms_consent_events").run()
})

after(async () => {
  setFollowupTransportForTests()
  setFollowupDeliveryFetchForTests()
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

function params(id: string) {
  return { params: Promise.resolve({ id }) }
}

function assertNoSecret(value: unknown) {
  const text = typeof value === "string" ? value : JSON.stringify(value)
  assert.equal(text.includes(SMTP_PASSWORD), false)
  assert.equal(text.includes(WEBHOOK_TOKEN), false)
  assert.equal(text.includes("credentialCipher"), false)
  assert.equal(text.includes("credential_cipher"), false)
}

async function seedDeal(input: {
  legalName: string
  status: string
  email?: string
  phone?: string
  owner?: string
  workspaceId?: string
}) {
  dealCounter += 1
  const workspaceId = input.workspaceId ?? ids.workspace
  const current = actor(workspaceId)
  const deal = (await createDeal(current, {
    idempotencyKey: `follow-deal-${dealCounter}`,
    legalName: input.legalName,
    contactEmail: input.email,
    contactPhone: input.phone,
    owners: [{ firstName: input.owner ?? "Pat", lastName: "Merchant", email: input.email, phone: input.phone, isPrimary: true }],
    assignments: [{ membershipId: current.membershipId!, kind: "originator", isPrimary: true }],
  })).deal
  await getDatabase().prepare("UPDATE deals SET status = ?, updated_at = ? WHERE id = ?").run(input.status, NOW, deal.id)
  return deal
}

function dailySchedule() {
  return { timezone: "America/New_York", frequency: "daily" as const, hour: 6, minute: 0 }
}

async function policy(input: {
  dealStatus: FollowupPolicyView["dealStatus"]
  channel: "email" | "sms"
  templateId: string
  retryPolicy?: { maxAttempts?: number; backoffMinutes?: number }
  enabled?: boolean
}) {
  return createFollowupPolicy(actor(), {
    dealStatus: input.dealStatus,
    channel: input.channel,
    localSchedule: dailySchedule(),
    templateId: input.templateId,
    enabled: input.enabled,
    retryPolicy: input.retryPolicy,
  })
}

test("MIC-115: missing-doc email, stage change skip, and replay cannot double-send", async () => {
  const winter = followupOccurrenceFor(dailySchedule(), NOW)
  assert.equal(winter?.localDate, "2026-01-15")
  assert.equal(winter?.occurrenceKey, "daily:2026-01-15")
  assert.equal(winter?.due, true)
  assert.equal(winter?.scheduledFor, NOW)
  const early = followupOccurrenceFor(dailySchedule(), BEFORE_SEND)
  assert.equal(early?.due, false)
  const weekly = followupOccurrenceFor({ timezone: "America/New_York", frequency: "weekly", hour: 6, minute: 0, weekday: 4 }, NOW)
  assert.equal(weekly?.occurrenceKey, "weekly:2026-01-15")
  const monthly = followupOccurrenceFor({ timezone: "America/New_York", frequency: "monthly", hour: 6, minute: 0, dayOfMonth: 15 }, NOW)
  assert.equal(monthly?.occurrenceKey, "monthly:2026-01-15")

  const missingPolicy = await policy({ dealStatus: "missing_documents", channel: "email", templateId: emailTemplateId })
  const missingDeal = await seedDeal({
    legalName: "Atlas Missing Docs LLC",
    status: "missing_documents",
    email: "docs@atlas.example.test",
    owner: "John",
  })
  const otherWs = await seedDeal({
    legalName: "Foreign Missing LLC",
    status: "missing_documents",
    email: "hidden@other.example.test",
    workspaceId: ids.otherWorkspace,
  })

  const tooEarly = await runFollowups({ actor: actor(), nowIso: BEFORE_SEND })
  assert.equal(tooEarly.sent, 0)
  assert.equal(delivered.length, 0)
  assert.ok(tooEarly.outcomes.every((item) => item.reason === "not_due"))

  const first = await runFollowups({ actor: actor(), nowIso: NOW })
  assert.equal(first.sent, 1)
  assert.equal(first.failed, 0)
  assert.equal(delivered.length, 1)
  assert.equal(delivered[0]?.dealId, missingDeal.id)
  assert.equal(delivered[0]?.to, "docs@atlas.example.test")
  assert.equal(delivered[0]?.channel, "email")
  assert.match(delivered[0]?.subject ?? "", /Atlas Missing Docs LLC/)
  assert.match(delivered[0]?.text ?? "", /John/)
  assert.match(delivered[0]?.text ?? "", /Upload:/)
  assert.equal(delivered[0]?.to.includes("hidden@other"), false)
  assert.equal(JSON.stringify(delivered[0]).includes(otherWs.id), false)
  assertNoSecret(delivered[0])

  const sentRow = await getDatabase().prepare<{ id: string; state: string; occurrence_key: string; correlation_id: string }>(
    "SELECT id, state, occurrence_key, correlation_id FROM mca_followup_occurrences WHERE deal_id=?",
  ).get(missingDeal.id)
  assert.equal(sentRow?.state, "sent")
  assert.equal(sentRow?.occurrence_key, "daily:2026-01-15")

  const replay = await runFollowups({ actor: actor(), nowIso: NOW })
  assert.equal(replay.sent, 0)
  assert.equal(delivered.length, 1)
  assert.ok(replay.outcomes.some((item) => item.reason === "already_sent" && item.occurrenceId === sentRow?.id && item.correlationId === sentRow?.correlation_id))
  const count = await getDatabase().prepare<{ count: number }>(
    "SELECT count(*)::int count FROM mca_followup_occurrences WHERE workspace_id=? AND policy_id=? AND deal_id=? AND occurrence_key=?",
  ).get(ids.workspace, missingPolicy.id, missingDeal.id, "daily:2026-01-15")
  assert.equal(count?.count, 1)

  const jobs = await jobsPost(cookieRequest("/api/mca/comms/jobs/run", "admin-session-token", {
    method: "POST",
    body: JSON.stringify({ nowIso: NOW, kinds: ["followup"] }),
  }))
  assert.equal(jobs.status, 200)
  const jobsBody = await jobs.json() as { followups: { attempted: number; sent: number; skipped: number } }
  assert.equal(jobsBody.followups.sent, 0)
  assert.equal(delivered.length, 1)
  assertNoSecret(jobsBody)

  const approvalPolicy = await policy({ dealStatus: "offer", channel: "email", templateId: emailTemplateId })
  const past = await seedDeal({
    legalName: "Past Approval LLC",
    status: "funded",
    email: "past@example.test",
  })
  await getDatabase().prepare(`INSERT INTO mca_followup_occurrences
    (id, workspace_id, policy_id, deal_id, occurrence_key, state, skip_reason, message_id, correlation_id, scheduled_for, attempted_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 'pending', NULL, NULL, ?, ?, NULL, ?, ?)`).run(
    newId(),
    ids.workspace,
    approvalPolicy.id,
    past.id,
    "daily:2026-01-15",
    "corr-past-approval",
    NOW,
    NOW,
    NOW,
  )
  const staged = await runFollowups({ actor: actor(), nowIso: NOW })
  const skipped = staged.outcomes.find((item) => item.dealId === past.id)
  assert.equal(skipped?.state, "skipped")
  assert.equal(skipped?.reason, "stage_changed")
  assert.equal(delivered.some((item) => item.dealId === past.id), false)
  const skippedRow = await getDatabase().prepare<{ state: string; skip_reason: string }>(
    "SELECT state, skip_reason FROM mca_followup_occurrences WHERE deal_id=?",
  ).get(past.id)
  assert.equal(skippedRow?.state, "skipped")
  assert.equal(skippedRow?.skip_reason, "stage_changed")
})

test("MIC-115: approval SMS consent, renewal, preview/test mode, and failed send keeps identity", async () => {
  const smsPolicy = await policy({ dealStatus: "offer", channel: "sms", templateId: smsTemplateId })
  const consented = await seedDeal({
    legalName: "Approved Merchant LLC",
    status: "offer",
    phone: MERCHANT_PHONE,
    owner: "Casey",
  })
  await recordSmsConsent(actor(), {
    dealId: consented.id,
    recipient: MERCHANT_E164,
    state: "opted_in",
    evidence: "Verbal opt-in on funding call",
    idempotencyKey: `consent-${consented.id}`,
  })
  const noConsent = await seedDeal({
    legalName: "No Consent LLC",
    status: "offer",
    phone: "(555) 222-3333",
    owner: "Riley",
  })
  const optedOut = await seedDeal({
    legalName: "Opted Out LLC",
    status: "offer",
    phone: "(555) 444-5555",
    owner: "Sam",
  })
  await recordSmsConsent(actor(), {
    dealId: optedOut.id,
    recipient: "+15554445555",
    state: "opted_out",
    evidence: "STOP reply",
    idempotencyKey: `optout-${optedOut.id}`,
  })

  const smsRun = await runFollowups({ actor: actor(), nowIso: NOW })
  assert.equal(smsRun.sent, 1)
  assert.equal(delivered.length, 1)
  assert.equal(delivered[0]?.dealId, consented.id)
  assert.equal(delivered[0]?.to, MERCHANT_E164)
  assert.equal(delivered[0]?.channel, "sms")
  assert.match(delivered[0]?.text ?? "", /Casey/)
  const blocked = smsRun.outcomes.filter((item) => item.dealId === noConsent.id || item.dealId === optedOut.id)
  assert.equal(blocked.find((item) => item.dealId === noConsent.id)?.reason, "sms_consent_required")
  assert.equal(blocked.find((item) => item.dealId === optedOut.id)?.reason, "sms_recipient_opted_out")
  assert.equal(blocked.every((item) => item.state === "skipped"), true)

  const renewal = await policy({ dealStatus: "renewed", channel: "email", templateId: renewalTemplateId })
  const renewed = await seedDeal({
    legalName: "Renewal Shop LLC",
    status: "renewed",
    email: "renew@shop.example.test",
    owner: "Alex",
  })
  const renewalRun = await runFollowups({ actor: actor(), nowIso: NOW })
  const renewalMail = delivered.find((item) => item.dealId === renewed.id)
  assert.ok(renewalMail)
  assert.match(renewalMail.subject ?? "", /Renewal Shop LLC/)
  assert.match(renewalMail.text, /Alex/)
  assert.match(renewalMail.text, /statements_upload_url|merchant-upload|target=statements/)
  assert.ok(renewalRun.outcomes.some((item) => item.dealId === renewed.id && item.state === "sent"))
  assert.equal(renewalMail.policyId, renewal.id)

  const previewPolicy = await policy({ dealStatus: "missing_documents", channel: "email", templateId: emailTemplateId })
  const previewDeal = await seedDeal({
    legalName: "Preview Mode LLC",
    status: "missing_documents",
    email: "preview@example.test",
    owner: "Kim",
  })
  const beforePreview = delivered.length
  const preview = await previewFollowupPolicy(actor(), { policyId: previewPolicy.id, dealId: previewDeal.id, nowIso: NOW, origin: "http://localhost" })
  assert.equal(preview.mode, "preview")
  assert.equal(preview.deals.length, 1)
  assert.equal(preview.deals[0]?.wouldSend, true)
  assert.equal(preview.deals[0]?.recipient, "preview@example.test")
  assert.match(preview.rendered?.text ?? "", /Kim/)
  assert.equal(delivered.length, beforePreview)
  const previewRows = await getDatabase().prepare<{ count: number }>(
    "SELECT count(*)::int count FROM mca_followup_occurrences WHERE policy_id=?",
  ).get(previewPolicy.id)
  assert.equal(previewRows?.count, 0)

  const tested = await testFollowupPolicy(actor(), previewPolicy.id, { dealId: previewDeal.id, origin: "http://localhost" })
  assert.equal(tested.mode, "test")
  assert.equal(tested.wouldSend, true)
  assert.equal(tested.delivery, "sent")
  assert.equal(tested.to, "preview@example.test")
  assert.equal(delivered.at(-1)?.mode, "test")
  const testRows = await getDatabase().prepare<{ count: number }>(
    "SELECT count(*)::int count FROM mca_followup_occurrences WHERE policy_id=?",
  ).get(previewPolicy.id)
  assert.equal(testRows?.count, 0)

  const liveAfterTest = await runFollowups({ actor: actor(), nowIso: NOW })
  assert.ok(liveAfterTest.outcomes.some((item) => item.dealId === previewDeal.id && item.state === "sent"))

  const retryPolicy = await policy({
    dealStatus: "missing_documents",
    channel: "email",
    templateId: emailTemplateId,
    retryPolicy: { maxAttempts: 3, backoffMinutes: 15 },
  })
  const retryDeal = await seedDeal({
    legalName: "Retry Merchant LLC",
    status: "missing_documents",
    email: "retry@example.test",
  })
  setFollowupTransportForTests(async () => ({ delivery: "failed", error: "The email provider did not accept the follow-up." }))
  const failed = await runFollowups({ actor: actor(), nowIso: NOW })
  const failedOutcome = failed.outcomes.find((item) => item.dealId === retryDeal.id && item.policyId === retryPolicy.id)
  assert.equal(failedOutcome?.state, "failed")
  assert.equal(failedOutcome?.reason, "send_failed")
  const failedRow = await getDatabase().prepare<{ id: string; state: string; correlation_id: string; skip_reason: string }>(
    "SELECT id, state, correlation_id, skip_reason FROM mca_followup_occurrences WHERE deal_id=? AND policy_id=?",
  ).get(retryDeal.id, retryPolicy.id)
  assert.equal(failedRow?.state, "failed")
  assert.match(failedRow?.skip_reason ?? "", /send_failed/)

  setFollowupTransportForTests(async (message) => {
    delivered.push(message)
    return { delivery: "sent", providerMessageId: "retry-ok" }
  })
  const retried = await runFollowups({ actor: actor(), nowIso: RETRY_NOW })
  const sentOutcome = retried.outcomes.find((item) => item.dealId === retryDeal.id && item.policyId === retryPolicy.id)
  assert.equal(sentOutcome?.state, "sent")
  assert.equal(sentOutcome?.occurrenceId, failedRow?.id)
  assert.equal(sentOutcome?.correlationId, failedRow?.correlation_id)
  const jobsReplay = await runCommsJobs({ actor: actor(), nowIso: RETRY_NOW, kinds: ["followup"] })
  assert.equal(jobsReplay.followups.sent, 0)
})

test("MIC-115: API matches the UI, validation and permissions, secrets stay out of JSON", async () => {
  const source = readFileSync(resolve(process.cwd(), "src/components/mca/comms/followup-panel.tsx"), "utf8")
  assert.match(source, /Loading follow-up policies/)
  assert.match(source, /No follow-up policies yet/)
  assert.match(source, /Choose a valid IANA timezone/)
  assert.match(source, /Follow-up policy saved/)
  assert.match(source, /Test follow-up delivered in preview mode/)
  assert.match(source, /role="alert"/)
  assert.match(source, /No matching deals in this status/)
  assert.match(source, /export function followupPanelGate/)
  assert.match(source, /phase: "loading"/)
  assert.match(source, /Choose a deal status/)
  assert.match(source, /Choose a published template/)

  const initial = await followupsGet(cookieRequest("/api/mca/comms/followups", "admin-session-token"))
  assert.equal(initial.status, 200)
  const initialBody = await initial.json() as { policies: unknown[]; templates: Array<{ id: string; channel: string }>; defaultTimezone: string; canManage: boolean }
  assert.equal(initialBody.policies.length, 0)
  assert.equal(initialBody.canManage, true)
  assert.equal(initialBody.defaultTimezone, "America/New_York")
  assert.ok(initialBody.templates.some((item) => item.id === emailTemplateId && item.channel === "email"))
  assertNoSecret(initialBody)

  const invalidTz = await followupsPost(cookieRequest("/api/mca/comms/followups", "admin-session-token", {
    method: "POST",
    body: JSON.stringify({
      dealStatus: "missing_documents",
      channel: "email",
      localSchedule: { timezone: "Not/AZone", frequency: "daily", hour: 6 },
      templateId: emailTemplateId,
    }),
  }))
  assert.equal(invalidTz.status, 422)
  assert.equal((await invalidTz.json() as ErrorBody).error.fieldErrors?.["localSchedule.timezone"]?.[0], "Choose a valid IANA timezone.")

  const created = await followupsPost(cookieRequest("/api/mca/comms/followups", "admin-session-token", {
    method: "POST",
    body: JSON.stringify({
      dealStatus: "missing_documents",
      channel: "email",
      localSchedule: dailySchedule(),
      templateId: emailTemplateId,
      enabled: true,
      retryPolicy: { maxAttempts: 3, backoffMinutes: 15 },
    }),
  }))
  assert.equal(created.status, 201)
  const createdBody = await created.json() as FollowupPolicyView
  assert.equal(createdBody.dealStatus, "missing_documents")
  assert.equal(createdBody.channel, "email")
  assert.equal(createdBody.enabled, true)
  assert.equal(createdBody.retryPolicy.maxAttempts, 3)
  assertNoSecret(createdBody)

  const patched = await followupPatch(cookieRequest(`/api/mca/comms/followups/${createdBody.id}`, "admin-session-token", {
    method: "PATCH",
    body: JSON.stringify({ enabled: false, retryPolicy: { maxAttempts: 2, backoffMinutes: 30 } }),
  }), params(createdBody.id))
  assert.equal(patched.status, 200)
  const patchedBody = await patched.json() as FollowupPolicyView
  assert.equal(patchedBody.id, createdBody.id)
  assert.equal(patchedBody.enabled, false)
  assert.equal(patchedBody.retryPolicy.maxAttempts, 2)
  const reenabled = await updateFollowupPolicy(actor(), createdBody.id, { enabled: true })
  assert.equal(reenabled.id, createdBody.id)

  const deal = await seedDeal({
    legalName: "API Preview LLC",
    status: "missing_documents",
    email: "api-preview@example.test",
  })
  const preview = await previewGet(cookieRequest(
    `/api/mca/comms/followups/preview?policyId=${createdBody.id}&dealId=${deal.id}&nowIso=${encodeURIComponent(NOW)}`,
    "admin-session-token",
  ))
  assert.equal(preview.status, 200)
  const previewBody = await preview.json() as { mode: string; deals: Array<{ wouldSend: boolean; dealId: string }> }
  assert.equal(previewBody.mode, "preview")
  assert.equal(previewBody.deals[0]?.wouldSend, true)
  assertNoSecret(previewBody)

  const previewWrite = await previewPost(cookieRequest("/api/mca/comms/followups/preview", "admin-session-token", {
    method: "POST",
    body: JSON.stringify({ policyId: createdBody.id, dealId: deal.id, nowIso: NOW }),
  }))
  assert.equal(previewWrite.status, 200)

  const tested = await testPost(cookieRequest(`/api/mca/comms/followups/${createdBody.id}/test`, "admin-session-token", {
    method: "POST",
    body: JSON.stringify({ dealId: deal.id }),
  }), params(createdBody.id))
  assert.equal(tested.status, 200)
  const testedBody = await tested.json() as { mode: string; wouldSend: boolean; to?: string }
  assert.equal(testedBody.mode, "test")
  assert.equal(testedBody.wouldSend, true)
  assertNoSecret(testedBody)

  const loaded = await followupGet(cookieRequest(`/api/mca/comms/followups/${createdBody.id}`, "admin-session-token"), params(createdBody.id))
  assert.equal(loaded.status, 200)

  const intake = await followupsGet(bearerRequest("/api/mca/comms/followups", "intake-secret"))
  assert.equal(intake.status, 403)
  const readKey = await followupsGet(bearerRequest("/api/mca/comms/followups", "read-secret"))
  assert.equal(readKey.status, 403)
  const writeKey = await followupsPost(bearerRequest("/api/mca/comms/followups", "write-secret", {
    method: "POST",
    body: JSON.stringify({
      dealStatus: "offer",
      channel: "email",
      localSchedule: dailySchedule(),
      templateId: emailTemplateId,
    }),
  }))
  assert.equal(writeKey.status, 403)

  const repGet = await followupsGet(cookieRequest("/api/mca/comms/followups", "rep-session-token"))
  assert.equal(repGet.status, 403)
  const repPost = await followupsPost(cookieRequest("/api/mca/comms/followups", "rep-session-token", {
    method: "POST",
    body: JSON.stringify({
      dealStatus: "offer",
      channel: "email",
      localSchedule: dailySchedule(),
      templateId: emailTemplateId,
    }),
  }))
  assert.equal(repPost.status, 403)

  const other = await followupsGet(cookieRequest("/api/mca/comms/followups", "other-session-token"))
  assert.equal(other.status, 200)
  const otherBody = await other.json() as { policies: FollowupPolicyView[] }
  assert.equal(otherBody.policies.some((item) => item.id === createdBody.id), false)

  const mismatch = await followupsPost(cookieRequest("/api/mca/comms/followups", "admin-session-token", {
    method: "POST",
    body: JSON.stringify({
      dealStatus: "offer",
      channel: "sms",
      localSchedule: dailySchedule(),
      templateId: emailTemplateId,
    }),
  }))
  assert.equal(mismatch.status, 422)

  process.env.MCA_EMAIL_WEBHOOK_URL = "https://email-webhook.example.test/followup"
  process.env.MCA_EMAIL_WEBHOOK_TOKEN = WEBHOOK_TOKEN
  setFollowupTransportForTests()
  setFollowupDeliveryFetchForTests(async (_input, init) => {
    webhookBodies.push(typeof init?.body === "string" ? init.body : "")
    return new Response("accepted", { status: 202 })
  })
  const hookedDeal = await seedDeal({
    legalName: "Webhook Merchant LLC",
    status: "missing_documents",
    email: "hook@example.test",
  })
  const hooked = await runFollowups({ actor: actor(), nowIso: NOW })
  assert.ok(hooked.outcomes.some((item) => item.dealId === hookedDeal.id && item.state === "sent"))
  assert.ok(webhookBodies.length >= 1)
  assertNoSecret(webhookBodies[0])
  assert.equal(webhookBodies[0]?.includes(WEBHOOK_TOKEN), false)
  assert.match(webhookBodies[0] ?? "", /merchant_followup/)
})
