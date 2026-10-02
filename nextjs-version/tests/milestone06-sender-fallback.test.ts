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
import { createSender, expireSender } from "../src/lib/mca/senders/service"
import { createMessageTemplate } from "../src/lib/mca/comms/templates"
import {
  SENDER_FALLBACK_COPY,
  getFollowupSenderSettings,
  listFollowupSenderCatalog,
  previewFollowupSender,
  resolveFollowupSender,
  senderFallbackGate,
  updateFollowupSenderSettings,
  type FollowupSenderCatalog,
  type FollowupSenderResolution,
} from "../src/lib/mca/comms/sender-fallback"
import { GET as settingsGet, PATCH as settingsPatch } from "../src/app/api/mca/comms/sender-fallback/route"
import { GET as previewGet, POST as previewPost } from "../src/app/api/mca/comms/sender-fallback/preview/route"

let testDatabase: Awaited<ReturnType<typeof createPostgresTestDatabase>>

const SMTP_PASSWORD = "smtp-sender-fallback-password-never-leak"
const NOW = "2026-01-15T11:00:00.000Z"

const ids = {
  workspace: "workspace-m06-sender-fallback",
  otherWorkspace: "workspace-m06-sender-fallback-other",
  adminUser: "sf-admin-user",
  adminMember: "sf-admin-member",
  repUser: "sf-rep-user",
  repMember: "sf-rep-member",
  otherUser: "sf-other-user",
  otherMember: "sf-other-member",
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

let dealCounter = 0
let originatorSenderId = ""
let fallbackSenderId = ""
let submissionSenderId = ""
let templateId = ""
let otherTemplateId = ""

async function seed() {
  const database = getDatabase()
  const now = new Date().toISOString()
  const visibility = JSON.stringify({ dashboard: true, deals: true, users: true, reports: true, payments: true, workspace: true, integrations: true })
  const actions = JSON.stringify({ createDeal: true, exportDeals: true, inviteUsers: true, manageApiKeys: true, viewPaymentTable: true, viewCompanyFinancials: true })
  const flags = JSON.stringify({ reports: true, payments: true, integrations: true })
  for (const [id, name] of [[ids.workspace, "Sender Fallback Test"], [ids.otherWorkspace, "Other Workspace"]] as const) {
    await database.prepare(`INSERT INTO workspaces (id,name,timezone,seat_limit,feature_flags,page_visibility,action_visibility,created_at,updated_at)
      VALUES (?, ?, 'America/New_York', 8, ?, ?, ?, ?, ?)`).run(id, name, flags, visibility, actions, now, now)
  }
  for (const [userId, memberId, email, name, phone, workspaceId, role] of [
    [ids.adminUser, ids.adminMember, "sf-admin@example.test", "Admin User", "(555) 000-0001", ids.workspace, "admin"],
    [ids.repUser, ids.repMember, "sf-originator@example.test", "Originator Rep", "(555) 000-0002", ids.workspace, "rep"],
    [ids.otherUser, ids.otherMember, "sf-other@example.test", "Other Admin", "(555) 000-0003", ids.otherWorkspace, "admin"],
  ] as const) {
    await database.prepare(`INSERT INTO users (id,email,password_hash,name,phone,application_identifier,created_at,updated_at)
      VALUES (?, ?, NULL, ?, ?, ?, ?, ?)`).run(userId, email, name, phone, `APP-${userId.slice(-6)}`, now, now)
    await database.prepare(`INSERT INTO memberships (id,workspace_id,user_id,role,manager_membership_id,status,sender_association,created_at,updated_at)
      VALUES (?, ?, ?, ?, NULL, 'active', NULL, ?, ?)`).run(memberId, workspaceId, userId, role, now, now)
  }
  await database.prepare(`INSERT INTO sessions (id,user_id,membership_id,token_hash,expires_at,created_at,last_seen_at)
    VALUES (?, ?, ?, ?, '2099-01-01T00:00:00.000Z', ?, ?)`).run("sf-admin-session", ids.adminUser, ids.adminMember, hashOpaqueToken("admin-session-token"), now, now)
  await database.prepare(`INSERT INTO sessions (id,user_id,membership_id,token_hash,expires_at,created_at,last_seen_at)
    VALUES (?, ?, ?, ?, '2099-01-01T00:00:00.000Z', ?, ?)`).run("sf-rep-session", ids.repUser, ids.repMember, hashOpaqueToken("rep-session-token"), now, now)
  await database.prepare(`INSERT INTO sessions (id,user_id,membership_id,token_hash,expires_at,created_at,last_seen_at)
    VALUES (?, ?, ?, ?, '2099-01-01T00:00:00.000Z', ?, ?)`).run("sf-other-session", ids.otherUser, ids.otherMember, hashOpaqueToken("other-session-token"), now, now)
  const addKey = async (id: string, secret: string, scopes: string[], workspaceId: string) => {
    await database.prepare(`INSERT INTO api_keys
      (id,workspace_id,name,prefix,secret_hash,scopes,expires_at,last_used_at,revoked_at,rate_limit_per_minute,created_by,created_at)
      VALUES (?, ?, ?, 'mca_test', ?, ?, NULL, NULL, NULL, 60, ?, ?)`).run(id, workspaceId, id, hashOpaqueToken(`mca_${secret}`), JSON.stringify(scopes), ids.adminUser, now)
  }
  await addKey("sf-intake-key", "intake-secret", ["intake:write"], ids.workspace)
  await addKey("sf-read-key", "read-secret", ["deals:read"], ids.workspace)
  await addKey("sf-write-key", "write-secret", ["deals:write"], ids.workspace)
}

before(async () => {
  testDatabase = await createPostgresTestDatabase("m06_sender_fb")
  Object.assign(process.env, testDatabase.env())
  delete process.env.MCA_EMAIL_WEBHOOK_URL
  delete process.env.MCA_EMAIL_WEBHOOK_TOKEN
  await seed()
  const originator = await createSender(actor(), {
    provider: "smtp",
    purpose: "merchant",
    fromName: "Originator Desk",
    fromAddress: "originator@example.test",
    isDefault: true,
    memberIds: [ids.repMember],
    smtp: { host: "smtp.example.test", port: 587, username: "originator", password: SMTP_PASSWORD },
  })
  originatorSenderId = originator.id
  await getDatabase().prepare("UPDATE mca_email_senders SET state='verified',verified_at=? WHERE workspace_id=? AND id=?").run(new Date().toISOString(), originator.workspaceId, originator.id)
  const fallback = await createSender(actor(), {
    provider: "smtp",
    purpose: "fallback",
    fromName: "Workspace Fallback",
    fromAddress: "fallback@example.test",
    isDefault: true,
    smtp: { host: "smtp.example.test", port: 587, username: "fallback", password: SMTP_PASSWORD },
  })
  fallbackSenderId = fallback.id
  await getDatabase().prepare("UPDATE mca_email_senders SET state='verified',verified_at=? WHERE workspace_id=? AND id=?").run(new Date().toISOString(), fallback.workspaceId, fallback.id)
  const submission = await createSender(actor(), {
    provider: "smtp",
    purpose: "submission",
    fromName: "Submission Desk",
    fromAddress: "submissions@example.test",
    isDefault: true,
    smtp: { host: "smtp.example.test", port: 587, username: "submissions", password: SMTP_PASSWORD },
  })
  submissionSenderId = submission.id
  await getDatabase().prepare("UPDATE mca_email_senders SET state='verified',verified_at=? WHERE workspace_id=? AND id=?").run(new Date().toISOString(), submission.workspaceId, submission.id)
  const otherFallback = await createSender(actor(ids.otherWorkspace), {
    provider: "smtp",
    purpose: "fallback",
    fromName: "Other Fallback",
    fromAddress: "other-fallback@example.test",
    isDefault: true,
    smtp: { host: "smtp.example.test", port: 587, username: "other", password: SMTP_PASSWORD },
  })
  await getDatabase().prepare("UPDATE mca_email_senders SET state='verified',verified_at=? WHERE workspace_id=? AND id=?").run(new Date().toISOString(), otherFallback.workspaceId, otherFallback.id)
  templateId = (await createMessageTemplate(actor(), {
    name: "Missing documents follow-up",
    channel: "email",
    scope: "followup",
    subject: "Docs needed for {{business_name}}",
    body: "Hi {{owner_first_name}}, we still need documents.",
  })).id
  otherTemplateId = (await createMessageTemplate(actor(ids.otherWorkspace), {
    name: "Other follow-up",
    channel: "email",
    scope: "followup",
    subject: "Other {{business_name}}",
    body: "Hi {{owner_first_name}}",
  })).id
  await listFollowupSenderCatalog(actor())
  await getDatabase().prepare(`INSERT INTO mca_submission_templates
    (id, workspace_id, funder_id, subject_template, body_template, prefix, cc_originator, cc_closer, updated_by_user_id, updated_at)
    VALUES (?, ?, NULL, 'Submission {{business}}', 'Please review.', NULL, 1, 1, ?, ?)`).run(
    newId(),
    ids.workspace,
    ids.adminUser,
    NOW,
  )
})

beforeEach(async () => {
  const database = getDatabase()
  const now = new Date().toISOString()
  for (const senderId of [originatorSenderId, fallbackSenderId, submissionSenderId]) {
    await database.prepare(
      "UPDATE mca_email_senders SET state='verified', last_error=NULL, verified_at=?, updated_at=? WHERE workspace_id=? AND id=?",
    ).run(now, now, ids.workspace, senderId)
  }
  await database.execute("DELETE FROM mca_followup_template_copy")
  await database.execute("DELETE FROM mca_followup_sender_settings")
})

after(async () => {
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
  assert.equal(text.includes("credentialCipher"), false)
  assert.equal(text.includes("credential_cipher"), false)
}

async function seedDeal(input: { legalName: string; email?: string; owner?: string; workspaceId?: string } = { legalName: "Atlas Funding LLC" }) {
  dealCounter += 1
  const workspaceId = input.workspaceId ?? ids.workspace
  const current = actor(workspaceId)
  const originatorMember = workspaceId === ids.otherWorkspace ? ids.otherMember : ids.repMember
  const deal = (await createDeal(current, {
    idempotencyKey: `sf-deal-${dealCounter}`,
    legalName: input.legalName,
    contactEmail: input.email ?? "merchant@atlas.example.test",
    owners: [{ firstName: input.owner ?? "John", lastName: "Merchant", email: input.email ?? "merchant@atlas.example.test", isPrimary: true }],
    assignments: [
      { membershipId: originatorMember, kind: "originator", isPrimary: true },
      ...(workspaceId === ids.workspace ? [{ membershipId: ids.adminMember, kind: "closer" as const, isPrimary: true }] : []),
    ],
  })).deal
  return deal
}

test("MIC-117: disconnecting originator selects verified fallback once; neither sender is a visible failure", async () => {
  const deal = await seedDeal({ legalName: "Atlas Originator LLC", email: "john@atlas.example.test", owner: "John" })
  await updateFollowupSenderSettings(actor(), { senderMode: "originator", bccFallback: false })

  const connected = await resolveFollowupSender(actor(), { dealId: deal.id, templateId })
  assert.equal(connected.ok, true)
  assert.equal(connected.success, true)
  assert.equal(connected.wouldSend, true)
  assert.equal(connected.source, "originator")
  assert.equal(connected.usedFallback, false)
  assert.equal(connected.fallbackAttempts, 0)
  assert.equal(connected.sender?.id, originatorSenderId)
  assert.equal(connected.fromAddress, "originator@example.test")
  assert.equal(connected.sender?.id === submissionSenderId, false)
  assert.equal(connected.originatorMembershipId, ids.repMember)
  assertNoSecret(connected)

  await expireSender(actor(), originatorSenderId, "Originator mailbox disconnected.")
  const firstFallback = await resolveFollowupSender(actor(), { dealId: deal.id, templateId })
  assert.equal(firstFallback.ok, true)
  assert.equal(firstFallback.success, true)
  assert.equal(firstFallback.wouldSend, true)
  assert.equal(firstFallback.source, "fallback")
  assert.equal(firstFallback.usedFallback, true)
  assert.equal(firstFallback.fallbackAttempts, 1)
  assert.equal(firstFallback.sender?.id, fallbackSenderId)
  assert.equal(firstFallback.fromAddress, "fallback@example.test")
  assert.equal(firstFallback.sender?.purpose, "fallback")
  assert.equal(firstFallback.reason, "originator_disconnected")
  assert.equal(firstFallback.problem, SENDER_FALLBACK_COPY.fallbackOnce)
  assert.match(firstFallback.originatorProblem ?? "", /expired|revoked|verified/i)
  assert.equal(firstFallback.sender?.id === submissionSenderId, false)
  assert.equal(firstFallback.sender?.fromAddress === "submissions@example.test", false)

  const second = await resolveFollowupSender(actor(), { dealId: deal.id, templateId })
  const third = await previewFollowupSender(actor(), { dealId: deal.id, templateId })
  assert.equal(second.sender?.id, firstFallback.sender?.id)
  assert.equal(third.sender?.id, firstFallback.sender?.id)
  assert.equal(second.fallbackAttempts, 1)
  assert.equal(third.fallbackAttempts, 1)
  assert.equal(second.usedFallback, true)
  assert.equal(third.source, "fallback")
  assert.equal(second.settingsId, firstFallback.settingsId)
  assert.equal(third.settingsId, firstFallback.settingsId)

  const preview = await previewGet(cookieRequest(
    `/api/mca/comms/sender-fallback/preview?dealId=${deal.id}&templateId=${templateId}`,
    "admin-session-token",
  ))
  assert.equal(preview.status, 200)
  const previewBody = await preview.json() as FollowupSenderResolution
  assert.equal(previewBody.ok, true)
  assert.equal(previewBody.sender?.id, fallbackSenderId)
  assert.equal(previewBody.fallbackAttempts, 1)
  assert.equal(previewBody.fromAddress, "fallback@example.test")
  assertNoSecret(previewBody)

  await expireSender(actor(), fallbackSenderId, "Fallback mailbox disconnected.")
  const failed = await resolveFollowupSender(actor(), { dealId: deal.id, templateId })
  assert.equal(failed.ok, false)
  assert.equal(failed.success, false)
  assert.equal(failed.wouldSend, false)
  assert.equal(failed.reason, "sender_unavailable")
  assert.equal(Boolean(failed.sender), false)
  assert.equal(failed.fromAddress, undefined)
  assert.match(failed.problem ?? "", /originator|fallback/i)
  assert.notEqual(failed.problem, undefined)

  const failedPreview = await previewPost(cookieRequest("/api/mca/comms/sender-fallback/preview", "admin-session-token", {
    method: "POST",
    body: JSON.stringify({ dealId: deal.id, templateId }),
  }))
  assert.equal(failedPreview.status, 200)
  const failedBody = await failedPreview.json() as FollowupSenderResolution
  assert.equal(failedBody.ok, false)
  assert.equal(failedBody.success, false)
  assert.equal(failedBody.wouldSend, false)
  assert.equal(failedBody.reason, "sender_unavailable")
  assert.equal(failedBody.sender, undefined)
  assert.ok(failedBody.problem)
  assertNoSecret(failedBody)

  const gateFailure = senderFallbackGate({
    loading: false,
    merchantCount: 1,
    fallbackCount: 1,
    senderMode: "originator",
    previewOk: false,
    previewReason: "sender_unavailable",
  })
  assert.equal(gateFailure.phase, "failure")
  assert.equal(gateFailure.reason, SENDER_FALLBACK_COPY.senderUnavailable)
})

test("MIC-117: workspace-shared vs originator, template CC and fallback BCC stay independent of submission rep-copy", async () => {
  const deal = await seedDeal({ legalName: "Harbor Bakery LLC", email: "casey@harbor.example.test", owner: "Casey" })
  const catalogBefore = await listFollowupSenderCatalog(actor())
  assert.equal(catalogBefore.settings.senderMode, "originator")
  assert.equal(catalogBefore.settings.bccFallback, false)
  assert.equal(catalogBefore.submissionRepCopyIndependent, true)
  assert.ok(catalogBefore.senders.merchant.some((item) => item.id === originatorSenderId))
  assert.ok(catalogBefore.senders.fallback.some((item) => item.id === fallbackSenderId))
  assert.ok(catalogBefore.senders.submission.some((item) => item.id === submissionSenderId))

  const saved = await updateFollowupSenderSettings(actor(), {
    senderMode: "workspace_shared",
    bccFallback: true,
    templates: [{ templateId, ccEmails: ["ops-copy@example.test", "compliance@example.test"] }],
  })
  assert.equal(saved.settings.senderMode, "workspace_shared")
  assert.equal(saved.settings.bccFallback, true)
  assert.equal(saved.settings.persisted, true)
  const templateCopy = saved.templates.find((item) => item.templateId === templateId)
  assert.deepEqual(templateCopy?.ccEmails, ["ops-copy@example.test", "compliance@example.test"])

  const shared = await resolveFollowupSender(actor(), { dealId: deal.id, templateId })
  assert.equal(shared.ok, true)
  assert.equal(shared.source, "workspace")
  assert.equal(shared.usedFallback, false)
  assert.equal(shared.fallbackAttempts, 0)
  assert.equal(shared.sender?.id, fallbackSenderId)
  assert.equal(shared.fromAddress, "fallback@example.test")
  assert.deepEqual(shared.cc, ["ops-copy@example.test", "compliance@example.test"])
  assert.deepEqual(shared.bcc, ["fallback@example.test"])
  assert.equal(shared.ccSource, "template")
  assert.equal(shared.bccSource, "fallback")
  assert.equal(shared.cc.includes("sf-originator@example.test"), false)
  assert.equal(shared.cc.includes("sf-admin@example.test"), false)
  assert.equal(shared.bcc.includes("sf-originator@example.test"), false)
  assert.equal(shared.sender?.id === originatorSenderId, false)
  assert.equal(shared.sender?.id === submissionSenderId, false)
  assertNoSecret(shared)

  const replaySettings = await updateFollowupSenderSettings(actor(), {
    senderMode: "originator",
    bccFallback: true,
    templates: [{ templateId, ccEmails: "ops-copy@example.test, compliance@example.test" }],
  })
  assert.equal(replaySettings.settings.id, saved.settings.id)
  assert.equal(replaySettings.settings.senderMode, "originator")

  const originatorMode = await resolveFollowupSender(actor(), { dealId: deal.id, templateId })
  assert.equal(originatorMode.source, "originator")
  assert.equal(originatorMode.sender?.id, originatorSenderId)
  assert.equal(originatorMode.fromAddress, "originator@example.test")
  assert.deepEqual(originatorMode.cc, ["ops-copy@example.test", "compliance@example.test"])
  assert.deepEqual(originatorMode.bcc, ["fallback@example.test"])
  assert.equal(originatorMode.cc.includes("sf-originator@example.test"), false)
  assert.equal(originatorMode.cc.includes("sf-admin@example.test"), false)
  assert.equal(originatorMode.ccSource, "template")
  assert.equal(originatorMode.bccSource, "fallback")

  const submissionRow = await getDatabase().prepare<{ cc_originator: number; cc_closer: number }>(
    "SELECT cc_originator, cc_closer FROM mca_submission_templates WHERE workspace_id=?",
  ).get(ids.workspace)
  assert.equal(Number(submissionRow?.cc_originator), 1)
  assert.equal(Number(submissionRow?.cc_closer), 1)

  const noDealShared = await resolveFollowupSender(actor(), { templateId })
  assert.equal(noDealShared.ok, false)
  assert.equal(noDealShared.reason, "deal_required")

  await updateFollowupSenderSettings(actor(), { senderMode: "workspace_shared" })
  const sharedNoDeal = await resolveFollowupSender(actor(), { templateId })
  assert.equal(sharedNoDeal.ok, true)
  assert.equal(sharedNoDeal.source, "workspace")
  assert.equal(sharedNoDeal.sender?.id, fallbackSenderId)
  assert.deepEqual(sharedNoDeal.cc, ["ops-copy@example.test", "compliance@example.test"])
})

test("MIC-117: API matches UI permissions, validation, identity, and secrets stay out of JSON", async () => {
  const source = readFileSync(resolve(process.cwd(), "src/lib/mca/comms/sender-fallback.ts"), "utf8")
  assert.match(source, /Loading follow-up sender settings/)
  assert.match(source, /No merchant or fallback senders yet/)
  assert.match(source, /Choose workspace-shared or each deal's originator/)
  assert.match(source, /Follow-up sender settings saved/)
  assert.match(source, /Neither the originator's merchant-facing sender nor the workspace fallback sender/)
  assert.match(source, /export function senderFallbackGate/)
  assert.match(source, /phase: "loading"/)
  assert.match(source, /submissionRepCopyIndependent/)
  assert.match(source, /fallbackAttempts: 1/)

  assert.equal(senderFallbackGate({ loading: true, merchantCount: 0, fallbackCount: 0 }).phase, "loading")
  assert.equal(senderFallbackGate({ loading: true, merchantCount: 0, fallbackCount: 0 }).reason, SENDER_FALLBACK_COPY.loading)
  assert.equal(senderFallbackGate({ loading: false, merchantCount: 0, fallbackCount: 0 }).phase, "empty")
  assert.equal(senderFallbackGate({ loading: false, merchantCount: 0, fallbackCount: 0 }).reason, SENDER_FALLBACK_COPY.empty)
  assert.equal(senderFallbackGate({ loading: false, merchantCount: 1, fallbackCount: 1, senderMode: "nope" }).phase, "validation")
  assert.equal(senderFallbackGate({ loading: false, merchantCount: 1, fallbackCount: 1, ccEmails: ["not-an-email"] }).phase, "validation")
  const ready = senderFallbackGate({ loading: false, merchantCount: 1, fallbackCount: 1, senderMode: "originator" })
  assert.equal(ready.phase, "ready")
  assert.equal(ready.saveEnabled, true)
  assert.equal(ready.reason, SENDER_FALLBACK_COPY.saved)

  const initial = await settingsGet(cookieRequest("/api/mca/comms/sender-fallback", "admin-session-token"))
  assert.equal(initial.status, 200)
  const initialBody = await initial.json() as FollowupSenderCatalog
  assert.equal(initialBody.settings.senderMode, "originator")
  assert.equal(initialBody.canManage, true)
  assert.equal(initialBody.copy.saved, SENDER_FALLBACK_COPY.saved)
  assert.equal(initialBody.copy.empty, SENDER_FALLBACK_COPY.empty)
  assert.ok(initialBody.templates.some((item) => item.templateId === templateId))
  assertNoSecret(initialBody)

  const invalidMode = await settingsPatch(cookieRequest("/api/mca/comms/sender-fallback", "admin-session-token", {
    method: "PATCH",
    body: JSON.stringify({ senderMode: "submission" }),
  }))
  assert.equal(invalidMode.status, 400)

  const invalidCc = await settingsPatch(cookieRequest("/api/mca/comms/sender-fallback", "admin-session-token", {
    method: "PATCH",
    body: JSON.stringify({ templates: [{ templateId, ccEmails: ["not-an-email"] }] }),
  }))
  assert.equal(invalidCc.status, 422)
  assert.equal((await invalidCc.json() as ErrorBody).error.fieldErrors?.["templates.0.ccEmails"]?.[0], SENDER_FALLBACK_COPY.ccInvalid)

  const otherTemplate = await settingsPatch(cookieRequest("/api/mca/comms/sender-fallback", "admin-session-token", {
    method: "PATCH",
    body: JSON.stringify({ templates: [{ templateId: otherTemplateId, ccEmails: ["leak@example.test"] }] }),
  }))
  assert.equal(otherTemplate.status, 422)

  const created = await settingsPatch(cookieRequest("/api/mca/comms/sender-fallback", "admin-session-token", {
    method: "PATCH",
    body: JSON.stringify({
      senderMode: "originator",
      bccFallback: true,
      templates: [{ templateId, ccEmails: ["ops-copy@example.test"] }],
    }),
  }))
  assert.equal(created.status, 200)
  const createdBody = await created.json() as FollowupSenderCatalog
  assert.equal(createdBody.settings.persisted, true)
  assert.ok(createdBody.settings.id)
  assert.equal(createdBody.settings.bccFallback, true)
  assertNoSecret(createdBody)

  const retried = await settingsPatch(cookieRequest("/api/mca/comms/sender-fallback", "admin-session-token", {
    method: "PATCH",
    body: JSON.stringify({ senderMode: "originator", bccFallback: true }),
  }))
  assert.equal(retried.status, 200)
  const retriedBody = await retried.json() as FollowupSenderCatalog
  assert.equal(retriedBody.settings.id, createdBody.settings.id)
  const persisted = await getFollowupSenderSettings(actor())
  assert.equal(persisted.id, createdBody.settings.id)

  const deal = await seedDeal({ legalName: "API Preview LLC" })
  const preview = await previewGet(cookieRequest(
    `/api/mca/comms/sender-fallback/preview?dealId=${deal.id}&templateId=${templateId}`,
    "admin-session-token",
  ))
  assert.equal(preview.status, 200)
  const previewBody = await preview.json() as FollowupSenderResolution
  assert.equal(previewBody.ok, true)
  assert.equal(previewBody.fromAddress, "originator@example.test")
  assert.deepEqual(previewBody.cc, ["ops-copy@example.test"])
  assert.deepEqual(previewBody.bcc, ["fallback@example.test"])
  assertNoSecret(previewBody)

  const previewWrite = await previewPost(cookieRequest("/api/mca/comms/sender-fallback/preview", "admin-session-token", {
    method: "POST",
    body: JSON.stringify({ dealId: deal.id, templateId }),
  }))
  assert.equal(previewWrite.status, 200)

  const intake = await settingsGet(bearerRequest("/api/mca/comms/sender-fallback", "intake-secret"))
  assert.equal(intake.status, 403)
  const readKey = await settingsGet(bearerRequest("/api/mca/comms/sender-fallback", "read-secret"))
  assert.equal(readKey.status, 403)
  const writeKey = await settingsPatch(bearerRequest("/api/mca/comms/sender-fallback", "write-secret", {
    method: "PATCH",
    body: JSON.stringify({ senderMode: "workspace_shared" }),
  }))
  assert.equal(writeKey.status, 403)

  const repGet = await settingsGet(cookieRequest("/api/mca/comms/sender-fallback", "rep-session-token"))
  assert.equal(repGet.status, 403)
  const repPatch = await settingsPatch(cookieRequest("/api/mca/comms/sender-fallback", "rep-session-token", {
    method: "PATCH",
    body: JSON.stringify({ senderMode: "workspace_shared" }),
  }))
  assert.equal(repPatch.status, 403)

  const other = await settingsGet(cookieRequest("/api/mca/comms/sender-fallback", "other-session-token"))
  assert.equal(other.status, 200)
  const otherBody = await other.json() as FollowupSenderCatalog
  assert.equal(otherBody.settings.id === createdBody.settings.id, false)
  assert.equal(otherBody.templates.some((item) => item.templateId === templateId), false)
  assert.equal(otherBody.senders.fallback.some((item) => item.id === fallbackSenderId), false)
  assertNoSecret(otherBody)
})
