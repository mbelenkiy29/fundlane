import test, { before, after } from "node:test"
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { closeDatabaseForTests, getDatabase } from "../src/lib/mca/db"
import { encryptSensitive } from "../src/lib/mca/crypto"
import type { SubmissionJob, ApprovedSubmissionPackage } from "../src/lib/mca/submissions/contracts"
import { assertBrokerApprovedDelivery } from "../src/lib/mca/submissions/broker-approval"
import { createPostgresTestDatabase } from "./helpers/postgres-test-db.mjs"

let database: Awaited<ReturnType<typeof createPostgresTestDatabase>>
const route = { id: "route", kind: "email" as const, label: "Fixture", destination: "lender@example.test", active: true, documentExceptions: [] }
const approved: ApprovedSubmissionPackage = { route, originalVersions: [], filenames: {}, documents: [] }
const job: SubmissionJob = { id: "job", workspaceId: "t2-workspace", dealId: "deal", funderId: "funder", displayFunderName: "Fixture", routeKind: "email", route, state: "queued", confirmationKey: "preview", attemptKey: "preview", dealVersion: 2, documentVersions: [], packageDocumentIds: [], approvedPackage: approved, preflightErrors: [], merchantIdentityKey: "merchant", packageFingerprint: "", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }

before(async () => {
  database = await createPostgresTestDatabase("t2_broker_gate", { migrateSchema: false })
  Object.assign(process.env, database.env({ MCA_ENCRYPTION_KEY: "0123456789abcdef0123456789abcdef" }))
  await getDatabase().execute(`CREATE TABLE intake_submission_previews (id text, workspace_id text, deal_id text, created_by_user_id text, snapshot_cipher text, fingerprint text, confirmed_at text)`)
})
after(async () => { await closeDatabaseForTests(); await database.close() })
async function preview(overrides: { workspace?: string; deal?: string; confirmed?: string | null; creator?: string | null; approved?: ApprovedSubmissionPackage } = {}) {
  await getDatabase().execute("DELETE FROM intake_submission_previews")
  const snapshot = { dealId: overrides.deal ?? job.dealId, dealVersion: job.dealVersion, destinations: [{ funderId: job.funderId, approved: overrides.approved ?? approved }] }
  const raw = JSON.stringify(snapshot)
  await getDatabase().prepare("INSERT INTO intake_submission_previews VALUES (?,?,?,?,?,?,?)").run("preview", overrides.workspace ?? job.workspaceId, overrides.deal ?? job.dealId, overrides.creator === undefined ? "broker" : overrides.creator, encryptSensitive(raw, job.workspaceId), createHash("sha256").update(raw).digest("hex"), overrides.confirmed === undefined ? "2026-10-01T00:00:00Z" : overrides.confirmed)
}

test("confirmed exact broker preview allows the approved delivery", async () => { await preview(); await assert.doesNotReject(() => assertBrokerApprovedDelivery(job)) })
test("automatic intent is blocked even with a confirmed package", async () => { await preview(); await assert.rejects(() => assertBrokerApprovedDelivery({ ...job, autoSubmitDecisionId: "automatic" }), { code: "broker_approval_required" }) })
test("missing package, missing preview and unconfirmed preview fail closed", async () => {
  await preview(); await assert.rejects(() => assertBrokerApprovedDelivery({ ...job, approvedPackage: undefined }), { code: "broker_approval_required" })
  await getDatabase().execute("DELETE FROM intake_submission_previews"); await assert.rejects(() => assertBrokerApprovedDelivery(job), { code: "broker_approval_required" })
  await preview({ confirmed: null }); await assert.rejects(() => assertBrokerApprovedDelivery(job), { code: "broker_approval_required" })
})
test("cross-tenant, wrong deal and nonhuman preview cannot authorize delivery", async () => {
  for (const override of [{ workspace: "other" }, { deal: "other" }, { creator: null }]) { await preview(override); await assert.rejects(() => assertBrokerApprovedDelivery(job), { code: "broker_approval_required" }) }
})
test("changed route, terms and attachment list invalidate approval", async () => {
  await preview()
  for (const changed of [
    { ...job, route: { ...route, destination: "other@example.test" } },
    { ...job, approvedPackage: { ...approved, documents: [{ documentId: "injected", originalDocumentId: "original", checksum: "changed", byteLength: 1, stage: "original" as const }] } },
    { ...job, dealVersion: 3 },
    { ...job, attemptKey: "resend" },
  ]) await assert.rejects(() => assertBrokerApprovedDelivery(changed), { code: "broker_approval_required" })
})
