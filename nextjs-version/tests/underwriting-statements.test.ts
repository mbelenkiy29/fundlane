import { updateDocumentScan } from "../src/lib/mca/documents/repository"
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
import { isDocumentReady } from "../src/lib/mca/documents/contracts"
import { storeDocument } from "../src/lib/mca/documents/service"
import { hashOpaqueToken } from "../src/lib/mca/crypto"
import type { ExistingPositionCandidate, MetricEvidence, StatementAccountKind, StatementMonthRecord } from "../src/lib/mca/underwriting/contracts"
import { computeUnderwritingAggregate } from "../src/lib/mca/underwriting/aggregates"
import { setUnderwritingNowForTests } from "../src/lib/mca/underwriting/lookback"
import type { StatementExtraction, StatementExtractionProvider } from "../src/lib/mca/underwriting/statement-extraction"
import {
  analyzeDealStatements,
  getUnderwritingAggregate,
  listExistingPositions,
  listStatementMonths,
  setStatementExtractionProviderForTests,
} from "../src/lib/mca/underwriting/statements"
import { GET as listStatements } from "../src/app/api/mca/underwriting/statements/route"
import { GET as getStatements } from "../src/app/api/mca/underwriting/statements/[dealId]/route"
import { POST as analyzeStatements } from "../src/app/api/mca/underwriting/statements/[dealId]/analyze/route"

const FROZEN_NOW = new Date("2026-09-18T16:00:00.000Z")

let testDatabase: Awaited<ReturnType<typeof createPostgresTestDatabase>>
delete process.env.MCA_DOCUMENT_SCANNER
delete process.env.MCA_BACKGROUND_JOBS
delete process.env.VERCEL
delete process.env.MCA_DOCUMENT_AI_PROVIDER
delete process.env.OPENAI_API_KEY
delete process.env.MCA_DOCUMENT_AI_MODEL

const actor = (workspaceId = "workspace-statements"): DealActor => ({
  workspaceId, userId: null, membershipId: null, role: "admin", managedMembershipIds: [], activeMembershipIds: [], source: "system", correlationId: `corr-${workspaceId}`,
})
const memory = new Map<string, Uint8Array>()
const storage: DocumentStorage = {
  name: "test-memory",
  async putImmutable(key, bytes) { if (memory.has(key)) throw new Error("duplicate storage key"); memory.set(key, new Uint8Array(bytes)) },
  async get(key) { const value = memory.get(key); if (!value) throw new Error("missing storage key"); return new Uint8Array(value) },
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
function unknownMetric(): MetricEvidence {
  return { value: null, unknown: true, page: 1, text: "illegible", confidence: 0.1 }
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
  nsfDates?: string[]
  negativeDates?: string[]
  positions?: StatementExtraction["positions"]
  warnings?: string[]
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
    nsfDates: input.nsfDates ?? [],
    negativeDates: input.negativeDates ?? [],
    positions: input.positions ?? [{ label: "Rapid Capital", estimatedPayment: 1_200, evidence: "ACH Rapid Capital 1200" }],
    warnings: input.warnings ?? [],
    provider: "fixture-statements",
    requestId: "statement-fixture",
  }
}

const extractions = new Map<string, StatementExtraction>()
const extractCalls: string[] = []
const provider: StatementExtractionProvider = {
  name: "fixture-statements",
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
    VALUES (?, ?, 'America/New_York', 5, ?, ?, ?, ?, ?)`).run(id, id, JSON.stringify({ reports: true, payments: true, integrations: true }), JSON.stringify({ dashboard: true, deals: true, users: true, reports: true, payments: true, workspace: true, integrations: true }), JSON.stringify({ createDeal: true, exportDeals: true, inviteUsers: true, manageApiKeys: true, viewPaymentTable: true, viewCompanyFinancials: true }), now, now)
  await getDatabase().prepare(`INSERT INTO users (id, email, password_hash, name, phone, application_identifier, created_at, updated_at)
    VALUES (?, ?, NULL, ?, NULL, ?, ?, ?)`).run(`fixture-user-${id}`, `${id}@example.test`, id, `APP-${id}`, now, now)
}

function pdf(marker: string) {
  return new Uint8Array(Buffer.from(`%PDF-1.4\n${marker}\n%%EOF\n`))
}

async function uploadStatement(dealActor: DealActor, dealId: string, filename: string, key: string, result: StatementExtraction, status: "clean" | "infected" = "clean") {
  extractions.set(filename, result)
  setDocumentScannerForTests(scanner(status))
  return storeDocument(dealActor, {
    dealId, idempotencyKey: key, filename, mimeType: "application/pdf", bytes: pdf(key), category: "statement", source: "test",
  })
}

before(async () => {
  testDatabase = await createPostgresTestDatabase("underwriting_statements")
  Object.assign(process.env, testDatabase.env())
  delete process.env.MCA_BACKGROUND_JOBS
  delete process.env.VERCEL
  setDocumentStorageForTests(storage)
  setDocumentScannerForTests(scanner("clean"))
  setStatementExtractionProviderForTests(provider)
  setUnderwritingNowForTests(FROZEN_NOW)
  await addWorkspace("workspace-statements")
  await addWorkspace("workspace-other")
})
beforeEach(() => {
  extractions.clear()
  extractCalls.length = 0
  setStatementExtractionProviderForTests(provider)
  setDocumentScannerForTests(scanner("clean"))
  setUnderwritingNowForTests(FROZEN_NOW)
})
after(async () => {
  setUnderwritingNowForTests()
  setDocumentStorageForTests()
  setDocumentScannerForTests()
  setStatementExtractionProviderForTests()
  await closeDatabaseForTests()
  await testDatabase.close()
})

test("MIC-179 duplicate statements same period/account do not double-count deposits", async () => {
  const deal = (await createDeal(actor(), { idempotencyKey: "dup-deal", legalName: "Duplicate Bakery LLC" })).deal
  await uploadStatement(actor(), deal.id, "harbor-aug.pdf", "dup-a", extraction({ deposits: known(10_000, "Deposits 10000") }))
  await uploadStatement(actor(), deal.id, "harbor-aug-copy.pdf", "dup-b", extraction({ deposits: known(10_000, "Deposits 10000") }))
  const first = await analyzeDealStatements(actor(), deal.id)
  const duplicate = first.months.find((month) => month.duplicateOfId)
  const canonical = first.months.find((month) => !month.duplicateOfId)
  assert.equal(first.months.length, 2)
  assert.ok(canonical)
  assert.ok(duplicate)
  assert.equal(duplicate.duplicateOfId, canonical.id)
  assert.equal(duplicate.period, canonical.period)
  assert.equal(duplicate.accountSuffix, canonical.accountSuffix)
  assert.equal(first.aggregate.monthlyRevenue.value, 10_000)
  assert.equal(first.aggregate.monthlyRevenue.unknown, false)
  assert.equal(first.aggregate.averageDailyBalance.value, 4_000)
  assert.equal(first.aggregate.nsfCount.value, 1)
  assert.equal(first.aggregate.negativeDays.value, 2)
  assert.equal(first.aggregate.stale, false)
  assert.equal(first.positions.length, 1)
  assert.equal(first.aggregate.positionCount, 0)
})

test("MIC-179 uncertain extraction stays unknown in the aggregate and is never presented as zero", async () => {
  const deal = (await createDeal(actor(), { idempotencyKey: "unknown-deal", legalName: "Unreadable Cafe LLC" })).deal
  await uploadStatement(actor(), deal.id, "blurry-aug.pdf", "unknown-a", extraction({
    deposits: unknownMetric(),
    averageDailyBalance: unknownMetric(),
    nsfCount: unknownMetric(),
    negativeDays: unknownMetric(),
  }))
  const result = await analyzeDealStatements(actor(), deal.id)
  assert.equal(result.months[0]?.deposits.unknown, true)
  assert.equal(result.months[0]?.deposits.value, null)
  assert.equal(result.aggregate.monthlyRevenue.unknown, true)
  assert.equal(result.aggregate.monthlyRevenue.value, null)
  assert.notEqual(result.aggregate.monthlyRevenue.value, 0)
  assert.equal(result.aggregate.averageDailyBalance.unknown, true)
  assert.equal(result.aggregate.averageDailyBalance.value, null)
  assert.equal(result.aggregate.nsfCount.unknown, true)
  assert.equal(result.aggregate.nsfCount.value, null)
  assert.equal(result.aggregate.negativeDays.unknown, true)
  assert.equal(result.aggregate.negativeDays.value, null)
})

test("MIC-179 savings keeps kind savings and is excluded from checking revenue", async () => {
  const deal = (await createDeal(actor(), { idempotencyKey: "savings-deal", legalName: "Mixed Accounts LLC" })).deal
  await uploadStatement(actor(), deal.id, "checking-aug.pdf", "savings-checking", extraction({
    accountKind: "checking", accountSuffix: "1111", deposits: known(8_000, "Checking 8000"), nsfCount: known(0, "0 NSF"),
  }))
  await uploadStatement(actor(), deal.id, "savings-aug.pdf", "savings-savings", extraction({
    accountKind: "savings", accountSuffix: "2222", deposits: known(50_000, "Savings 50000"), nsfCount: known(0, "0 NSF"),
    positions: [],
  }))
  const result = await analyzeDealStatements(actor(), deal.id)
  const savings = result.months.find((month) => month.documentId && month.accountKind !== "checking")
  const checking = result.months.find((month) => month.accountKind === "checking")
  assert.ok(savings)
  assert.ok(checking)
  assert.equal(savings.accountKind, "savings")
  assert.equal(result.aggregate.monthlyRevenue.value, 8_000)
  assert.equal(result.aggregate.monthlyRevenue.unknown, false)
})

test("MIC-179 credit_card and loan kinds are persisted without collapsing to unsupported", async () => {
  const deal = (await createDeal(actor(), { idempotencyKey: "kinds-deal", legalName: "Mixed Kinds LLC" })).deal
  await uploadStatement(actor(), deal.id, "checking-aug.pdf", "kinds-checking", extraction({
    accountKind: "checking", accountSuffix: "1111", deposits: known(9_000, "Checking 9000"), nsfCount: known(0, "0 NSF"), positions: [],
  }))
  await uploadStatement(actor(), deal.id, "card-aug.pdf", "kinds-card", extraction({
    accountKind: "credit_card", accountSuffix: "3333", deposits: known(1_000, "Card 1000"), nsfCount: known(0, "0 NSF"), positions: [],
  }))
  await uploadStatement(actor(), deal.id, "loan-aug.pdf", "kinds-loan", extraction({
    accountKind: "loan", accountSuffix: "4444", deposits: known(2_000, "Loan 2000"), nsfCount: known(0, "0 NSF"), positions: [],
  }))
  const result = await analyzeDealStatements(actor(), deal.id)
  assert.equal(result.months.find((month) => month.accountSuffix === "3333")?.accountKind, "credit_card")
  assert.equal(result.months.find((month) => month.accountSuffix === "4444")?.accountKind, "loan")
  assert.equal(result.aggregate.monthlyRevenue.value, 9_000)
})

test("statement extraction persists NSF and negative dates without changing deposit totals", async () => {
  const deal = (await createDeal(actor(), { idempotencyKey: "dates-deal", legalName: "Dated NSF LLC" })).deal
  await uploadStatement(actor(), deal.id, "dated-aug.pdf", "dates-a", extraction({
    deposits: known(12_500, "Total deposits 12500"),
    nsfCount: known(2, "2 NSF"),
    negativeDays: known(3, "3 negative days"),
    nsfDates: ["2026-08-04", "2026-08-19"],
    negativeDates: ["2026-08-05", "2026-08-06", "2026-08-20"],
    warnings: ["transfer: Wire from savings 2500", "mca_credit: Rapid Capital advance 8000"],
    positions: [],
  }))
  const result = await analyzeDealStatements(actor(), deal.id)
  const month = result.months[0]
  assert.ok(month)
  assert.deepEqual(month.nsfDates, ["2026-08-04", "2026-08-19"])
  assert.deepEqual(month.negativeDates, ["2026-08-05", "2026-08-06", "2026-08-20"])
  assert.equal(month.deposits.value, 12_500)
  assert.equal(result.aggregate.monthlyRevenue.value, 12_500)
  assert.ok(result.aggregate.warnings.some((warning) => warning.startsWith("transfer:")))
  assert.ok(result.aggregate.warnings.some((warning) => warning.startsWith("mca_credit:")))
  assert.equal(result.aggregate.depositCount.value, 12)
  assert.equal(result.aggregate.depositCount.unknown, false)
})

test("MIC-179 unique checking accounts in the same period are summed before the monthly average", async () => {
  const deal = (await createDeal(actor(), { idempotencyKey: "multi-acct", legalName: "Two Accounts LLC" })).deal
  await uploadStatement(actor(), deal.id, "acct-1111-jul.pdf", "acct-jul", extraction({
    period: "2026-07", accountSuffix: "1111", deposits: known(6_000, "6000"), averageDailyBalance: known(1_000, "1000"),
    nsfCount: known(1, "1"), nsfDates: ["2026-07-15"], negativeDays: known(1, "1"), negativeDates: ["2026-07-16"], positions: [],
  }))
  await uploadStatement(actor(), deal.id, "acct-1111-aug.pdf", "acct-aug-1", extraction({
    period: "2026-08", accountSuffix: "1111", deposits: known(10_000, "10000"), averageDailyBalance: known(2_000, "2000"),
    nsfCount: known(1, "1"), nsfDates: ["2026-08-04"], negativeDays: known(2, "2"), negativeDates: ["2026-08-05", "2026-08-06"], positions: [],
  }))
  await uploadStatement(actor(), deal.id, "acct-2222-aug.pdf", "acct-aug-2", extraction({
    period: "2026-08", accountSuffix: "2222", deposits: known(5_000, "5000"), averageDailyBalance: known(1_000, "1000"),
    nsfCount: known(2, "2"), nsfDates: ["2026-08-04", "2026-08-19"], negativeDays: known(1, "1"), negativeDates: ["2026-08-07"], positions: [],
  }))
  const result = await analyzeDealStatements(actor(), deal.id)
  assert.equal(result.aggregate.monthlyRevenue.value, 10_500)
  assert.equal(result.aggregate.averageDailyBalance.value, 2_000)
  assert.equal(result.aggregate.nsfCount.value, 3)
  assert.equal(result.aggregate.negativeDays.value, 4)
  assert.equal(result.aggregate.worstMonthNsf.value, 2)
})

test("MIC-179 cross-workspace analysis is a 404", async () => {
  const deal = (await createDeal(actor(), { idempotencyKey: "cross-deal", legalName: "Home Workspace LLC" })).deal
  await uploadStatement(actor(), deal.id, "home-aug.pdf", "cross-a", extraction({}))
  await assert.rejects(() => analyzeDealStatements(actor("workspace-other"), deal.id), (error: { status?: number; code?: string }) => error.status === 404 && error.code === "deal_not_found")
  await assert.rejects(listStatementMonths(actor("workspace-other"), deal.id), (error: { status?: number; code?: string }) => error.status === 404 && error.code === "deal_not_found")
  await assert.rejects(getUnderwritingAggregate(actor("workspace-other"), deal.id), (error: { status?: number; code?: string }) => error.status === 404 && error.code === "deal_not_found")
})

test("MIC-179 analyze is idempotent on unchanged documents", async () => {
  const deal = (await createDeal(actor(), { idempotencyKey: "idem-deal", legalName: "Stable Statements LLC" })).deal
  await uploadStatement(actor(), deal.id, "stable-jul.pdf", "idem-a", extraction({ period: "2026-07" }))
  await uploadStatement(actor(), deal.id, "stable-aug.pdf", "idem-b", extraction({ period: "2026-08", accountSuffix: "1111" }))
  const first = await analyzeDealStatements(actor(), deal.id)
  const firstCalls = extractCalls.length
  const second = await analyzeDealStatements(actor(), deal.id)
  assert.equal(extractCalls.length, firstCalls)
  assert.deepEqual(second.months.map((month) => month.id).sort(), first.months.map((month) => month.id).sort())
  assert.deepEqual(second.months.map((month) => month.extractionVersion), first.months.map((month) => month.extractionVersion))
  assert.equal(second.aggregate.version, first.aggregate.version)
  assert.deepEqual(second.positions.map((position) => position.id).sort(), first.positions.map((position) => position.id).sort())
  assert.equal((await listStatementMonths(actor(), deal.id)).length, 2)
  assert.equal((await getUnderwritingAggregate(actor(), deal.id))?.version, first.aggregate.version)
  assert.equal((await listExistingPositions(actor(), deal.id)).length, first.positions.length)
})

test("MIC-179 concurrent analysis serializes one semantic position and aggregate version", async () => {
  const deal = (await createDeal(actor(), { idempotencyKey: "parallel-deal", legalName: "Parallel Statements LLC" })).deal
  await uploadStatement(actor(), deal.id, "parallel-aug.pdf", "parallel-a", extraction({}))
  let arrivals = 0
  let releaseBoth!: () => void
  const bothArrived = new Promise<void>((resolve) => { releaseBoth = resolve })
  setStatementExtractionProviderForTests({
    name: "parallel-fixture",
    async extractStatement(_actor, input) {
      arrivals += 1
      if (arrivals === 2) releaseBoth()
      await bothArrived
      const result = extractions.get(input.filename)
      if (!result) throw new Error(`missing statement fixture for ${input.filename}`)
      return result
    },
  })

  const [left, right] = await Promise.all([
    analyzeDealStatements(actor(), deal.id),
    analyzeDealStatements(actor(), deal.id),
  ])

  assert.equal(arrivals, 2)
  assert.equal(left.aggregate.version, 1)
  assert.equal(right.aggregate.version, 1)
  assert.equal(left.positions.length, 1)
  assert.equal(right.positions.length, 1)
  assert.equal(left.positions[0]?.id, right.positions[0]?.id)
  const count = await getDatabase().prepare<{ count: string }>(`SELECT COUNT(*) AS count
    FROM mca_existing_positions WHERE workspace_id = ? AND deal_id = ? AND lower(trim(label)) = lower(trim(?))`).get(
    actor().workspaceId,
    deal.id,
    "Rapid Capital",
  )
  assert.equal(Number(count?.count), 1)
})

test("MIC-179 pending and quarantined statements are not analyzed", async () => {
  const deal = (await createDeal(actor(), { idempotencyKey: "scan-deal", legalName: "Scan Filter LLC" })).deal
  const clean = await uploadStatement(actor(), deal.id, "clean-aug.pdf", "scan-clean", extraction({ deposits: known(9_000, "9000"), positions: [] }))
  assert.equal(isDocumentReady(clean.processingState), true)
  assert.equal(clean.processingState, "clean")
  setDocumentScannerForTests(undefined)
  const pending = await storeDocument(actor(), { dealId: deal.id, idempotencyKey: "scan-pending", filename: "pending-aug.pdf", mimeType: "application/pdf", bytes: pdf("pending"), category: "statement", source: "test" })
  await updateDocumentScan(actor().workspaceId, pending.id, "pending_scan", "legacy-scanner", {}, new Date().toISOString())
  setDocumentScannerForTests(scanner("infected"))
  const quarantined = await storeDocument(actor(), { dealId: deal.id, idempotencyKey: "scan-infected", filename: "infected-aug.pdf", mimeType: "application/pdf", bytes: pdf("infected"), category: "statement", source: "test" })
  await updateDocumentScan(actor().workspaceId, quarantined.id, "quarantined", "legacy-scanner", {}, new Date().toISOString())
  const result = await analyzeDealStatements(actor(), deal.id)
  assert.equal(result.months.length, 1)
  assert.equal(result.months[0]?.documentId, clean.id)
  assert.equal(result.aggregate.monthlyRevenue.value, 9_000)
})

test("MIC-179 missing live credentials fail closed as provider_unavailable", async () => {
  const deal = (await createDeal(actor(), { idempotencyKey: "provider-deal", legalName: "No Provider LLC" })).deal
  await uploadStatement(actor(), deal.id, "need-ai.pdf", "provider-a", extraction({}))
  setStatementExtractionProviderForTests()
  await assert.rejects(() => analyzeDealStatements(actor(), deal.id), (error: { status?: number; code?: string }) => error.status === 503 && error.code === "provider_unavailable")
})

test("MIC-179 deals:read lists, deals:write analyzes, and intake:write is 403", async () => {
  const deal = (await createDeal(actor(), { idempotencyKey: "http-deal", legalName: "HTTP Statements LLC" })).deal
  await uploadStatement(actor(), deal.id, "http-aug.pdf", "http-a", extraction({ deposits: known(7_500, "7500"), positions: [] }))
  const now = new Date().toISOString()
  const addKey = async (id: string, secret: string, scopes: string[]) => getDatabase().prepare(`INSERT INTO api_keys
    (id,workspace_id,name,prefix,secret_hash,scopes,expires_at,last_used_at,revoked_at,rate_limit_per_minute,created_by,created_at)
    VALUES (?, 'workspace-statements', ?, 'mca_test', ?, ?, NULL, NULL, NULL, 60, 'fixture-user-workspace-statements', ?)`).run(id, id, hashOpaqueToken(`mca_${secret}`), JSON.stringify(scopes), now)
  await addKey("stmt-read-key", "stmt-read", ["deals:read"])
  await addKey("stmt-write-key", "stmt-write", ["deals:write"])
  await addKey("stmt-intake-key", "stmt-intake", ["intake:write"])

  const headers = (secret: string) => ({ authorization: `Bearer mca_${secret}` })
  const listRequest = (secret: string) => new Request(`http://localhost/api/mca/underwriting/statements?dealId=${deal.id}`, { headers: headers(secret) })
  const dealRequest = (secret: string, method = "GET") => new Request(`http://localhost/api/mca/underwriting/statements/${deal.id}`, { method, headers: headers(secret) })
  const analyzeRequest = (secret: string) => new Request(`http://localhost/api/mca/underwriting/statements/${deal.id}/analyze`, { method: "POST", headers: headers(secret), body: "{}" })
  const params = { params: Promise.resolve({ dealId: deal.id }) }

  assert.equal((await listStatements(listRequest("stmt-intake"))).status, 403)
  assert.equal((await getStatements(dealRequest("stmt-intake"), params)).status, 403)
  assert.equal((await analyzeStatements(analyzeRequest("stmt-intake"), params)).status, 403)
  assert.equal((await analyzeStatements(analyzeRequest("stmt-read"), params)).status, 403)
  assert.equal((await listStatements(listRequest("stmt-write"))).status, 403)

  const analyzed = await analyzeStatements(analyzeRequest("stmt-write"), params)
  assert.equal(analyzed.status, 200)
  const analyzedBody = await analyzed.json() as { aggregate: { monthlyRevenue: MetricEvidence } }
  assert.equal(analyzedBody.aggregate.monthlyRevenue.value, 7_500)

  const listed = await listStatements(listRequest("stmt-read"))
  assert.equal(listed.status, 200)
  const listedBody = await listed.json() as { months: unknown[]; aggregate: { monthlyRevenue: MetricEvidence } }
  assert.equal(listedBody.months.length, 1)
  assert.equal(listedBody.aggregate.monthlyRevenue.value, 7_500)
  assert.equal((await getStatements(dealRequest("stmt-read"), params)).status, 200)
})

const LOOKBACK = ["2026-06", "2026-07", "2026-08"]
const FIVE_NSF_DAYS = ["2026-08-03", "2026-08-04", "2026-08-05", "2026-08-06", "2026-08-07"]

function statementMonth(overrides: Partial<StatementMonthRecord> & { id: string; period: string }): StatementMonthRecord {
  return {
    dealId: "deal-aggregate",
    documentId: `doc-${overrides.id}`,
    accountKind: "checking",
    deposits: known(10_000, "deposits"),
    depositCount: known(12, "12 deposits"),
    averageDailyBalance: known(4_000, "ADB"),
    nsfCount: known(0, "0 NSF"),
    negativeDays: known(0, "0 negative days"),
    nsfDates: [],
    negativeDates: [],
    endingBalance: known(3_500, "ending"),
    warnings: [],
    extractionVersion: 1,
    corrected: false,
    ...overrides,
  }
}

function existingPosition(status: ExistingPositionCandidate["status"], id = `pos-${status}`): ExistingPositionCandidate {
  return { id, dealId: "deal-aggregate", label: `Position ${status}`, evidence: "ACH", status }
}

function aggregateOf(input: { months?: StatementMonthRecord[]; positions?: ExistingPositionCandidate[]; window?: string[] }) {
  return computeUnderwritingAggregate({
    dealId: "deal-aggregate",
    months: input.months ?? [],
    positions: input.positions ?? [],
    window: input.window ?? LOOKBACK,
    version: 1,
    computedAt: "2026-09-18T16:00:00.000Z",
  })
}

test("unique-day NSF: same 5 days on two accounts count as 5", () => {
  const result = aggregateOf({
    months: [
      statementMonth({ id: "acct-1111", period: "2026-08", accountSuffix: "1111", nsfDates: FIVE_NSF_DAYS, nsfCount: known(5, "5 NSF") }),
      statementMonth({ id: "acct-2222", period: "2026-08", accountSuffix: "2222", nsfDates: FIVE_NSF_DAYS, nsfCount: known(5, "5 NSF") }),
    ],
  })
  assert.equal(result.nsfCount.value, 5)
  assert.equal(result.nsfCount.unknown, false)
  assert.notEqual(result.nsfCount.value, 10)
  assert.equal(result.worstMonthNsf.value, 5)
})

test("unique-day NSF: disjoint dates across accounts are unioned", () => {
  const result = aggregateOf({
    months: [
      statementMonth({
        id: "acct-1111", period: "2026-08", accountSuffix: "1111",
        nsfDates: ["2026-08-01", "2026-08-02"], nsfCount: known(2, "2 NSF"),
      }),
      statementMonth({
        id: "acct-2222", period: "2026-08", accountSuffix: "2222",
        nsfDates: ["2026-08-03", "2026-08-04", "2026-08-05"], nsfCount: known(3, "3 NSF"),
      }),
    ],
  })
  assert.equal(result.nsfCount.value, 5)
  assert.equal(result.nsfCount.unknown, false)
  assert.equal(result.worstMonthNsf.value, 5)
})

test("unique-day NSF: known count on a single file without dates is used", () => {
  const result = aggregateOf({
    months: [
      statementMonth({ id: "aug", period: "2026-08", nsfDates: [], nsfCount: known(3, "3 NSF") }),
    ],
  })
  assert.equal(result.nsfCount.value, 3)
  assert.equal(result.nsfCount.unknown, false)
  assert.equal(result.worstMonthNsf.value, 3)
})

test("unique-day NSF: two files without dates are unknown", () => {
  const result = aggregateOf({
    months: [
      statementMonth({ id: "acct-1111", period: "2026-08", accountSuffix: "1111", nsfDates: [], nsfCount: known(2, "2 NSF") }),
      statementMonth({ id: "acct-2222", period: "2026-08", accountSuffix: "2222", nsfDates: [], nsfCount: known(3, "3 NSF") }),
    ],
  })
  assert.equal(result.nsfCount.unknown, true)
  assert.equal(result.nsfCount.value, null)
  assert.equal(result.worstMonthNsf.unknown, true)
})

test("unique-day NSF: worst-month is the highest monthly unique-day count", () => {
  const result = aggregateOf({
    months: [
      statementMonth({
        id: "jul", period: "2026-07",
        nsfDates: ["2026-07-10", "2026-07-11"], nsfCount: known(2, "2 NSF"),
      }),
      statementMonth({
        id: "aug", period: "2026-08",
        nsfDates: FIVE_NSF_DAYS, nsfCount: known(5, "5 NSF"),
      }),
    ],
  })
  assert.equal(result.nsfCount.value, 7)
  assert.equal(result.worstMonthNsf.value, 5)
  assert.equal(result.worstMonthNsf.unknown, false)
})

test("aggregate skips unknown period and current month", () => {
  const result = aggregateOf({
    months: [
      statementMonth({
        id: "unknown", period: "unknown",
        deposits: known(99_000, "skip"), averageDailyBalance: known(50_000, "skip"),
        nsfDates: FIVE_NSF_DAYS, nsfCount: known(5, "skip"),
      }),
      statementMonth({
        id: "current", period: "2026-09",
        deposits: known(80_000, "skip"), averageDailyBalance: known(80_000, "skip"),
        nsfDates: FIVE_NSF_DAYS, nsfCount: known(5, "skip"),
      }),
      statementMonth({
        id: "aug", period: "2026-08",
        deposits: known(10_000, "keep"), averageDailyBalance: known(4_000, "keep"),
        nsfDates: ["2026-08-10"], nsfCount: known(1, "1 NSF"),
      }),
    ],
  })
  assert.equal(result.monthlyRevenue.value, 10_000)
  assert.equal(result.averageDailyBalance.value, 4_000)
  assert.equal(result.nsfCount.value, 1)
  assert.equal(result.worstMonthNsf.value, 1)
})

test("proposed positions contribute 0 to positionCount", () => {
  const result = aggregateOf({ positions: [existingPosition("proposed")] })
  assert.equal(result.positionCount, 0)
})

test("dismissed positions do not inflate positionCount", () => {
  const result = aggregateOf({
    positions: [existingPosition("confirmed"), existingPosition("dismissed"), existingPosition("proposed")],
  })
  assert.equal(result.positionCount, 1)
})
