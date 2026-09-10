import test, { after, before, beforeEach } from "node:test"
import assert from "node:assert/strict"
import { closeDatabaseForTests, getDatabase } from "../src/lib/mca/db"
import { createPostgresTestDatabase } from "./helpers/postgres-test-db.mjs"
import { createDeal } from "../src/lib/mca/deals/service"
import type { DealActor } from "../src/lib/mca/deals/schema"
import type { DocumentStorage } from "../src/lib/mca/documents/storage"
import { setDocumentStorageForTests } from "../src/lib/mca/documents/storage"
import type { DocumentScanner } from "../src/lib/mca/documents/scanner"
import { setDocumentScannerForTests } from "../src/lib/mca/documents/scanner"
import { storeDocument } from "../src/lib/mca/documents/service"
import { hashOpaqueToken } from "../src/lib/mca/crypto"
import type { MetricEvidence, StatementAccountKind } from "../src/lib/mca/underwriting/contracts"
import type { StatementExtraction, StatementExtractionProvider } from "../src/lib/mca/underwriting/statement-extraction"
import {
  analyzeDealStatements,
  getUnderwritingAggregate,
  listStatementMonths,
  setStatementExtractionProviderForTests,
} from "../src/lib/mca/underwriting/statements"
import {
  analyzeDealStatementsForCorrections,
  correctExistingPosition,
  correctStatementMonth,
  getDealCorrections,
} from "../src/lib/mca/underwriting/corrections"
import { GET as listCorrections } from "../src/app/api/mca/underwriting/corrections/route"
import { GET as getCorrections, POST as postCorrection } from "../src/app/api/mca/underwriting/corrections/[dealId]/route"
import { POST as analyzeCorrections } from "../src/app/api/mca/underwriting/corrections/[dealId]/analyze/route"

let testDatabase: Awaited<ReturnType<typeof createPostgresTestDatabase>>
delete process.env.MCA_DOCUMENT_SCANNER
delete process.env.MCA_DOCUMENT_AI_PROVIDER
delete process.env.OPENAI_API_KEY
delete process.env.MCA_DOCUMENT_AI_MODEL

const actor = (workspaceId = "workspace-corrections"): DealActor => ({
  workspaceId,
  userId: "user-corrections",
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
    return status === "clean"
      ? { status, provider: `fixture-${status}`, evidence: { engineVerified: true } }
      : status === "infected"
        ? { status, provider: `fixture-${status}`, evidence: { signatureDetected: true } }
        : { status, provider: `fixture-${status}`, evidence: { reason: "fixture_error" } }
  },
})

function known(value: number, text: string): MetricEvidence {
  return { value, unknown: false, page: 1, text, confidence: 0.95 }
}

function extraction(input: {
  accountKind?: StatementAccountKind
  period?: string
  accountSuffix?: string
  deposits?: MetricEvidence
  depositCount?: MetricEvidence
  averageDailyBalance?: MetricEvidence
  nsfCount?: MetricEvidence
  negativeDays?: MetricEvidence
  endingBalance?: MetricEvidence
  positions?: StatementExtraction["positions"]
}): StatementExtraction {
  return {
    accountKind: input.accountKind ?? "checking",
    period: input.period ?? "2026-08",
    accountSuffix: input.accountSuffix ?? "6789",
    deposits: input.deposits ?? known(10_000, "Total deposits 10000"),
    depositCount: input.depositCount ?? known(12, "12 deposits"),
    averageDailyBalance: input.averageDailyBalance ?? known(4_000, "ADB 4000"),
    nsfCount: input.nsfCount ?? known(1, "1 NSF"),
    negativeDays: input.negativeDays ?? known(2, "2 negative days"),
    endingBalance: input.endingBalance ?? known(3_500, "Ending 3500"),
    positions: input.positions ?? [{ label: "Rapid Capital", estimatedPayment: 1_200, evidence: "ACH Rapid Capital 1200" }],
    warnings: [],
    provider: "fixture-corrections",
    requestId: "correction-fixture",
  }
}

const extractions = new Map<string, StatementExtraction>()
const extractCalls: string[] = []
const provider: StatementExtractionProvider = {
  name: "fixture-corrections",
  async extractStatement(_actor, input) {
    extractCalls.push(input.filename)
    const result = extractions.get(input.filename)
    if (!result) throw new Error(`missing statement fixture for ${input.filename}`)
    return result
  },
}

async function addWorkspace(id: string) {
  const now = new Date().toISOString()
  await getDatabase().prepare(`INSERT INTO workspaces (id,name,timezone,seat_limit,feature_flags,page_visibility,action_visibility,created_at,updated_at)
    VALUES (?, ?, 'America/New_York', 5, ?, ?, ?, ?, ?)`).run(
    id, id,
    JSON.stringify({ reports: true, payments: true, integrations: true }),
    JSON.stringify({ dashboard: true, deals: true, users: true, reports: true, payments: true, workspace: true, integrations: true }),
    JSON.stringify({ createDeal: true, exportDeals: true, inviteUsers: true, manageApiKeys: true, viewPaymentTable: true, viewCompanyFinancials: true }),
    now, now,
  )
  await getDatabase().prepare(`INSERT INTO users (id, email, password_hash, name, phone, application_identifier, created_at, updated_at)
    VALUES (?, ?, NULL, ?, NULL, ?, ?, ?)`).run(`fixture-user-${id}`, `${id}@example.test`, id, `APP-${id}`, now, now)
}

function pdf(marker: string) {
  return new Uint8Array(Buffer.from(`%PDF-1.4\n${marker}\n%%EOF\n`))
}

async function uploadStatement(dealActor: DealActor, dealId: string, filename: string, key: string, result: StatementExtraction) {
  extractions.set(filename, result)
  setDocumentScannerForTests(scanner("clean"))
  return storeDocument(dealActor, {
    dealId, idempotencyKey: key, filename, mimeType: "application/pdf", bytes: pdf(key), category: "statement", source: "test",
  })
}

before(async () => {
  testDatabase = await createPostgresTestDatabase("underwriting_corrections")
  Object.assign(process.env, testDatabase.env())
  setDocumentStorageForTests(storage)
  setDocumentScannerForTests(scanner("clean"))
  setStatementExtractionProviderForTests(provider)
  await addWorkspace("workspace-corrections")
  await addWorkspace("workspace-other")
})
beforeEach(() => {
  extractions.clear()
  extractCalls.length = 0
  setStatementExtractionProviderForTests(provider)
  setDocumentScannerForTests(scanner("clean"))
})
after(async () => {
  setDocumentStorageForTests()
  setDocumentScannerForTests()
  setStatementExtractionProviderForTests()
  await closeDatabaseForTests()
  await testDatabase.close()
})

test("MIC-172 changing one monthly revenue recalculates the aggregate and sets stale", async () => {
  const deal = (await createDeal(actor(), { idempotencyKey: "rev-deal", legalName: "Revenue Correction LLC" })).deal
  await uploadStatement(actor(), deal.id, "jul.pdf", "rev-jul", extraction({
    period: "2026-07", accountSuffix: "1111", deposits: known(10_000, "10000"), nsfCount: known(1, "1"), negativeDays: known(1, "1"), positions: [],
  }))
  await uploadStatement(actor(), deal.id, "aug.pdf", "rev-aug", extraction({
    period: "2026-08", accountSuffix: "1111", deposits: known(8_000, "8000"), nsfCount: known(1, "1"), negativeDays: known(1, "1"), positions: [],
  }))
  const analyzed = await analyzeDealStatements(actor(), deal.id)
  assert.equal(analyzed.aggregate.monthlyRevenue.value, 9_000)
  assert.equal(analyzed.aggregate.stale, false)
  const july = analyzed.months.find((month) => month.period === "2026-07")
  assert.ok(july)

  const corrected = await correctStatementMonth(actor(), {
    dealId: deal.id,
    monthId: july.id,
    reason: "Bank confirmed July deposits exclude a same-day reverse.",
    deposits: 14_000,
  })
  assert.equal(corrected.month.corrected, true)
  assert.equal(corrected.month.deposits.value, 14_000)
  assert.equal(corrected.month.deposits.unknown, false)
  assert.equal(corrected.month.correctionReason, "Bank confirmed July deposits exclude a same-day reverse.")
  assert.equal(corrected.month.correctedByUserId, "user-corrections")
  assert.ok(corrected.month.correctedAt)
  assert.equal(corrected.month.original.deposits.value, 10_000)
  assert.equal(corrected.aggregate.monthlyRevenue.value, 11_000)
  assert.equal(corrected.aggregate.stale, true)
  assert.equal(corrected.aggregate.nsfCount.value, 2)

  const listed = await listStatementMonths(actor(), deal.id)
  const storedJuly = listed.find((month) => month.id === july.id)
  assert.equal(storedJuly?.deposits.value, 14_000)
  assert.equal(storedJuly?.corrected, true)
  assert.equal((await getUnderwritingAggregate(actor(), deal.id))?.stale, true)
  assert.equal((await getUnderwritingAggregate(actor(), deal.id))?.monthlyRevenue.value, 11_000)

  const view = await getDealCorrections(actor(), deal.id)
  assert.equal(view.months.find((month) => month.id === july.id)?.original.deposits.value, 10_000)
  assert.equal(view.aggregate?.stale, true)
})

test("MIC-172 concurrent disjoint month corrections preserve both changes", async () => {
  const deal = (await createDeal(actor(), { idempotencyKey: "parallel-corrections", legalName: "Parallel Corrections LLC" })).deal
  await uploadStatement(actor(), deal.id, "parallel-corrections.pdf", "parallel-corrections-aug", extraction({
    deposits: known(10_000, "10000"),
    nsfCount: known(1, "1"),
    positions: [],
  }))
  const analyzed = await analyzeDealStatements(actor(), deal.id)
  const month = analyzed.months[0]
  assert.ok(month)

  await Promise.all([
    correctStatementMonth(actor(), {
      dealId: deal.id,
      monthId: month.id,
      reason: "Bank portal confirmed deposits.",
      deposits: 14_000,
    }),
    correctStatementMonth(actor(), {
      dealId: deal.id,
      monthId: month.id,
      reason: "Bank portal confirmed NSF count.",
      nsfCount: 3,
    }),
  ])

  const result = await getDealCorrections(actor(), deal.id)
  const corrected = result.months.find((candidate) => candidate.id === month.id)
  assert.ok(corrected)
  assert.equal(corrected.deposits.value, 14_000)
  assert.equal(corrected.nsfCount.value, 3)
  assert.equal(result.aggregate?.monthlyRevenue.value, 14_000)
  assert.equal(result.aggregate?.nsfCount.value, 3)
  assert.equal(result.aggregate?.stale, true)
})

test("MIC-172 concurrent analyze cannot silently overwrite a reviewed correction unless replaceReviewed", async () => {
  const deal = (await createDeal(actor(), { idempotencyKey: "race-deal", legalName: "Race Merchant LLC" })).deal
  await uploadStatement(actor(), deal.id, "harbor-aug.pdf", "race-aug", extraction({
    deposits: known(10_000, "10000"), positions: [],
  }))
  const first = await analyzeDealStatements(actor(), deal.id)
  const month = first.months[0]
  assert.ok(month)
  await correctStatementMonth(actor(), {
    dealId: deal.id,
    monthId: month.id,
    reason: "Underwriter verified deposits from the bank portal.",
    deposits: 15_000,
  })

  extractions.set("harbor-aug.pdf", extraction({ deposits: known(99_999, "ai rerun"), positions: [] }))
  await uploadStatement(actor(), deal.id, "harbor-sep.pdf", "race-sep", extraction({
    period: "2026-09", accountSuffix: "6789", deposits: known(7_000, "7000"), nsfCount: known(0, "0"), negativeDays: known(0, "0"), positions: [],
  }))
  const concurrent = await analyzeDealStatements(actor(), deal.id)
  const preserved = concurrent.months.find((item) => item.id === month.id)
  assert.ok(preserved)
  assert.equal(preserved.deposits.value, 15_000)
  assert.equal(preserved.corrected, true)
  assert.equal(preserved.correctionReason, "Underwriter verified deposits from the bank portal.")
  assert.equal((await getDealCorrections(actor(), deal.id)).months.find((item) => item.id === month.id)?.original.deposits.value, 10_000)

  extractions.set("harbor-aug.pdf", extraction({ deposits: known(22_000, "replacement ai"), positions: [] }))
  const replaced = await analyzeDealStatementsForCorrections(actor(), deal.id, { replaceReviewed: true })
  const after = replaced.months.find((item) => item.documentId === month.documentId)
  assert.ok(after)
  assert.equal(after.deposits.value, 22_000)
  assert.equal(after.corrected, false)
  assert.equal(after.original.deposits.value, 22_000)
})

test("MIC-172 position confirm is retained and marks underwriting stale", async () => {
  const deal = (await createDeal(actor(), { idempotencyKey: "pos-deal", legalName: "Position Review LLC" })).deal
  await uploadStatement(actor(), deal.id, "pos-aug.pdf", "pos-aug", extraction({}))
  const analyzed = await analyzeDealStatements(actor(), deal.id)
  const position = analyzed.positions[0]
  assert.ok(position)
  assert.equal(position.status, "proposed")

  const corrected = await correctExistingPosition(actor(), {
    dealId: deal.id,
    positionId: position.id,
    reason: "Merchant confirmed this ACH is an existing MCA.",
    status: "confirmed",
  })
  assert.equal(corrected.position.id, position.id)
  assert.equal(corrected.position.status, "confirmed")
  assert.equal(corrected.position.corrected, true)
  assert.equal(corrected.aggregate.stale, true)
  assert.equal(corrected.aggregate.positionCount, 1)

  await uploadStatement(actor(), deal.id, "pos-sep.pdf", "pos-sep", extraction({
    period: "2026-09", positions: [{ label: "Rapid Capital", estimatedPayment: 1_200, evidence: "ACH Rapid Capital 1200" }],
  }))
  const rerun = await analyzeDealStatements(actor(), deal.id)
  const kept = rerun.positions.find((item) => item.id === position.id)
  assert.ok(kept)
  assert.equal(kept.status, "confirmed")
})

test("MIC-172 correction validation and cross-workspace isolation", async () => {
  const deal = (await createDeal(actor(), { idempotencyKey: "val-deal", legalName: "Validation LLC" })).deal
  await uploadStatement(actor(), deal.id, "val-aug.pdf", "val-aug", extraction({}))
  const analyzed = await analyzeDealStatements(actor(), deal.id)
  const month = analyzed.months[0]
  assert.ok(month)

  await assert.rejects(
    correctStatementMonth(actor(), { dealId: deal.id, monthId: month.id, reason: "   ", deposits: 1 }),
    (error: { status?: number; code?: string }) => error.status === 422 && error.code === "validation_failed",
  )
  await assert.rejects(
    correctStatementMonth(actor(), { dealId: deal.id, monthId: month.id, reason: "Bad number", deposits: Number.NaN }),
    (error: { status?: number; code?: string }) => error.status === 422 && error.code === "validation_failed",
  )
  await assert.rejects(
    correctStatementMonth(actor(), { dealId: deal.id, monthId: "missing-month", reason: "Unknown row", deposits: 1 }),
    (error: { status?: number; code?: string }) => error.status === 404 && error.code === "month_not_found",
  )
  await assert.rejects(
    correctStatementMonth(actor("workspace-other"), { dealId: deal.id, monthId: month.id, reason: "Foreign", deposits: 1 }),
    (error: { status?: number; code?: string }) => error.status === 404 && error.code === "deal_not_found",
  )
  await assert.rejects(
    getDealCorrections(actor("workspace-other"), deal.id),
    (error: { status?: number; code?: string }) => error.status === 404 && error.code === "deal_not_found",
  )
})

test("MIC-172 deals:read lists, deals:write corrects, intake:write is 403", async () => {
  const deal = (await createDeal(actor(), { idempotencyKey: "http-corr", legalName: "HTTP Corrections LLC" })).deal
  await uploadStatement(actor(), deal.id, "http-aug.pdf", "http-corr-aug", extraction({ deposits: known(7_500, "7500"), positions: [] }))
  const analyzed = await analyzeDealStatements(actor(), deal.id)
  const month = analyzed.months[0]
  assert.ok(month)

  const now = new Date().toISOString()
  const addKey = async (id: string, secret: string, scopes: string[]) => getDatabase().prepare(`INSERT INTO api_keys
    (id,workspace_id,name,prefix,secret_hash,scopes,expires_at,last_used_at,revoked_at,rate_limit_per_minute,created_by,created_at)
    VALUES (?, 'workspace-corrections', ?, 'mca_test', ?, ?, NULL, NULL, NULL, 60, 'fixture-user-workspace-corrections', ?)`).run(id, id, hashOpaqueToken(`mca_${secret}`), JSON.stringify(scopes), now)
  await addKey("corr-read-key", "corr-read", ["deals:read"])
  await addKey("corr-write-key", "corr-write", ["deals:write"])
  await addKey("corr-intake-key", "corr-intake", ["intake:write"])

  const headers = (secret: string) => ({ authorization: `Bearer mca_${secret}` })
  const listRequest = (secret: string) => new Request(`http://localhost/api/mca/underwriting/corrections?dealId=${deal.id}`, { headers: headers(secret) })
  const dealRequest = (secret: string, method = "GET", body?: string) => new Request(`http://localhost/api/mca/underwriting/corrections/${deal.id}`, {
    method, headers: headers(secret), ...(body ? { body } : {}),
  })
  const analyzeRequest = (secret: string, body = "{}") => new Request(`http://localhost/api/mca/underwriting/corrections/${deal.id}/analyze`, {
    method: "POST", headers: headers(secret), body,
  })
  const params = { params: Promise.resolve({ dealId: deal.id }) }

  assert.equal((await listCorrections(listRequest("corr-intake"))).status, 403)
  assert.equal((await getCorrections(dealRequest("corr-intake"), params)).status, 403)
  assert.equal((await postCorrection(dealRequest("corr-intake", "POST", "{}"), params)).status, 403)
  assert.equal((await analyzeCorrections(analyzeRequest("corr-intake"), params)).status, 403)
  assert.equal((await postCorrection(dealRequest("corr-read", "POST", "{}"), params)).status, 403)
  assert.equal((await analyzeCorrections(analyzeRequest("corr-read"), params)).status, 403)
  assert.equal((await listCorrections(listRequest("corr-write"))).status, 403)

  const listed = await listCorrections(listRequest("corr-read"))
  assert.equal(listed.status, 200)
  const listedBody = await listed.json() as { months: Array<{ id: string }>; aggregate: { monthlyRevenue: MetricEvidence } }
  assert.equal(listedBody.months.length, 1)
  assert.equal(listedBody.aggregate.monthlyRevenue.value, 7_500)

  const posted = await postCorrection(dealRequest("corr-write", "POST", JSON.stringify({
    monthId: month.id,
    reason: "Portal total is 8000",
    deposits: 8_000,
  })), params)
  assert.equal(posted.status, 200)
  const postedBody = await posted.json() as { month: { deposits: MetricEvidence; corrected: boolean }; aggregate: { stale: boolean; monthlyRevenue: MetricEvidence } }
  assert.equal(postedBody.month.deposits.value, 8_000)
  assert.equal(postedBody.month.corrected, true)
  assert.equal(postedBody.aggregate.stale, true)
  assert.equal(postedBody.aggregate.monthlyRevenue.value, 8_000)

  const analyzedHttp = await analyzeCorrections(analyzeRequest("corr-write", JSON.stringify({ replaceReviewed: false })), params)
  assert.equal(analyzedHttp.status, 200)
  const analyzedBody = await analyzedHttp.json() as { months: Array<{ deposits: MetricEvidence; corrected: boolean }> }
  assert.equal(analyzedBody.months[0]?.deposits.value, 8_000)
  assert.equal(analyzedBody.months[0]?.corrected, true)
})
