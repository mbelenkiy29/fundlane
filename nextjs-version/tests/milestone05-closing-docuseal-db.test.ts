import test, { after, before } from "node:test"
import assert from "node:assert/strict"
import { createPostgresTestDatabase } from "./helpers/postgres-test-db.mjs"
import { closeDatabaseForTests, getDatabase, withImmediateTransaction } from "../src/lib/mca/db"
import { encryptSensitive } from "../src/lib/mca/crypto"
import { deliverPsfRequestWithDocuSeal, selectPsfDeliveryProvider } from "../src/lib/mca/closing/psf-docuseal-service"

let fixture: Awaited<ReturnType<typeof createPostgresTestDatabase>>
const workspaceId = "docuseal-db-workspace"
const requestId = "docuseal-db-request"
const dealId = "docuseal-db-deal"
const connection = {
  workspaceId,
  apiBaseUrl: "https://sign.example.test/api",
  apiToken: "synthetic-api-token",
  webhookSecret: "synthetic-webhook-secret-with-at-least-32-characters",
  templateId: 42,
  signerRole: "Merchant",
  fieldBindings: {
    amount: { name: "Approved Amount", type: "number" },
    bankName: { name: "Approved Bank Name", type: "text" },
    routingNumber: { name: "Approved Routing Number", type: "text", mask: true },
    accountNumber: { name: "Approved Account Number", type: "text", mask: true },
    businessName: { name: "Approved Business Name", type: "text" },
    contactName: { name: "Approved Contact Name", type: "text" },
    contactEmail: { name: "Approved Contact Email", type: "text" },
  },
  sendEmail: false,
  requireEmail2fa: true,
  artifactAllowedHosts: ["files.example.test"],
}
const actor = { workspaceId, userId: "admin-user", membershipId: "admin-member", role: "admin" as const, managedMembershipIds: [], activeMembershipIds: ["admin-member"], source: "user" as const, correlationId: "docuseal-db-correlation" }
const publicLookup = async () => [{ address: "93.184.216.34", family: 4 }]
const noAudit = async () => ({}) as never

function json(value: unknown): Response { return new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } }) }

before(async () => {
  fixture = await createPostgresTestDatabase("m05_docuseal")
  Object.assign(process.env, fixture.env())
  const database = getDatabase(), now = new Date().toISOString()
  await database.prepare("INSERT INTO workspaces (id,name,timezone,seat_limit,feature_flags,page_visibility,action_visibility,created_at,updated_at) VALUES (?,?,'America/New_York',5,'{}','{}','{}',?,?)").run(workspaceId, "DocuSeal DB Test", now, now)
  await database.prepare("INSERT INTO mca_psf_config (workspace_id,enabled,visible_to_reps,destination_cipher,signing_secret_cipher,updated_by_user_id,updated_at) VALUES (?,1,0,NULL,NULL,NULL,?)").run(workspaceId, now)
  await database.prepare(`INSERT INTO mca_psf_requests
    (id,workspace_id,deal_id,offer_id,offer_revision_id,offer_revision_number,amount_cents,bank_name_cipher,routing_number_cipher,account_number_cipher,business_name_cipher,contact_name_cipher,contact_email_cipher,payload_version,payload_hash,state,idempotency_key,correlation_id,external_request_id,last_error_code,last_error_message,delivered_at,signed_at,created_by_user_id,created_at,updated_at)
    VALUES (?,?,?,?,?,1,?,?,?,?,?,?,?,1,?,'pending',?,?,NULL,NULL,NULL,NULL,NULL,NULL,?,?)`).run(
    requestId, workspaceId, dealId, "offer-docuseal-db", "revision-docuseal-db", 4_000_001,
    encryptSensitive("Harbor Bank", workspaceId), encryptSensitive("021000021", workspaceId), encryptSensitive("1234567890", workspaceId),
    encryptSensitive("Synthetic Bakery LLC", workspaceId), encryptSensitive("Mira Merchant", workspaceId), encryptSensitive("mira@example.test", workspaceId),
    "a".repeat(64), "docuseal-db-idempotency", "docuseal-db-correlation", now, now,
  )
})

after(async () => { await closeDatabaseForTests(); await fixture.close() })

test("real Postgres reservation and fenced state writes preserve a concurrently reconciled DocuSeal delivery", async () => {
  let postStarted!: () => void
  let releaseFirstLookup!: () => void
  const postSignal = new Promise<void>((resolve) => { postStarted = resolve })
  const firstLookupGate = new Promise<void>((resolve) => { releaseFirstLookup = resolve })
  let firstSubmitterLookups = 0
  const first = deliverPsfRequestWithDocuSeal(actor, requestId, {
    connectionJson: JSON.stringify([connection]),
    audit: noAudit,
    provider: {
      lookupImpl: publicLookup,
      fetchImpl: async (resource, init) => {
        const url = new URL(String(resource))
        if (url.pathname === "/api/templates/42") return json({ id: 42, archived_at: null, submitters: [{ name: "Merchant", uuid: "merchant-role" }], fields: Object.values(connection.fieldBindings).map((binding) => ({ name: binding.name, type: binding.type, submitter_uuid: "merchant-role" })) })
        if (url.pathname === "/api/submissions" && init?.method === "POST") { postStarted(); throw new TypeError("synthetic response loss") }
        firstSubmitterLookups += 1
        if (firstSubmitterLookups === 2) await firstLookupGate
        return json({ data: [] })
      },
    },
  })
  await postSignal
  let secondPosts = 0
  const second = await deliverPsfRequestWithDocuSeal(actor, requestId, {
    connectionJson: JSON.stringify([connection]),
    audit: noAudit,
    provider: {
      lookupImpl: publicLookup,
      fetchImpl: async (resource, init) => {
        if (init?.method === "POST") secondPosts += 1
        assert.equal(new URL(String(resource)).pathname, "/api/submitters")
        return json({ data: [{ id: 71, submission_id: 84, external_id: requestId, email: "mira@example.test", role: "Merchant", status: "sent", template: { id: 42 } }] })
      },
    },
  })
  assert.equal(second.state, "delivered")
  releaseFirstLookup()
  assert.equal((await first).state, "pending_reconciliation")
  assert.equal(secondPosts, 0)
  const requestRow = await getDatabase().prepare<{ state: string; external_request_id: string; last_error_code: string | null }>("SELECT state,external_request_id,last_error_code FROM mca_psf_requests WHERE workspace_id=? AND id=?").get(workspaceId, requestId)
  assert.deepEqual(requestRow, { state: "delivered", external_request_id: "84", last_error_code: null })
  const deliveries = await getDatabase().prepare<{ state: string; external_id: string; error_code: string | null; count: number }>("SELECT state,external_id,error_code,COUNT(*) OVER()::int count FROM mca_closing_deliveries WHERE workspace_id=? AND kind='psf_docuseal' AND record_id=?").all(workspaceId, requestId)
  assert.deepEqual(deliveries, [{ state: "sent", external_id: "84", error_code: null, count: 1 }])
})

test("real delivery history pins provider choice across environment changes and malformed config never falls back", async () => {
  await assert.rejects(() => selectPsfDeliveryProvider(workspaceId, requestId, { connectionJson: "[]" }), (error: { code?: string }) => error.code === "docuseal_unconfigured")
  const now = new Date().toISOString()
  await getDatabase().prepare(`INSERT INTO mca_closing_deliveries
    (id,workspace_id,deal_id,kind,record_id,attempt_key,channel,state,recipient_cipher,payload_hash,correlation_id,external_id,error_code,error_message,created_at,updated_at)
    VALUES ('legacy-provider-pin',?,?, 'psf_request','legacy-psf-request','legacy-attempt','webhook','pending',NULL,?,'legacy-correlation',NULL,NULL,NULL,?,?)`).run(workspaceId, dealId, "b".repeat(64), now, now)
  assert.equal(await selectPsfDeliveryProvider(workspaceId, "legacy-psf-request", { connectionJson: JSON.stringify([connection]) }), "webhook")
  await assert.rejects(() => selectPsfDeliveryProvider(workspaceId, "unreserved-request", { connectionJson: "{broken" }), (error: { code?: string }) => error.code === "docuseal_configuration_invalid")
  await getDatabase().prepare(`INSERT INTO mca_closing_deliveries
    (id,workspace_id,deal_id,kind,record_id,attempt_key,channel,state,recipient_cipher,payload_hash,correlation_id,external_id,error_code,error_message,created_at,updated_at)
    VALUES ('mixed-provider-pin',?,?, 'psf_request',?,'mixed-attempt','webhook','pending',NULL,?,'mixed-correlation',NULL,NULL,NULL,?,?)`).run(workspaceId, dealId, requestId, "a".repeat(64), now, now)
  await assert.rejects(() => selectPsfDeliveryProvider(workspaceId, requestId, { connectionJson: JSON.stringify([connection]) }), (error: { code?: string }) => error.code === "psf_provider_conflict")
})

test("shared provider reservation lock prevents a stale DocuSeal choice from posting after a generic reservation wins", async () => {
  const raceRequestId = "docuseal-provider-race"
  await getDatabase().prepare(`INSERT INTO mca_psf_requests
    (id,workspace_id,deal_id,offer_id,offer_revision_id,offer_revision_number,amount_cents,bank_name_cipher,routing_number_cipher,account_number_cipher,business_name_cipher,contact_name_cipher,contact_email_cipher,payload_version,payload_hash,state,idempotency_key,correlation_id,external_request_id,last_error_code,last_error_message,delivered_at,signed_at,created_by_user_id,created_at,updated_at)
    SELECT ?,workspace_id,deal_id,offer_id,?,offer_revision_number,amount_cents,bank_name_cipher,routing_number_cipher,account_number_cipher,business_name_cipher,contact_name_cipher,contact_email_cipher,payload_version,payload_hash,'pending',?, ?,NULL,NULL,NULL,NULL,NULL,NULL,created_at,updated_at
    FROM mca_psf_requests WHERE workspace_id=? AND id=?`).run(raceRequestId, "revision-provider-race", "idempotency-provider-race", "correlation-provider-race", workspaceId, requestId)
  let lockHeld!: () => void, releaseLock!: () => void
  const held = new Promise<void>((resolve) => { lockHeld = resolve }), release = new Promise<void>((resolve) => { releaseLock = resolve })
  const genericReservation = withImmediateTransaction(async (database) => {
    await database.prepare("SELECT pg_advisory_xact_lock(hashtextextended(?, 0))").get(`${workspaceId}:psf-provider:${raceRequestId}`)
    lockHeld()
    await release
    const now = new Date().toISOString()
    await database.prepare(`INSERT INTO mca_closing_deliveries
      (id,workspace_id,deal_id,kind,record_id,attempt_key,channel,state,recipient_cipher,payload_hash,correlation_id,external_id,error_code,error_message,created_at,updated_at)
      VALUES ('race-generic-reservation',?,?, 'psf_request',?,'race-generic-attempt','webhook','pending',NULL,?,'race-generic-correlation',NULL,NULL,NULL,?,?)`).run(workspaceId, dealId, raceRequestId, "a".repeat(64), now, now)
  })
  await held
  let providerCalls = 0
  const staleDirect = deliverPsfRequestWithDocuSeal(actor, raceRequestId, {
    connectionJson: JSON.stringify([connection]),
    audit: noAudit,
    provider: { lookupImpl: publicLookup, fetchImpl: async () => { providerCalls += 1; return json({ data: [] }) } },
  })
  releaseLock()
  await genericReservation
  await assert.rejects(() => staleDirect, (error: { code?: string }) => error.code === "psf_provider_conflict")
  assert.equal(providerCalls, 0)
  const kinds = await getDatabase().prepare<{ kind: string }>("SELECT kind FROM mca_closing_deliveries WHERE workspace_id=? AND record_id=?").all(workspaceId, raceRequestId)
  assert.deepEqual(kinds, [{ kind: "psf_request" }])
})
