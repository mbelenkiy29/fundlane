import "./helpers/business-auth"
import test, { after, before, beforeEach } from "node:test"
import assert from "node:assert/strict"
import { createHmac } from "node:crypto"
import { createPostgresTestDatabase } from "./helpers/postgres-test-db.mjs"
import { closeDatabaseForTests, getDatabase } from "../src/lib/mca/db"
import { createDeal } from "../src/lib/mca/deals/service"
import { createOffer, selectOfferRevision } from "../src/lib/mca/offers/service"
import { acceptOfferForClosing } from "../src/lib/mca/closing/service"
import { recordContractDocuSealWebhook, sendContractWithDocuSeal } from "../src/lib/mca/closing/contract-docuseal-service"
import type { DealActor } from "../src/lib/mca/deals/schema"
import { POST as sendRoute } from "../src/app/api/mca/closing/contracts/[id]/send/route"

let fixture: Awaited<ReturnType<typeof createPostgresTestDatabase>>
const workspaceId = "contract-send-workspace", otherWorkspaceId = "contract-send-other"
const actor = (workspace = workspaceId): DealActor => ({ workspaceId: workspace, userId: "user", membershipId: "member", role: "admin", managedMembershipIds: [], activeMembershipIds: ["member"], source: "user", correlationId: "contract-send-correlation" })
const fieldMap = Object.fromEntries(["merchantLegalName", "signerEmail", "signerName", "funderName", "fundedAmount", "paybackAmount", "factorRate", "paymentFrequency"].map((key) => [key, key]))
const secret = "contract-send-webhook-secret-at-least-32-bytes"
const connection = () => JSON.stringify([{ workspaceId, webhookSecret: secret, bindings: [], apiBaseUrl: "https://docuseal.example.test", apiKey: "synthetic-key", templateId: 42, signerRole: "Merchant", fieldMap }])
let workflowId = "", revisionId = ""

before(async () => {
  fixture = await createPostgresTestDatabase("contract_docuseal_send"); Object.assign(process.env, fixture.env())
  const now = new Date().toISOString()
  const pages = JSON.stringify({ dashboard: true, deals: true, users: true, reports: true, payments: true, workspace: true, integrations: true }), actions = JSON.stringify({ createDeal: true, exportDeals: true, inviteUsers: true, manageApiKeys: true, viewPaymentTable: true, viewCompanyFinancials: true }), flags = JSON.stringify({ reports: true, payments: true, integrations: true })
  await getDatabase().prepare("INSERT INTO users (id,email,password_hash,name,phone,application_identifier,created_at,updated_at) VALUES ('user','contract-send-user@example.test',NULL,'user',NULL,'APP-contract-send-user',?,?)").run(now, now)
  for (const id of [workspaceId, otherWorkspaceId]) {
    await getDatabase().prepare("INSERT INTO workspaces(id,name,timezone,seat_limit,feature_flags,page_visibility,action_visibility,created_at,updated_at) VALUES(?,?,'UTC',5,?,?,?,?,?)").run(id, id, flags, pages, actions, now, now)
  }
  await getDatabase().prepare("INSERT INTO memberships (id,workspace_id,user_id,role,manager_membership_id,status,sender_association,created_at,updated_at) VALUES ('member',?,'user','admin',NULL,'active',NULL,?,?)").run(workspaceId, now, now)
  const deal = await createDeal(actor(), { idempotencyKey: "docuseal-deal", legalName: "Synthetic Merchant LLC", contactName: "Morgan Merchant", contactEmail: "merchant@example.test" })
  const offer = await createOffer(actor(), { dealId: deal.deal.id, funderName: "Synthetic Funder", terms: { amountCents: 1000000, factorRate: 1.25, paymentFrequency: "weekly" } })
  revisionId = offer.currentRevisionId
  await selectOfferRevision(actor(), { dealId: deal.deal.id, offerId: offer.id, revisionId, selected: true })
  const workflow = await acceptOfferForClosing(actor(), { dealId: deal.deal.id, offerId: offer.id, revisionId, idempotencyKey: "docuseal-workflow" })
  workflowId = workflow.id
})
beforeEach(async () => {
  Object.assign(process.env, { MCA_CLOSING_VERIFIED_FLOW_ENABLED: "true", MCA_CLOSING_DOCUSEAL_CONTRACT_ENABLED: "true", MCA_CLOSING_DOCUSEAL_CONTRACT_SEND_ENABLED: "true", MCA_DOCUSEAL_CONTRACT_CONNECTIONS_JSON: connection() })
  await getDatabase().prepare("DELETE FROM mca_closing_deliveries WHERE kind='contract_docuseal'").run()
  await getDatabase().prepare("DELETE FROM audit_events WHERE action='contract.docuseal_completion_received'").run()
  await getDatabase().prepare("UPDATE mca_contract_workflows SET state='contract_requested',contract_sent_at=NULL WHERE id=?").run(workflowId)
})
after(async () => { for (const key of ["MCA_CLOSING_VERIFIED_FLOW_ENABLED", "MCA_CLOSING_DOCUSEAL_CONTRACT_ENABLED", "MCA_CLOSING_DOCUSEAL_CONTRACT_SEND_ENABLED", "MCA_DOCUSEAL_CONTRACT_CONNECTIONS_JSON"]) delete process.env[key]; await closeDatabaseForTests(); await fixture?.close() })

const lookupImpl = async () => [{ address: "203.0.113.20", family: 4 }]
function provider(success = true) {
  let calls = 0
  const fetchImpl = async () => {
    calls++
    if (!success && calls === 2) throw new Error("timeout")
    return calls === 1
      ? new Response(JSON.stringify({ id: 42, submitters: [{ name: "Merchant", uuid: "role-1" }], fields: Object.values(fieldMap).map((name) => ({ name, submitter_uuid: "role-1", type: "text" })) }))
      : new Response(JSON.stringify([{ id: 7, submission_id: 84, status: "sent" }]))
  }
  return { get calls() { return calls }, dependencies: { lookupImpl, fetchImpl: fetchImpl as typeof fetch } }
}

test("send flag defaults off and the route returns 404 without authenticating or calling a provider", async () => {
  delete process.env.MCA_CLOSING_DOCUSEAL_CONTRACT_SEND_ENABLED
  const response = await sendRoute({ headers: { get() { throw new Error("authenticated") } } } as unknown as Request, { params: Promise.resolve({ id: workflowId }) })
  assert.equal(response.status, 404)
})

test("success stores one submission binding, transitions state, and duplicate calls are idempotent", async () => {
  const mock = provider()
  assert.deepEqual(await sendContractWithDocuSeal(actor(), workflowId, { provider: mock.dependencies }), { state: "sent", submissionId: "84", replayed: false })
  assert.deepEqual(await sendContractWithDocuSeal(actor(), workflowId, { provider: mock.dependencies }), { state: "sent", submissionId: "84", replayed: true })
  assert.equal(mock.calls, 2)
  const stored = await getDatabase().prepare<{ state: string; external_id: string }>("SELECT state,external_id FROM mca_closing_deliveries WHERE kind='contract_docuseal'").get()
  assert.deepEqual(stored, { state: "sent", external_id: "84" })
  assert.equal((await getDatabase().prepare<{ state: string }>("SELECT state FROM mca_contract_workflows WHERE id=?").get(workflowId))?.state, "contract_sent")
})

test("unknown outcome is fenced as uncertain and never creates again", async () => {
  const mock = provider(false)
  assert.deepEqual(await sendContractWithDocuSeal(actor(), workflowId, { provider: mock.dependencies }), { state: "delivery_uncertain", replayed: false })
  assert.deepEqual(await sendContractWithDocuSeal(actor(), workflowId, { provider: mock.dependencies }), { state: "delivery_uncertain", replayed: true })
  assert.equal(mock.calls, 2)
})

test("workspace isolation denies another workspace and the webhook resolves the stored binding", async () => {
  await assert.rejects(() => sendContractWithDocuSeal(actor(otherWorkspaceId), workflowId, { connectionJson: connection() }), (error: { code?: string }) => error.code === "docuseal_unconfigured")
  const mock = provider(); await sendContractWithDocuSeal(actor(), workflowId, { provider: mock.dependencies })
  const body = JSON.stringify({ event_type: "submission.completed", data: { id: 84, status: "completed", submitters: [{ status: "completed" }] } })
  const timestamp = Math.floor(Date.now() / 1000), signature = `${timestamp}.${createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex")}`
  assert.deepEqual(await recordContractDocuSealWebhook(workspaceId, body, signature), { state: "received", replayed: false })
  const receipt = await getDatabase().prepare<{ resource_id: string }>("SELECT resource_id FROM audit_events WHERE action='contract.docuseal_completion_received'").get()
  assert.equal(receipt?.resource_id, workflowId)
})
