import test, { after, before, beforeEach } from "node:test"
import assert from "node:assert/strict"
import { createHmac } from "node:crypto"
import { createPostgresTestDatabase } from "./helpers/postgres-test-db.mjs"
import { closeDatabaseForTests, getDatabase } from "../src/lib/mca/db"
import { createDeal } from "../src/lib/mca/deals/service"
import type { DealActor } from "../src/lib/mca/deals/schema"
import { createOffer, selectOfferRevision } from "../src/lib/mca/offers/service"
import { setClosingTransportForTests } from "../src/lib/mca/closing/delivery"
import {
  confirmPsfRequest, getClosingSnapshot, getPsfConfiguration, recordPsfWebhook, updatePsfConfiguration,
} from "../src/lib/mca/closing/service"
import { decryptSensitive, hashOpaqueToken } from "../src/lib/mca/crypto"
import { GET as snapshotGet } from "../src/app/api/mca/closing/[dealId]/route"
import { GET as psfConfigGet, PATCH as psfConfigPatch } from "../src/app/api/mca/closing/psf-config/route"
import { POST as psfPost } from "../src/app/api/mca/closing/psf/route"

let fixture: Awaited<ReturnType<typeof createPostgresTestDatabase>>
const ids = { workspace: "mic157-workspace", user: "mic157-user", member: "mic157-member" }
const signingSecret = "psf-signing-secret-at-least-32-characters"
const actor = (): DealActor => ({
  workspaceId: ids.workspace, userId: ids.user, membershipId: ids.member, role: "admin",
  managedMembershipIds: [], activeMembershipIds: [ids.member], source: "user", correlationId: "corr-mic157-admin",
})
const apiActor = (role: DealActor["role"] = null): DealActor => ({
  workspaceId: ids.workspace, userId: null, membershipId: null, role, managedMembershipIds: [],
  activeMembershipIds: [ids.member], source: "api_key", correlationId: "corr-mic157-api",
})
let dealId = "", offerId = "", revisionId = ""

function codeOf(error: unknown): string | undefined {
  return error && typeof error === "object" && "code" in error ? String((error as { code?: string }).code) : undefined
}

async function responseCode(response: Response): Promise<string | undefined> {
  const body = await response.json() as { error?: { code?: string } }
  return body.error?.code
}

const bankInput = () => ({
  dealId, offerId, revisionId, amountCents: 4_000_000, bankName: "Secret Harbor Bank", routingNumber: "021000021",
  accountNumber: "1234567890", businessName: "Synthetic Bakery LLC", contactName: "Mira",
  contactEmail: "mira@example.test",
})

before(async () => {
  fixture = await createPostgresTestDatabase("m05_mic157")
  Object.assign(process.env, fixture.env())
  delete process.env.MCA_DOCUSEAL_PSF_CONNECTIONS_JSON
  const db = getDatabase(), now = new Date().toISOString()
  const pages = JSON.stringify({ dashboard: true, deals: true, users: true, reports: true, payments: true, workspace: true, integrations: true })
  const actions = JSON.stringify({ createDeal: true, exportDeals: true, inviteUsers: true, manageApiKeys: true, viewPaymentTable: true, viewCompanyFinancials: true })
  const flags = JSON.stringify({ reports: true, payments: true, integrations: true })
  await db.prepare("INSERT INTO workspaces (id,name,timezone,seat_limit,feature_flags,page_visibility,action_visibility,created_at,updated_at) VALUES (?,?,'America/New_York',5,?,?,?,?,?)").run(ids.workspace, ids.workspace, flags, pages, actions, now, now)
  await db.prepare("INSERT INTO users (id,email,password_hash,name,phone,application_identifier,created_at,updated_at) VALUES (?,?,NULL,?,NULL,?,?,?)").run(ids.user, `${ids.user}@example.test`, ids.user, `APP-${ids.user}`, now, now)
  await db.prepare("INSERT INTO memberships (id,workspace_id,user_id,role,manager_membership_id,status,sender_association,created_at,updated_at) VALUES (?,?,?,'admin',NULL,'active',NULL,?,?)").run(ids.member, ids.workspace, ids.user, now, now)
  await db.prepare("INSERT INTO sessions (id,user_id,membership_id,token_hash,expires_at,created_at,last_seen_at) VALUES ('mic157-session',?,?,?,'2099-01-01T00:00:00.000Z',?,?)").run(ids.user, ids.member, hashOpaqueToken("mic157-token"), now, now)
  await db.prepare("INSERT INTO api_keys (id,workspace_id,name,prefix,secret_hash,scopes,expires_at,last_used_at,revoked_at,rate_limit_per_minute,created_by,created_at) VALUES ('mic157-read-key',?,'read','mca_test',?,'[\"deals:read\"]',NULL,NULL,NULL,60,?,?)").run(ids.workspace, hashOpaqueToken("mca_read-secret"), ids.user, now)
  await db.prepare("INSERT INTO api_keys (id,workspace_id,name,prefix,secret_hash,scopes,expires_at,last_used_at,revoked_at,rate_limit_per_minute,created_by,created_at) VALUES ('mic157-write-key',?,'write','mca_test',?,'[\"deals:write\"]',NULL,NULL,NULL,60,?,?)").run(ids.workspace, hashOpaqueToken("mca_write-secret"), ids.user, now)
  dealId = (await createDeal(actor(), { idempotencyKey: "mic157-deal", legalName: "Synthetic Bakery LLC", contactName: "Mira", contactEmail: "mira@example.test", contactPhone: "+12125550123" })).deal.id
  const offer = await createOffer(actor(), { dealId, funderName: "Northstar Capital", terms: { amountCents: 4000000, factorRate: 1.25, termMonths: 10, paymentAmountCents: 250000, paymentFrequency: "weekly", commissionCents: 320000 } })
  offerId = offer.id
  revisionId = offer.currentRevisionId
  await selectOfferRevision(actor(), { dealId, offerId, revisionId, selected: true })
})

beforeEach(async () => {
  setClosingTransportForTests()
  await getDatabase().execute("DELETE FROM mca_closing_deliveries")
  await getDatabase().execute("DELETE FROM mca_psf_requests")
  await getDatabase().execute("DELETE FROM mca_psf_config")
  await getDatabase().execute("DELETE FROM audit_events")
})

after(async () => {
  setClosingTransportForTests()
  await closeDatabaseForTests()
  await fixture.close()
})

test("MIC-157 rejects private and loopback PSF destinations", async () => {
  const privateDestinations = [
    "https://127.0.0.1/psf",
    "https://localhost/psf",
    "https://10.0.0.8/psf",
    "https://192.168.1.20/psf",
    "https://169.254.169.254/latest",
    "https://[::1]/psf",
    "https://[fd12:3456:789a:1::1]/psf",
    "https://metadata.google.internal/psf",
  ]
  for (const destination of privateDestinations) {
    await assert.rejects(
      () => updatePsfConfiguration(actor(), { enabled: true, visibleToReps: false, destination, signingSecret }),
      (error: unknown) => codeOf(error) === "psf_destination_private",
    )
  }
  await assert.rejects(
    () => updatePsfConfiguration(actor(), { enabled: true, visibleToReps: false, destination: "http://example.com/psf", signingSecret }),
    (error: unknown) => codeOf(error) === "psf_destination_invalid",
  )
  await assert.rejects(
    () => updatePsfConfiguration(actor(), { enabled: true, visibleToReps: false, destination: "https://user:pass@example.com/psf", signingSecret }),
    (error: unknown) => codeOf(error) === "psf_destination_invalid",
  )
  await assert.rejects(
    () => updatePsfConfiguration(actor(), { enabled: true, visibleToReps: false, destination: "https://example.com:8443/psf", signingSecret }),
    (error: unknown) => codeOf(error) === "psf_destination_invalid",
  )
  assert.equal((await getDatabase().prepare<{ count: number }>("SELECT COUNT(*)::int count FROM mca_psf_config WHERE workspace_id=?").get(ids.workspace))?.count, 0)
})

test("MIC-157 closing snapshot reports persisted PSF webhook readiness", async () => {
  const before = await getClosingSnapshot(actor(), dealId)
  assert.equal(before.psfDeliveryReady, false)
  assert.match(before.productionGates.psfDelivery, /available after an administrator connects/i)
  await updatePsfConfiguration(actor(), { enabled: true, visibleToReps: true, destination: "https://example.com/psf", signingSecret })
  const after = await getClosingSnapshot(actor(), dealId)
  assert.equal(after.psfDeliveryReady, true)
  assert.equal(after.capabilities.psfVisible, true)
  assert.match(after.productionGates.psfDelivery, /webhook is configured/i)
})

test("MIC-157 DocuSeal PSF is not ready until delivery is enabled", async () => {
  const previous = process.env.MCA_DOCUSEAL_PSF_CONNECTIONS_JSON
  process.env.MCA_DOCUSEAL_PSF_CONNECTIONS_JSON = JSON.stringify([{
    workspaceId: ids.workspace,
    apiBaseUrl: "https://sign.example.test/api",
    apiToken: "synthetic-api-token",
    webhookSecret: "synthetic-webhook-secret-with-at-least-32-characters",
    templateId: 42,
    signerRole: "Merchant",
    fieldBindings: {},
    sendEmail: false,
    requireEmail2fa: true,
    artifactAllowedHosts: ["files.example.test"],
  }])
  try {
    const before = await getClosingSnapshot(actor(), dealId)
    assert.equal(before.psfDeliveryReady, false)
    assert.match(before.productionGates.psfDelivery, /enable PSF delivery/i)
    await updatePsfConfiguration(actor(), { enabled: true, visibleToReps: true })
    const after = await getClosingSnapshot(actor(), dealId)
    assert.equal(after.psfDeliveryReady, true)
    assert.match(after.productionGates.psfDelivery, /DocuSeal is configured/i)
  } finally {
    if (previous === undefined) delete process.env.MCA_DOCUSEAL_PSF_CONNECTIONS_JSON
    else process.env.MCA_DOCUSEAL_PSF_CONNECTIONS_JSON = previous
  }
})

test("MIC-157 API keys cannot read PSF records, submit bank details, or configure PSF", async () => {
  await updatePsfConfiguration(actor(), { enabled: true, visibleToReps: true, destination: "https://example.com/psf", signingSecret })
  setClosingTransportForTests({ async deliver(request) { return { state: "sent", correlationId: request.correlationId, externalId: "psf-ext-visible" } } })
  const saved = await confirmPsfRequest(actor(), { ...bankInput(), idempotencyKey: "psf-api-deny", deliver: true, attemptKey: "psf-api-deny-attempt" })
  assert.equal(saved.request.state, "delivered")

  const snapshot = await getClosingSnapshot(apiActor(), dealId)
  assert.equal(snapshot.capabilities.psfVisible, false)
  assert.equal(snapshot.capabilities.psfAdmin, false)
  assert.deepEqual(snapshot.psfRequests, [])
  assert.equal(JSON.stringify(snapshot).includes("Secret Harbor Bank"), false)
  assert.equal(JSON.stringify(snapshot).includes("1234567890"), false)
  assert.equal(JSON.stringify(snapshot).includes("021000021"), false)

  await assert.rejects(() => confirmPsfRequest(apiActor(), { ...bankInput(), idempotencyKey: "psf-api-submit", deliver: true, attemptKey: "psf-api-submit-attempt" }), (error: unknown) => codeOf(error) === "psf_permission_denied")
  await assert.rejects(() => getPsfConfiguration(apiActor()), (error: unknown) => codeOf(error) === "psf_configuration_denied")
  await assert.rejects(() => updatePsfConfiguration(apiActor(), { enabled: true, visibleToReps: true, destination: "https://example.com/psf", signingSecret }), (error: unknown) => codeOf(error) === "psf_configuration_denied")

  const snapshotResponse = await snapshotGet(new Request(`http://localhost/api/mca/closing/${dealId}`, { headers: { authorization: "Bearer mca_read-secret" } }), { params: Promise.resolve({ dealId }) })
  assert.equal(snapshotResponse.status, 200)
  const httpSnapshot = await snapshotResponse.json() as { capabilities: { psfVisible: boolean; psfAdmin: boolean }; psfRequests: unknown[] }
  assert.equal(httpSnapshot.capabilities.psfVisible, false)
  assert.equal(httpSnapshot.capabilities.psfAdmin, false)
  assert.deepEqual(httpSnapshot.psfRequests, [])

  const configGet = await psfConfigGet(new Request("http://localhost/api/mca/closing/psf-config", { headers: { authorization: "Bearer mca_write-secret" } }))
  assert.equal(configGet.status, 403)
  assert.equal(await responseCode(configGet), "session_required")
  const configPatch = await psfConfigPatch(new Request("http://localhost/api/mca/closing/psf-config", { method: "PATCH", headers: { authorization: "Bearer mca_write-secret", "content-type": "application/json" }, body: JSON.stringify({ enabled: true, visibleToReps: true }) }))
  assert.equal(configPatch.status, 403)
  assert.equal(await responseCode(configPatch), "session_required")
  const submit = await psfPost(new Request("http://localhost/api/mca/closing/psf", { method: "POST", headers: { authorization: "Bearer mca_write-secret", "content-type": "application/json" }, body: JSON.stringify({ ...bankInput(), idempotencyKey: "psf-http-api", deliver: true }) }))
  assert.equal(submit.status, 403)
  assert.equal(await responseCode(submit), "session_required")
})

test("MIC-157 failed webhook stays failed, confirmation reuses one external identity, and bank fields stay encrypted and masked", async () => {
  await updatePsfConfiguration(actor(), { enabled: true, visibleToReps: true, destination: "https://example.com/psf", signingSecret })
  setClosingTransportForTests({ async deliver(request) { return { state: "failed", correlationId: request.correlationId, errorCode: "synthetic_failure", errorMessage: "Synthetic provider rejected request." } } })
  const input = { ...bankInput(), idempotencyKey: "psf-1", deliver: true, attemptKey: "psf-attempt-1" }
  const failed = await confirmPsfRequest(actor(), input)
  assert.equal(failed.request.state, "failed")
  assert.equal(failed.request.externalRequestId, undefined)
  assert.equal(failed.request.accountLast4, "7890")
  assert.equal(failed.request.bankNameMasked, "S•••")
  assert.equal(JSON.stringify(failed.request).includes("Secret Harbor Bank"), false)
  assert.equal(JSON.stringify(failed.request).includes("1234567890"), false)
  assert.equal(JSON.stringify(failed.request).includes("021000021"), false)

  const raw = await getDatabase().prepare<Record<string, string>>("SELECT bank_name_cipher,routing_number_cipher,account_number_cipher,business_name_cipher,contact_name_cipher,contact_email_cipher FROM mca_psf_requests WHERE id=?").get(failed.request.id)
  assert.ok(raw)
  const serialized = JSON.stringify(raw)
  assert.equal(serialized.includes("Secret Harbor Bank"), false)
  assert.equal(serialized.includes("021000021"), false)
  assert.equal(serialized.includes("1234567890"), false)
  assert.equal(serialized.includes("Synthetic Bakery LLC"), false)
  assert.equal(raw.bank_name_cipher.startsWith("v1."), true)
  assert.equal(raw.routing_number_cipher.startsWith("v1."), true)
  assert.equal(raw.account_number_cipher.startsWith("v1."), true)
  assert.equal(decryptSensitive(raw.bank_name_cipher, ids.workspace), "Secret Harbor Bank")
  assert.equal(decryptSensitive(raw.routing_number_cipher, ids.workspace), "021000021")
  assert.equal(decryptSensitive(raw.account_number_cipher, ids.workspace), "1234567890")

  const forgedBody = JSON.stringify({ externalRequestId: "forged-request", status: "signed", evidenceId: "should-not-apply" })
  const forgedTimestamp = Math.floor(Date.now() / 1000).toString()
  const forgedSignature = createHmac("sha256", signingSecret).update(`${forgedTimestamp}.${forgedBody}`).digest("hex")
  await assert.rejects(() => recordPsfWebhook(ids.workspace, forgedBody, `${forgedTimestamp}.${forgedSignature}`), (error: unknown) => codeOf(error) === "psf_request_not_found")
  assert.equal((await getDatabase().prepare<{ state: string; external_request_id: string | null }>("SELECT state,external_request_id FROM mca_psf_requests WHERE id=?").get(failed.request.id))?.state, "failed")

  setClosingTransportForTests({ async deliver(request) { return { state: "sent", correlationId: request.correlationId } } })
  const missingAck = await confirmPsfRequest(actor(), { ...input, attemptKey: "psf-attempt-missing-ack" })
  assert.equal(missingAck.request.id, failed.request.id)
  assert.equal(missingAck.request.state, "failed")
  assert.equal(missingAck.request.externalRequestId, undefined)
  assert.equal(missingAck.request.lastErrorCode, "provider_ack_missing")
  assert.equal(missingAck.delivery?.state, "failed")

  setClosingTransportForTests({ async deliver(request) { return { state: "sent", correlationId: request.correlationId, externalId: "psf-request-1" } } })
  const delivered = await confirmPsfRequest(actor(), { ...input, attemptKey: "psf-attempt-2" })
  assert.equal(delivered.request.id, failed.request.id)
  assert.equal(delivered.request.state, "delivered")
  assert.equal(delivered.request.externalRequestId, "psf-request-1")
  const replay = await confirmPsfRequest(actor(), { ...input, attemptKey: "psf-attempt-3" })
  assert.equal(replay.request.id, failed.request.id)
  assert.equal(replay.request.state, "delivered")
  assert.equal(replay.request.externalRequestId, "psf-request-1")
  assert.equal(replay.delivery, undefined)
  const identities = await getDatabase().prepare<{ external_id: string }>("SELECT external_id FROM mca_closing_deliveries WHERE workspace_id=? AND record_id=? AND state='sent'").all(ids.workspace, failed.request.id)
  assert.deepEqual(identities.map((row) => row.external_id), ["psf-request-1"])

  const body = JSON.stringify({ externalRequestId: "psf-request-1", status: "signed", evidenceId: "signature-evidence" })
  const timestamp = Math.floor(Date.now() / 1000).toString()
  const signature = createHmac("sha256", signingSecret).update(`${timestamp}.${body}`).digest("hex")
  const signed = await recordPsfWebhook(ids.workspace, body, `${timestamp}.${signature}`)
  assert.equal(signed.state, "signed")
  assert.deepEqual(await recordPsfWebhook(ids.workspace, body, `${timestamp}.${signature}`), signed)
  assert.equal((await confirmPsfRequest(actor(), { ...input, attemptKey: "psf-after-sign" })).request.state, "signed")

  const audits = await getDatabase().prepare<{ action: string; metadata: string }>("SELECT action, metadata FROM audit_events WHERE workspace_id=?").all(ids.workspace)
  const auditText = JSON.stringify(audits)
  assert.equal(auditText.includes("Secret Harbor Bank"), false)
  assert.equal(auditText.includes("021000021"), false)
  assert.equal(auditText.includes("1234567890"), false)
  assert.equal(auditText.includes(signingSecret), false)
})
