import test from "node:test"
import assert from "node:assert/strict"
import { createHmac } from "node:crypto"
import { MAX_PROVIDER_BODY_BYTES, parseProviderPayload, readProviderBody } from "../src/lib/mca/intake/ingress"
import { normalizeProviderPayload, verifyProviderAdmission } from "../src/lib/mca/intake/providers"
import { hashOpaqueToken } from "../src/lib/mca/crypto"
import type { IntegrationRecord } from "../src/lib/mca/intake/repository"

function integration(provider: string): IntegrationRecord {
  return {
    id: "connection", workspaceId: "workspace", provider, displayName: provider,
    formId: "form-1", locationId: "location-1", templateId: "template-1",
    admissionSecretHash: hashOpaqueToken("test-secret"), signingSecret: "test-secret",
    credentialConfigured: false, credentialVersion: 1, mapping: {}, allowedHosts: [],
    senderRules: [], assignmentPool: [], initialStatus: "lead", enabled: true,
    approvalState: "approved", contractKey: "zoho_forms_json_drive_v1",
    createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
  }
}

test("webhook body rejects declared and streamed data above 1 MiB", async () => {
  const oversized = "x".repeat(MAX_PROVIDER_BODY_BYTES + 1)
  await assert.rejects(readProviderBody(new Request("https://example.test/hook", { method: "POST", body: "x", headers: { "content-length": String(oversized.length) } })), { status: 413, code: "provider_payload_too_large" })
  await assert.rejects(readProviderBody(new Request("https://example.test/hook", { method: "POST", body: oversized })), { status: 413, code: "provider_payload_too_large" })
})

test("standard Jotform multipart and urlencoded payloads map rawRequest", async () => {
  const fields = { formID: "form-1", submissionID: "submission-1", rawRequest: JSON.stringify({ legalName: "Example Merchant" }) }
  const form = new FormData()
  for (const [key, value] of Object.entries(fields)) form.set(key, value)
  const multipart = new Request("https://example.test/hook", { method: "POST", body: form })
  const parsed = await parseProviderPayload(multipart, "jotform", await readProviderBody(multipart))
  assert.equal(normalizeProviderPayload("jotform", parsed, integration("jotform")).application.legalName, "Example Merchant")
  const encoded = new Request("https://example.test/hook", { method: "POST", body: new URLSearchParams(fields) })
  const encodedParsed = await parseProviderPayload(encoded, "jotform", await readProviderBody(encoded))
  assert.equal(normalizeProviderPayload("jotform", encodedParsed, integration("jotform")).eventId, "submission-1")
})

test("generic JSON accepts documented flat and nested application fields", () => {
  const base = { formId: "form-1", eventId: "event-1", legalName: "Example Merchant", contactEmail: "merchant@example.test" }
  const flat = normalizeProviderPayload("custom", base, integration("custom"))
  const nested = normalizeProviderPayload("custom", { formId: "form-1", eventId: "event-2", application: { legalName: base.legalName, contactEmail: base.contactEmail } }, integration("custom"))
  assert.equal(flat.application.legalName, nested.application.legalName)
  assert.equal(flat.application.contactEmail, nested.application.contactEmail)
  assert.equal(flat.eventId, "event-1")
  assert.throws(() => normalizeProviderPayload("custom", { ...base, formId: "foreign-form" }, integration("custom")), { code: "provider_binding_mismatch" })
})

test("provider fixtures map documented identity and submitted values", () => {
  const fillout = normalizeProviderPayload("fillout", { formId: "form-1", submissionId: "sub-1", questions: [{ id: "legalName", name: "legalName", type: "ShortAnswer", value: "Fillout Merchant" }] }, integration("fillout"))
  assert.equal(fillout.application.legalName, "Fillout Merchant")
  const ghl = normalizeProviderPayload("highlevel", { location: { id: "location-1" }, webhookId: "hook-1", company_name: "GHL Merchant", email: "owner@example.test" }, integration("highlevel"))
  assert.equal(ghl.application.legalName, "GHL Merchant")
  const zoho = normalizeProviderPayload("zoho", { formId: "form-1", entryId: "entry-1", legalName: "Zoho Merchant" }, integration("zoho"))
  assert.equal(zoho.application.legalName, "Zoho Merchant")
  const zohoCrm = normalizeProviderPayload("zoho", { formId: "form-1", entryId: "crm-record-1", Company: "CRM Merchant", Email: "crm@example.test" }, {
    ...integration("zoho"), mapping: { legalName: "Company", contactEmail: "Email" },
  })
  assert.equal(zohoCrm.application.legalName, "CRM Merchant")
  assert.equal(zohoCrm.application.contactEmail, "crm@example.test")
  const docuseal = normalizeProviderPayload("docuseal", { event_type: "submission.completed", data: { id: 123, template_id: "template-1", submitters: [{ values: [{ field: "legalName", value: "Signed Merchant" }] }] } }, integration("docuseal"))
  assert.equal(docuseal.application.legalName, "Signed Merchant")
  assert.throws(() => normalizeProviderPayload("docuseal", { event_type: "submission.created" }, integration("docuseal")), { status: 202 })
})

test("generic admission uses the stored hash and DocuSeal verifies the signed body", () => {
  verifyProviderAdmission(new Request("https://example.test/hook", { headers: { authorization: "Bearer test-secret" } }), "{}", integration("custom"))
  assert.throws(() => verifyProviderAdmission(new Request("https://example.test/hook", { headers: { authorization: "Bearer wrong" } }), "{}", integration("custom")), { status: 401 })
  const timestamp = String(Math.floor(Date.now() / 1000))
  const raw = '{"event_type":"submission.completed"}'
  const signature = createHmac("sha256", "test-secret").update(`${timestamp}.${raw}`).digest("hex")
  verifyProviderAdmission(new Request("https://example.test/hook", { headers: { "x-docuseal-signature": `${timestamp}.${signature}` } }), raw, integration("docuseal"))
})
