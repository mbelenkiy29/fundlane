import "./helpers/business-auth";
import test, { after, before, beforeEach } from "node:test"
import assert from "node:assert/strict"
import { createHmac } from "node:crypto"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { createPostgresTestDatabase } from "./helpers/postgres-test-db.mjs"
import { closeDatabaseForTests, getDatabase } from "../src/lib/mca/db"
import { createDeal } from "../src/lib/mca/deals/service"
import type { DealActor } from "../src/lib/mca/deals/schema"
import { createFunder } from "../src/lib/mca/funders/directory"
import { createOffer, selectOfferRevision } from "../src/lib/mca/offers/service"
import { setClosingTransportForTests } from "../src/lib/mca/closing/delivery"
import { createSmsAccount, recordSmsConsent } from "../src/lib/mca/sms/service"
import type { TwilioSmsTransport } from "../src/lib/mca/sms/twilio"
import {
  acceptOfferForClosing, confirmPsfRequest, createMerchantUploadLink, createStipulation, getClosingSnapshot,
  inspectMerchantUpload, markContractFinalReview, previewContractAction, previewMerchantOffers, previewStipulationRequest, recordContractSignature, recordPhonePitch,
  recordPsfWebhook, sendMerchantOfferPreview, sendRequestPreview, updatePsfConfiguration, updateStipulation, uploadMerchantDocument,
  redeemClosingArtifact,
} from "../src/lib/mca/closing/service"
import { setDocumentScannerForTests } from "../src/lib/mca/documents/scanner"
import { setDocumentStorageForTests, type DocumentStorage } from "../src/lib/mca/documents/storage"
import { storeDocument } from "../src/lib/mca/documents/service"
import { decryptSensitive, encryptSensitive, hashOpaqueToken } from "../src/lib/mca/crypto"
import { GET as snapshotGet } from "../src/app/api/mca/closing/[dealId]/route"
import { POST as stipulationPost } from "../src/app/api/mca/closing/stipulations/route"

let fixture: Awaited<ReturnType<typeof createPostgresTestDatabase>>
const ids = { workspace: "closing-workspace", otherWorkspace: "closing-other", user: "closing-user", member: "closing-member", otherUser: "closing-other-user", otherMember: "closing-other-member" }
const actor = (workspaceId = ids.workspace): DealActor => ({ workspaceId, userId: workspaceId === ids.workspace ? ids.user : ids.otherUser, membershipId: workspaceId === ids.workspace ? ids.member : ids.otherMember, role: "admin", managedMembershipIds: [], activeMembershipIds: [workspaceId === ids.workspace ? ids.member : ids.otherMember], source: "user", correlationId: `corr-${workspaceId}` })
function guessedUploadHmac(workspaceId: string, stipulationId: string, key: string): string {
  const configured = process.env.MCA_UPLOAD_TOKEN_SECRET
  const secret = configured && configured.length >= 32 ? Buffer.from(configured) : Buffer.from("local-only-upload-token-secret-32-bytes-minimum")
  return createHmac("sha256", secret).update(`${workspaceId}:${stipulationId}:${key}`).digest("base64url")
}
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
  const northstar = (await createFunder(actor(), {
    idempotencyKey: "closing-northstar",
    legalName: "Northstar Capital",
    routes: [{ kind: "email", label: "Contracts", destination: "contracts@northstar.example", active: true }],
  })).funder
  const harbor = (await createFunder(actor(), {
    idempotencyKey: "closing-harbor",
    legalName: "Harbor Funding",
    routes: [{ kind: "email", label: "Contracts", destination: "contracts@harbor.example", active: true }],
  })).funder
  const first = await createOffer(actor(), { dealId, funderId: northstar.id, funderName: "Northstar Capital", terms: { amountCents: 4000000, factorRate: 1.25, termMonths: 10, paymentAmountCents: 250000, paymentFrequency: "weekly", commissionCents: 320000 } })
  selectedOfferId = first.id; selectedRevisionId = first.currentRevisionId
  await selectOfferRevision(actor(), { dealId, offerId: first.id, revisionId: first.currentRevisionId, selected: true })
  const second = await createOffer(actor(), { dealId, funderId: harbor.id, funderName: "Harbor Funding", terms: { amountCents: 4500000, factorRate: 1.28, termMonths: 12, paymentAmountCents: 240000, paymentFrequency: "weekly", commissionCents: 400000 } })
  secondRevisionId = second.currentRevisionId
}

before(async () => { fixture = await createPostgresTestDatabase("milestone05_closing"); Object.assign(process.env, fixture.env()); delete process.env.MCA_BACKGROUND_JOBS; delete process.env.VERCEL; setDocumentStorageForTests(storage); setDocumentScannerForTests({ name: "clean-fixture", async scan() { return { status: "clean", provider: "clean-fixture", evidence: { engineVerified: true } } } }); await seed() })
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

test("recipient binding defaults to deal contact, masks previews, and audits admin overrides", async () => {
  const { bindMerchantEmail, bindMerchantSms, bindFunderEmail } = await import("../src/lib/mca/closing/recipients")
  const { getDealForDocument } = await import("../src/lib/mca/deals/service")
  const deal = await getDealForDocument(actor(), dealId)

  const defaultEmail = bindMerchantEmail(deal, {}, actor())
  assert.equal(defaultEmail.address, "mira@example.test")
  assert.equal(defaultEmail.masked, "m•••@example.test")
  assert.equal(defaultEmail.overridden, false)
  assert.equal(defaultEmail.source, "deal_contact")

  const matched = bindMerchantEmail(deal, { recipient: "Mira@Example.test" }, actor())
  assert.equal(matched.overridden, false)
  assert.equal(matched.address, "mira@example.test")

  assert.throws(() => bindMerchantEmail(deal, { recipient: "other@example.test" }, actor()), (error: { code?: string }) => error.code === "recipient_override_required")
  assert.throws(() => bindMerchantEmail(deal, { recipient: "other@example.test", overrideReason: "short" }, actor()), (error: { code?: string }) => error.code === "recipient_override_required")
  assert.throws(() => bindMerchantEmail(deal, { recipient: "other@example.test", overrideReason: "Merchant asked for a different inbox." }, { ...actor(), role: "rep" }), (error: { code?: string }) => error.code === "recipient_override_denied")
  assert.throws(() => bindMerchantEmail(deal, { recipient: "other@example.test", overrideReason: "Merchant asked for a different inbox." }, { ...actor(), source: "api_key", userId: null, membershipId: null, role: null }), (error: { code?: string }) => error.code === "recipient_override_denied")

  const overridden = bindMerchantEmail(deal, { recipient: "other@example.test", overrideReason: "Merchant asked for a different inbox." }, actor())
  assert.equal(overridden.overridden, true)
  assert.equal(overridden.address, "other@example.test")
  assert.equal(overridden.source, "admin_override")

  const defaultSms = bindMerchantSms(deal, {}, actor())
  assert.equal(defaultSms.address, "+12125550123")
  assert.equal(defaultSms.masked, "•••0123")
  assert.equal(defaultSms.overridden, false)

  const missingDeal = await createDeal(actor(), { idempotencyKey: "closing-no-contact", legalName: "No Contact LLC" })
  const bare = await getDealForDocument(actor(), missingDeal.deal.id)
  assert.throws(() => bindMerchantEmail(bare, {}, actor()), (error: { code?: string }) => error.code === "merchant_contact_missing")
  assert.throws(() => bindMerchantSms(bare, {}, actor()), (error: { code?: string }) => error.code === "merchant_contact_missing")

  const funder = (await createFunder(actor(), {
    idempotencyKey: "closing-funder-route",
    legalName: "Route Capital",
    routes: [{ kind: "email", label: "Contracts", destination: "contracts@route.example", active: true }],
  })).funder
  const funderBound = await bindFunderEmail({ funderId: funder.id, dealId }, actor())
  assert.equal(funderBound.address, "contracts@route.example")
  assert.equal(funderBound.source, "funder_route")
  assert.equal(funderBound.overridden, false)
  await assert.rejects(() => bindFunderEmail({ funderId: funder.id, recipient: "other@route.example", dealId }, actor()), (error: { code?: string }) => error.code === "recipient_override_required")

  const preview = await previewMerchantOffers(actor(), { dealId, selectionMode: "selected", channel: "email", senderId: "merchant-sender", idempotencyKey: "bind-default-preview" })
  assert.equal(preview.recipientMasked, "m•••@example.test")
  assert.equal(JSON.stringify(preview).includes("mira@example.test"), false)

  await assert.rejects(() => previewMerchantOffers(actor(), { dealId, selectionMode: "selected", channel: "email", senderId: "merchant-sender", recipient: "other@example.test", idempotencyKey: "bind-other-no-reason" }), (error: { code?: string }) => error.code === "recipient_override_required")
  await assert.rejects(() => previewMerchantOffers({ ...actor(), role: "rep" }, { dealId, selectionMode: "selected", channel: "email", senderId: "merchant-sender", recipient: "other@example.test", overrideReason: "Merchant asked for a different inbox.", idempotencyKey: "bind-rep-denied" }), (error: { code?: string }) => error.code === "recipient_override_denied")

  const adminPreview = await previewMerchantOffers(actor(), { dealId, selectionMode: "selected", channel: "email", senderId: "merchant-sender", recipient: "other@example.test", overrideReason: "Merchant asked for a different inbox.", idempotencyKey: "bind-admin-override" })
  assert.equal(adminPreview.recipientMasked, "o•••@example.test")
  const audit = await getDatabase().prepare<{ action: string; metadata: string }>("SELECT action, metadata FROM audit_events WHERE workspace_id=? AND action='closing.recipient_overridden' ORDER BY created_at DESC LIMIT 1").get(ids.workspace)
  assert.equal(audit?.action, "closing.recipient_overridden")
  assert.equal(audit?.metadata.includes("other@example.test"), false)
  assert.equal(audit?.metadata.includes("mira@example.test"), false)
  assert.match(audit?.metadata ?? "", /Merchant asked for a different inbox/)
})

test("admin SMS recipient override can record consent and preview without deal-phone lock", async () => {
  const priorProvider = process.env.MCA_SMS_PROVIDER, priorAccounts = process.env.MCA_SMS_TWILIO_ACCOUNTS_JSON, priorBaseUrl = process.env.MCA_SMS_PUBLIC_BASE_URL
  const sender = "+12125550998", overridePhone = "+12125550987"
  try {
    process.env.MCA_SMS_PROVIDER = "twilio"
    process.env.MCA_SMS_PUBLIC_BASE_URL = "https://sms.example.test"
    process.env.MCA_SMS_TWILIO_ACCOUNTS_JSON = JSON.stringify({ [ids.workspace]: { CLOSING_OVERRIDE: { accountSid: `AC${"d".repeat(32)}`, apiKeySid: `SK${"e".repeat(32)}`, apiKeySecret: "synthetic-secret", authToken: "synthetic-auth-token", allowedSenders: [sender] } } })
    const account = await createSmsAccount(actor(), { label: "Override texts", senderKind: "phone_number", senderIdentity: sender, credentialRef: "CLOSING_OVERRIDE", memberIds: [ids.member], isDefault: true })
    await assert.rejects(
      () => recordSmsConsent(actor(), { dealId, recipient: overridePhone, state: "opted_in", evidence: "Override mobile consent evidence", idempotencyKey: "closing-sms-override-consent-denied" }),
      (error: { code?: string }) => error.code === "recipient_deal_mismatch",
    )
    await recordSmsConsent(actor(), { dealId, recipient: overridePhone, state: "opted_in", evidence: "Override mobile consent evidence", idempotencyKey: "closing-sms-override-consent", matchDealContact: false })
    const preview = await previewMerchantOffers(actor(), {
      dealId,
      revisionId: selectedRevisionId,
      selectionMode: "selected",
      channel: "sms",
      senderId: account.id,
      recipient: overridePhone,
      overrideReason: "Merchant asked to use a different mobile.",
      idempotencyKey: "closing-sms-override-preview",
    })
    assert.equal(preview.recipientMasked, "•••0987")
    assert.equal(JSON.stringify(preview).includes(overridePhone), false)
    const audit = await getDatabase().prepare<{ action: string; metadata: string }>("SELECT action, metadata FROM audit_events WHERE workspace_id=? AND action='closing.recipient_overridden' ORDER BY created_at DESC LIMIT 1").get(ids.workspace)
    assert.equal(audit?.action, "closing.recipient_overridden")
    assert.equal(audit?.metadata.includes(overridePhone), false)
    assert.match(audit?.metadata ?? "", /different mobile/)

    let calls = 0
    const sent = await sendMerchantOfferPreview(actor(), preview.id, "closing-sms-override-send", {
      async send(request) {
        calls += 1
        assert.equal(request.recipient, overridePhone)
        assert.equal(request.body, preview.body)
        return { state: "accepted", externalId: `SM${"f".repeat(32)}`, providerStatus: "queued" }
      },
    })
    assert.equal(sent.delivery.state, "sent")
    assert.equal(sent.pitched, true)
    assert.equal(calls, 1)
  } finally {
    if (priorProvider === undefined) delete process.env.MCA_SMS_PROVIDER; else process.env.MCA_SMS_PROVIDER = priorProvider
    if (priorAccounts === undefined) delete process.env.MCA_SMS_TWILIO_ACCOUNTS_JSON; else process.env.MCA_SMS_TWILIO_ACCOUNTS_JSON = priorAccounts
    if (priorBaseUrl === undefined) delete process.env.MCA_SMS_PUBLIC_BASE_URL; else process.env.MCA_SMS_PUBLIC_BASE_URL = priorBaseUrl
  }
})

test("stipulation preview uses placeholders and send mints one idempotent random upload URL", async () => {
  const stip = await createStipulation(actor(), { dealId, documentCategory: "driver_license", label: "Owner driver license", idempotencyKey: "stip-preview-send" })
  const preview = await previewStipulationRequest(actor(), {
    dealId,
    stipulationIds: [stip.id],
    senderId: "merchant-sender",
    idempotencyKey: "stip-preview-1",
    origin: "https://app.example.test",
  })
  assert.equal(preview.body.includes("/merchant-upload/"), false)
  assert.match(preview.body, new RegExp(`\\[secure-upload:${stip.id}\\]`))
  const previewLinks = await getDatabase().prepare<{ count: number }>("SELECT COUNT(*)::int count FROM mca_merchant_upload_links WHERE workspace_id=?").get(ids.workspace)
  assert.equal(previewLinks?.count, 0)

  const staff = await createMerchantUploadLink(actor(), { stipulationId: stip.id, idempotencyKey: "staff-link-now", origin: "https://app.example.test" })
  assert.match(staff.url ?? "", /^https:\/\/app\.example\.test\/merchant-upload\/[A-Za-z0-9_-]{30,}$/)
  await assert.rejects(() => inspectMerchantUpload(guessedUploadHmac(ids.workspace, stip.id, "staff-link-now")), (error: { code?: string }) => error.code === "upload_link_invalid")
  await getDatabase().prepare("DELETE FROM mca_merchant_upload_links WHERE workspace_id=?").run(ids.workspace)

  let deliveredBody = ""
  setClosingTransportForTests({ async deliver(request) { deliveredBody = request.body ?? ""; return { state: "sent", correlationId: request.correlationId, externalId: "stip-mail-1" } } })
  const sent = await sendRequestPreview(actor(), preview.id, "stip-send-1")
  assert.equal(sent.state, "sent")
  assert.match(deliveredBody, /\/merchant-upload\/[A-Za-z0-9_-]{30,}/)
  assert.equal(deliveredBody.includes("[secure-upload:"), false)
  const links = await getDatabase().prepare<{ id: string; idempotency_key: string; token_cipher: string | null; token_hash: string }>("SELECT id,idempotency_key,token_cipher,token_hash FROM mca_merchant_upload_links WHERE workspace_id=?").all(ids.workspace)
  assert.equal(links.length, 1)
  assert.equal(links[0].idempotency_key, `send:${preview.id}:${stip.id}`)
  assert.ok(links[0].token_cipher)
  const token = deliveredBody.match(/\/merchant-upload\/([A-Za-z0-9_-]+)/)?.[1]
  assert.ok(token)
  assert.equal(links[0].token_cipher?.includes(token!), false)
  assert.equal(JSON.stringify(links[0]).includes(token!), false)
  const publicView = await inspectMerchantUpload(token!)
  assert.equal(publicView.destinationCategory, "driver_license")

  let replayDeliveries = 0
  setClosingTransportForTests({ async deliver(request) { replayDeliveries += 1; return { state: "sent", correlationId: request.correlationId, externalId: "must-not-resend" } } })
  const replay = await sendRequestPreview(actor(), preview.id, "stip-send-replay")
  assert.equal(replay.state, "sent")
  assert.equal(replayDeliveries, 0)
  const afterReplay = await getDatabase().prepare<{ count: number }>("SELECT COUNT(*)::int count FROM mca_merchant_upload_links WHERE workspace_id=?").get(ids.workspace)
  assert.equal(afterReplay?.count, 1)

  await assert.rejects(() => inspectMerchantUpload(guessedUploadHmac(ids.workspace, stip.id, `send:${preview.id}:${stip.id}`)), (error: { code?: string }) => error.code === "upload_link_invalid")
  await assert.rejects(() => inspectMerchantUpload(guessedUploadHmac(ids.workspace, stip.id, `preview:stip-preview-1:${stip.id}`)), (error: { code?: string }) => error.code === "upload_link_invalid")
})

test("legacy HMAC merchant upload hashes remain redeemable until expiry", async () => {
  const stip = await createStipulation(actor(), { dealId, documentCategory: "voided_check", label: "Voided check", idempotencyKey: "stip-legacy-hmac" })
  const key = "legacy-hmac-link"
  const token = guessedUploadHmac(ids.workspace, stip.id, key)
  const now = new Date().toISOString()
  const expiresAt = new Date(Date.now() + 86_400_000).toISOString()
  await getDatabase().prepare(`INSERT INTO mca_merchant_upload_links
    (id,workspace_id,deal_id,stipulation_id,token_hash,destination_category,expires_at,max_uploads,used_count,revoked_at,idempotency_key,created_by_user_id,created_at,updated_at)
    VALUES ('legacy-hmac-row',?,?,?,?,?,?,1,0,NULL,?,?,?,?)`).run(ids.workspace, dealId, stip.id, hashOpaqueToken(token), "voided_check", expiresAt, key, ids.user, now, now)
  const publicView = await inspectMerchantUpload(token)
  assert.equal(publicView.destinationCategory, "voided_check")
  const replay = await createMerchantUploadLink(actor(), { stipulationId: stip.id, idempotencyKey: key, origin: "https://app.example.test" })
  assert.equal(replay.url, `https://app.example.test/merchant-upload/${token}`)
  const count = await getDatabase().prepare<{ count: number }>("SELECT COUNT(*)::int count FROM mca_merchant_upload_links WHERE workspace_id=?").get(ids.workspace)
  assert.equal(count?.count, 1)
})

test("ABA routing checksum accepts 021000021 and rejects 123456789", async () => {
  const { assertUsAbaRoutingNumber } = await import("../src/lib/mca/closing/aba")
  assert.equal(assertUsAbaRoutingNumber("021000021"), "021000021")
  assert.equal(assertUsAbaRoutingNumber("021-000-021"), "021000021")
  assert.throws(() => assertUsAbaRoutingNumber("123456789"), (error: { code?: string }) => error.code === "routing_number_invalid")
  assert.throws(() => assertUsAbaRoutingNumber("12345678"), (error: { code?: string }) => error.code === "routing_number_invalid")
})

test("confirmPsfRequest requires ABA checksum and deal-matching contact email unless admin override", async () => {
  await updatePsfConfiguration(actor(), { enabled: true, visibleToReps: true, destination: "https://example.com/psf", signingSecret: "psf-signing-secret-at-least-32-characters" })
  const base = {
    dealId,
    offerId: selectedOfferId,
    revisionId: selectedRevisionId,
    amountCents: 4000000,
    bankName: "Secret Harbor Bank",
    accountNumber: "1234567890",
    businessName: "Synthetic Bakery LLC",
    contactName: "Mira",
    deliver: false,
  }
  await assert.rejects(
    () => confirmPsfRequest(actor(), { ...base, routingNumber: "123456789", contactEmail: "mira@example.test", idempotencyKey: "psf-bad-aba" }),
    (error: { code?: string }) => error.code === "routing_number_invalid",
  )
  await assert.rejects(
    () => confirmPsfRequest(actor(), { ...base, routingNumber: "021000021", contactEmail: "other@example.test", idempotencyKey: "psf-email-mismatch" }),
    (error: { code?: string }) => error.code === "recipient_override_required",
  )
  await assert.rejects(
    () => confirmPsfRequest({ ...actor(), role: "rep" }, { ...base, routingNumber: "021000021", contactEmail: "other@example.test", overrideReason: "Merchant asked for a different inbox.", idempotencyKey: "psf-email-rep-denied" }),
    (error: { code?: string }) => error.code === "recipient_override_denied",
  )
  const overridden = await confirmPsfRequest(actor(), {
    ...base,
    routingNumber: "021000021",
    contactEmail: "other@example.test",
    overrideReason: "Merchant asked for a different inbox.",
    idempotencyKey: "psf-email-override",
  })
  assert.equal(overridden.request.state, "pending")
  assert.equal(overridden.request.accountLast4, "7890")
  assert.equal(JSON.stringify(overridden.request).toLowerCase().includes("other@example.test"), false)
  const storedEmail = await getDatabase().prepare<{ contact_email_cipher: string }>("SELECT contact_email_cipher FROM mca_psf_requests WHERE id=?").get(overridden.request.id)
  assert.equal(decryptSensitive(String(storedEmail?.contact_email_cipher), ids.workspace), "other@example.test")
  const audit = await getDatabase().prepare<{ action: string; metadata: string }>("SELECT action, metadata FROM audit_events WHERE workspace_id=? AND action='closing.recipient_overridden' ORDER BY created_at DESC LIMIT 1").get(ids.workspace)
  assert.equal(audit?.action, "closing.recipient_overridden")
  assert.equal(String(audit?.metadata).includes("other@example.test"), false)
  await getDatabase().prepare("DELETE FROM mca_psf_requests WHERE workspace_id=?").run(ids.workspace)
  const matched = await confirmPsfRequest(actor(), {
    ...base,
    routingNumber: "021-000-021",
    contactEmail: "Mira@Example.test",
    idempotencyKey: "psf-email-match",
  })
  assert.equal(matched.request.state, "pending")
  assert.equal(matched.request.offer.revisionId, selectedRevisionId)
  const matchedEmail = await getDatabase().prepare<{ contact_email_cipher: string }>("SELECT contact_email_cipher FROM mca_psf_requests WHERE id=?").get(matched.request.id)
  assert.equal(decryptSensitive(String(matchedEmail?.contact_email_cipher), ids.workspace), "mira@example.test")
})

test("pickHighestMerchantOffer ranks amount desc, then lower factor, then revisionId asc", async () => {
  const { pickHighestMerchantOffer } = await import("../src/lib/mca/offers/rank")
  const tied = [
    { amountCents: 5_000_000, factorRate: 1.35, revisionId: "rev-b" },
    { amountCents: 5_000_000, factorRate: 1.28, revisionId: "rev-a" },
    { amountCents: 4_000_000, factorRate: 1.1, revisionId: "rev-c" },
  ]
  assert.equal(pickHighestMerchantOffer(tied).revisionId, "rev-a")

  const missingFactor = [
    { amountCents: 5_000_000, revisionId: "rev-missing" },
    { amountCents: 5_000_000, factorRate: 1.4, revisionId: "rev-known" },
  ]
  assert.equal(pickHighestMerchantOffer(missingFactor).revisionId, "rev-known")

  const revisionTie = [
    { amountCents: 5_000_000, factorRate: 1.3, revisionId: "rev-z" },
    { amountCents: 5_000_000, factorRate: 1.3, revisionId: "rev-m" },
  ]
  assert.equal(pickHighestMerchantOffer(revisionTie).revisionId, "rev-m")
  assert.throws(() => pickHighestMerchantOffer([]))
})

test("highest merchant preview picks lower factor on equal amount", async () => {
  const worse = await createOffer(actor(), {
    dealId,
    funderName: "Worse Factor Capital",
    externalId: "rank-worse-1",
    terms: { amountCents: 6_000_000, factorRate: 1.4, termMonths: 10, paymentAmountCents: 300000, paymentFrequency: "weekly" },
  })
  const better = await createOffer(actor(), {
    dealId,
    funderName: "Better Factor Capital",
    externalId: "rank-better-1",
    terms: { amountCents: 6_000_000, factorRate: 1.25, termMonths: 10, paymentAmountCents: 300000, paymentFrequency: "weekly" },
  })
  const preview = await previewMerchantOffers(actor(), {
    dealId,
    selectionMode: "highest",
    channel: "email",
    senderId: "merchant-sender",
    recipient: "mira@example.test",
    idempotencyKey: "rank-highest-factor-tie",
  })
  assert.equal(preview.offer.revisionId, better.currentRevisionId)
  assert.match(preview.body, /Better Factor Capital/)
  assert.equal(preview.body.includes("Worse Factor Capital"), false)
  assert.notEqual(worse.currentRevisionId, better.currentRevisionId)
})

test("production gates stay qualified and closing UI renders all four lines", async () => {
  const snapshot = await getClosingSnapshot(actor(), dealId)
  const gates = snapshot.productionGates
  assert.equal(typeof gates.merchantEmail, "string")
  assert.equal(typeof gates.merchantSms, "string")
  assert.equal(typeof gates.contractDelivery, "string")
  assert.equal(typeof gates.psfDelivery, "string")
  for (const copy of [gates.merchantEmail, gates.contractDelivery, gates.psfDelivery]) {
    assert.equal(/\bready\b/i.test(copy), false, `email/PSF gate must not use bare ready: ${copy}`)
    assert.match(copy, /configured|unavailable|available after/i)
  }
  assert.match(gates.merchantEmail, /configured; verify delivery|unavailable: connect merchant email/i)
  assert.match(gates.contractDelivery, /configured; verify delivery|unavailable: connect contract delivery/i)
  assert.match(gates.psfDelivery, /configured|available after an administrator connects/i)

  const source = readFileSync(resolve(process.cwd(), "src/components/mca/closing/closing-panel.tsx"), "utf8")
  assert.match(source, /productionGates\.merchantEmail/)
  assert.match(source, /productionGates\.merchantSms/)
  assert.match(source, /productionGates\.contractDelivery/)
  assert.match(source, /productionGates\.psfDelivery/)
  assert.match(source, /Provider readiness/)
  assert.equal(/\bready\b/i.test(gates.merchantEmail), false)
})