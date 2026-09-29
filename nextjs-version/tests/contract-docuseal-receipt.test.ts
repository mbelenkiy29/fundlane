import test, { before, after } from "node:test"
import assert from "node:assert/strict"
import { createHmac } from "node:crypto"
import { createPostgresTestDatabase } from "./helpers/postgres-test-db.mjs"
import { closeDatabaseForTests, getDatabase } from "../src/lib/mca/db"
import { parseContractDocuSealConnections } from "../src/lib/mca/closing/contract-docuseal-service"
import { POST } from "../src/app/api/mca/closing/contract/webhook/[workspaceId]/route"

const workspaceId = "contract-receipt-workspace"
const otherWorkspaceId = "contract-receipt-other"
const workflowId = "contract-receipt-workflow"
const secret = "synthetic-contract-webhook-secret-32-bytes-minimum"
const bindings = [{ submissionId: "84", workflowId, offerRevisionId: "revision-one" }]
let fixture: Awaited<ReturnType<typeof createPostgresTestDatabase>>

before(async () => {
  fixture = await createPostgresTestDatabase("contract_receipt")
  Object.assign(process.env, fixture.env())
  const now = new Date().toISOString()
  for (const id of [workspaceId, otherWorkspaceId]) await getDatabase().prepare("INSERT INTO workspaces(id,name,timezone,seat_limit,feature_flags,page_visibility,action_visibility,created_at,updated_at) VALUES(?,?,'UTC',5,'{}','{}','{}',?,?)").run(id, id, now, now)
  await getDatabase().prepare(`INSERT INTO mca_contract_workflows(id,workspace_id,deal_id,offer_id,offer_revision_id,offer_revision_number,funder_name,state,idempotency_key,created_at,updated_at)
    VALUES(?,?, 'synthetic-deal','synthetic-offer','revision-one',1,'Synthetic Funder','contract_sent','synthetic-key',?,?)`).run(workflowId, workspaceId, now, now)
})
after(async () => {
  delete process.env.MCA_CLOSING_VERIFIED_FLOW_ENABLED
  delete process.env.MCA_CLOSING_DOCUSEAL_CONTRACT_ENABLED
  delete process.env.MCA_DOCUSEAL_CONTRACT_CONNECTIONS_JSON
  await closeDatabaseForTests()
  await fixture?.close()
})

function payload(id = 84): string { return JSON.stringify({ event_type: "submission.completed", data: { id, status: "completed", submitters: [{ status: "completed" }] } }) }
function signed(body: string, timestamp = Math.floor(Date.now() / 1000), key = secret): string {
  return `${timestamp}.${createHmac("sha256", key).update(`${timestamp}.${body}`).digest("hex")}`
}
async function post(body = payload(), signature = signed(body), workspace = workspaceId) {
  return POST(new Request(`https://example.test/api/mca/closing/contract/webhook/${workspace}`, { method: "POST", body, headers: { "x-docuseal-signature": signature } }), { params: Promise.resolve({ workspaceId: workspace }) })
}
async function receipts() { return getDatabase().prepare<{ metadata: string }>("SELECT metadata FROM audit_events WHERE action='contract.docuseal_completion_received'").all() }

test("both flags are required before reading the body or writing", async () => {
  process.env.MCA_DOCUSEAL_CONTRACT_CONNECTIONS_JSON = JSON.stringify([{ workspaceId, webhookSecret: secret, bindings }])
  for (const [verified, contract] of [[undefined, "true"], ["true", undefined], ["TRUE", "true"]]) {
    if (verified) process.env.MCA_CLOSING_VERIFIED_FLOW_ENABLED = verified; else delete process.env.MCA_CLOSING_VERIFIED_FLOW_ENABLED
    if (contract) process.env.MCA_CLOSING_DOCUSEAL_CONTRACT_ENABLED = contract; else delete process.env.MCA_CLOSING_DOCUSEAL_CONTRACT_ENABLED
    const response = await POST({ text: () => { throw new Error("body read") } } as unknown as Request, { params: Promise.resolve({ workspaceId }) })
    assert.equal(response.status, 404)
  }
  assert.equal((await receipts()).length, 0)
})

test("authenticated exact binding stores one receipt, replays, and ignores unknown submissions", async () => {
  process.env.MCA_CLOSING_VERIFIED_FLOW_ENABLED = "true"
  process.env.MCA_CLOSING_DOCUSEAL_CONTRACT_ENABLED = "true"
  assert.equal((await post(payload(), signed(payload(), Math.floor(Date.now() / 1000) - 1000))).status, 401)
  assert.equal((await post(payload(), signed(payload(), undefined, "wrong-secret-with-at-least-32-characters"))).status, 401)
  const malformed = "{bad"
  assert.equal((await post(malformed, signed(malformed))).status, 400)
  assert.deepEqual(await (await post()).json(), { state: "received", replayed: false })
  assert.deepEqual(await (await post()).json(), { state: "received", replayed: true })
  assert.deepEqual(await (await post(payload(85))).json(), { state: "ignored" })
  const rows = await receipts()
  assert.equal(rows.length, 1)
  const metadata = JSON.parse(rows[0].metadata)
  assert.equal(metadata.workflowId, workflowId)
  assert.equal(metadata.submissionId, "84")
  assert.equal(typeof metadata.bodyHash, "string")
  assert.equal((await getDatabase().prepare<{ state: string }>("SELECT state FROM mca_contract_workflows WHERE id=?").get(workflowId))?.state, "contract_sent")
})

test("cross-workspace and conflicting bindings fail closed", async () => {
  process.env.MCA_DOCUSEAL_CONTRACT_CONNECTIONS_JSON = JSON.stringify([{ workspaceId: otherWorkspaceId, webhookSecret: secret, bindings }])
  assert.equal((await post()).status, 503)
  process.env.MCA_DOCUSEAL_CONTRACT_CONNECTIONS_JSON = JSON.stringify([{ workspaceId, webhookSecret: secret, bindings: [{ submissionId: "84", workflowId: "different-workflow" }] }])
  assert.equal((await post()).status, 409)
  process.env.MCA_DOCUSEAL_CONTRACT_CONNECTIONS_JSON = JSON.stringify([{ workspaceId, webhookSecret: secret, bindings: [{ submissionId: "84", workflowId }] }])
  assert.deepEqual(await (await post()).json(), { state: "received", replayed: true })
  await getDatabase().prepare("UPDATE audit_events SET resource_id='different-workflow' WHERE action='contract.docuseal_completion_received'").run()
  assert.equal((await post()).status, 409)
  assert.throws(() => parseContractDocuSealConnections(JSON.stringify([{ workspaceId, webhookSecret: secret, bindings }, { workspaceId, webhookSecret: secret, bindings: [] }])))
  assert.throws(() => parseContractDocuSealConnections(JSON.stringify([{ workspaceId, webhookSecret: secret, bindings: [...bindings, ...bindings] }])))
  assert.throws(() => parseContractDocuSealConnections(JSON.stringify([{ workspaceId, webhookSecret: "short", bindings }])))
})
