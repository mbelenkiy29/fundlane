import "./helpers/business-auth";
import test, { after, before } from "node:test"
import assert from "node:assert/strict"
import { createHash, createHmac, generateKeyPairSync, sign as cryptoSign } from "node:crypto"
import { closeDatabaseForTests, getDatabase } from "../src/lib/mca/db"
import { createPostgresTestDatabase } from "./helpers/postgres-test-db.mjs"
import { hashOpaqueToken } from "../src/lib/mca/crypto"
import type { MembershipContext } from "../src/lib/mca/types"
import type { DealActor } from "../src/lib/mca/deals/schema"
import { getDeal } from "../src/lib/mca/deals/service"
import { setDocumentStorageForTests, type DocumentStorage } from "../src/lib/mca/documents/storage"
import { setDocumentScannerForTests } from "../src/lib/mca/documents/scanner"
import { configureIntegration, createJotformRepLink, provisionPostmarkIntegration, provisionUsesendIntegration, rotateIntegrationCredentials } from "../src/lib/mca/intake/configuration"
import { ingestProviderDelivery } from "../src/lib/mca/intake/ingress"
import { ingestEmailDelivery, deliverPendingReceipts, readInboundEmailBody } from "../src/lib/mca/intake/email"
import { usesendSignature } from "../src/lib/mca/intake/usesend"
import { normalizeProviderPayload } from "../src/lib/mca/intake/providers"
import { associateIntakeIntegration, claimAttachmentJob, claimReceipt, completeAttachmentJob, completeReceipt, enqueueReceipt, findIntegrationByPublicId, listAttachmentJobs, listPendingReceipts } from "../src/lib/mca/intake/repository"
import { attachIntakeDocument, fetchPrivateAttachment, ingestApplication, listIntakeSummaries, processAttachmentJob, replayIntake, scheduleAttachment } from "../src/lib/mca/intake/service"
import { POST as intakePost } from "../src/app/api/mca/intake/route"
import { POST as integrationPost } from "../src/app/api/mca/intake/integrations/route"

let testDatabase: Awaited<ReturnType<typeof createPostgresTestDatabase>>
delete process.env.MCA_INTAKE_RECEIPT_WEBHOOK_URL

const ids = {
  workspace: "10000000-0000-4000-8000-000000000001",
  adminUser: "10000000-0000-4000-8000-000000000002",
  adminMember: "10000000-0000-4000-8000-000000000003",
  repAUser: "10000000-0000-4000-8000-000000000004",
  repAMember: "10000000-0000-4000-8000-000000000005",
  repBUser: "10000000-0000-4000-8000-000000000006",
  repBMember: "10000000-0000-4000-8000-000000000007",
}

const adminContext: MembershipContext = { authType: "session", userId: ids.adminUser, membershipId: ids.adminMember, workspaceId: ids.workspace, role: "admin", scopes: [], sessionId: "fixture-session" }
const adminActor: DealActor = { workspaceId: ids.workspace, userId: ids.adminUser, membershipId: ids.adminMember, role: "admin", managedMembershipIds: [], activeMembershipIds: [ids.adminMember, ids.repAMember, ids.repBMember], source: "user", correlationId: "intake-admin" }
const repActor = (membershipId: string, userId: string): DealActor => ({ workspaceId: ids.workspace, userId, membershipId, role: "rep", managedMembershipIds: [], activeMembershipIds: [ids.adminMember, ids.repAMember, ids.repBMember], source: "user", correlationId: `intake-${membershipId}` })

const memory = new Map<string, Uint8Array>()
const storage: DocumentStorage = {
  name: "intake-memory",
  async putImmutable(key, bytes) { if (!memory.has(key)) memory.set(key, new Uint8Array(bytes)) },
  async get(key) { const value = memory.get(key); if (!value) throw new Error("missing test document"); return new Uint8Array(value) },
}
const minimalPdf = new Uint8Array(Buffer.from("%PDF-1.4\n%%EOF\n"))

async function seed() {
  const database = getDatabase(); const now = new Date().toISOString()
  await database.prepare(`INSERT INTO workspaces (id,name,timezone,seat_limit,feature_flags,page_visibility,action_visibility,created_at,updated_at)
    VALUES (?, 'Intake Test', 'America/New_York', 10, ?, ?, ?, ?, ?)`).run(ids.workspace, JSON.stringify({ reports: true, payments: true, integrations: true }), JSON.stringify({ dashboard: true, deals: true, users: true, reports: true, payments: true, workspace: true, integrations: true }), JSON.stringify({ createDeal: true, exportDeals: true, inviteUsers: true, manageApiKeys: true, viewPaymentTable: true, viewCompanyFinancials: true }), now, now)
  for (const [userId, memberId, email, role] of [
    [ids.adminUser, ids.adminMember, "admin@example.test", "admin"],
    [ids.repAUser, ids.repAMember, "rep-a@example.test", "rep"],
    [ids.repBUser, ids.repBMember, "rep-b@example.test", "rep"],
  ]) {
    await database.prepare(`INSERT INTO users (id,email,password_hash,name,phone,application_identifier,created_at,updated_at)
      VALUES (?, ?, NULL, ?, NULL, ?, ?, ?)`).run(userId, email, email, `APP-${String(userId).slice(-6)}`, now, now)
    await database.prepare(`INSERT INTO memberships (id,workspace_id,user_id,role,manager_membership_id,status,sender_association,created_at,updated_at)
      VALUES (?, ?, ?, ?, NULL, 'active', NULL, ?, ?)`).run(memberId, ids.workspace, userId, role, now, now)
  }
}

before(async () => {
  testDatabase = await createPostgresTestDatabase("intake")
  Object.assign(process.env, testDatabase.env())
  await seed()
  setDocumentStorageForTests(storage)
  setDocumentScannerForTests({ name: "intake-clean-fixture", async scan() { return { status: "clean", provider: "intake-clean-fixture", evidence: { fixture: true } } } })
})
after(async () => { setDocumentStorageForTests(); setDocumentScannerForTests(); await closeDatabaseForTests(); await testDatabase.close() })

test("MIC-152 durable ingest is idempotent, rejects conflicting replay, and hashes long provider IDs", async () => {
  const first = await ingestApplication(adminActor, { schemaVersion: 1, provider: "custom", eventId: "event-1", application: { legalName: "Harbor Bakery LLC" } })
  const retry = await ingestApplication(adminActor, { schemaVersion: 1, provider: "custom", eventId: "event-1", application: { legalName: "Harbor Bakery LLC" } })
  assert.equal(first.created, true); assert.equal(retry.created, false); assert.equal(retry.dealId, first.dealId)
  await assert.rejects(() => ingestApplication(adminActor, { schemaVersion: 1, provider: "custom", eventId: "event-1", application: { legalName: "Different LLC" } }), (error: { code?: string }) => error.code === "intake_event_conflict")

  const prefix = "x".repeat(180)
  const longA = await ingestApplication(adminActor, { schemaVersion: 1, provider: "custom", eventId: `${prefix}A`, application: { legalName: "Long A LLC" } })
  const longB = await ingestApplication(adminActor, { schemaVersion: 1, provider: "custom", eventId: `${prefix}B`, application: { legalName: "Long B LLC" } })
  assert.notEqual(longA.dealId, longB.dealId)
})

test("MIC-152 replay rechecks deal visibility for the current actor", async () => {
  const input = { schemaVersion: 1 as const, provider: "custom", eventId: "scoped-replay", application: { legalName: "Rep A Only", assignments: [{ membershipId: ids.repAMember, kind: "originator" as const, isPrimary: true }] } }
  const created = await ingestApplication(adminActor, input)
  await assert.rejects(() => ingestApplication(repActor(ids.repBMember, ids.repBUser), input), (error: { code?: string }) => error.code === "deal_not_found")
  await assert.rejects(() => replayIntake(repActor(ids.repBMember, ids.repBUser), created.intakeId), (error: { code?: string }) => error.code === "deal_not_found")
})

test("MIC-175/MIC-176 one Jotform routes opaque links to two active reps and quarantines tampering", async () => {
  const configured = await configureIntegration(adminContext, {
    provider: "jotform", displayName: "Shared team form", formId: "240000000000001", credential: "jotform-read-key",
    allowedHosts: ["www.jotform.com", "api.jotform.com"], mapping: { legalName: "business_name", contactEmail: "email" },
  })
  assert.ok(configured.admissionSecret)
  const repA = await createJotformRepLink(adminContext, configured.status.id, ids.repAMember, "https://mca.example.test")
  const repB = await createJotformRepLink(adminContext, configured.status.id, ids.repBMember, "https://mca.example.test")
  const deliver = async (submissionID: string, token: string, options: { secret?: string; businessName?: string } = {}) => {
    const rawBody = JSON.stringify({ formID: "240000000000001", submissionID, rawRequest: JSON.stringify({ business_name: options.businessName ?? `Merchant ${submissionID}`, email: `${submissionID}@example.test`, mca_rep: token }) })
    return ingestProviderDelivery({ provider: "jotform", integrationId: configured.status.id, rawBody, request: new Request("https://mca.example.test/hook", { method: "POST", headers: { authorization: `Bearer ${options.secret ?? configured.admissionSecret}` }, body: rawBody }) })
  }
  const resultA = await deliver("submission-a", repA.token); const resultB = await deliver("submission-b", repB.token)
  assert.equal((await getDeal(adminActor, resultA.dealId!)).assignments[0].membershipId, ids.repAMember)
  assert.equal((await getDeal(adminActor, resultB.dealId!)).assignments[0].membershipId, ids.repBMember)
  const replay = await deliver("submission-a", repA.token)
  assert.equal(replay.dealId, resultA.dealId); assert.equal(replay.created, false)
  await assert.rejects(() => deliver("submission-a", repA.token, { businessName: "Changed replay LLC" }), (error: { code?: string }) => error.code === "intake_event_conflict")
  await assert.rejects(() => deliver("submission-invalid-secret", repA.token, { secret: "wrong-workflow-secret" }), (error: { code?: string }) => error.code === "webhook_credential_invalid")
  await assert.rejects(() => deliver("submission-tampered", `${repA.token}x`), (error: { code?: string }) => error.code === "attribution_quarantined")
  assert.ok((await listIntakeSummaries(adminActor)).some((item) => item.eventId === "submission-tampered" && item.state === "error"))

  const attachmentPayload = JSON.stringify({ formID: "240000000000001", submissionID: "submission-with-file", rawRequest: JSON.stringify({ business_name: "Jotform File Merchant", email: "file@example.test", mca_rep: repA.token }), attachments: [{ id: "jotform-file", name: "statement.pdf", url: "https://www.jotform.com/uploads/statement.pdf", category: "statement" }] })
  const withFile = await ingestProviderDelivery({ provider: "jotform", integrationId: configured.status.id, rawBody: attachmentPayload, request: new Request("https://mca.example.test/hook", { method: "POST", headers: { authorization: `Bearer ${configured.admissionSecret}` }, body: attachmentPayload }) })
  const stored = await processAttachmentJob((await listAttachmentJobs(ids.workspace, withFile.intakeId))[0], { lookupImpl: async () => [{ address: "203.0.113.26", family: 4 }], fetchImpl: async () => new Response(Buffer.from(minimalPdf), { status: 200, headers: { "content-type": "application/pdf" } }) })
  assert.equal(stored.state, "stored")
})

test("MIC-183/MIC-186 realistic Fillout and signed HighLevel fixtures create assigned deals and files", async () => {
  const fillout = await configureIntegration(adminContext, { provider: "fillout", displayName: "Fillout", formId: "form_abc", credential: "fillout-read", allowedHosts: ["files.fillout.com"], assignmentPool: [ids.repAMember], mapping: { legalName: "Business legal name", requestedAmount: "Amount" } })
  const filloutRecord = (await findIntegrationByPublicId(fillout.status.id))!
  const filloutPayload = { formId: "form_abc", submissionId: "sub_1", questions: [{ id: "q1", name: "Business legal name", type: "ShortAnswer", value: "Cedar Cafe LLC" }, { id: "q2", name: "Amount", type: "Number", value: 125000 }, { id: "q3", name: "Statements", type: "fileUpload", value: [{ id: "file1", name: "august.pdf", url: "https://files.fillout.com/private/august.pdf", category: "statement" }] }], urlParameters: [] }
  const normalizedFillout = normalizeProviderPayload("fillout", filloutPayload, filloutRecord)
  assert.equal(normalizedFillout.application.legalName, "Cedar Cafe LLC"); assert.equal(normalizedFillout.application.requestedAmount, 125000); assert.equal(normalizedFillout.attachments.length, 1)
  const filloutRaw = JSON.stringify(filloutPayload)
  const created = await ingestProviderDelivery({ provider: "fillout", integrationId: fillout.status.id, rawBody: filloutRaw, request: new Request("https://mca.example.test/hook", { method: "POST", headers: { authorization: `Bearer ${fillout.admissionSecret}` }, body: filloutRaw }) })
  assert.equal((await getDeal(adminActor, created.dealId!)).assignments[0].membershipId, ids.repAMember)
  const job = (await listAttachmentJobs(ids.workspace, created.intakeId))[0]
  const stored = await processAttachmentJob(job, { lookupImpl: async () => [{ address: "203.0.113.25", family: 4 }], fetchImpl: async () => new Response(Buffer.from(minimalPdf), { status: 200, headers: { "content-type": "application/pdf" } }) })
  assert.equal(stored.state, "stored")

  const highlevel = await configureIntegration(adminContext, { provider: "highlevel", displayName: "MCA Simplified", locationId: "loc_123", credential: "ghl-private-read", allowedHosts: ["files.gohighlevel.com"], mapping: { legalName: "companyName", contactEmail: "email", "rep:external-user": ids.repBMember } })
  const highlevelRecord = (await findIntegrationByPublicId(highlevel.status.id))!
  const highlevelPayload = { type: "ContactTagUpdate", webhookId: "wh_1", locationId: "loc_123", companyName: "Northwind Market LLC", email: "owner@northwind.test", assignedTo: "external-user", tags: ["mca-application"], attachments: [{ id: "ghl-file", name: "application.pdf", url: "https://files.gohighlevel.com/private/application.pdf", category: "application" }] }
  const normalizedGhl = normalizeProviderPayload("highlevel", highlevelPayload, highlevelRecord)
  assert.equal(normalizedGhl.application.legalName, "Northwind Market LLC"); assert.equal(normalizedGhl.eventId, "wh_1"); assert.equal(normalizedGhl.externalAssignee, "external-user")
  const { publicKey, privateKey } = generateKeyPairSync("ed25519")
  process.env.MCA_HIGHLEVEL_WEBHOOK_PUBLIC_KEY = publicKey.export({ type: "spki", format: "pem" }).toString()
  const highlevelRaw = JSON.stringify(highlevelPayload)
  const highlevelCreated = await ingestProviderDelivery({ provider: "highlevel", integrationId: highlevel.status.id, rawBody: highlevelRaw, request: new Request("https://mca.example.test/hook", { method: "POST", headers: { "x-ghl-signature": cryptoSign(null, Buffer.from(highlevelRaw), privateKey).toString("base64") }, body: highlevelRaw }) })
  delete process.env.MCA_HIGHLEVEL_WEBHOOK_PUBLIC_KEY
  assert.equal((await getDeal(adminActor, highlevelCreated.dealId!)).assignments[0].membershipId, ids.repBMember)
  const highlevelStored = await processAttachmentJob((await listAttachmentJobs(ids.workspace, highlevelCreated.intakeId))[0], { lookupImpl: async () => [{ address: "203.0.113.27", family: 4 }], fetchImpl: async () => new Response(Buffer.from(minimalPdf), { status: 200, headers: { "content-type": "application/pdf" } }) })
  assert.equal(highlevelStored.state, "stored")
})

test("provider mapping preserves unknown numbers and supports multiple bounded owners", async () => {
  const configured = await configureIntegration(adminContext, {
    provider: "custom", displayName: "Multiple-owner intake", formId: "multi-owner-form", mapping: {
      legalName: "business.name", monthlyRevenue: "financial.monthlyRevenue", requestedAmount: "financial.requestedAmount",
      ficoScore: "financial.ficoScore", "owners.0.firstName": "owners.0.firstName", "owners.0.ownershipPercent": "owners.0.ownershipPercent",
      "owners.0.isPrimary": "owners.0.isPrimary", "owners.1.firstName": "owners.1.firstName",
      "owners.1.lastName": "owners.1.lastName", "owners.1.ownershipPercent": "owners.1.ownershipPercent",
      "owners.1.isPrimary": "owners.1.isPrimary", "owners.10.firstName": "owners.10.firstName",
    },
  })
  const integration = (await findIntegrationByPublicId(configured.status.id))!
  const normalized = normalizeProviderPayload("custom", {
    formId: "multi-owner-form", eventId: "multi-owner-1", application: {
      business: { name: "Two Owner Bakery LLC" }, financial: { monthlyRevenue: "", requestedAmount: "   " },
      owners: [{ firstName: "Mira" }, { firstName: "Noah", lastName: "Chen", ownershipPercent: "50", isPrimary: "yes" },
        {}, {}, {}, {}, {}, {}, {}, {}, { firstName: "Outside bound" }],
    },
  }, integration)
  assert.equal(normalized.application.monthlyRevenue, undefined)
  assert.equal(normalized.application.requestedAmount, undefined)
  assert.equal(normalized.application.ficoScore, undefined)
  assert.equal(normalized.application.owners?.length, 2)
  assert.deepEqual(normalized.application.owners?.[0], { firstName: "Mira" })
  assert.deepEqual(normalized.application.owners?.[1], { firstName: "Noah", lastName: "Chen", ownershipPercent: 50, isPrimary: true })

  const defaultConfigured = await configureIntegration(adminContext, { provider: "jotform", displayName: "Default owner array", formId: "default-owner-array" })
  const defaultNormalized = normalizeProviderPayload("jotform", {
    formID: "default-owner-array", submissionID: "default-owner-array-1",
    rawRequest: JSON.stringify({ legalName: "Default Owners LLC", monthlyRevenue: "", owners: [{ firstName: "Ari" }, { firstName: "Sam", ownershipPercent: 40 }] }),
  }, (await findIntegrationByPublicId(defaultConfigured.status.id))!)
  assert.equal(defaultNormalized.application.monthlyRevenue, undefined)
  assert.deepEqual(defaultNormalized.application.owners, [{ firstName: "Ari" }, { firstName: "Sam", ownershipPercent: 40 }])
})

test("MIC-159 DocuSeal verifies HMAC, only accepts submission.completed, and replays one signed artifact", async () => {
  const configured = await configureIntegration(adminContext, { provider: "docuseal", displayName: "Signed MCA application", templateId: "1000001", credential: "docuseal-api-key", allowedHosts: ["docuseal.com"], mapping: { legalName: "Business Name" } })
  const body = JSON.stringify({ event_type: "submission.completed", timestamp: new Date().toISOString(), data: { id: 9001, template: { id: 1000001 }, submitters: [{ email: "owner@example.test", values: [{ field: "Business Name", value: "Signed Merchant LLC" }] }], documents: [{ uuid: "signed-pdf", name: "signed-application.pdf", url: "https://docuseal.com/file/private.pdf" }] } })
  const timestamp = Math.floor(Date.now() / 1000).toString()
  const signature = createHmac("sha256", configured.admissionSecret!).update(`${timestamp}.${body}`).digest("hex")
  const deliver = () => ingestProviderDelivery({ provider: "docuseal", integrationId: configured.status.id, rawBody: body, request: new Request("https://mca.example.test/hook", { method: "POST", headers: { "x-docuseal-signature": `${timestamp}.${signature}` }, body }) })
  const first = await deliver(); const retry = await deliver()
  assert.equal(first.dealId, retry.dealId); assert.equal(retry.created, false); assert.equal((await listAttachmentJobs(ids.workspace, first.intakeId)).length, 1)
  const stored = await attachIntakeDocument(adminActor, { intakeId: first.intakeId, attachmentId: "signed-pdf", filename: "signed-application.pdf", mimeType: "application/pdf", bytes: minimalPdf, category: "application" })
  const replayed = await attachIntakeDocument(adminActor, { intakeId: first.intakeId, attachmentId: "signed-pdf", filename: "signed-application.pdf", mimeType: "application/pdf", bytes: minimalPdf, category: "application" })
  assert.equal(stored.id, replayed.id)

  const incomplete = JSON.stringify({ event_type: "form.completed", data: { id: 9002, template: { id: 1000001 } } })
  const incompleteTs = Math.floor(Date.now() / 1000).toString(); const incompleteSig = createHmac("sha256", configured.admissionSecret!).update(`${incompleteTs}.${incomplete}`).digest("hex")
  await assert.rejects(() => ingestProviderDelivery({ provider: "docuseal", integrationId: configured.status.id, rawBody: incomplete, request: new Request("https://mca.example.test/hook", { method: "POST", headers: { "x-docuseal-signature": `${incompleteTs}.${incompleteSig}` }, body: incomplete }) }), (error: { code?: string; status?: number }) => error.code === "docuseal_event_ignored" && error.status === 202)

  const unknown = JSON.stringify({ event_type: "submission.completed", data: { id: 9003, template: { id: 9999999 } } })
  const unknownTs = Math.floor(Date.now() / 1000).toString(); const unknownSig = createHmac("sha256", configured.admissionSecret!).update(`${unknownTs}.${unknown}`).digest("hex")
  await assert.rejects(() => ingestProviderDelivery({ provider: "docuseal", integrationId: configured.status.id, rawBody: unknown, request: new Request("https://mca.example.test/hook", { method: "POST", headers: { "x-docuseal-signature": `${unknownTs}.${unknownSig}` }, body: unknown }) }), (error: { code?: string }) => error.code === "docuseal_template_unknown")
  assert.ok((await listIntakeSummaries(adminActor)).some((item) => item.eventId === `review-${createHash("sha256").update(unknown).digest("hex")}` && item.state === "error"))
})

test("MIC-181 selected Zoho JSON/Drive contract creates one assigned deal and recovers private files", async () => {
  const configured = await configureIntegration(adminContext, {
    provider: "zoho", displayName: "Zoho Forms Drive", formId: "mca-application-v1",
    credential: "google-drive-access-token", credentialExpiresAt: "2099-01-01T00:00:00.000Z", assignmentPool: [ids.repAMember],
  })
  assert.equal(configured.status.approvalState, "approved")
  assert.equal(configured.status.contractKey, "zoho_forms_json_drive_v1")
  assert.deepEqual(configured.status.allowedHosts, ["www.googleapis.com"])
  const payload = {
    formId: "mca-application-v1", entryId: "MCA-000001", legalName: "Fixture Bakery LLC",
    contactEmail: "owner@example.test", monthlyRevenue: "42000", ownerFirstName: "Fixture",
    ownerLastName: "Owner", ownerOwnershipPercent: "100",
    applicationFile: "https://drive.google.com/file/d/fixture_application_id/view",
    statementFile: "https://drive.google.com/open?id=fixture_statement_id",
  }
  const rawBody = JSON.stringify(payload)
  const request = (body = rawBody, secret = configured.admissionSecret) => new Request("https://mca.example.test/zoho", { method: "POST", headers: { authorization: `Bearer ${secret}` }, body })
  const created = await ingestProviderDelivery({ provider: "zoho", integrationId: configured.status.id, request: request(), rawBody })
  const deal = await getDeal(adminActor, created.dealId!)
  assert.equal(deal.legalName, "Fixture Bakery LLC")
  assert.equal(deal.monthlyRevenue, 42000)
  assert.deepEqual(deal.owners.map((owner) => [owner.firstName, owner.lastName, owner.ownershipPercent]), [["Fixture", "Owner", 100]])
  assert.equal(deal.assignments[0].membershipId, ids.repAMember)
  const jobs = await listAttachmentJobs(ids.workspace, created.intakeId)
  assert.equal(jobs.length, 2)
  const driveRequests: Array<{ url: string; authorization: string | null }> = []
  for (const job of jobs) {
    const stored = await processAttachmentJob(job, {
      lookupImpl: async () => [{ address: "142.250.72.234", family: 4 }],
      fetchImpl: async (url, init) => {
        driveRequests.push({ url: String(url), authorization: new Headers(init?.headers).get("authorization") })
        return new Response(Buffer.from(minimalPdf), { status: 200, headers: { "content-type": "application/pdf" } })
      },
    })
    assert.equal(stored.state, "stored")
  }
  assert.ok(driveRequests.every((item) => item.url.startsWith("https://www.googleapis.com/drive/v3/files/") && item.authorization === "Bearer google-drive-access-token"))
  const replay = await ingestProviderDelivery({ provider: "zoho", integrationId: configured.status.id, request: request(), rawBody })
  assert.equal(replay.dealId, created.dealId); assert.equal(replay.created, false)
  const changed = JSON.stringify({ ...payload, legalName: "Changed Bakery LLC" })
  await assert.rejects(() => ingestProviderDelivery({ provider: "zoho", integrationId: configured.status.id, request: request(changed), rawBody: changed }), (error: { code?: string }) => error.code === "intake_event_conflict")

  for (const [fixture, code] of [
    [{ ...payload, entryId: "bad-form", formId: "another-form" }, "provider_binding_mismatch"],
    [{ ...payload, entryId: "fallback-form", formId: undefined, form_id: "mca-application-v1" }, "provider_binding_mismatch"],
    [{ ...payload, entryId: "" }, "provider_event_missing"],
    [{ ...payload, entryId: "bad-link", applicationFile: "https://evil.example/file.pdf" }, "zoho_attachment_link_invalid"],
    [{ ...payload, entryId: "bad-drive-shape", applicationFile: "https://drive.google.com/folders/not-a-file" }, "zoho_attachment_link_invalid"],
    [{ ...payload, entryId: undefined, entry_id: "undocumented-fallback" }, "provider_event_missing"],
  ] as const) {
    const body = JSON.stringify(fixture)
    await assert.rejects(() => ingestProviderDelivery({ provider: "zoho", integrationId: configured.status.id, request: request(body), rawBody: body }), (error: { code?: string }) => error.code === code)
  }
  await assert.rejects(() => ingestProviderDelivery({ provider: "zoho", integrationId: configured.status.id, request: new Request("https://mca.example.test/zoho", { method: "POST", body: JSON.stringify({ ...payload, entryId: "no-auth" }) }), rawBody: JSON.stringify({ ...payload, entryId: "no-auth" }) }), (error: { code?: string }) => error.code === "webhook_credential_invalid")

  const expiringPayload = JSON.stringify({ ...payload, entryId: "MCA-000002", applicationFile: "https://drive.google.com/file/d/fixture_expired_file/view", statementFile: undefined })
  const expiring = await ingestProviderDelivery({ provider: "zoho", integrationId: configured.status.id, request: request(expiringPayload), rawBody: expiringPayload })
  await rotateIntegrationCredentials(adminContext, configured.status.id, { credential: "expired-drive-token", credentialExpiresAt: "2020-01-01T00:00:00.000Z" })
  const failed = await processAttachmentJob((await listAttachmentJobs(ids.workspace, expiring.intakeId))[0], { lookupImpl: async () => [{ address: "142.250.72.234", family: 4 }] })
  assert.equal(failed.state, "retryable"); assert.match(failed.lastError ?? "", /expired/i)
  await rotateIntegrationCredentials(adminContext, configured.status.id, { credential: "rotated-drive-token", credentialExpiresAt: "2099-01-01T00:00:00.000Z" })
  await getDatabase().prepare("UPDATE intake_attachment_jobs SET next_attempt_at=? WHERE id=?").run("2000-01-01T00:00:00.000Z", failed.id)
  const recovered = await processAttachmentJob(failed, { lookupImpl: async () => [{ address: "142.250.72.234", family: 4 }], fetchImpl: async (_url, init) => {
    assert.equal(new Headers(init?.headers).get("authorization"), "Bearer rotated-drive-token")
    return new Response(Buffer.from(minimalPdf), { status: 200, headers: { "content-type": "application/pdf" } })
  } })
  assert.equal(recovered.state, "stored")
  assert.equal((await getDeal(adminActor, expiring.dealId!)).id, expiring.dealId)

  const unknown = await configureIntegration(adminContext, { provider: "zoho", displayName: "Unknown custom contract", formId: "unknown-zoho", contractKey: "customer_custom_v9" })
  assert.equal(unknown.status.approvalState, "pending_customer_contract")
  const unknownRecord = (await findIntegrationByPublicId(unknown.status.id))!
  assert.throws(() => normalizeProviderPayload("zoho", { formId: "unknown-zoho", entryId: "unknown-1" }, unknownRecord), (error: { code?: string }) => error.code === "zoho_contract_pending")
})

test("MIC-184 custom email deduplicates message identity, ignores signature graphics, queues receipt, and keeps rejected senders visible", async () => {
  const configured = await configureIntegration(adminContext, { provider: "email", emailGateway: "custom", displayName: "Private forwarding route", inboundAddress: "leads@mca.example.test", senderRules: ["@trusted.example"], assignmentPool: [ids.repAMember, ids.repBMember] })
  const payload = { messageId: "message-1", to: "leads@mca.example.test", from: "broker@trusted.example", subject: "Application", attachments: [
    { id: "logo", filename: "logo.png", mimeType: "image/png", disposition: "inline", contentId: "logo", base64: Buffer.from("not an application").toString("base64") },
    { id: "application", filename: "merchant-application.pdf", mimeType: "application/pdf", category: "application", base64: Buffer.from(minimalPdf).toString("base64") },
  ] }
  const rawBody = JSON.stringify(payload)
  const request = () => new Request("https://mca.example.test/email", { method: "POST", headers: { authorization: `Bearer ${configured.admissionSecret}` }, body: rawBody })
  const extractor = async () => ({ version: 1, fields: { legalName: "Email Merchant LLC", contactEmail: "owner@email.test" }, evidence: { legalName: { confidence: 0.99 } }, warnings: ["Verify requested amount."], provider: "fixture-ai" })
  const first = await ingestEmailDelivery({ integrationId: configured.status.id, request: request(), rawBody, appOrigin: "https://mca.example.test", extractor })
  const retry = await ingestEmailDelivery({ integrationId: configured.status.id, request: request(), rawBody, appOrigin: "https://mca.example.test", extractor })
  assert.equal("dealId" in first && "dealId" in retry && first.dealId, "dealId" in retry ? retry.dealId : null)
  assert.equal((await listPendingReceipts(ids.workspace)).length >= 1, true)
  await assert.rejects(() => deliverPendingReceipts({ workspaceId: ids.workspace }), (error: { code?: string }) => error.code === "receipt_delivery_unconfigured")
  process.env.MCA_INTAKE_RECEIPT_WEBHOOK_URL = "https://mail.example.test/intake"
  const delivered = await deliverPendingReceipts({ workspaceId: ids.workspace, fetchImpl: async () => new Response(JSON.stringify({ id: "mail-1" }), { status: 200, headers: { "content-type": "application/json" } }) })
  assert.ok(delivered.some((receipt) => receipt.state === "sent" && receipt.providerMessageId === "mail-1"))
  delete process.env.MCA_INTAKE_RECEIPT_WEBHOOK_URL

  const rejectedBody = JSON.stringify({ ...payload, messageId: "message-rejected", from: "attacker@outside.example" })
  const rejected = await ingestEmailDelivery({ integrationId: configured.status.id, request: new Request("https://mca.example.test/email", { method: "POST", headers: { authorization: `Bearer ${configured.admissionSecret}` }, body: rejectedBody }), rawBody: rejectedBody, appOrigin: "https://mca.example.test", extractor })
  assert.equal("state" in rejected && rejected.state, "error")
})

test("MIC-184 Postmark Basic ingress validates the genuine payload before one assigned intake and provisions only from provider evidence", async () => {
  const configured = await configureIntegration(adminContext, {
    provider: "email", emailGateway: "postmark", displayName: "Postmark inbound",
    inboundAddress: "realhash@inbound.postmarkapp.com", senderRules: ["@trusted.example"], assignmentPool: [ids.repAMember],
  })
  assert.equal(configured.status.readiness, "live_unverified")
  await assert.rejects(() => readInboundEmailBody(new Request("https://mca.example.test/email", { method: "POST", body: new Blob(["abcdef"]) }), 4), (error: { code?: string }) => error.code === "email_payload_too_large")
  const pdfContent = Buffer.from(minimalPdf).toString("base64")
  const logoContent = Buffer.from("inline logo").toString("base64")
  const payload = {
    MessageID: "postmark-delivery-1", OriginalRecipient: "realhash@inbound.postmarkapp.com",
    FromFull: { Email: "broker@trusted.example", Name: "Trusted Broker" }, Subject: "Merchant application", TextBody: "Attached application.",
    Headers: [{ Name: "Message-ID", Value: "<original-message-1@trusted.example>" }],
    Attachments: [
      { Name: "logo.png", ContentType: "image/png", ContentLength: Buffer.byteLength("inline logo"), ContentID: "cid-logo", Content: logoContent },
      { Name: "application.pdf", ContentType: "application/pdf", ContentLength: minimalPdf.length, ContentID: "cid-pdf-must-stay", Content: pdfContent },
      { Name: "application.pdf", ContentType: "application/pdf", ContentLength: minimalPdf.length, Content: pdfContent },
    ],
  }
  const basic = `Basic ${Buffer.from(`mca:${configured.admissionSecret}`).toString("base64")}`
  const extractor = async () => ({ version: 1, fields: { legalName: "Postmark Merchant LLC", contactEmail: "merchant@example.test" }, evidence: { legalName: { confidence: 0.98 } }, warnings: [], provider: "fixture-ai" })
  const deliver = (body: Record<string, unknown>, authorization = basic) => {
    const rawBody = JSON.stringify(body)
    return ingestEmailDelivery({ integrationId: configured.status.id, request: new Request("https://mca.example.test/email", { method: "POST", headers: { authorization }, body: rawBody }), rawBody, appOrigin: "https://mca.example.test", extractor })
  }
  const documentCountBefore = Number(((await getDatabase().prepare<{ count: number }>("SELECT COUNT(*) AS count FROM mca_documents").get())!).count)
  const first = await deliver(payload)
  assert.ok("dealId" in first && first.dealId)
  assert.equal((await getDeal(adminActor, "dealId" in first ? first.dealId! : "")).assignments[0].membershipId, ids.repAMember)
  const documentCountAfter = Number(((await getDatabase().prepare<{ count: number }>("SELECT COUNT(*) AS count FROM mca_documents").get())!).count)
  assert.equal(documentCountAfter - documentCountBefore, 2)
  const retry = await deliver(payload)
  assert.equal("dealId" in retry ? retry.dealId : null, "dealId" in first ? first.dealId : null)
  const forwardedCopy = await deliver({ ...payload, MessageID: "postmark-delivery-2" })
  assert.equal("dealId" in forwardedCopy ? forwardedCopy.dealId : null, "dealId" in first ? first.dealId : null)
  assert.equal((await listPendingReceipts(ids.workspace)).filter((item) => item.intakeId === ("intakeId" in first ? first.intakeId : "")).length, 1)

  await assert.rejects(() => deliver({ ...payload, MessageID: "unauthorized", Headers: [] }, `Basic ${Buffer.from("wrong:secret").toString("base64")}`), (error: { code?: string }) => error.code === "webhook_credential_invalid")
  await assert.rejects(() => deliver({ ...payload, MessageID: "wrong-recipient", Headers: [], OriginalRecipient: "other@inbound.postmarkapp.com" }), (error: { code?: string }) => error.code === "email_route_mismatch")
  const rejected = await deliver({ ...payload, MessageID: "sender-denied", Headers: [], FromFull: { Email: "attacker@outside.example" } })
  assert.equal("state" in rejected ? rejected.state : undefined, "error")
  assert.ok((await listIntakeSummaries(adminActor)).some((item) => item.eventId === "sender-denied" && item.errorCode === "sender_not_allowed"))

  const badBase64 = { ...payload, MessageID: "bad-base64", Headers: [], Attachments: [{ Name: "application.pdf", ContentType: "application/pdf", ContentLength: 3, Content: "%%%=" }] }
  await assert.rejects(() => deliver(badBase64), (error: { code?: string }) => error.code === "email_attachment_invalid")
  const mismatch = { ...payload, MessageID: "size-mismatch", Headers: [], Attachments: [{ Name: "application.pdf", ContentType: "application/pdf", ContentLength: minimalPdf.length + 1, Content: pdfContent }] }
  await assert.rejects(() => deliver(mismatch), (error: { code?: string }) => error.code === "email_attachment_size_mismatch")
  const tooLargeBytes = Buffer.alloc(25 * 1024 * 1024 + 1, 1)
  const oversized = { ...payload, MessageID: "oversized", Headers: [], Attachments: [{ Name: "application.pdf", ContentType: "application/pdf", ContentLength: tooLargeBytes.length, Content: tooLargeBytes.toString("base64") }] }
  await assert.rejects(() => deliver(oversized), (error: { code?: string }) => ["email_payload_too_large", "email_attachment_too_large"].includes(error.code ?? ""))

  const extractionFailurePayload = { ...payload, MessageID: "extract-failed", Headers: [], Attachments: [payload.Attachments[1]] }
  const extractionFailureBody = JSON.stringify(extractionFailurePayload)
  const extractionFailure = await ingestEmailDelivery({ integrationId: configured.status.id, request: new Request("https://mca.example.test/email", { method: "POST", headers: { authorization: basic }, body: extractionFailureBody }), rawBody: extractionFailureBody, appOrigin: "https://mca.example.test", extractor: async () => { throw new Error("fixture extraction unavailable") } })
  assert.equal("state" in extractionFailure ? extractionFailure.state : undefined, "error")
  assert.ok((await listIntakeSummaries(adminActor)).some((item) => item.eventId === "extract-failed" && item.errorCode === "email_extraction_failed"))
  const forwarding = await deliver({ ...payload, MessageID: "forwarding-review", Headers: [], Subject: "Confirm forwarding", TextBody: "Click to confirm forwarding." })
  assert.equal("state" in forwarding ? forwarding.state : undefined, "error")
  assert.ok((await listIntakeSummaries(adminActor)).some((item) => item.eventId === "forwarding-review" && item.errorCode === "forwarding_confirmation_review"))

  process.env.MCA_INTAKE_RECEIPT_WEBHOOK_URL = "https://mail.example.test/intake"
  const receipts = await deliverPendingReceipts({ workspaceId: ids.workspace, fetchImpl: async () => new Response(JSON.stringify({ id: "postmark-receipt-fixture" }), { status: 200, headers: { "content-type": "application/json" } }) })
  assert.ok(receipts.some((item) => item.intakeId === ("intakeId" in first ? first.intakeId : "") && item.state === "sent"))
  delete process.env.MCA_INTAKE_RECEIPT_WEBHOOK_URL

  const setupCalls: Array<{ url: string; method: string; token: string | null; body?: Record<string, unknown> }> = []
  const provisioned = await provisionPostmarkIntegration(adminContext, {
    accountToken: "postmark-account-token", serverId: "42", serverName: "MCA Workspace", displayName: "Verified Postmark",
    publicOrigin: "https://mca.example.test", assignmentPool: [ids.repBMember],
  }, async (url, init) => {
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined
    setupCalls.push({ url: String(url), method: init?.method ?? "GET", token: new Headers(init?.headers).get("x-postmark-account-token"), body })
    return new Response(JSON.stringify({ ID: 42, Name: "MCA Workspace", InboundHash: "providerhash42" }), { status: 200, headers: { "content-type": "application/json" } })
  })
  assert.equal(provisioned.status.inboundAddress, "providerhash42@inbound.postmarkapp.com")
  assert.equal(provisioned.status.readiness, "live_configured")
  assert.deepEqual(setupCalls.map((call) => [call.method, call.token]), [["GET", "postmark-account-token"], ["PUT", "postmark-account-token"]])
  const hook = new URL(String(setupCalls[1].body?.InboundHookUrl))
  assert.equal(hook.origin, "https://mca.example.test"); assert.equal(hook.username, "mca"); assert.ok(hook.password)
  assert.equal(JSON.stringify(provisioned.status).includes(hook.password), false)
  await assert.rejects(() => provisionPostmarkIntegration(adminContext, { accountToken: "token", serverId: "42", serverName: "MCA Workspace", displayName: "Local", publicOrigin: "http://localhost:3000" }, async () => { throw new Error("must not call") }), (error: { code?: string }) => error.code === "postmark_origin_invalid")
})

test("MIC-184 useSend HMAC ingress extracts one lead, refuses unauthorized senders, and sends receipts with Idempotency-Key", async () => {
  const configured = await configureIntegration(adminContext, {
    provider: "email", emailGateway: "usesend", displayName: "useSend inbound",
    inboundAddress: "leads@fundlane.io", senderRules: ["@trusted.example"], assignmentPool: [ids.repAMember],
    mapping: { fromAddress: "MCA Intake <intake@fundlane.io>" }, credential: "us_test_key",
  })
  assert.equal(configured.status.readiness, "live_unverified")
  assert.equal(configured.status.emailGateway, "usesend")
  const pdfContent = Buffer.from(minimalPdf).toString("base64")
  const logoContent = Buffer.from("inline logo").toString("base64")
  const payload = {
    id: "call_usesend_1", type: "email.received",
    data: {
      id: "email_usesend_1", from: "Broker <broker@trusted.example>", to: ["leads@fundlane.io"],
      subject: "Merchant application", text: "Attached application.",
      headers: [{ name: "Message-ID", value: "<original-usesend-1@trusted.example>" }],
      attachments: [
        { filename: "logo.png", contentType: "image/png", contentDisposition: "inline", contentId: "cid-logo", content: logoContent, contentLength: Buffer.byteLength("inline logo") },
        { filename: "application.pdf", contentType: "application/pdf", content: pdfContent, contentLength: minimalPdf.length },
        { filename: "application.pdf", contentType: "application/pdf", content: pdfContent, contentLength: minimalPdf.length },
      ],
    },
  }
  const signed = (body: Record<string, unknown>, secret = configured.admissionSecret!, timestamp = String(Date.now())) => {
    const rawBody = JSON.stringify(body)
    return {
      rawBody,
      request: new Request("https://fundlane.io/email", {
        method: "POST",
        headers: { "content-type": "application/json", "x-usesend-signature": usesendSignature(secret, timestamp, rawBody), "x-usesend-timestamp": timestamp },
        body: rawBody,
      }),
    }
  }
  const extractor = async () => ({ version: 1, fields: { legalName: "UseSend Merchant LLC", contactEmail: "merchant@example.test" }, evidence: { legalName: { confidence: 0.98 } }, warnings: [], provider: "fixture-ai" })
  const deliver = (body: Record<string, unknown>) => {
    const message = signed(body)
    return ingestEmailDelivery({ integrationId: configured.status.id, request: message.request, rawBody: message.rawBody, appOrigin: "https://fundlane.io", extractor })
  }
  await assert.rejects(() => ingestEmailDelivery({
    integrationId: configured.status.id,
    request: new Request("https://fundlane.io/email", { method: "POST", headers: { authorization: `Bearer ${configured.admissionSecret}` }, body: JSON.stringify(payload) }),
    rawBody: JSON.stringify(payload), appOrigin: "https://fundlane.io", extractor,
  }), (error: { code?: string }) => error.code === "webhook_signature_required")
  const first = await deliver(payload)
  assert.ok("dealId" in first && first.dealId)
  assert.equal((await getDeal(adminActor, first.dealId!)).assignments[0].membershipId, ids.repAMember)
  const retry = await deliver(payload)
  assert.equal(retry.dealId, first.dealId)
  const forwardedCopy = await deliver({ ...payload, id: "call_usesend_2", data: { ...payload.data, id: "email_usesend_2" } })
  assert.equal(forwardedCopy.dealId, first.dealId)
  assert.equal((await listPendingReceipts(ids.workspace)).filter((item) => item.intakeId === first.intakeId).length, 1)

  const stale = signed(payload, configured.admissionSecret, String(Date.now() - 10 * 60 * 1000))
  await assert.rejects(() => ingestEmailDelivery({ integrationId: configured.status.id, request: stale.request, rawBody: stale.rawBody, appOrigin: "https://fundlane.io", extractor }), (error: { code?: string }) => error.code === "webhook_signature_stale")
  const wrongSecret = signed(payload, "wrong-secret")
  await assert.rejects(() => ingestEmailDelivery({ integrationId: configured.status.id, request: wrongSecret.request, rawBody: wrongSecret.rawBody, appOrigin: "https://fundlane.io", extractor }), (error: { code?: string }) => error.code === "webhook_signature_invalid")
  await assert.rejects(() => deliver({ ...payload, type: "email.delivered", data: { ...payload.data, id: "outbound-only" } }), (error: { code?: string; status?: number }) => error.code === "usesend_event_ignored" && error.status === 202)
  const rejected = await deliver({ ...payload, id: "call_denied", data: { ...payload.data, id: "sender-denied-usesend", from: "attacker@outside.example", headers: [] } })
  assert.equal("state" in rejected ? rejected.state : undefined, "error")
  assert.ok((await listIntakeSummaries(adminActor)).some((item) => item.eventId === "sender-denied-usesend" && item.errorCode === "sender_not_allowed"))

  const receiptCalls: Array<{ url: string; key: string | null; auth: string | null; body: Record<string, unknown> }> = []
  const receipts = await deliverPendingReceipts({
    workspaceId: ids.workspace,
    fetchImpl: async (url, init) => {
      receiptCalls.push({
        url: String(url), key: new Headers(init?.headers).get("idempotency-key"),
        auth: new Headers(init?.headers).get("authorization"),
        body: init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {},
      })
      return new Response(JSON.stringify({ emailId: "usesend-receipt-1" }), { status: 200, headers: { "content-type": "application/json" } })
    },
  })
  assert.ok(receipts.some((item) => item.intakeId === first.intakeId && item.state === "sent" && item.providerMessageId === "usesend-receipt-1"))
  assert.equal(receiptCalls[0]?.url, "https://app.usesend.com/api/v1/emails")
  assert.equal(receiptCalls[0]?.auth, "Bearer us_test_key")
  assert.equal(receiptCalls[0]?.key, `intake-receipt:${receipts.find((item) => item.intakeId === first.intakeId)?.id}`)
  assert.equal(receiptCalls[0]?.body.from, "MCA Intake <intake@fundlane.io>")
  assert.equal(receiptCalls[0]?.body.to, "broker@trusted.example")
  assert.match(String(receiptCalls[0]?.body.text), /Open the deal/)

  const setupCalls: Array<{ url: string; method: string; auth: string | null }> = []
  const provisioned = await provisionUsesendIntegration(adminContext, {
    apiKey: "us_live_key", inboundAddress: "applications@fundlane.io", fromAddress: "receipts@fundlane.io",
    displayName: "Verified useSend", publicOrigin: "https://fundlane.io", assignmentPool: [ids.repBMember],
  }, async (url, init) => {
    setupCalls.push({ url: String(url), method: init?.method ?? "GET", auth: new Headers(init?.headers).get("authorization") })
    return new Response(JSON.stringify([{ id: 7, name: "fundlane.io", status: "SUCCESS" }]), { status: 200, headers: { "content-type": "application/json" } })
  })
  assert.equal(provisioned.status.inboundAddress, "applications@fundlane.io")
  assert.equal(provisioned.status.readiness, "live_configured")
  assert.equal(provisioned.status.emailGateway, "usesend")
  assert.equal(provisioned.status.providerServerId, "7")
  assert.equal(provisioned.webhookUrl, `https://fundlane.io/api/mca/intake/email/${provisioned.status.id}`)
  assert.deepEqual(setupCalls.map((call) => [call.method, call.auth]), [["GET", "Bearer us_live_key"]])
  assert.equal(JSON.stringify(provisioned.status).includes(provisioned.admissionSecret), false)
  await assert.rejects(() => provisionUsesendIntegration(adminContext, {
    apiKey: "us_live_key", inboundAddress: "leads@fundlane.io", fromAddress: "intake@fundlane.io",
    displayName: "Local", publicOrigin: "http://localhost:3000",
  }, async () => { throw new Error("must not call") }), (error: { code?: string }) => error.code === "usesend_origin_invalid")
  await assert.rejects(() => provisionUsesendIntegration(adminContext, {
    apiKey: "us_live_key", inboundAddress: "other@unverified.example", fromAddress: "other@unverified.example",
    displayName: "Unverified", publicOrigin: "https://fundlane.io",
  }, async () => new Response(JSON.stringify([{ id: 7, name: "fundlane.io", status: "SUCCESS" }]), { status: 200 })), (error: { code?: string }) => error.code === "usesend_domain_unverified")
})

test("MIC-152 private attachment retrieval blocks private addresses, redirects, oversize bodies, and expired credentials", async () => {
  const privateConfig = await configureIntegration(adminContext, { provider: "custom", displayName: "Private files", formId: "files", credential: "secret", allowedHosts: ["files.example.test", "127.0.0.1"] })
  const integration = (await findIntegrationByPublicId(privateConfig.status.id, true))!
  const job = { id: "job", workspaceId: ids.workspace, intakeId: "intake", attachmentId: "attachment", sourceUrl: "https://127.0.0.1/private.pdf", filename: "private.pdf", mimeType: "application/pdf", category: "application", state: "pending" as const, attemptCount: 0 }
  await assert.rejects(() => fetchPrivateAttachment(job, integration), (error: { code?: string }) => error.code === "attachment_address_denied")
  const safe = { ...job, sourceUrl: "https://files.example.test/private.pdf" }
  const resolver = async () => [{ address: "203.0.113.20", family: 4 }]
  await assert.rejects(() => fetchPrivateAttachment(safe, integration, { lookupImpl: resolver, fetchImpl: async () => new Response(null, { status: 302, headers: { location: "https://evil.example/" } }) }), (error: { code?: string }) => error.code === "attachment_redirect_denied")
  await assert.rejects(() => fetchPrivateAttachment(safe, integration, { maxBytes: 4, lookupImpl: resolver, fetchImpl: async () => new Response("12345") }), (error: { code?: string }) => error.code === "attachment_too_large")
  const rotated = await rotateIntegrationCredentials(adminContext, integration.id, { credential: "expired", credentialExpiresAt: "2020-01-01T00:00:00.000Z" })
  const expired = (await findIntegrationByPublicId(rotated.status.id, true))!
  await assert.rejects(() => fetchPrivateAttachment(safe, expired, { lookupImpl: resolver, fetchImpl: async () => new Response(minimalPdf) }), (error: { code?: string }) => error.code === "provider_credential_expired")
})

test("MIC-152/MIC-184 workers claim attachments and receipts once, recover expired leases, and reuse transport idempotency", async () => {
  const configured = await configureIntegration(adminContext, {
    provider: "custom", displayName: "Queue claims", formId: "queue-claims", credential: "private-read",
    allowedHosts: ["files.example.test"],
  })
  const intake = await ingestApplication(adminActor, {
    schemaVersion: 1, provider: "custom", eventId: "queue-claims-intake", application: { legalName: "Queue Claims LLC" },
  })
  await associateIntakeIntegration(ids.workspace, intake.intakeId, configured.status.id)
  const resolver = async () => [{ address: "203.0.113.44", family: 4 }]

  const parallelJob = await scheduleAttachment({
    actor: adminActor, intakeId: intake.intakeId, attachmentId: "parallel-file", sourceUrl: "https://files.example.test/parallel.pdf",
    filename: "parallel.pdf", mimeType: "application/pdf", category: "application",
  })
  let releaseAttachment!: () => void
  let attachmentStarted!: () => void
  const attachmentStart = new Promise<void>((resolve) => { attachmentStarted = resolve })
  const attachmentGate = new Promise<void>((resolve) => { releaseAttachment = resolve })
  let attachmentFetches = 0
  const firstWorker = processAttachmentJob(parallelJob, {
    lookupImpl: resolver,
    fetchImpl: async () => {
      attachmentFetches += 1
      attachmentStarted()
      await attachmentGate
      return new Response(Buffer.from(minimalPdf), { status: 200, headers: { "content-type": "application/pdf" } })
    },
  })
  await attachmentStart
  const secondWorker = await processAttachmentJob(parallelJob, {
    lookupImpl: resolver,
    fetchImpl: async () => { attachmentFetches += 1; return new Response(Buffer.from(minimalPdf)) },
  })
  assert.equal(secondWorker.state, "fetching")
  releaseAttachment()
  assert.equal((await firstWorker).state, "stored")
  assert.equal(attachmentFetches, 1)

  const recoveryJob = await scheduleAttachment({
    actor: adminActor, intakeId: intake.intakeId, attachmentId: "expired-file", sourceUrl: "https://files.example.test/expired.pdf",
    filename: "expired.pdf", mimeType: "application/pdf", category: "application",
  })
  const abandoned = await claimAttachmentJob(ids.workspace, recoveryJob.id, 60_000)
  assert.equal(abandoned.acquired, true)
  await getDatabase().prepare("UPDATE intake_attachment_jobs SET lease_expires_at=? WHERE id=?").run("2000-01-01T00:00:00.000Z", recoveryJob.id)
  const recovered = await processAttachmentJob(recoveryJob, {
    lookupImpl: resolver,
    fetchImpl: async () => new Response(Buffer.from(minimalPdf), { status: 200, headers: { "content-type": "application/pdf" } }),
  })
  assert.equal(recovered.state, "stored")
  const staleCompletion = await completeAttachmentJob(ids.workspace, recoveryJob.id, abandoned.job.leaseToken!, { state: "failed", lastError: "late worker" })
  assert.equal(staleCompletion.completed, false)
  assert.equal(staleCompletion.job.state, "stored")

  const parallelReceipt = await enqueueReceipt({
    workspaceId: ids.workspace, intakeId: intake.intakeId, recipient: "queue@example.test",
    dealLink: "https://mca.example.test/deals/queue", addDocumentLink: "https://mca.example.test/deals/queue?addDocument=1", warnings: [],
  })
  process.env.MCA_INTAKE_RECEIPT_WEBHOOK_URL = "https://mail.example.test/intake"
  let releaseReceipt!: () => void
  let receiptStarted!: () => void
  const receiptStart = new Promise<void>((resolve) => { receiptStarted = resolve })
  const receiptGate = new Promise<void>((resolve) => { releaseReceipt = resolve })
  let receiptCalls = 0
  const firstDelivery = deliverPendingReceipts({ workspaceId: ids.workspace, fetchImpl: async () => {
    receiptCalls += 1; receiptStarted(); await receiptGate
    return new Response(JSON.stringify({ id: "parallel-mail" }), { status: 200, headers: { "content-type": "application/json" } })
  } })
  await receiptStart
  assert.deepEqual(await deliverPendingReceipts({ workspaceId: ids.workspace, fetchImpl: async () => { receiptCalls += 1; return new Response() } }), [])
  releaseReceipt()
  assert.equal((await firstDelivery)[0].state, "sent")
  assert.equal(receiptCalls, 1)
  assert.equal((await listPendingReceipts(ids.workspace)).some((item) => item.id === parallelReceipt.id), false)

  const retryIntake = await ingestApplication(adminActor, {
    schemaVersion: 1, provider: "custom", eventId: "receipt-lost-response", application: { legalName: "Receipt Retry LLC" },
  })
  const retryReceipt = await enqueueReceipt({
    workspaceId: ids.workspace, intakeId: retryIntake.intakeId, recipient: "retry@example.test",
    dealLink: "https://mca.example.test/deals/retry", addDocumentLink: "https://mca.example.test/deals/retry?addDocument=1", warnings: [],
  })
  const abandonedReceipt = await claimReceipt(ids.workspace, retryReceipt.id, 60_000)
  assert.equal(abandonedReceipt.acquired, true)
  await getDatabase().prepare("UPDATE intake_receipts SET lease_expires_at=? WHERE id=?").run("2000-01-01T00:00:00.000Z", retryReceipt.id)
  const transportKeys: string[] = []
  const failed = await deliverPendingReceipts({ workspaceId: ids.workspace, fetchImpl: async (_url, init) => {
    transportKeys.push(new Headers(init?.headers).get("idempotency-key") ?? "")
    throw new Error("response lost after provider accepted the request")
  } })
  assert.equal(failed[0].state, "failed")
  const staleReceiptCompletion = await completeReceipt(ids.workspace, retryReceipt.id, abandonedReceipt.receipt.leaseToken!, { state: "sent", providerMessageId: "late-mail" })
  assert.equal(staleReceiptCompletion.completed, false)
  assert.equal(staleReceiptCompletion.receipt.state, "failed")
  const retried = await deliverPendingReceipts({ workspaceId: ids.workspace, fetchImpl: async (_url, init) => {
    transportKeys.push(new Headers(init?.headers).get("idempotency-key") ?? "")
    return new Response(JSON.stringify({ id: "retry-mail" }), { status: 200, headers: { "content-type": "application/json" } })
  } })
  assert.equal(retried[0].state, "sent")
  assert.deepEqual(transportKeys, [`intake-receipt:${retryReceipt.id}`, `intake-receipt:${retryReceipt.id}`])
  delete process.env.MCA_INTAKE_RECEIPT_WEBHOOK_URL
})

test("MIC-152 direct HTTP intake rejects unauthenticated creation", async () => {
  const response = await intakePost(new Request("http://localhost/api/mca/intake", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ schemaVersion: 1, provider: "custom", eventId: "unauthorized", application: { legalName: "Nope" } }) }))
  assert.equal(response.status, 401)
  assert.equal((await response.json()).error.code, "authentication_required")

  await assert.rejects(() => configureIntegration(adminContext, { provider: "email", emailGateway: "evil" as "postmark", displayName: "Invalid gateway", inboundAddress: "hash@inbound.postmarkapp.com" }), (error: { code?: string }) => error.code === "integration_validation_failed")
  const sessionToken = "intake-admin-session-token"
  const now = new Date().toISOString()
  await getDatabase().prepare(`INSERT INTO sessions (id,user_id,membership_id,token_hash,expires_at,created_at,last_seen_at)
    VALUES ('intake-admin-http-session',?,?,?,?,?,?)`).run(ids.adminUser, ids.adminMember, hashOpaqueToken(sessionToken), "2099-01-01T00:00:00.000Z", now, now)
  const invalidGateway = await integrationPost(new Request("http://localhost/api/mca/intake/integrations", {
    method: "POST", headers: { "content-type": "application/json", cookie: `mca_session=${sessionToken}` },
    body: JSON.stringify({ provider: "email", emailGateway: "evil", displayName: "Invalid route gateway", inboundAddress: "hash2@inbound.postmarkapp.com" }),
  }))
  assert.equal(invalidGateway.status, 422)
  assert.equal((await invalidGateway.json()).error.code, "integration_validation_failed")
})

test("MIC-184 failed extraction replays encrypted source with stable identity, assignment, attachments and receipts", async () => {
  const configured = await configureIntegration(adminContext, { provider: "email", emailGateway: "custom", displayName: "Recoverable email", inboundAddress: "recover@example.test", senderRules: ["@trusted.example"], assignmentPool: [ids.repAMember] })
  const payload = { messageId: "recover-original", to: "recover@example.test", from: "broker@trusted.example", attachments: [
    { filename: "application.pdf", mimeType: "application/pdf", base64: Buffer.from(minimalPdf).toString("base64") },
    { filename: "bank-statement.pdf", mimeType: "application/pdf", base64: Buffer.from(minimalPdf).toString("base64") },
  ] }
  const rawBody = JSON.stringify(payload)
  const deliver = (extractor: Parameters<typeof ingestEmailDelivery>[0]["extractor"], body = rawBody) => ingestEmailDelivery({ integrationId: configured.status.id, request: new Request("https://mca.example.test/email", { method: "POST", headers: { authorization: `Bearer ${configured.admissionSecret}` } }), rawBody: body, appOrigin: "https://fundlane.io", extractor })
  const failed = await deliver(async () => { throw new Error("secret sensitive provider content") })
  assert.ok("intakeId" in failed)
  const id = "intakeId" in failed ? failed.intakeId : ""
  const row = await getDatabase().prepare<{ email_source_cipher: string; error_message: string }>("SELECT email_source_cipher, error_message FROM intake_events WHERE id = ?").get(id)
  assert.ok(row?.email_source_cipher)
  assert.equal(row.email_source_cipher.includes("broker@trusted.example"), false)
  assert.equal(row.error_message.includes("secret sensitive"), false)
  const { replayEmailIntake } = await import("../src/lib/mca/intake/email")
  const extractor = async () => ({ version: 1, fields: { legalName: "Recovery Merchant LLC" }, evidence: { legalName: { confidence: 0.99 } }, warnings: ["Review requested amount."], provider: "fixture" })
  await assert.rejects(() => replayEmailIntake(repActor(ids.repAMember, ids.repAUser), id, { appOrigin: "https://fundlane.io", extractor }), (error: { code?: string }) => error.code === "permission_denied")
  const recovered = await replayEmailIntake(adminActor, id, { appOrigin: "https://fundlane.io", extractor })
  assert.ok("dealId" in recovered && recovered.dealId)
  assert.equal("intakeId" in recovered && recovered.intakeId, id)
  assert.ok((await listAttachmentJobs(ids.workspace, id)).some((job) => job.category === "statement" && job.state === "stored"))
  await configureIntegration(adminContext, { id: configured.status.id, provider: "email", emailGateway: "custom", displayName: "Recoverable email", inboundAddress: "recover@example.test", assignmentPool: [ids.repBMember] })
  const duplicate = await deliver(async () => { throw new Error("Duplicate must not rerun extraction") })
  assert.equal("dealId" in duplicate && duplicate.dealId, "dealId" in recovered && recovered.dealId)
  const deal = await getDeal(adminActor, "dealId" in recovered ? recovered.dealId! : "")
  assert.equal(deal.assignments[0].membershipId, ids.repAMember)
  const receipts = (await listPendingReceipts(ids.workspace)).filter((receipt) => receipt.intakeId === id)
  assert.equal(receipts.length, 1)
  assert.equal(receipts[0].dealLink, `https://fundlane.io/deals?deal=${deal.id}`)
  assert.equal(receipts[0].addDocumentLink, `https://fundlane.io/deals?deal=${deal.id}&addDocument=1`)
  await assert.rejects(() => deliver(extractor, JSON.stringify({ ...payload, subject: "Changed source" })), (error: { code?: string }) => error.code === "intake_event_conflict")
})

test("MIC-184 uncertain extraction stays in review and concurrent callbacks create one deal", async () => {
  const configured = await configureIntegration(adminContext, { provider: "email", emailGateway: "custom", displayName: "Concurrent email", inboundAddress: "concurrent@example.test" })
  const rawBody = JSON.stringify({ messageId: "concurrent-original", to: "concurrent@example.test", from: "broker@trusted.example", attachments: [{ filename: "application.pdf", mimeType: "application/pdf", base64: Buffer.from(minimalPdf).toString("base64") }] })
  let confidence = 0.4
  let calls = 0
  const deliver = () => ingestEmailDelivery({ integrationId: configured.status.id, request: new Request("https://mca.example.test/email", { method: "POST", headers: { authorization: `Bearer ${configured.admissionSecret}` } }), rawBody, appOrigin: "https://fundlane.io", extractor: async () => { calls++; return { version: 1, fields: { legalName: "Concurrent Merchant LLC" }, evidence: { legalName: { confidence } }, warnings: [], provider: "fixture" } } })
  const uncertain = await deliver()
  assert.equal("state" in uncertain && uncertain.state, "error")
  assert.equal("dealId" in uncertain && uncertain.dealId, null)
  confidence = 0.99
  const [first, second] = await Promise.all([deliver(), deliver()])
  assert.ok("dealId" in first && first.dealId)
  assert.equal("dealId" in first && first.dealId, "dealId" in second && second.dealId)
  assert.equal(calls, 2)
})

test("MIC-184 manual review recovers without AI while denied senders cannot be approved", async () => {
  const configured = await configureIntegration(adminContext, { provider: "email", emailGateway: "custom", displayName: "Manual email review", inboundAddress: "review@example.test", senderRules: ["@trusted.example"] })
  const deliver = async (messageId: string, from: string) => ingestEmailDelivery({ integrationId: configured.status.id, request: new Request("https://mca.example.test/email", { method: "POST", headers: { authorization: `Bearer ${configured.admissionSecret}` } }), rawBody: JSON.stringify({ messageId, from, to: "review@example.test", text: "Please create a lead for the business in this message." }), appOrigin: "https://fundlane.io" })
  const pending = await deliver("manual-review", "broker@trusted.example")
  assert.equal(pending.state, "error")
  const { replayEmailIntake } = await import("../src/lib/mca/intake/email")
  const approved = await replayEmailIntake(adminActor, pending.intakeId, { appOrigin: "https://fundlane.io", reviewedApplication: { legalName: "Reviewed Harbor Bakery LLC", contactEmail: "merchant@example.test" }, extractor: async () => { throw new Error("Manual review must not invoke AI") } })
  assert.equal(approved.intakeId, pending.intakeId); assert.ok(approved.dealId)
  assert.equal((await getDeal(adminActor, approved.dealId!)).legalName, "Reviewed Harbor Bakery LLC")
  const rejected = await deliver("manual-denied", "attacker@outside.example")
  const attempt = await replayEmailIntake(adminActor, rejected.intakeId, { appOrigin: "https://fundlane.io", reviewedApplication: { legalName: "Must not create" } })
  assert.equal(attempt.state, "error"); assert.equal(attempt.dealId, null)
  await assert.rejects(() => ingestEmailDelivery({ integrationId: configured.status.id, request: new Request("https://mca.example.test/email", { headers: { authorization: `Bearer ${configured.admissionSecret}` } }), rawBody: JSON.stringify({ messageId: 42, attachments: {} }), appOrigin: "https://fundlane.io" }), (error: { code?: string }) => error.code === "email_payload_invalid")
})

test("MIC-184 labelled email text extracts one lead and ambiguous multiple businesses stay in review", async () => {
  const configured = await configureIntegration(adminContext, { provider: "email", emailGateway: "postmark", displayName: "Text intake", inboundAddress: "text@inbound.postmarkapp.com", assignmentPool: [ids.repAMember] })
  const deliver = (id: string, text: string) => ingestEmailDelivery({ integrationId: configured.status.id, request: new Request("https://mca.example.test/email", { headers: { authorization: `Basic ${Buffer.from(`mca:${configured.admissionSecret}`).toString("base64")}` } }), rawBody: JSON.stringify({ MessageID: id, OriginalRecipient: "text@inbound.postmarkapp.com", FromFull: { Email: "broker@trusted.example" }, TextBody: text }), appOrigin: "https://fundlane.io" })
  const result = await deliver("labelled-body", "Business name: Harbor Bakery LLC\nContact email: owner@example.test\nContact phone: 2125550100")
  assert.ok(result.dealId)
  const deal = await getDeal(adminActor, result.dealId!)
  assert.equal(deal.legalName, "Harbor Bakery LLC"); assert.equal(deal.contactEmail, "owner@example.test")
  const ambiguous = await deliver("multiple-businesses", "Business name: Harbor Bakery LLC\nBusiness name: Different Merchant LLC")
  assert.equal(ambiguous.state, "error"); assert.equal(ambiguous.dealId, null)
})
