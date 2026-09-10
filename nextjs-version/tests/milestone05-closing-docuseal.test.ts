import test from "node:test"
import assert from "node:assert/strict"
import { createHash, createHmac } from "node:crypto"
import {
  buildDocuSealPsfSubmissionRequest,
  fetchDocuSealArtifact,
  getVerifiedDocuSealCompletedSubmission,
  reconcileOrCreateDocuSealPsfSubmission,
  verifyDocuSealCompletedWebhook,
  verifyDocuSealTemplateBinding,
  type DocuSealProviderConfig,
  type DocuSealPsfSubmissionInput,
} from "../src/lib/mca/closing/docuseal-provider"

const bindings: DocuSealProviderConfig["fieldBindings"] = {
  amount: { name: "Approved Amount", type: "number" },
  bankName: { name: "Approved Bank Name", type: "text" },
  routingNumber: { name: "Approved Routing Number", type: "text", mask: true },
  accountNumber: { name: "Approved Account Number", type: "text", mask: true },
  businessName: { name: "Approved Business Name", type: "text" },
  contactName: { name: "Approved Contact Name", type: "text" },
  contactEmail: { name: "Approved Contact Email", type: "text" },
}

const config: DocuSealProviderConfig = {
  apiBaseUrl: "https://sign.example.test/api",
  apiToken: "synthetic-api-token",
  webhookSecret: "synthetic-webhook-secret-with-at-least-32-characters",
  templateId: 42,
  signerRole: "Merchant",
  fieldBindings: bindings,
  sendEmail: false,
  requireEmail2fa: true,
  artifactAllowedHosts: ["files.example.test"],
}

const input: DocuSealPsfSubmissionInput = {
  requestId: "psf-request-42",
  workspaceId: "workspace-42",
  dealId: "deal-42",
  offerRevisionId: "revision-42",
  payloadHash: "a".repeat(64),
  signerName: "Mira Merchant",
  signerEmail: "Mira@Example.test",
  amountCents: 4_000_001,
  bankName: "Harbor Bank",
  routingNumber: "021000021",
  accountNumber: "1234567890",
  businessName: "Synthetic Bakery LLC",
  contactName: "Mira Merchant",
  contactEmail: "Mira@Example.test",
}

const publicLookup = async () => [{ address: "93.184.216.34", family: 4 }]

const templatePayload = {
  id: 42,
  archived_at: null,
  submitters: [{ name: "Merchant", uuid: "merchant-role-uuid" }],
  fields: Object.entries(bindings).map(([, binding]) => ({
    name: binding.name,
    type: binding.type,
    submitter_uuid: "merchant-role-uuid",
  })),
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } })
}

function submitter(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 71,
    submission_id: 84,
    external_id: input.requestId,
    email: input.signerEmail.toLowerCase(),
    role: config.signerRole,
    status: "sent",
    slug: "signer-slug",
    embed_src: "https://sign.example.test/s/signer-slug",
    template: { id: config.templateId },
    ...overrides,
  }
}

test("DocuSeal PSF request binds the approved template, signer, and exact immutable fields without auto-signing", () => {
  const body = buildDocuSealPsfSubmissionRequest(config, input)
  assert.equal(body.template_id, 42)
  assert.equal(body.send_email, false)
  assert.equal(body.send_sms, false)
  assert.equal(body.order, "preserved")
  assert.equal(body.submitters.length, 1)
  const signer = body.submitters[0]
  assert.equal(signer.role, "Merchant")
  assert.equal(signer.external_id, "psf-request-42")
  assert.equal(signer.email, "mira@example.test")
  assert.equal(signer.require_email_2fa, true)
  assert.deepEqual(signer.metadata, {
    mca_workspace_id: "workspace-42",
    mca_request_id: "psf-request-42",
    mca_deal_id: "deal-42",
    mca_offer_revision_id: "revision-42",
    mca_payload_hash: "a".repeat(64),
  })
  assert.deepEqual(signer.fields.map((field) => field.name), Object.values(bindings).map((binding) => binding.name))
  assert.equal(signer.fields.every((field) => field.readonly && field.required), true)
  assert.equal(signer.fields[0].default_value, "40000.01")
  assert.equal(signer.fields[2].mask, true)
  assert.equal(signer.fields[3].mask, true)
  assert.equal("completed" in signer, false)
  assert.equal(JSON.stringify(signer.metadata).includes("021000021"), false)
  assert.equal(JSON.stringify(signer.metadata).includes("1234567890"), false)
})

test("DocuSeal reconciliation returns the stable external identity before any template read or create request", async () => {
  const calls: string[] = []
  const result = await reconcileOrCreateDocuSealPsfSubmission(config, input, "never_attempted", {
    lookupImpl: publicLookup,
    fetchImpl: async (request, init) => {
      calls.push(`${init?.method}:${new URL(String(request)).pathname}`)
      assert.equal(new Headers(init?.headers).get("x-auth-token"), config.apiToken)
      return json({ data: [submitter()] })
    },
  })
  assert.deepEqual(result, {
    source: "reconciled",
    submissionId: "84",
    submitterId: "71",
    status: "sent",
    slug: "signer-slug",
    embedSrc: "https://sign.example.test/s/signer-slug",
  })
  assert.deepEqual(calls, ["GET:/api/submitters"])
})

test("DocuSeal creation verifies the live template schema and sends the typed request once", async () => {
  const calls: string[] = []
  const result = await reconcileOrCreateDocuSealPsfSubmission(config, input, "never_attempted", {
    lookupImpl: publicLookup,
    fetchImpl: async (request, init) => {
      const url = new URL(String(request))
      calls.push(`${init?.method}:${url.pathname}`)
      if (url.pathname === "/api/submitters") return json({ data: [] })
      if (url.pathname === "/api/templates/42") return json(templatePayload)
      assert.equal(url.pathname, "/api/submissions")
      assert.equal(init?.method, "POST")
      assert.equal(new Headers(init?.headers).get("content-type"), "application/json")
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>
      assert.equal(body.template_id, 42)
      assert.equal(JSON.stringify(body).includes('"completed"'), false)
      return json([submitter({ template: undefined })])
    },
  })
  assert.equal(result?.source, "created")
  assert.equal(result?.submissionId, "84")
  assert.deepEqual(calls, ["GET:/api/submitters", "GET:/api/templates/42", "POST:/api/submissions"])
})

test("DocuSeal creation fails closed when the approved template field or signer assignment changed", async () => {
  let posts = 0
  await assert.rejects(() => reconcileOrCreateDocuSealPsfSubmission(config, input, "never_attempted", {
    lookupImpl: publicLookup,
    fetchImpl: async (request, init) => {
      const url = new URL(String(request))
      if (url.pathname === "/api/submitters") return json({ data: [] })
      if (url.pathname === "/api/templates/42") {
        return json({ ...templatePayload, fields: templatePayload.fields.map((field, index) => index === 0 ? { ...field, name: "Changed Amount" } : field) })
      }
      if (init?.method === "POST") posts += 1
      return json([])
    },
  }), (error: { code?: string }) => error.code === "docuseal_template_binding_invalid")
  assert.equal(posts, 0)
})

test("DocuSeal response loss is reconciled by external_id without creating a second submission", async () => {
  let listCalls = 0
  let postCalls = 0
  const result = await reconcileOrCreateDocuSealPsfSubmission(config, input, "never_attempted", {
    lookupImpl: publicLookup,
    fetchImpl: async (request, init) => {
      const url = new URL(String(request))
      if (url.pathname === "/api/submitters") return json({ data: ++listCalls === 1 ? [] : [submitter()] })
      if (url.pathname === "/api/templates/42") return json(templatePayload)
      assert.equal(init?.method, "POST")
      postCalls += 1
      throw new TypeError("synthetic connection reset after request write")
    },
  })
  assert.equal(result?.source, "reconciled")
  assert.equal(listCalls, 2)
  assert.equal(postCalls, 1)
})

test("DocuSeal delayed external_id indexing never authorizes a second POST after an unknown attempt", async () => {
  let lookups = 0
  let posts = 0
  const dependencies = {
    lookupImpl: publicLookup,
    fetchImpl: async (request: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(request))
      if (init?.method === "POST") posts += 1
      assert.equal(url.pathname, "/api/submitters")
      lookups += 1
      return json({ data: lookups < 3 ? [] : [submitter()] })
    },
  }
  assert.equal(await reconcileOrCreateDocuSealPsfSubmission(config, input, "reconcile_only", dependencies), undefined)
  assert.equal(await reconcileOrCreateDocuSealPsfSubmission(config, input, "reconcile_only", dependencies), undefined)
  assert.equal((await reconcileOrCreateDocuSealPsfSubmission(config, input, "reconcile_only", dependencies))?.source, "reconciled")
  assert.equal(posts, 0)
  assert.equal(lookups, 3)
})

test("DocuSeal webhook verification uses the exact raw body, official header shape, and all-party completion", () => {
  const nowMs = 1_800_000_000_000
  const timestamp = String(nowMs / 1000)
  const body = JSON.stringify({
    event_type: "submission.completed",
    timestamp: "2027-01-15T08:00:00.000Z",
    data: { id: 84, status: "completed", submitters: [{ id: 71, status: "completed" }] },
  })
  const signature = createHmac("sha256", config.webhookSecret).update(`${timestamp}.${body}`).digest("hex")
  const verified = verifyDocuSealCompletedWebhook(body, `${timestamp}.${signature}`, config.webhookSecret, { nowMs, expectedSubmissionId: "84" })
  assert.equal(verified.eventType, "submission.completed")
  assert.equal(verified.submissionId, "84")
  assert.throws(() => verifyDocuSealCompletedWebhook(`${body} `, `${timestamp}.${signature}`, config.webhookSecret, { nowMs }), (error: { code?: string }) => error.code === "docuseal_signature_invalid")
  assert.throws(() => verifyDocuSealCompletedWebhook(body, `${Number(timestamp) - 301}.${signature}`, config.webhookSecret, { nowMs }), (error: { code?: string }) => error.code === "docuseal_signature_invalid")
  const incomplete = JSON.stringify({ event_type: "submission.completed", data: { id: 84, status: "pending", submitters: [{ status: "awaiting" }] } })
  const incompleteSignature = createHmac("sha256", config.webhookSecret).update(`${timestamp}.${incomplete}`).digest("hex")
  assert.throws(() => verifyDocuSealCompletedWebhook(incomplete, `${timestamp}.${incompleteSignature}`, config.webhookSecret, { nowMs }), (error: { code?: string }) => error.code === "docuseal_submission_incomplete")
})

test("DocuSeal completion is independently verified and remains pending until signed artifacts are durable", async () => {
  const result = await getVerifiedDocuSealCompletedSubmission(config, {
    submissionId: "84",
    requestId: input.requestId,
    signerEmail: input.signerEmail,
    signerRole: config.signerRole,
  }, {
    lookupImpl: publicLookup,
    fetchImpl: async (request, init) => {
      assert.equal(new URL(String(request)).pathname, "/api/submissions/84")
      assert.equal(init?.method, "GET")
      return json({
        id: 84,
        status: "completed",
        completed_at: "2027-01-15T08:00:00.000Z",
        template: { id: 42 },
        submitters: [{ id: 71, external_id: input.requestId, email: input.signerEmail.toLowerCase(), role: config.signerRole, status: "completed" }],
        documents: [{ name: "approved-psf", url: "https://files.example.test/signed.pdf" }],
        audit_log_url: "https://files.example.test/audit.pdf",
        combined_document_url: "https://files.example.test/combined.pdf",
      })
    },
  })
  assert.equal(result.state, "completed_pending_artifact")
  assert.equal(result.submitterId, "71")
  assert.deepEqual(result.documents, [{ kind: "signed_document", name: "approved-psf", url: "https://files.example.test/signed.pdf" }])
  assert.equal(result.auditLog.kind, "audit_log")
  assert.equal(result.combinedDocument?.kind, "combined_document")
})

test("DocuSeal artifact fetch is host-bound, PDF-only, streamed with a hard limit, and checksummed", async () => {
  const pdf = new Uint8Array(Buffer.from("%PDF-1.7\nsynthetic signed document\n%%EOF"))
  const fetched = await fetchDocuSealArtifact(config, "https://files.example.test/signed.pdf", {
    lookupImpl: publicLookup,
    maxArtifactBytes: 100,
    fetchImpl: async (_request, init) => {
      assert.equal(init?.redirect, "error")
      assert.equal(new Headers(init?.headers).get("x-auth-token"), null)
      return new Response(pdf, { status: 200, headers: { "content-type": "application/pdf", "content-length": String(pdf.byteLength) } })
    },
  })
  assert.deepEqual(fetched.bytes, pdf)
  assert.equal(fetched.mimeType, "application/pdf")
  assert.equal(fetched.checksum, createHash("sha256").update(pdf).digest("hex"))

  await assert.rejects(() => fetchDocuSealArtifact(config, "https://evil.example.test/signed.pdf", { lookupImpl: publicLookup, fetchImpl: async () => new Response(pdf) }), (error: { code?: string }) => error.code === "docuseal_artifact_url_denied")
  await assert.rejects(() => fetchDocuSealArtifact(config, "https://files.example.test/signed.pdf", { lookupImpl: async () => [{ address: "127.0.0.1", family: 4 }], fetchImpl: async () => new Response(pdf) }), (error: { code?: string }) => error.code === "docuseal_artifact_url_denied")
  await assert.rejects(() => fetchDocuSealArtifact(config, "https://files.example.test/signed.pdf", { lookupImpl: publicLookup, maxArtifactBytes: 10, fetchImpl: async () => new Response(pdf, { headers: { "content-type": "application/pdf" } }) }), (error: { code?: string }) => error.code === "docuseal_artifact_too_large")
  await assert.rejects(() => fetchDocuSealArtifact(config, "https://files.example.test/signed.pdf", { lookupImpl: publicLookup, fetchImpl: async () => new Response("not a pdf", { headers: { "content-type": "text/plain" } }) }), (error: { code?: string }) => error.code === "docuseal_artifact_type_invalid")
})

test("DocuSeal template validator accepts the exact live role and field schema", async () => {
  let calls = 0
  await verifyDocuSealTemplateBinding(config, {
    lookupImpl: publicLookup,
    fetchImpl: async () => { calls += 1; return json(templatePayload) },
  })
  assert.equal(calls, 1)
})
