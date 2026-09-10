import test from "node:test"
import assert from "node:assert/strict"
import { createHash, createHmac } from "node:crypto"
import type { DealActor } from "../src/lib/mca/deals/schema"
import {
  deliverPsfRequestWithDocuSeal,
  docuSealPsfConnectionConfigured,
  getDocuSealPsfConnection,
  recordDocuSealPsfWebhook,
  type DocuSealAttemptReservation,
  type DocuSealPsfRecord,
  type DocuSealPsfRepository,
} from "../src/lib/mca/closing/psf-docuseal-service"

const workspaceId = "workspace-docuseal"
const requestId = "psf-request-docuseal"
const submissionId = "84"
const pdf = new Uint8Array(Buffer.from("%PDF-1.7\nsynthetic DocuSeal evidence\n%%EOF"))

const fieldBindings = {
  amount: { name: "Approved Amount", type: "number" },
  bankName: { name: "Approved Bank Name", type: "text" },
  routingNumber: { name: "Approved Routing Number", type: "text", mask: true },
  accountNumber: { name: "Approved Account Number", type: "text", mask: true },
  businessName: { name: "Approved Business Name", type: "text" },
  contactName: { name: "Approved Contact Name", type: "text" },
  contactEmail: { name: "Approved Contact Email", type: "text" },
} as const

const connection = {
  workspaceId,
  apiBaseUrl: "https://sign.example.test/api",
  apiToken: "synthetic-api-token",
  webhookSecret: "synthetic-webhook-secret-with-at-least-32-characters",
  templateId: 42,
  signerRole: "Merchant",
  fieldBindings,
  sendEmail: false,
  requireEmail2fa: true,
  artifactAllowedHosts: ["files.example.test"],
}

const connectionJson = JSON.stringify([connection])
const publicLookup = async () => [{ address: "93.184.216.34", family: 4 }]
const actor: DealActor = { workspaceId, userId: "admin-user", membershipId: "admin-member", role: "admin", managedMembershipIds: [], activeMembershipIds: ["admin-member"], source: "user", correlationId: "correlation-test" }

const templatePayload = {
  id: 42,
  archived_at: null,
  submitters: [{ name: "Merchant", uuid: "merchant-role-uuid" }],
  fields: Object.values(fieldBindings).map((binding) => ({ name: binding.name, type: binding.type, submitter_uuid: "merchant-role-uuid" })),
}

function request(overrides: Partial<DocuSealPsfRecord> = {}): DocuSealPsfRecord {
  return {
    requestId,
    workspaceId,
    dealId: "deal-docuseal",
    offerRevisionId: "offer-revision-docuseal",
    payloadHash: "a".repeat(64),
    signerName: "Mira Merchant",
    signerEmail: "mira@example.test",
    amountCents: 4_000_001,
    bankName: "Harbor Bank",
    routingNumber: "021000021",
    accountNumber: "1234567890",
    businessName: "Synthetic Bakery LLC",
    contactName: "Mira Merchant",
    contactEmail: "mira@example.test",
    state: "pending",
    correlationId: "correlation-test",
    ...overrides,
  }
}

class MemoryRepository implements DocuSealPsfRepository {
  record: DocuSealPsfRecord
  reservation?: DocuSealAttemptReservation
  pendingCodes: string[] = []
  signedAt?: string

  constructor(record = request()) { this.record = record }
  async findRequest(workspace: string, id: string) { return workspace === this.record.workspaceId && id === this.record.requestId ? this.record : undefined }
  async findRequestBySubmission(workspace: string, id: string) { return workspace === this.record.workspaceId && id === this.record.externalRequestId ? this.record : undefined }
  async reserveAttempt() {
    if (this.reservation) return { ...this.reservation, inserted: false }
    this.reservation = { id: "delivery-docuseal", inserted: true, state: "pending" }
    return this.reservation
  }
  async markPending(_request: DocuSealPsfRecord, _reservationId: string, errorCode: string) {
    if (this.record.state === "delivered" || this.record.state === "signed" || this.record.externalRequestId) return
    this.record.state = "pending"
    this.pendingCodes.push(errorCode)
  }
  async markFailed(_request: DocuSealPsfRecord, _reservationId: string, errorCode: string) {
    if (this.record.state === "delivered" || this.record.state === "signed" || this.record.externalRequestId) return
    this.record.state = "failed"
    this.reservation = { ...(this.reservation!), inserted: false, state: "failed", errorCode }
  }
  async markDelivered(_request: DocuSealPsfRecord, _reservationId: string, providerSubmissionId: string) {
    this.record.state = "delivered"
    this.record.externalRequestId = providerSubmissionId
    this.reservation = { ...(this.reservation!), inserted: false, state: "sent", externalId: providerSubmissionId }
  }
  async markCompletionPending(_request: DocuSealPsfRecord, errorCode: string) { this.pendingCodes.push(errorCode) }
  async markSigned(_request: DocuSealPsfRecord, completedAt: string) {
    if (this.record.state === "signed") return false
    this.record.state = "signed"
    this.signedAt = completedAt
    return true
  }
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } })
}

function submitter() {
  return { id: 71, submission_id: 84, external_id: requestId, email: "mira@example.test", role: "Merchant", status: "sent", template: { id: 42 } }
}

function signedWebhook(): { body: string; signature: string } {
  const timestamp = String(Math.floor(Date.now() / 1000))
  const body = JSON.stringify({ event_type: "submission.completed", timestamp: new Date().toISOString(), data: { id: 84, status: "completed", submitters: [{ id: 71, status: "completed" }] } })
  const signature = createHmac("sha256", connection.webhookSecret).update(`${timestamp}.${body}`).digest("hex")
  return { body, signature: `${timestamp}.${signature}` }
}

function completedSubmission() {
  return {
    id: 84,
    status: "completed",
    completed_at: "2027-01-15T08:00:00.000Z",
    template: { id: 42 },
    submitters: [{ id: 71, external_id: requestId, email: "mira@example.test", role: "Merchant", status: "completed" }],
    documents: [{ name: "signed-psf.pdf", url: "https://files.example.test/signed.pdf" }],
    audit_log_url: "https://files.example.test/audit.pdf",
  }
}

const noAudit = async () => ({}) as never

test("DocuSeal PSF environment selection is exact per workspace and fails closed on duplicate or incomplete bindings", () => {
  assert.equal(docuSealPsfConnectionConfigured(workspaceId, connectionJson), true)
  assert.equal(getDocuSealPsfConnection(workspaceId, connectionJson).templateId, 42)
  assert.equal(docuSealPsfConnectionConfigured("another-workspace", connectionJson), false)
  assert.equal(docuSealPsfConnectionConfigured(workspaceId, JSON.stringify([connection, connection])), false)
  assert.equal(docuSealPsfConnectionConfigured(workspaceId, JSON.stringify([{ ...connection, apiToken: "" }])), false)
})

test("durable reservation permits one DocuSeal POST and every unknown retry is reconciliation-only", async () => {
  const repository = new MemoryRepository()
  let posts = 0
  let submitterLookups = 0
  const fetchImpl = async (resource: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(resource))
    if (url.pathname === "/api/submitters") { submitterLookups += 1; return json({ data: [] }) }
    if (url.pathname === "/api/templates/42") return json(templatePayload)
    assert.equal(url.pathname, "/api/submissions")
    assert.equal(init?.method, "POST")
    posts += 1
    throw new TypeError("synthetic response loss")
  }
  const first = await deliverPsfRequestWithDocuSeal(actor, requestId, { repository, connectionJson, provider: { lookupImpl: publicLookup, fetchImpl }, audit: noAudit })
  const second = await deliverPsfRequestWithDocuSeal(actor, requestId, { repository, connectionJson, provider: { lookupImpl: publicLookup, fetchImpl }, audit: noAudit })
  assert.equal(first.state, "pending_reconciliation")
  assert.equal(second.state, "pending_reconciliation")
  assert.equal(posts, 1)
  assert.equal(submitterLookups, 3)
  assert.deepEqual(repository.pendingCodes, ["docuseal_outcome_unknown", "docuseal_outcome_unknown"])
})

test("DocuSeal dispatch stores a stable provider identity and replays the durable delivery without another request", async () => {
  const repository = new MemoryRepository()
  let posts = 0
  const fetchImpl = async (resource: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(resource))
    if (url.pathname === "/api/submitters") return json({ data: [] })
    if (url.pathname === "/api/templates/42") return json(templatePayload)
    posts += 1
    assert.equal(init?.method, "POST")
    return json([submitter()])
  }
  const first = await deliverPsfRequestWithDocuSeal(actor, requestId, { repository, connectionJson, provider: { lookupImpl: publicLookup, fetchImpl }, audit: noAudit })
  const replay = await deliverPsfRequestWithDocuSeal(actor, requestId, { repository, connectionJson, provider: { lookupImpl: publicLookup, fetchImpl }, audit: noAudit })
  assert.deepEqual(first, { state: "delivered", requestId, submissionId, submitterId: "71", reconciled: false })
  assert.equal(replay.state, "delivered")
  assert.equal(posts, 1)
  assert.equal(repository.record.externalRequestId, submissionId)
})

test("a delayed unknown result cannot regress a request that another worker already delivered", async () => {
  const repository = new MemoryRepository()
  let lookupCount = 0
  const result = await deliverPsfRequestWithDocuSeal(actor, requestId, {
    repository,
    connectionJson,
    provider: {
      lookupImpl: publicLookup,
      fetchImpl: async (resource, init) => {
        const url = new URL(String(resource))
        if (url.pathname === "/api/templates/42") return json(templatePayload)
        if (url.pathname === "/api/submissions" && init?.method === "POST") throw new TypeError("synthetic response loss")
        lookupCount += 1
        if (lookupCount === 2) await repository.markDelivered(repository.record, "delivery-docuseal", submissionId)
        return json({ data: [] })
      },
    },
    audit: noAudit,
  })
  assert.equal(result.state, "pending_reconciliation")
  assert.equal(repository.record.state, "delivered")
  assert.equal(repository.record.externalRequestId, submissionId)
})

test("verified completion persists scan-clean signed and audit artifacts, resumes partial failure, and signs only after both", async () => {
  const repository = new MemoryRepository(request({ state: "delivered", externalRequestId: submissionId }))
  const stored = new Map<string, { id: string; checksum: string; processingState: "clean" }>()
  let signedFetches = 0
  let auditFetches = 0
  let providerReads = 0
  const fetchImpl = async (resource: RequestInfo | URL) => {
    const url = new URL(String(resource))
    if (url.pathname === "/api/submissions/84") { providerReads += 1; return json(completedSubmission()) }
    if (url.pathname === "/signed.pdf") { signedFetches += 1; return new Response(pdf, { headers: { "content-type": "application/pdf" } }) }
    auditFetches += 1
    if (auditFetches === 1) throw new TypeError("synthetic temporary artifact failure")
    return new Response(pdf, { headers: { "content-type": "application/pdf" } })
  }
  const dependencies = {
    repository,
    connectionJson,
    provider: { lookupImpl: publicLookup, fetchImpl },
    storeDocument: async (_systemActor: DealActor, input: Parameters<typeof import("../src/lib/mca/documents/service").storeDocument>[1]) => {
      assert.equal(_systemActor.source, "system")
      assert.equal(_systemActor.workspaceId, workspaceId)
      const checksum = createHash("sha256").update(input.bytes).digest("hex")
      const replay = stored.get(input.idempotencyKey)
      if (replay) assert.equal(replay.checksum, checksum)
      const document = replay ?? { id: `document-${stored.size + 1}`, checksum, processingState: "clean" as const }
      if (!replay) stored.set(input.idempotencyKey, document)
      return { ...document, dealId: input.dealId, workspaceId, originalFilename: input.filename, displayFilename: input.filename, mimeType: input.mimeType, byteLength: input.bytes.byteLength, category: input.category, version: 1, createdAt: new Date().toISOString() }
    },
    listStoredEvidence: async () => [
      { id: "document-1", source: "docuseal_signed_psf", sourceReference: `docuseal:${submissionId}:signed:0`, processingState: "clean" },
      { id: "document-2", source: "docuseal_audit_log", sourceReference: `docuseal:${submissionId}:audit`, processingState: "clean" },
    ],
    audit: noAudit,
  }
  const webhook = signedWebhook()
  await assert.rejects(() => recordDocuSealPsfWebhook(workspaceId, webhook.body, webhook.signature, dependencies), (error: { code?: string }) => error.code === "docuseal_artifact_unavailable")
  assert.equal(repository.record.state, "delivered")
  assert.equal(stored.size, 1)
  const completed = await recordDocuSealPsfWebhook(workspaceId, webhook.body, webhook.signature, dependencies)
  assert.equal(completed.state, "signed")
  assert.equal(completed.signedDocumentIds.length, 1)
  assert.ok(completed.auditDocumentId)
  assert.equal(repository.signedAt, "2027-01-15T08:00:00.000Z")
  assert.equal(signedFetches, 2)
  assert.equal(auditFetches, 2)
  assert.equal(providerReads, 2)
  const replay = await recordDocuSealPsfWebhook(workspaceId, webhook.body, webhook.signature, dependencies)
  assert.equal(replay.replayed, true)
  assert.deepEqual(replay.signedDocumentIds, ["document-1"])
  assert.equal(replay.auditDocumentId, "document-2")
  assert.equal(providerReads, 2)
})

test("a stored but non-clean DocuSeal artifact leaves the PSF delivered and records the evidence gate", async () => {
  const repository = new MemoryRepository(request({ state: "delivered", externalRequestId: submissionId }))
  const webhook = signedWebhook()
  await assert.rejects(() => recordDocuSealPsfWebhook(workspaceId, webhook.body, webhook.signature, {
    repository,
    connectionJson,
    provider: {
      lookupImpl: publicLookup,
      fetchImpl: async (resource) => new URL(String(resource)).pathname === "/api/submissions/84"
        ? json(completedSubmission())
        : new Response(pdf, { headers: { "content-type": "application/pdf" } }),
    },
    storeDocument: async (_systemActor, input) => ({ id: "quarantined-document", dealId: input.dealId, workspaceId, originalFilename: input.filename, displayFilename: input.filename, mimeType: input.mimeType, byteLength: input.bytes.byteLength, checksum: createHash("sha256").update(input.bytes).digest("hex"), category: input.category, version: 1, createdAt: new Date().toISOString(), processingState: "quarantined" }),
    audit: noAudit,
  }), (error: { code?: string }) => error.code === "docuseal_artifact_not_clean")
  assert.equal(repository.record.state, "delivered")
  assert.equal(repository.signedAt, undefined)
  assert.equal(repository.pendingCodes.at(-1), "docuseal_artifact_not_clean")
})
