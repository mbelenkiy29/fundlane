import { updateDocumentScan } from "../src/lib/mca/documents/repository"
import test, { after, before, beforeEach } from "node:test"
import assert from "node:assert/strict"
import { closeDatabaseForTests, getDatabase } from "../src/lib/mca/db"
import { createPostgresTestDatabase } from "./helpers/postgres-test-db.mjs"
import { createDeal, getDealForDocument } from "../src/lib/mca/deals/service"
import type { DealActor } from "../src/lib/mca/deals/schema"
import type { DocumentStorage } from "../src/lib/mca/documents/storage"
import { setDocumentStorageForTests } from "../src/lib/mca/documents/storage"
import type { DocumentScanner } from "../src/lib/mca/documents/scanner"
import { setDocumentScannerForTests } from "../src/lib/mca/documents/scanner"
import { storeDocument, renameDocument } from "../src/lib/mca/documents/service"
import { hashOpaqueToken } from "../src/lib/mca/crypto"
import {
  checkCompleteness,
  getCompleteness,
  listReadinessEvents,
  requireCompletenessActor,
  setRequiredStatementMonths,
} from "../src/lib/mca/underwriting/completeness"
import { GET as getDealCompleteness, POST as rerunDealCompleteness } from "../src/app/api/mca/underwriting/completeness/[dealId]/route"

let testDatabase: Awaited<ReturnType<typeof createPostgresTestDatabase>>
delete process.env.MCA_DOCUMENT_SCANNER

const actor = (workspaceId = "workspace-docs"): DealActor => ({
  workspaceId,
  userId: "user-admin",
  membershipId: null,
  role: "admin",
  managedMembershipIds: [],
  activeMembershipIds: [],
  source: "system",
  correlationId: `corr-${workspaceId}`,
})

const memory = new Map<string, Uint8Array>()
const storage: DocumentStorage = {
  name: "test-memory",
  async putImmutable(key, bytes) {
    if (memory.has(key)) throw new Error("duplicate storage key")
    memory.set(key, new Uint8Array(bytes))
  },
  async get(key) {
    const value = memory.get(key)
    if (!value) throw new Error("missing storage key")
    return new Uint8Array(value)
  },
}
const scanner = (status: "clean" | "infected" | "error"): DocumentScanner => ({
  name: `fixture-${status}`,
  async scan() {
    if (status === "clean") return { status, provider: `fixture-${status}`, evidence: { engineVerified: true } }
    if (status === "infected") return { status, provider: `fixture-${status}`, evidence: { signatureDetected: true } }
    return { status, provider: `fixture-${status}`, evidence: { reason: "fixture_error" } }
  },
})

async function addWorkspace(id: string) {
  const now = new Date().toISOString()
  await getDatabase().prepare(`INSERT INTO workspaces (id,name,timezone,seat_limit,feature_flags,page_visibility,action_visibility,created_at,updated_at)
    VALUES (?, ?, 'America/New_York', 5, ?, ?, ?, ?, ?)`).run(
    id,
    id,
    JSON.stringify({ reports: true, payments: true, integrations: true }),
    JSON.stringify({ dashboard: true, deals: true, users: true, reports: true, payments: true, workspace: true, integrations: true }),
    JSON.stringify({ createDeal: true, exportDeals: true, inviteUsers: true, manageApiKeys: true, viewPaymentTable: true, viewCompanyFinancials: true }),
    now,
    now,
  )
  await getDatabase().prepare(`INSERT INTO users (id, email, password_hash, name, phone, application_identifier, created_at, updated_at)
    VALUES (?, ?, NULL, ?, NULL, ?, ?, ?)`).run(`fixture-user-${id}`, `${id}@example.test`, id, `APP-${id}`, now, now)
}

function lookbackMonths(count: number, now = new Date()): string[] {
  const year = now.getUTCFullYear()
  const month = now.getUTCMonth()
  const periods: string[] = []
  for (let offset = count - 1; offset >= 0; offset -= 1) {
    const date = new Date(Date.UTC(year, month - offset, 1))
    periods.push(`${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`)
  }
  return periods
}

function pdf(tag: string): Uint8Array {
  return new Uint8Array(Buffer.from(`%PDF-1.4\n${tag}\n%%EOF\n`))
}

async function upload(dealId: string, input: { key: string; filename: string; category: "statement" | "application" | "api_application"; workspaceId?: string }) {
  return storeDocument(actor(input.workspaceId), {
    dealId,
    idempotencyKey: input.key,
    filename: input.filename,
    mimeType: "application/pdf",
    bytes: pdf(input.key),
    category: input.category,
    source: "test",
  })
}

before(async () => {
  testDatabase = await createPostgresTestDatabase("underwriting_completeness")
  Object.assign(process.env, testDatabase.env())
  setDocumentStorageForTests(storage)
  setDocumentScannerForTests(scanner("clean"))
  await addWorkspace("workspace-docs")
  await addWorkspace("workspace-other")
})

beforeEach(async () => {
  setDocumentScannerForTests(scanner("clean"))
  await setRequiredStatementMonths(actor(), 3)
})

after(async () => {
  setDocumentStorageForTests()
  setDocumentScannerForTests()
  await closeDatabaseForTests()
  await testDatabase.close()
})

test("MIC-164: application with only 2 of 3 statement months is not ready and names the gap", async () => {
  const deal = (await createDeal(actor(), { idempotencyKey: "gap-deal", legalName: "Gap Merchant LLC" })).deal
  const months = lookbackMonths(3)
  await upload(deal.id, { key: "gap-app", filename: "application.pdf", category: "application" })
  await upload(deal.id, { key: "gap-m0", filename: `Bank-${months[0]}-stmt.pdf`, category: "statement" })
  await upload(deal.id, { key: "gap-m1", filename: `Bank-${months[1]}-stmt.pdf`, category: "statement" })

  const result = await checkCompleteness(actor(), deal.id)
  const missingCode = `missing_statement_${months[2]}`
  assert.equal(result.ready, false)
  assert.equal(result.findings.some((finding) => finding.code === missingCode), true)
  assert.equal(result.findings.find((finding) => finding.code === missingCode)?.period, months[2])
  assert.equal(result.findings.some((finding) => finding.code === `missing_statement_${months[0]}`), false)
  assert.equal(result.findings.some((finding) => finding.code === `missing_statement_${months[1]}`), false)
  assert.equal(JSON.parse(result.ruleSnapshot).requiredStatementMonths, 3)
})

test("MIC-164: unchanged rerun keeps version and does not emit another readiness event", async () => {
  const deal = (await createDeal(actor(), { idempotencyKey: "stable-deal", legalName: "Stable Merchant LLC" })).deal
  const months = lookbackMonths(3)
  await upload(deal.id, { key: "stable-app", filename: "application.pdf", category: "application" })
  await upload(deal.id, { key: "stable-m0", filename: `Bank-${months[0]}.pdf`, category: "statement" })
  await upload(deal.id, { key: "stable-m1", filename: `Bank-${months[1]}.pdf`, category: "statement" })

  const first = await checkCompleteness(actor(), deal.id)
  const second = await checkCompleteness(actor(), deal.id)
  assert.equal(second.version, first.version)
  assert.equal(second.checkedAt, first.checkedAt)
  assert.deepEqual(second.findings, first.findings)
  assert.equal((await listReadinessEvents(actor(), deal.id)).length, 1)
})

test("MIC-164: unreadable statement blocks ready", async () => {
  const deal = (await createDeal(actor(), { idempotencyKey: "unread-deal", legalName: "Unread Merchant LLC" })).deal
  const months = lookbackMonths(3)
  await upload(deal.id, { key: "unread-app", filename: "application.pdf", category: "application" })
  await upload(deal.id, { key: "unread-m0", filename: `Bank-${months[0]}.pdf`, category: "statement" })
  await upload(deal.id, { key: "unread-m1", filename: `Bank-${months[1]}.pdf`, category: "statement" })
  await upload(deal.id, { key: "unread-m2", filename: `Bank-${months[2]}.pdf`, category: "statement" })
  setDocumentScannerForTests(scanner("infected"))
  const quarantined = await upload(deal.id, { key: "unread-bad", filename: `Bank-${months[2]}-copy.pdf`, category: "statement" })
  await updateDocumentScan(actor().workspaceId, quarantined.id, "quarantined", "legacy-scanner", {}, new Date().toISOString())

  const result = await checkCompleteness(actor(), deal.id)
  assert.equal(result.ready, false)
  assert.equal(result.findings.some((finding) => finding.code === "unreadable_document" && finding.documentId === quarantined.id), true)
})

test("MIC-164: partial application fields are still ready when required documents satisfy the rules", async () => {
  const deal = (await createDeal(actor(), { idempotencyKey: "partial-deal", legalName: "Partial Merchant LLC" })).deal
  assert.equal((await getDealForDocument(actor(), deal.id)).draftState, "partial")
  const months = lookbackMonths(3)
  await upload(deal.id, { key: "partial-app", filename: "api-application.pdf", category: "api_application" })
  for (const [index, month] of months.entries()) {
    await upload(deal.id, { key: `partial-m${index}`, filename: `Checking-${month}.pdf`, category: "statement" })
  }

  const result = await checkCompleteness(actor(), deal.id)
  assert.equal((await getDealForDocument(actor(), deal.id)).draftState, "partial")
  assert.equal(result.ready, true)
  assert.equal(result.findings.length, 0)
  assert.equal(result.version, 1)
})

test("MIC-164: cross-workspace completeness access is 404", async () => {
  const deal = (await createDeal(actor(), { idempotencyKey: "tenant-deal", legalName: "Tenant Merchant LLC" })).deal
  await assert.rejects(() => checkCompleteness(actor("workspace-other"), deal.id), (error: { code?: string; status?: number }) => error.code === "deal_not_found" && error.status === 404)
  await assert.rejects(() => getCompleteness(actor("workspace-other"), deal.id), (error: { code?: string }) => error.code === "deal_not_found")
  await assert.rejects(() => listReadinessEvents(actor("workspace-other"), deal.id), (error: { code?: string }) => error.code === "deal_not_found")
})

test("MIC-164: unknown period, period mismatch, and MIC-179 checking months", async () => {
  const deal = (await createDeal(actor(), { idempotencyKey: "period-deal", legalName: "Period Merchant LLC" })).deal
  await upload(deal.id, { key: "period-app", filename: "application.pdf", category: "application" })
  const unknown = await upload(deal.id, { key: "period-unknown", filename: "bank-statement.pdf", category: "statement" })
  const mismatched = await upload(deal.id, { key: "period-mismatch", filename: "Bank-2026-08.pdf", category: "statement" })
  await renameDocument(actor(), mismatched.id, "Bank-2026-07.pdf")

  const first = await checkCompleteness(actor(), deal.id)
  assert.equal(first.ready, false)
  assert.equal(first.findings.some((finding) => finding.code === "unknown_statement_period" && finding.documentId === unknown.id), true)
  assert.equal(first.findings.some((finding) => finding.code === "period_mismatch" && finding.documentId === mismatched.id), true)

  const months = lookbackMonths(3)
  const preferred = await upload(deal.id, { key: "period-preferred", filename: "Bank-2019-01.pdf", category: "statement" })
  const savings = await upload(deal.id, { key: "period-savings", filename: `Savings-${months[2]}.pdf`, category: "statement" })
  const now = new Date().toISOString()
  const insertMonth = getDatabase().prepare(`INSERT INTO mca_statement_months
    (id, workspace_id, deal_id, document_id, account_kind, period, deposits, deposit_count,
     average_daily_balance, nsf_count, negative_days, ending_balance, extraction_version,
     corrected, original_extraction, created_at, updated_at)
    VALUES (?, 'workspace-docs', ?, ?, ?, ?, '0', '0', '0', '0', '0', '0', 1, 0, '{}', ?, ?)`)
  await insertMonth.run("month-checking", deal.id, preferred.id, "checking", months[0], now, now)
  await insertMonth.run("month-savings", deal.id, savings.id, "savings", months[2], now, now)

  const withTable = await checkCompleteness(actor(), deal.id)
  assert.equal(withTable.findings.some((finding) => finding.code === `missing_statement_${months[0]}`), false)
  assert.equal(withTable.findings.some((finding) => finding.code === `missing_statement_${months[2]}`), true)
  assert.equal(withTable.version > first.version, true)
  assert.equal((await listReadinessEvents(actor(), deal.id)).length, 2)
})

test("MIC-164: only admins can change required statement months and intake:write is 403", async () => {
  await assert.rejects(
    () => setRequiredStatementMonths({ ...actor(), role: "rep", source: "user" }, 4),
    (error: { code?: string; status?: number }) => error.code === "permission_denied" && error.status === 403,
  )
  const updated = await setRequiredStatementMonths(actor(), 4)
  assert.equal(updated.requiredStatementMonths, 4)

  const now = new Date().toISOString()
  const addKey = async (id: string, secret: string, scopes: string[]) => getDatabase().prepare(`INSERT INTO api_keys
    (id,workspace_id,name,prefix,secret_hash,scopes,expires_at,last_used_at,revoked_at,rate_limit_per_minute,created_by,created_at)
    VALUES (?, 'workspace-docs', ?, 'mca_test', ?, ?, NULL, NULL, NULL, 60, 'fixture-user-workspace-docs', ?)`).run(id, id, hashOpaqueToken(`mca_${secret}`), JSON.stringify(scopes), now)
  await addKey("completeness-intake-key", "intake-secret", ["intake:write"])
  await addKey("completeness-read-key", "read-secret", ["deals:read"])

  const deal = (await createDeal(actor(), { idempotencyKey: "scope-deal", legalName: "Scope Merchant LLC" })).deal
  const request = (secret: string) => new Request(`http://localhost/api/mca/underwriting/completeness/${deal.id}`, { headers: { authorization: `Bearer mca_${secret}` } })
  await assert.rejects(() => requireCompletenessActor(request("intake-secret"), "read"), (error: { code?: string }) => error.code === "scope_required")
  await assert.rejects(() => requireCompletenessActor(request("intake-secret"), "write"), (error: { code?: string }) => error.code === "scope_required")
  assert.equal((await requireCompletenessActor(request("read-secret"), "read")).workspaceId, "workspace-docs")
})

test("MIC-164: deal completeness routes return empty then persist a rerun", async () => {
  const deal = (await createDeal(actor(), { idempotencyKey: "route-deal", legalName: "Route Merchant LLC" })).deal
  const now = new Date().toISOString()
  await getDatabase().prepare(`INSERT INTO api_keys
    (id,workspace_id,name,prefix,secret_hash,scopes,expires_at,last_used_at,revoked_at,rate_limit_per_minute,created_by,created_at)
    VALUES ('completeness-write-key', 'workspace-docs', 'write', 'mca_test', ?, ?, NULL, NULL, NULL, 60, 'fixture-user-workspace-docs', ?)`).run(
    hashOpaqueToken("mca_write-secret"),
    JSON.stringify(["deals:write"]),
    now,
  )
  await getDatabase().prepare(`INSERT INTO api_keys
    (id,workspace_id,name,prefix,secret_hash,scopes,expires_at,last_used_at,revoked_at,rate_limit_per_minute,created_by,created_at)
    VALUES ('completeness-read-key-2', 'workspace-docs', 'read2', 'mca_test', ?, ?, NULL, NULL, NULL, 60, 'fixture-user-workspace-docs', ?)`).run(
    hashOpaqueToken("mca_read-secret-2"),
    JSON.stringify(["deals:read"]),
    now,
  )

  const params = { params: Promise.resolve({ dealId: deal.id }) }
  const empty = await getDealCompleteness(new Request(`http://localhost/api/mca/underwriting/completeness/${deal.id}`, { headers: { authorization: "Bearer mca_read-secret-2" } }), params)
  assert.equal(empty.status, 200)
  const emptyBody = await empty.json() as { result: null }
  assert.equal(emptyBody.result, null)

  const rerun = await rerunDealCompleteness(new Request(`http://localhost/api/mca/underwriting/completeness/${deal.id}`, { method: "POST", headers: { authorization: "Bearer mca_write-secret", origin: "http://localhost" }, body: "{}" }), params)
  assert.equal(rerun.status, 200)
  const rerunBody = await rerun.json() as { ready: boolean; findings: Array<{ code: string }> }
  assert.equal(rerunBody.ready, false)
  assert.equal(rerunBody.findings.some((finding) => finding.code === "missing_application"), true)
})
