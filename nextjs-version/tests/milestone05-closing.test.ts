import "./helpers/business-auth";
import test, { after, before, beforeEach } from "node:test"
import assert from "node:assert/strict"
import { createHmac } from "node:crypto"
import { createPostgresTestDatabase } from "./helpers/postgres-test-db.mjs"
import { closeDatabaseForTests, getDatabase } from "../src/lib/mca/db"
import { createDeal } from "../src/lib/mca/deals/service"
import type { DealActor } from "../src/lib/mca/deals/schema"
import { createOffer, selectOfferRevision } from "../src/lib/mca/offers/service"
import { setClosingTransportForTests } from "../src/lib/mca/closing/delivery"
import { createSmsAccount, recordSmsConsent } from "../src/lib/mca/sms/service"
import type { TwilioSmsTransport } from "../src/lib/mca/sms/twilio"
import {
  acceptOfferForClosing, confirmPsfRequest, createMerchantUploadLink, createStipulation, getClosingSnapshot,
  inspectMerchantUpload, markContractFinalReview, previewContractAction, previewMerchantOffers, recordContractSignature, recordPhonePitch,
  recordPsfWebhook, sendMerchantOfferPreview, sendRequestPreview, updatePsfConfiguration, updateStipulation, uploadMerchantDocument,
  redeemClosingArtifact,
} from "../src/lib/mca/closing/service"
import { setDocumentScannerForTests } from "../src/lib/mca/documents/scanner"
import { setDocumentStorageForTests, type DocumentStorage } from "../src/lib/mca/documents/storage"
import { storeDocument } from "../src/lib/mca/documents/service"
import { encryptSensitive, hashOpaqueToken } from "../src/lib/mca/crypto"
import { GET as snapshotGet } from "../src/app/api/mca/closing/[dealId]/route"
import { POST as stipulationPost } from "../src/app/api/mca/closing/stipulations/route"

let fixture: Awaited<ReturnType<typeof createPostgresTestDatabase>>
const ids = { workspace: "closing-workspace", otherWorkspace: "closing-other", user: "closing-user", member: "closing-member", otherUser: "closing-other-user", otherMember: "closing-other-member" }
const actor = (workspaceId = ids.workspace): DealActor => ({ workspaceId, userId: workspaceId === ids.workspace ? ids.user : ids.otherUser, membershipId: workspaceId === ids.workspace ? ids.member : ids.otherMember, role: "admin", managedMembershipIds: [], activeMembershipIds: [workspaceId === ids.workspace ? ids.member : ids.otherMember], source: "user", correlationId: `corr-${workspaceId}` })
const files = new Map<string, Uint8Array>()
const storage: DocumentStorage = { name: "memory", async putImmutable(key, bytes) { if (files.has(key)) throw new Error("exists"); files.set(key, bytes) }, async get(key) { const bytes = files.get(key); if (!bytes) throw new Error("missing"); return bytes } }
const pdf = new Uint8Array(Buffer.from("%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\n%%EOF\n"))
let dealId = "", selectedRevisionId = "", selectedOfferId = "", secondRevisionId = ""

async function seed() {
  const db = getDatabase(), now = new Date().toISOString(), pages = JSON.stringify({ dashboard: true, deals: true, users: true, reports: true, payments: true, workspace: true, integrations: true }), actions = JSON.stringify({ createDeal: true, exportDeals: true, inviteUsers: true, manageApiKeys: true, viewPaymentTable: true, viewCompanyFinancials: true }), flags = JSON.stringify({ reports: true, payments: true, integrations: true })
  for (const [workspaceId, userId, memberId] of [[ids.workspace, ids.user, ids.member], [ids.otherWorkspace, ids.otherUser, ids.otherMember]]) {
    await db.prepare("INSERT INTO workspaces (id,name,timezone,seat_limit,feature_flags,page_visibility,action_visibility,created_at,updated_at) VALUES (?,?,'America/New_York',5,?,?,?,?,?)").run(workspaceId, workspaceId, flags, pages, actions, now, now)
    await db.prepare("INSERT INTO users (id,email,password_hash,name,phone,application_identifier,created_at,updated_at) VALUES (?,?,NULL,?,NULL,?,?,?)").run(userId, `${userId}@example.test`, userId, `APP-${userId}`, now, now)
    await db.prepare("INSERT INTO memberships (id,workspace_id,user_id,role,manager_membership_id,status,sender_association,created_at,updated_at) VALUES (?,?,?,'admin',NULL,'active',NULL,?,?)").run(memberId, workspaceId, userId, now, now)
  }
  await db.prepare("INSERT INTO sessions (id,user_id,membership_id,token_hash,expires_at,created_at,last_seen_at) VALUES ('closing-session',?,?,?,'2099-01-01T00:00:00.000Z',?,?)").run(ids.user, ids.member, hashOpaqueToken("closing-token"), now, now)
  await db.prepare("INSERT INTO api_keys (id,workspace_id,name,prefix,secret_hash,scopes,expires_at,last_used_at,revoked_at,rate_limit_per_minute,created_by,created_at) VALUES ('closing-read-key',?,'read','mca_test',?,'[\"deals:read\"]',NULL,NULL,NULL,60,?,?)").run(ids.workspace, hashOpaqueToken("mca_read-secret"), ids.user, now)
  await db.prepare("INSERT INTO mca_email_senders (id,workspace_id,provider,purpose,from_name,from_address,signature,credential_cipher,state,is_default,verified_at,last_error,created_by_user_id,created_at,updated_at) VALUES ('merchant-sender',?,'smtp','merchant','Closer','closer@example.test',NULL,?,'verified',1,?,NULL,?,?,?)").run(ids.workspace, encryptSensitive(JSON.stringify({ kind: "smtp", host: "smtp.example.test", port: 587, username: "u", password: "secret", secure: false }), ids.workspace), now, ids.user, now, now)
  await db.prepare("INSERT INTO mca_email_senders (id,workspace_id,provider,purpose,from_name,from_address,signature,credential_cipher,state,is_default,verified_at,last_error,created_by_user_id,created_at,updated_at) VALUES ('submission-sender',?,'smtp','submission','Closer','closer@example.test',NULL,?,'verified',1,?,NULL,?,?,?)").run(ids.workspace, encryptSensitive(JSON.stringify({ kind: "smtp", host: "smtp.example.test", port: 587, username: "u", password: "secret", secure: false }), ids.workspace), now, ids.user, now, now)
  dealId = (await createDeal(actor(), { idempotencyKey: "closing-deal", legalName: "Synthetic Bakery LLC", contactName: "Mira", contactEmail: "mira@example.test", contactPhone: "+12125550123" })).deal.id
  const first = await createOffer(actor(), { dealId, funderName: "Northstar Capital", terms: { amountCents: 4000000, factorRate: 1.25, termMonths: 10, paymentAmountCents: 250000, paymentFrequency: "weekly", commissionCents: 320000 } })
  selectedOfferId = first.id; selectedRevisionId = first.currentRevisionId
  await selectOfferRevision(actor(), { dealId, offerId: first.id, revisionId: first.currentRevisionId, selected: true })
  const second = await createOffer(actor(), { dealId, funderName: "Harbor Funding", terms: { amountCents: 4500000, factorRate: 1.28, termMonths: 12, paymentAmountCents: 240000, paymentFrequency: "weekly", commissionCents: 400000 } })
  secondRevisionId = second.currentRevisionId
}

before(async () => { fixture = await createPostgresTestDatabase("milestone05_closing"); Object.assign(process.env, fixture.env()); setDocumentStorageForTests(storage); setDocumentScannerForTests({ name: "clean-fixture", async scan() { return { status: "clean", provider: "clean-fixture", evidence: { engineVerified: true } } } }); await seed() })
beforeEach(async () => { setClosingTransportForTests(); await getDatabase().execute("DELETE FROM mca_pitch_events"); await getDatabase().execute("DELETE FROM mca_closing_deliveries"); await getDatabase().execute("DELETE FROM mca_offer_message_previews"); await getDatabase().execute("DELETE FROM mca_closing_previews"); await getDatabase().execute("DELETE FROM mca_psf_requests"); await getDatabase().execute("DELETE FROM mca_psf_config"); await getDatabase().execute("DELETE FROM mca_contract_workflows"); await getDatabase().execute("DELETE FROM mca_merchant_upload_links"); await getDatabase().execute("DELETE FROM mca_closing_stipulations"); await getDatabase().execute("DELETE FROM mca_sms_status_events"); await getDatabase().execute("DELETE FROM mca_sms_messages"); await getDatabase().execute("DELETE FROM mca_sms_consent_events"); await getDatabase().execute("DELETE FROM mca_sms_account_members"); await getDatabase().execute("DELETE FROM mca_sms_accounts") })
after(async () => { setClosingTransportForTests(); setDocumentScannerForTests(); setDocumentStorageForTests(); await closeDatabaseForTests(); await fixture.close() })

test("MIC-106 opaque merchant upload is deal scoped, validates content, resolves once, and replays after response loss", async () => {
  const stip = await createStipulation(actor(), { dealId, documentCategory: "driver_license", label: "Owner driver license", idempotencyKey: "stip-dl" })
  const link = await createMerchantUploadLink(actor(), { stipulationId: stip.id, idempotencyKey: "link-dl", origin: "https://app.example.test" })
  assert.ok(link.url); const token = link.url!.split("/").pop()!
  const publicView = await inspectMerchantUpload(token)
  assert.deepEqual(Object.keys(publicView).sort(), ["destinationCategory", "expiresAt", "remainingUploads", "requestLabel"].sort())
  assert.equal(JSON.stringify(publicView).includes(dealId), false)
  await assert.rejects(() => uploadMerchantDocument(token, { idempotencyKey: "upload-1", filename: "fake.pdf", mimeType: "application/pdf", bytes: new Uint8Array(Buffer.from("not a pdf")) }), (error: { code?: string }) => error.code === "document_content_mismatch")
  assert.equal((await getClosingSnapshot(actor(), dealId)).stipulations[0].status, "open")
  const uploaded = await uploadMerchantDocument(token, { idempotencyKey: "upload-1", filename: "license.pdf", mimeType: "application/pdf", bytes: pdf })
  assert.equal(uploaded.stipulationStatus, "received")
  assert.deepEqual(await uploadMerchantDocument(token, { idempotencyKey: "upload-1", filename: "license.pdf", mimeType: "application/pdf", bytes: pdf }), uploaded)
  await assert.rejects(() => inspectMerchantUpload(token), (error: { code?: string }) => error.code === "upload_link_invalid")
  const verified = await updateStipulation(actor(), stip.id, { status: "verified" }); assert.equal(verified.status, "verified")
  await assert.rejects(() => updateStipulation(actor(ids.otherWorkspace), stip.id, { status: "waived", exceptionReason: "wrong workspace" }), (error: { code?: string }) => error.code === "stipulation_not_found")
})

test("MIC-108 requests preserve blockers, attach pinned clean documents, never imply signature, and require evidence", async () => {
  const workflow = await acceptOfferForClosing(actor(), { dealId, offerId: selectedOfferId, revisionId: selectedRevisionId, idempotencyKey: "accept-1" })
  assert.equal(workflow.state, "accepted")
  await assert.rejects(() => previewContractAction(actor(), { workflowId: workflow.id, action: "request_contract", recipient: "contracts@northstar.example", senderId: "submission-sender", idempotencyKey: "contract-preview" }), (error: { code?: string }) => error.code === "closing_documents_missing")
  const dl = await storeDocument(actor(), { dealId, idempotencyKey: "contract-dl", filename: "dl.pdf", mimeType: "application/pdf", bytes: pdf, category: "driver_license", source: "test" })
  const check = await storeDocument(actor(), { dealId, idempotencyKey: "contract-check", filename: "check.pdf", mimeType: "application/pdf", bytes: pdf, category: "voided_check", source: "test" })
  const prepared = await previewContractAction(actor(), { workflowId: workflow.id, action: "request_contract", recipient: "contracts@northstar.example", senderId: "submission-sender", attachedDocumentIds: [dl.id, check.id], idempotencyKey: "contract-preview" })
  assert.equal(prepared.workflow.state, "contract_requested"); assert.equal(prepared.preview.body.includes("Attachments: 2"), true)
  setClosingTransportForTests({ async deliver(request) { assert.equal(request.attachments?.length, 2); const token = request.attachments![0].url.split("/").pop()!; const artifact = await redeemClosingArtifact(token); assert.deepEqual(artifact.bytes, pdf); return { state: "sent", correlationId: request.correlationId, externalId: "mail-1" } } })
  const delivery = await sendRequestPreview(actor(), prepared.preview.id, "contract-send-1"); assert.equal(delivery.state, "sent")
  assert.equal((await getClosingSnapshot(actor(), dealId)).contracts[0].state, "contract_sent")
  await assert.rejects(() => previewContractAction(actor(), { workflowId: workflow.id, action: "request_repricing", recipient: "contracts@northstar.example", senderId: "submission-sender", attachedDocumentIds: [dl.id, check.id], idempotencyKey: "repricing-no-reason" }), (error: { code?: string }) => error.code === "repricing_reason_required")
  const repricing = await previewContractAction(actor(), { workflowId: workflow.id, action: "request_repricing", recipient: "contracts@northstar.example", senderId: "submission-sender", attachedDocumentIds: [dl.id, check.id], reason: "Merchant requested a lower weekly payment.", idempotencyKey: "repricing-preview" })
  assert.equal(repricing.workflow.state, "repricing_requested"); assert.match(repricing.preview.body, /Reason: Merchant requested a lower weekly payment/)
  await assert.rejects(() => recordContractSignature(actor(), { workflowId: workflow.id, source: "external", externalId: "provider-sign-1" }), (error: { code?: string }) => error.code === "validation_failed")
  const signedPdf = await storeDocument(actor(), { dealId, idempotencyKey: "signed-pdf", filename: "signed.pdf", mimeType: "application/pdf", bytes: pdf, category: "closing_document", source: "test" })
  const signed = await recordContractSignature(actor(), { workflowId: workflow.id, source: "external", externalId: "provider-sign-1", evidenceDocumentId: signedPdf.id }); assert.equal(signed.state, "signed"); assert.equal(signed.signature?.source, "external")
  await sendRequestPreview(actor(), prepared.preview.id, "late-replay")
  assert.equal((await getClosingSnapshot(actor(), dealId)).contracts[0].state, "signed")
  const final = await markContractFinalReview(actor(), workflow.id); assert.equal(final.state, "final_review")
  await sendRequestPreview(actor(), prepared.preview.id, "after-final-review")
  assert.equal((await getClosingSnapshot(actor(), dealId)).contracts[0].state, "final_review")
})

test("MIC-157 encrypts PSF details, failed transport stays failed, one provider identity is reused, and signed webhook replay is idempotent", async () => {
  await updatePsfConfiguration(actor(), { enabled: true, visibleToReps: true, destination: "https://example.com/psf", signingSecret: "psf-signing-secret-at-least-32-characters" })
  setClosingTransportForTests({ async deliver(request) { return { state: "failed", correlationId: request.correlationId, errorCode: "synthetic_failure", errorMessage: "Synthetic provider rejected request." } } })
  const input = { dealId, offerId: selectedOfferId, revisionId: selectedRevisionId, amountCents: 4000000, bankName: "Secret Harbor Bank", routingNumber: "021000021", accountNumber: "1234567890", businessName: "Synthetic Bakery LLC", contactName: "Mira", contactEmail: "mira@example.test", idempotencyKey: "psf-1", deliver: true, attemptKey: "psf-attempt-1" }
  const failed = await confirmPsfRequest(actor(), input); assert.equal(failed.request.state, "failed"); assert.equal(failed.request.accountLast4, "7890")
  const raw = await getDatabase().prepare<Record<string, string>>("SELECT bank_name_cipher,account_number_cipher FROM mca_psf_requests WHERE id=?").get(failed.request.id)
  assert.equal(JSON.stringify(raw).includes("Secret Harbor Bank"), false); assert.equal(JSON.stringify(raw).includes("1234567890"), false)
  setClosingTransportForTests({ async deliver(request) { return { state: "sent", correlationId: request.correlationId, externalId: "docuseal-request-1" } } })
  const delivered = await confirmPsfRequest(actor(), { ...input, attemptKey: "psf-attempt-2" }); assert.equal(delivered.request.state, "delivered"); assert.equal(delivered.request.externalRequestId, "docuseal-request-1")
  const replay = await confirmPsfRequest(actor(), { ...input, attemptKey: "psf-attempt-3" }); assert.equal(replay.request.state, "delivered"); assert.equal(replay.delivery, undefined)
  const body = JSON.stringify({ externalRequestId: "docuseal-request-1", status: "signed", evidenceId: "signature-evidence" }), timestamp = Math.floor(Date.now() / 1000).toString(), signature = createHmac("sha256", "psf-signing-secret-at-least-32-characters").update(`${timestamp}.${body}`).digest("hex")
  const signed = await recordPsfWebhook(ids.workspace, body, `${timestamp}.${signature}`); assert.equal(signed.state, "signed")
  assert.deepEqual(await recordPsfWebhook(ids.workspace, body, `${timestamp}.${signature}`), signed)
  assert.equal((await confirmPsfRequest(actor(), { ...input, attemptKey: "psf-after-sign" })).request.state, "signed")
  const apiActor: DealActor = { ...actor(), source: "api_key", userId: null, membershipId: null, role: null }
  const apiSnapshot = await getClosingSnapshot(apiActor, dealId); assert.equal(apiSnapshot.capabilities.psfVisible, false); assert.deepEqual(apiSnapshot.psfRequests, [])
  await assert.rejects(() => confirmPsfRequest(apiActor, { ...input, idempotencyKey: "psf-api", attemptKey: "psf-api-attempt" }), (error: { code?: string }) => error.code === "psf_permission_denied")
})

test("MIC-168 pins preview revisions, excludes commissions, never pitches failed sends, and logs every successful or phone revision separately", async () => {
  const preview = await previewMerchantOffers(actor(), { dealId, selectionMode: "all", channel: "email", senderId: "merchant-sender", recipient: "mira@example.test", idempotencyKey: "offers-all" })
  assert.match(preview.body, /Northstar Capital/); assert.match(preview.body, /Harbor Funding/); assert.equal(preview.body.includes("commission"), false); assert.equal(preview.body.includes("$3,200"), false)
  setClosingTransportForTests({ async deliver(request) { return { state: "failed", correlationId: request.correlationId, errorCode: "synthetic_failure" } } })
  const failed = await sendMerchantOfferPreview(actor(), preview.id, "offer-send-fail"); assert.equal(failed.pitched, false); assert.equal((await getClosingSnapshot(actor(), dealId)).pitchedRevisionIds.length, 0)
  setClosingTransportForTests({ async deliver(request) { assert.equal(request.body, preview.body); assert.equal(request.payloadHash, preview.contentHash); return { state: "sent", correlationId: request.correlationId, externalId: "merchant-mail-1" } } })
  const sent = await sendMerchantOfferPreview(actor(), preview.id, "offer-send-success"); assert.equal(sent.pitched, true)
  const pitched = new Set((await getClosingSnapshot(actor(), dealId)).pitchedRevisionIds); assert.deepEqual(pitched, new Set([selectedRevisionId, secondRevisionId]))
  const phone = await recordPhonePitch(actor(), { dealId, revisionId: selectedRevisionId, notes: "Merchant reviewed terms by phone.", idempotencyKey: "phone-1" }); assert.equal(phone.offerRevisionId, selectedRevisionId)
})

test("MIC-168 text delivery pins an assigned sender, requires consent, sends the exact preview, and records provider acknowledgement", async () => {
  const priorProvider = process.env.MCA_SMS_PROVIDER, priorAccounts = process.env.MCA_SMS_TWILIO_ACCOUNTS_JSON, priorBaseUrl = process.env.MCA_SMS_PUBLIC_BASE_URL
  const sender = "+12125550999", externalId = `SM${"c".repeat(32)}`
  try {
    process.env.MCA_SMS_PROVIDER = "twilio"
    process.env.MCA_SMS_PUBLIC_BASE_URL = "https://sms.example.test"
    process.env.MCA_SMS_TWILIO_ACCOUNTS_JSON = JSON.stringify({ [ids.workspace]: { CLOSING: { accountSid: `AC${"a".repeat(32)}`, apiKeySid: `SK${"b".repeat(32)}`, apiKeySecret: "synthetic-secret", authToken: "synthetic-auth-token", allowedSenders: [sender] } } })
    const account = await createSmsAccount(actor(), { label: "Closing texts", senderKind: "phone_number", senderIdentity: sender, credentialRef: "CLOSING", memberIds: [ids.member], isDefault: true })
    await recordSmsConsent(actor(), { dealId, recipient: "+12125550123", state: "opted_in", evidence: "Synthetic written consent recorded for this test", idempotencyKey: "closing-sms-consent" })
    const snapshot = await getClosingSnapshot(actor(), dealId)
    assert.deepEqual(snapshot.merchantSmsAccounts.map((item) => ({ id: item.id, configured: item.providerConfigured })), [{ id: account.id, configured: true }])
    assert.match(snapshot.productionGates.merchantSms, /^ready/)
    const preview = await previewMerchantOffers(actor(), { dealId, revisionId: selectedRevisionId, selectionMode: "selected", channel: "sms", senderId: account.id, recipient: "+1 (212) 555-0123", idempotencyKey: "closing-sms-preview" })
    assert.equal(preview.senderId, account.id)
    assert.equal(preview.recipientMasked, "•••0123")
    let calls = 0
    const transport: TwilioSmsTransport = { async send(request) {
      calls += 1
      assert.equal(request.senderIdentity, sender)
      assert.equal(request.recipient, "+12125550123")
      assert.equal(request.body, preview.body)
      assert.match(request.statusCallbackUrl, /^https:\/\/sms\.example\.test\/api\/mca\/sms\/webhooks\/twilio\//)
      return { state: "accepted", externalId, providerStatus: "queued" }
    } }
    const sent = await sendMerchantOfferPreview(actor(), preview.id, "closing-sms-send", transport)
    assert.equal(sent.delivery.state, "sent")
    assert.equal(sent.delivery.externalId, externalId)
    assert.equal(sent.pitched, true)
    assert.equal(calls, 1)
    const stored = await getDatabase().prepare<{ state: string; provider_message_id: string; body_cipher: string }>("SELECT state,provider_message_id,body_cipher FROM mca_sms_messages WHERE workspace_id=? AND deal_id=?").get(ids.workspace, dealId)
    assert.deepEqual({ state: stored?.state, providerMessageId: stored?.provider_message_id }, { state: "accepted", providerMessageId: externalId })
    assert.equal(stored?.body_cipher.includes("Northstar Capital"), false)
    assert.equal((await getClosingSnapshot(actor(), dealId)).pitchedRevisionIds.includes(selectedRevisionId), true)

    const unknownPreview = await previewMerchantOffers(actor(), { dealId, revisionId: secondRevisionId, selectionMode: "highest", channel: "sms", senderId: account.id, recipient: "+12125550123", idempotencyKey: "closing-sms-unknown-preview" })
    let unknownCalls = 0
    const unknown = await sendMerchantOfferPreview(actor(), unknownPreview.id, "closing-sms-unknown", { async send() { unknownCalls += 1; return { state: "unknown", errorCode: "provider_outcome_unknown" } } })
    assert.equal(unknown.delivery.state, "blocked")
    assert.equal(unknown.delivery.errorCode, "provider_outcome_unknown")
    assert.equal(unknown.pitched, false)
    const replay = await sendMerchantOfferPreview(actor(), unknownPreview.id, "closing-sms-unknown-retry", { async send() { throw new Error("reconcile-only replay must never send") } })
    assert.equal(replay.delivery.state, "blocked")
    assert.equal(replay.pitched, false)
    assert.equal(unknownCalls, 1)
    assert.equal((await getClosingSnapshot(actor(), dealId)).pitchedRevisionIds.includes(secondRevisionId), false)
  } finally {
    if (priorProvider === undefined) delete process.env.MCA_SMS_PROVIDER; else process.env.MCA_SMS_PROVIDER = priorProvider
    if (priorAccounts === undefined) delete process.env.MCA_SMS_TWILIO_ACCOUNTS_JSON; else process.env.MCA_SMS_TWILIO_ACCOUNTS_JSON = priorAccounts
    if (priorBaseUrl === undefined) delete process.env.MCA_SMS_PUBLIC_BASE_URL; else process.env.MCA_SMS_PUBLIC_BASE_URL = priorBaseUrl
  }
})

test("closing delivery fences concurrent attempt keys and reconciles a crash-pending reservation without resending", async () => {
  const preview = await previewMerchantOffers(actor(), { dealId, revisionId: selectedRevisionId, selectionMode: "selected", channel: "email", senderId: "merchant-sender", recipient: "mira@example.test", idempotencyKey: "delivery-fence-preview" })
  let deliverCalls = 0, reconcileCalls = 0, releaseDelivery!: () => void, markStarted!: () => void
  const deliveryStarted = new Promise<void>((resolve) => { markStarted = resolve })
  const deliveryGate = new Promise<void>((resolve) => { releaseDelivery = resolve })
  setClosingTransportForTests({
    async deliver(request) { deliverCalls += 1; markStarted(); await deliveryGate; return { state: "sent", correlationId: request.correlationId, externalId: "postmark-fenced-message" } },
    async reconcile(request) { reconcileCalls += 1; return { state: "blocked", correlationId: request.correlationId, errorCode: "provider_outcome_unknown" } },
  })
  const first = sendMerchantOfferPreview(actor(), preview.id, "delivery-fence-a")
  await deliveryStarted
  const second = await sendMerchantOfferPreview(actor(), preview.id, "delivery-fence-b")
  assert.equal(second.delivery.errorCode, "provider_outcome_unknown")
  releaseDelivery()
  assert.equal((await first).delivery.externalId, "postmark-fenced-message")
  assert.equal(deliverCalls, 1); assert.equal(reconcileCalls, 1)
  const rows = await getDatabase().prepare<{ state: string }>("SELECT state FROM mca_closing_deliveries WHERE workspace_id=? AND kind='offer_message' AND record_id=?").all(ids.workspace, preview.id)
  assert.deepEqual(rows, [{ state: "sent" }])

  const crashPreview = await previewMerchantOffers(actor(), { dealId, revisionId: selectedRevisionId, selectionMode: "selected", channel: "email", senderId: "merchant-sender", recipient: "mira@example.test", idempotencyKey: "crash-preview" })
  const now = new Date().toISOString()
  await getDatabase().prepare(`INSERT INTO mca_closing_deliveries (id,workspace_id,deal_id,kind,record_id,attempt_key,channel,state,recipient_cipher,payload_hash,correlation_id,external_id,error_code,error_message,created_at,updated_at)
    VALUES ('crash-pending',?,?, 'offer_message',?,'crashed-process','email','pending',NULL,?,'postmark-crash-correlation',NULL,NULL,NULL,?,?)`).run(ids.workspace, dealId, crashPreview.id, crashPreview.contentHash, now, now)
  let crashDeliverCalls = 0
  setClosingTransportForTests({
    async deliver(request) { crashDeliverCalls += 1; return { state: "sent", correlationId: request.correlationId, externalId: "must-not-send" } },
    async reconcile(request) { assert.equal(request.correlationId, "postmark-crash-correlation"); return { state: "sent", correlationId: request.correlationId, externalId: "postmark-reconciled-crash" } },
  })
  const recovered = await sendMerchantOfferPreview(actor(), crashPreview.id, "after-process-crash")
  assert.equal(recovered.delivery.externalId, "postmark-reconciled-crash")
  assert.equal(crashDeliverCalls, 0)
  assert.equal((await getDatabase().prepare<{ count: number }>("SELECT COUNT(*)::int count FROM mca_closing_deliveries WHERE workspace_id=? AND record_id=?").get(ids.workspace, crashPreview.id))?.count, 1)
})

test("closing HTTP routes enforce read/write scopes, session page visibility, and workspace isolation", async () => {
  const read = new Request(`http://localhost/api/mca/closing/${dealId}`, { headers: { authorization: "Bearer mca_read-secret" } })
  assert.equal((await snapshotGet(read, { params: Promise.resolve({ dealId }) })).status, 200)
  const denied = new Request("http://localhost/api/mca/closing/stipulations", { method: "POST", headers: { authorization: "Bearer mca_read-secret", "content-type": "application/json" }, body: JSON.stringify({ dealId, documentCategory: "statement", label: "Denied", idempotencyKey: "denied" }) })
  assert.equal((await stipulationPost(denied)).status, 403)
  await getDatabase().prepare("UPDATE workspaces SET page_visibility=? WHERE id=?").run(JSON.stringify({ dashboard: true, deals: false, users: true, reports: true, payments: true, workspace: true, integrations: true }), ids.workspace)
  const session = new Request(`http://localhost/api/mca/closing/${dealId}`, { headers: { cookie: "mca_session=closing-token" } })
  assert.equal((await snapshotGet(session, { params: Promise.resolve({ dealId }) })).status, 403)
})
