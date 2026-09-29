import test, { after, before, beforeEach } from "node:test"
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { createPostgresTestDatabase } from "./helpers/postgres-test-db.mjs"
import { closeDatabaseForTests, getDatabase } from "../src/lib/mca/db"
import { parseContractDocuSealConnections, verifyContractDocuSealCompletion } from "../src/lib/mca/closing/contract-docuseal-service"

const workspaceId = "contract-verify-workspace"
const otherWorkspaceId = "contract-verify-other"
const workflowId = "contract-verify-workflow"
const submissionId = "840"
const secret = "synthetic-contract-webhook-secret-32-bytes-minimum"
let fixture: Awaited<ReturnType<typeof createPostgresTestDatabase>>
let signatureCalls = 0

function connection(workspace = workspaceId, submission = submissionId) {
  return [{ workspaceId: workspace, webhookSecret: secret, apiBaseUrl: "https://docuseal.test", apiKey: "synthetic-api-key", bindings: [{ submissionId: submission, workflowId, offerRevisionId: "revision-one" }] }]
}

before(async () => {
  fixture = await createPostgresTestDatabase("contract_verify")
  Object.assign(process.env, fixture.env())
  const now = new Date().toISOString()
  for (const id of [workspaceId, otherWorkspaceId]) await getDatabase().prepare("INSERT INTO workspaces(id,name,timezone,seat_limit,feature_flags,page_visibility,action_visibility,created_at,updated_at) VALUES(?,?,'UTC',5,'{}','{}','{}',?,?)").run(id, id, now, now)
  await getDatabase().prepare(`INSERT INTO mca_contract_workflows(id,workspace_id,deal_id,offer_id,offer_revision_id,offer_revision_number,funder_name,state,idempotency_key,created_at,updated_at)
    VALUES(?,?, 'synthetic-deal','synthetic-offer','revision-one',1,'Synthetic Funder','contract_sent','synthetic-key',?,?)`).run(workflowId, workspaceId, now, now)
  await getDatabase().prepare(`INSERT INTO audit_events(id,workspace_id,actor_user_id,source,action,resource_type,resource_id,metadata,correlation_id,created_at)
    VALUES('contract-receipt',?,NULL,'system','contract.docuseal_completion_received','mca_contract_workflow',?,?, 'contract-receipt',?)`).run(workspaceId, workflowId, JSON.stringify({ workflowId, submissionId, offerRevisionId: "revision-one" }), now)
})

beforeEach(async () => {
  process.env.MCA_CLOSING_VERIFIED_FLOW_ENABLED = "true"
  process.env.MCA_CLOSING_DOCUSEAL_CONTRACT_ENABLED = "true"
  process.env.MCA_CLOSING_DOCUSEAL_CONTRACT_VERIFY_ENABLED = "true"
  process.env.MCA_DOCUSEAL_CONTRACT_CONNECTIONS_JSON = JSON.stringify(connection())
  signatureCalls = 0
  await getDatabase().prepare("DELETE FROM mca_closing_deliveries WHERE kind='contract_docuseal'").run()
  await getDatabase().prepare("UPDATE mca_contract_workflows SET state='contract_sent',signature_source=NULL,signature_external_id=NULL,signature_evidence_document_id=NULL WHERE id=?").run(workflowId)
  await getDatabase().prepare("DELETE FROM audit_events WHERE action IN ('contract.docuseal_signature_verified','contract.docuseal_verification_failed')").run()
})

after(async () => {
  for (const key of ["MCA_CLOSING_VERIFIED_FLOW_ENABLED", "MCA_CLOSING_DOCUSEAL_CONTRACT_ENABLED", "MCA_CLOSING_DOCUSEAL_CONTRACT_VERIFY_ENABLED", "MCA_DOCUSEAL_CONTRACT_CONNECTIONS_JSON"]) delete process.env[key]
  await closeDatabaseForTests(); await fixture?.close()
})

function dependencies(state: "clean" | "quarantined" = "clean", providerId = submissionId) {
  const pdf = new TextEncoder().encode("%PDF- synthetic")
  let stored = 0
  return {
    fetchImpl: async () => new Response(JSON.stringify({ id: providerId, status: "completed", submitters: [{ status: "completed" }], documents: [{ name: "signed.pdf", url: "https://docuseal.test/signed.pdf" }], audit_log_url: "https://docuseal.test/audit.pdf" }), { status: 200 }),
    provider: { lookupImpl: async () => [{ address: "93.184.216.34", family: 4 }], fetchImpl: async () => new Response(pdf, { status: 200, headers: { "content-type": "application/pdf", "content-length": String(pdf.byteLength) } }) },
    storeDocument: async (_actor: unknown, input: { dealId: string }) => ({ id: `evidence-${++stored}`, dealId: input.dealId, workspaceId, originalFilename: "evidence.pdf", displayFilename: "evidence.pdf", mimeType: "application/pdf" as const, byteLength: pdf.byteLength, checksum: createHash("sha256").update(pdf).digest("hex"), category: "closing_document" as const, version: 1, createdAt: new Date().toISOString(), processingState: state }),
    recordSignature: async (_actor: unknown, input: { externalId: string; evidenceDocumentId: string }) => {
      signatureCalls++
      await getDatabase().prepare("UPDATE mca_contract_workflows SET state='signed',signature_source='external',signature_external_id=?,signature_evidence_document_id=? WHERE workspace_id=? AND id=?").run(input.externalId, input.evidenceDocumentId, workspaceId, workflowId)
      return {} as never
    },
  }
}

test("verification flag off preserves receipt-only external rejection", async () => {
  delete process.env.MCA_CLOSING_DOCUSEAL_CONTRACT_VERIFY_ENABLED
  await assert.rejects(() => verifyContractDocuSealCompletion(workspaceId, submissionId, dependencies()), (error: { code?: string }) => error.code === "contract_signature_provider_unavailable")
  assert.equal(signatureCalls, 0)
})

test("scan-clean evidence signs once and replay is idempotent", async () => {
  const first = await verifyContractDocuSealCompletion(workspaceId, submissionId, dependencies())
  assert.equal(first.replayed, false); assert.equal(signatureCalls, 1)
  const replay = await verifyContractDocuSealCompletion(workspaceId, submissionId, dependencies())
  assert.equal(replay.replayed, true); assert.equal(signatureCalls, 1)
})

test("verification resolves a stored send delivery without a static binding", async () => {
  process.env.MCA_DOCUSEAL_CONTRACT_CONNECTIONS_JSON = JSON.stringify([{ ...connection()[0], bindings: [] }])
  const now = new Date().toISOString()
  await getDatabase().prepare(`INSERT INTO mca_closing_deliveries(id,workspace_id,deal_id,kind,record_id,attempt_key,channel,state,payload_hash,correlation_id,external_id,created_at,updated_at)
    VALUES('stored-send',?,'synthetic-deal','contract_docuseal',?,'revision-one','webhook','sent','synthetic-hash','synthetic-correlation',?,?,?)`).run(workspaceId, workflowId, submissionId, now, now)
  const result = await verifyContractDocuSealCompletion(workspaceId, submissionId, dependencies())
  assert.equal(result.state, "signed")
  assert.equal(signatureCalls, 1)
})

test("connection parser accepts send and verify options together and rejects incomplete or unsafe values", () => {
  const fieldMap = Object.fromEntries(["merchantLegalName", "signerEmail", "signerName", "funderName", "fundedAmount", "paybackAmount", "factorRate", "paymentFrequency"].map((key) => [key, key]))
  const combined = { ...connection()[0], templateId: 42, signerRole: "Merchant", fieldMap, artifactAllowedHosts: ["files.docuseal.test"] }
  assert.deepEqual(parseContractDocuSealConnections(JSON.stringify([combined]))[0].artifactAllowedHosts, ["files.docuseal.test"])
  assert.equal(parseContractDocuSealConnections(JSON.stringify(connection()))[0].templateId, undefined)
  for (const invalid of [
    { ...combined, signerRole: undefined },
    { ...combined, apiBaseUrl: "http://docuseal.test" },
    { ...combined, apiBaseUrl: "https://user@docuseal.test" },
    { ...combined, apiBaseUrl: "https://docuseal.test?" },
    { ...combined, apiBaseUrl: "https://docuseal.test#" },
    { ...combined, unexpected: true },
  ]) assert.throws(() => parseContractDocuSealConnections(JSON.stringify([invalid])), { code: "docuseal_configuration_invalid" })
})

test("malware evidence is audited and never signs", async () => {
  await assert.rejects(() => verifyContractDocuSealCompletion(workspaceId, submissionId, dependencies("quarantined")), (error: { code?: string }) => error.code === "docuseal_artifact_not_clean")
  assert.equal(signatureCalls, 0)
  assert.equal((await getDatabase().prepare<{ state: string }>("SELECT state FROM mca_contract_workflows WHERE id=?").get(workflowId))?.state, "contract_sent")
})

test("submission mismatch and another workspace are refused", async () => {
  await assert.rejects(() => verifyContractDocuSealCompletion(workspaceId, submissionId, dependencies("clean", "841")), (error: { code?: string }) => error.code === "docuseal_submission_binding_invalid")
  process.env.MCA_DOCUSEAL_CONTRACT_CONNECTIONS_JSON = JSON.stringify(connection(otherWorkspaceId))
  await assert.rejects(() => verifyContractDocuSealCompletion(otherWorkspaceId, submissionId, dependencies()), (error: { code?: string }) => ["docuseal_contract_receipt_missing", "docuseal_contract_binding_invalid"].includes(error.code ?? ""))
  assert.equal(signatureCalls, 0)
})
