import "./helpers/business-auth";
import test, { after, before, beforeEach } from "node:test"
import assert from "node:assert/strict"
import { Client } from "pg"
import { closeDatabaseForTests, getDatabase } from "../src/lib/mca/db"
import { createPostgresTestDatabase } from "./helpers/postgres-test-db.mjs"
import { hashOpaqueToken } from "../src/lib/mca/crypto"
import { createDeal } from "../src/lib/mca/deals/service"
import type { DealActor } from "../src/lib/mca/deals/schema"
import type { Role } from "../src/lib/mca/types"
import type { DocumentStorage } from "../src/lib/mca/documents/storage"
import { setDocumentStorageForTests } from "../src/lib/mca/documents/storage"
import type { DocumentScanner } from "../src/lib/mca/documents/scanner"
import { setDocumentScannerForTests } from "../src/lib/mca/documents/scanner"
import { storeDocument } from "../src/lib/mca/documents/service"
import { createFunder, getFunder } from "../src/lib/mca/funders/directory"
import { listFunderCriteria, publishFunderCriteria, upsertIndustryAlias } from "../src/lib/mca/funders/criteria"
import type { CriteriaOperator, EligibilityRule } from "../src/lib/mca/funders/contracts"
import type { CriteriaExtraction, CriteriaScanProvider } from "../src/lib/mca/funders/criteria-scan"
import {
  acceptCriteriaScan,
  listCriteriaScanDocuments,
  listCriteriaScans,
  rejectCriteriaScan,
  rollbackCriteriaScan,
  scanFunderCriteria,
  setCriteriaScanProviderForTests,
} from "../src/lib/mca/funders/criteria-scan"
import { GET as scanGet, POST as scanPost } from "../src/app/api/mca/funders/scan/route"
import { GET as scanItemGet } from "../src/app/api/mca/funders/scan/[id]/route"
import { POST as scanAccept } from "../src/app/api/mca/funders/scan/[id]/accept/route"
import { POST as scanReject } from "../src/app/api/mca/funders/scan/[id]/reject/route"
import { POST as scanRollback } from "../src/app/api/mca/funders/scan/[id]/rollback/route"

let testDatabase: Awaited<ReturnType<typeof createPostgresTestDatabase>>
delete process.env.MCA_DOCUMENT_SCANNER
delete process.env.MCA_DOCUMENT_AI_PROVIDER
delete process.env.OPENAI_API_KEY
delete process.env.MCA_DOCUMENT_AI_MODEL

const runId = Date.now().toString(36)
const ids = {
  workspace: `workspace-scan-${runId}`,
  otherWorkspace: `workspace-scan-other-${runId}`,
  adminUser: `scan-admin-user-${runId}`,
  adminMember: `scan-admin-member-${runId}`,
  repUser: `scan-rep-user-${runId}`,
  repMember: `scan-rep-member-${runId}`,
  otherUser: `scan-other-user-${runId}`,
  otherMember: `scan-other-member-${runId}`,
}
const tokens = {
  admin: `scan-admin-session-${runId}`,
  rep: `scan-rep-session-${runId}`,
  other: `scan-other-session-${runId}`,
}

const actor = (workspaceId = ids.workspace, role: Role | null = "admin"): DealActor => ({
  workspaceId,
  userId: workspaceId === ids.otherWorkspace ? ids.otherUser : role === "rep" ? ids.repUser : ids.adminUser,
  membershipId: workspaceId === ids.otherWorkspace ? ids.otherMember : role === "rep" ? ids.repMember : ids.adminMember,
  role,
  managedMembershipIds: [],
  activeMembershipIds: workspaceId === ids.otherWorkspace ? [ids.otherMember] : [ids.adminMember, ids.repMember],
  source: role ? "user" : "api_key",
  correlationId: `corr-scan-${workspaceId}-${role ?? "key"}`,
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

type ExtractedRule = CriteriaExtraction["rules"][number]
const extractions = new Map<string, CriteriaExtraction>()
const extractCalls: string[] = []
const provider: CriteriaScanProvider = {
  name: "fixture-criteria-scan",
  async extractCriteria(_actor, input) {
    extractCalls.push(input.filename)
    const result = extractions.get(input.filename)
    if (!result) throw new Error(`missing criteria fixture for ${input.filename}`)
    return result
  },
}

function rule(input: Partial<ExtractedRule> & Pick<ExtractedRule, "field" | "operator" | "unit">): ExtractedRule {
  return {
    value: input.value ?? null,
    sourceText: input.sourceText,
    unspecified: input.unspecified ?? input.value == null,
    ambiguous: input.ambiguous ?? false,
    rangeText: input.rangeText,
    confidence: input.confidence ?? 0.92,
    page: input.page ?? 1,
    text: input.text ?? input.sourceText,
    unknown: input.unknown ?? false,
    ...input,
  }
}

function extraction(input: Partial<CriteriaExtraction> & { filename: string }): CriteriaExtraction {
  const result: CriteriaExtraction = {
    rules: input.rules ?? [],
    contacts: input.contacts ?? [],
    warnings: input.warnings ?? [],
    provider: "fixture-criteria-scan",
    requestId: input.requestId ?? `req-${input.filename}`,
  }
  extractions.set(input.filename, result)
  return result
}

function pdf(marker: string) {
  return new Uint8Array(Buffer.from(`%PDF-1.4\n${marker}\n%%EOF\n`))
}

function png(marker: string) {
  return new Uint8Array(Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.from(marker)]))
}

function jpeg(marker: string) {
  return new Uint8Array(Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.from(marker)]))
}

async function seed() {
  const database = getDatabase()
  const now = new Date().toISOString()
  const visibility = JSON.stringify({ dashboard: true, deals: true, users: true, reports: true, payments: true, workspace: true, integrations: true })
  const actions = JSON.stringify({ createDeal: true, exportDeals: true, inviteUsers: true, manageApiKeys: true, viewPaymentTable: true, viewCompanyFinancials: true })
  const flags = JSON.stringify({ reports: true, payments: true, integrations: true })
  for (const [id, name] of [[ids.workspace, "Scan Test"], [ids.otherWorkspace, "Other Scan"]] as const) {
    await database.prepare(`INSERT INTO workspaces (id,name,timezone,seat_limit,feature_flags,page_visibility,action_visibility,created_at,updated_at)
      VALUES (?, ?, 'America/New_York', 5, ?, ?, ?, ?, ?)
      ON CONFLICT (id) DO NOTHING`).run(id, name, flags, visibility, actions, now, now)
  }
  for (const [userId, memberId, email, workspaceId, role] of [
    [ids.adminUser, ids.adminMember, "scan-admin@example.test", ids.workspace, "admin"],
    [ids.repUser, ids.repMember, "scan-rep@example.test", ids.workspace, "rep"],
    [ids.otherUser, ids.otherMember, "scan-other@example.test", ids.otherWorkspace, "admin"],
  ] as const) {
    await database.prepare(`INSERT INTO users (id,email,password_hash,name,phone,application_identifier,created_at,updated_at)
      VALUES (?, ?, NULL, ?, NULL, ?, ?, ?)
      ON CONFLICT (id) DO NOTHING`).run(userId, `${runId}-${email}`, email, `APP-${userId}`, now, now)
    await database.prepare(`INSERT INTO memberships (id,workspace_id,user_id,role,manager_membership_id,status,sender_association,created_at,updated_at)
      VALUES (?, ?, ?, ?, NULL, 'active', NULL, ?, ?)
      ON CONFLICT (id) DO NOTHING`).run(memberId, workspaceId, userId, role, now, now)
  }
  await database.prepare(`INSERT INTO sessions (id,user_id,membership_id,token_hash,expires_at,created_at,last_seen_at)
    VALUES (?, ?, ?, ?, '2099-01-01T00:00:00.000Z', ?, ?)
    ON CONFLICT (id) DO NOTHING`).run(`scan-admin-session-${runId}`, ids.adminUser, ids.adminMember, hashOpaqueToken(tokens.admin), now, now)
  await database.prepare(`INSERT INTO sessions (id,user_id,membership_id,token_hash,expires_at,created_at,last_seen_at)
    VALUES (?, ?, ?, ?, '2099-01-01T00:00:00.000Z', ?, ?)
    ON CONFLICT (id) DO NOTHING`).run(`scan-rep-session-${runId}`, ids.repUser, ids.repMember, hashOpaqueToken(tokens.rep), now, now)
  await database.prepare(`INSERT INTO sessions (id,user_id,membership_id,token_hash,expires_at,created_at,last_seen_at)
    VALUES (?, ?, ?, ?, '2099-01-01T00:00:00.000Z', ?, ?)
    ON CONFLICT (id) DO NOTHING`).run(`scan-other-session-${runId}`, ids.otherUser, ids.otherMember, hashOpaqueToken(tokens.other), now, now)
  const addKey = async (id: string, secret: string, scopes: string[], workspaceId: string, createdBy: string) => {
    await database.prepare(`INSERT INTO api_keys
      (id,workspace_id,name,prefix,secret_hash,scopes,expires_at,last_used_at,revoked_at,rate_limit_per_minute,created_by,created_at)
      VALUES (?, ?, ?, 'mca_test', ?, ?, NULL, NULL, NULL, 60, ?, ?)
      ON CONFLICT (id) DO NOTHING`).run(id, workspaceId, id, hashOpaqueToken(`mca_${secret}`), JSON.stringify(scopes), createdBy, now)
  }
  await addKey(`scan-intake-key-${runId}`, `intake-secret-${runId}`, ["intake:write"], ids.workspace, ids.adminUser)
  await addKey(`scan-read-key-${runId}`, `read-secret-${runId}`, ["deals:read"], ids.workspace, ids.adminUser)
}

async function uploadSheet(dealActor: DealActor, dealId: string, filename: string, key: string, bytes = pdf(key), mimeType = "application/pdf", status: "clean" | "infected" | "error" = "clean") {
  setDocumentScannerForTests(scanner(status))
  return storeDocument(dealActor, {
    dealId,
    idempotencyKey: key,
    filename,
    mimeType,
    bytes,
    category: "other_stip",
    source: "test",
  })
}

function cookieRequest(path: string, token: string, init: RequestInit = {}) {
  return new Request(`http://localhost${path}`, {
    ...init,
    headers: {
      cookie: `mca_session=${token}`,
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...init.headers,
    },
  })
}

function bearerRequest(path: string, secret: string, init: RequestInit = {}) {
  return new Request(`http://localhost${path}`, {
    ...init,
    headers: {
      authorization: `Bearer mca_${secret}`,
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...init.headers,
    },
  })
}

function params(id: string) {
  return { params: Promise.resolve({ id }) }
}

async function holdFunderLock(workspaceId: string, funderId: string) {
  const client = new Client({
    connectionString: testDatabase.databaseUrlUnpooled,
    ssl: { rejectUnauthorized: true },
    enableChannelBinding: true,
  })
  await client.connect()
  await client.query("BEGIN")
  await client.query("SELECT id FROM mca_funders WHERE workspace_id = $1 AND id = $2 FOR UPDATE", [workspaceId, funderId])
  return async () => {
    await client.query("COMMIT")
    await client.end()
  }
}

function findRule(rules: EligibilityRule[], field: string, operator?: CriteriaOperator) {
  return rules.find((item) => item.field === field && (operator ? item.operator === operator : true))
}

before(async () => {
  testDatabase = await createPostgresTestDatabase("funders_scan")
  Object.assign(process.env, testDatabase.env())
  setDocumentStorageForTests(storage)
  setDocumentScannerForTests(scanner("clean"))
  setCriteriaScanProviderForTests(provider)
  await seed()
})
beforeEach(() => {
  extractions.clear()
  extractCalls.length = 0
  setCriteriaScanProviderForTests(provider)
  setDocumentScannerForTests(scanner("clean"))
})
after(async () => {
  setDocumentStorageForTests()
  setDocumentScannerForTests()
  setCriteriaScanProviderForTests()
  await closeDatabaseForTests()
  await testDatabase.close()
})

test("MIC-194 ambiguous ranges are flagged and unspecified stays unspecified without sentinels", async () => {
  const funder = (await createFunder(actor(), { idempotencyKey: "ambiguous-funder", legalName: "Range Capital LLC" })).funder
  const deal = (await createDeal(actor(), { idempotencyKey: "ambiguous-deal", legalName: "Range Merchant LLC" })).deal
  extraction({
    filename: "range-sheet.pdf",
    rules: [
      rule({ field: "fico", operator: "min", unit: "fico", value: 600, unspecified: false, ambiguous: true, rangeText: "FICO 600-650", sourceText: "FICO 600-650" }),
      rule({ field: "nsf", operator: "max", unit: "count", value: 9999999, unspecified: true, sourceText: "NSF not stated" }),
      rule({ field: "term", operator: "max", unit: "months", value: null, unspecified: true, unknown: true, sourceText: "Term TBD" }),
    ],
  })
  const document = await uploadSheet(actor(), deal.id, "range-sheet.pdf", "ambiguous-doc")
  const proposal = await scanFunderCriteria(actor(), { funderId: funder.id, documentId: document.id })
  const fico = findRule(proposal.rules, "fico")
  const nsf = findRule(proposal.rules, "nsf")
  const term = findRule(proposal.rules, "term")
  assert.equal(proposal.status, "proposed")
  assert.ok(fico)
  assert.equal(fico.unspecified, true)
  assert.equal(fico.value, null)
  assert.ok(proposal.warnings.some((warning) => /ambiguous/i.test(warning) && /fico/i.test(warning)))
  assert.ok(proposal.ambiguousRanges.some((item) => item.field === "fico" && item.rangeText === "FICO 600-650"))
  assert.ok(nsf)
  assert.equal(nsf.unspecified, true)
  assert.equal(nsf.value, null)
  assert.notEqual(nsf.value, 0)
  assert.notEqual(nsf.value, -1)
  assert.notEqual(nsf.value, 9999999)
  assert.ok(term)
  assert.equal(term.unspecified, true)
  assert.equal(term.value, null)
  const published = await listFunderCriteria(actor(), funder.id)
  assert.equal(published.rules.length, 0)
})

test("MIC-194 scan cannot erase a configured contact or silently broaden an eligibility rule", async () => {
  const funder = (await createFunder(actor(), {
    idempotencyKey: "preserve-funder",
    legalName: "Harbor Capital LLC",
    contacts: [{ name: "Pat Broker", email: "pat@harbor.test", phone: "555-0100", role: "ISO manager" }],
  })).funder
  await publishFunderCriteria(actor(), funder.id, [
    { field: "fico", operator: "min", unit: "fico", value: 650, unspecified: false, sourceText: "Min 650" },
    { field: "nsf", operator: "max", unit: "count", value: 2, unspecified: false },
    { field: "state", operator: "not_in", unit: "state", value: ["NV", "SD"], unspecified: false },
  ])
  const deal = (await createDeal(actor(), { idempotencyKey: "preserve-deal", legalName: "Harbor Merchant LLC" })).deal
  extraction({
    filename: "broader-sheet.pdf",
    contacts: [{ name: "AI Overwrite", email: "ai@example.test", phone: "000", role: "scanner" }],
    rules: [
      rule({ field: "fico", operator: "min", unit: "fico", value: 600, unspecified: false, sourceText: "FICO 600+" }),
      rule({ field: "nsf", operator: "max", unit: "count", value: 4, unspecified: false, sourceText: "Max 4 NSF" }),
      rule({ field: "state", operator: "not_in", unit: "state", value: ["NV"], unspecified: false, sourceText: "No Nevada" }),
      rule({ field: "revenue", operator: "min", unit: "usd_monthly", value: 10000, unspecified: false, sourceText: "$10k monthly" }),
    ],
  })
  const document = await uploadSheet(actor(), deal.id, "broader-sheet.pdf", "preserve-doc")
  const proposal = await scanFunderCriteria(actor(), { funderId: funder.id, documentId: document.id })
  const afterScan = await getFunder(actor(), funder.id)
  assert.equal(afterScan.contacts.length, 1)
  assert.equal(afterScan.contacts[0]?.email, "pat@harbor.test")
  assert.equal(afterScan.contacts[0]?.name, "Pat Broker")
  const fico = findRule(proposal.rules, "fico", "min")
  const nsf = findRule(proposal.rules, "nsf", "max")
  const states = findRule(proposal.rules, "state", "not_in")
  const revenue = findRule(proposal.rules, "revenue", "min")
  assert.equal(fico?.value, 650)
  assert.equal(nsf?.value, 2)
  assert.deepEqual(states?.value, ["NV", "SD"])
  assert.equal(revenue?.value, 10000)
  assert.ok(proposal.warnings.some((warning) => /broaden/i.test(warning) && /fico/i.test(warning)))
  assert.ok(proposal.warnings.some((warning) => /broaden/i.test(warning) && /nsf/i.test(warning)))
  assert.ok(proposal.contactsPreserved)
  const accepted = await acceptCriteriaScan(actor(), proposal.id)
  const afterAccept = await getFunder(actor(), funder.id)
  assert.equal(afterAccept.contacts[0]?.email, "pat@harbor.test")
  assert.equal(afterAccept.contacts.length, 1)
  assert.equal(findRule(accepted.criteria.rules, "fico")?.value, 650)
  assert.equal(findRule(accepted.criteria.rules, "revenue")?.value, 10000)
})

test("MIC-194 accept, reject, and rollback keep version history", async () => {
  const funder = (await createFunder(actor(), { idempotencyKey: "history-funder", legalName: "History Capital LLC" })).funder
  const original = await publishFunderCriteria(actor(), funder.id, [
    { field: "fico", operator: "min", unit: "fico", value: 620, unspecified: false },
  ])
  const deal = (await createDeal(actor(), { idempotencyKey: "history-deal", legalName: "History Merchant LLC" })).deal
  extraction({
    filename: "history-accept.pdf",
    rules: [rule({ field: "fico", operator: "min", unit: "fico", value: 640, unspecified: false, sourceText: "FICO 640" })],
  })
  const acceptDoc = await uploadSheet(actor(), deal.id, "history-accept.pdf", "history-accept-doc")
  const proposed = await scanFunderCriteria(actor(), { funderId: funder.id, documentId: acceptDoc.id })
  assert.equal(proposed.version, 1)
  const accepted = await acceptCriteriaScan(actor(), proposed.id)
  assert.equal(accepted.proposal.status, "accepted")
  assert.equal(findRule(accepted.criteria.rules, "fico")?.value, 640)
  assert.equal((await getFunder(actor(), funder.id)).criteriaVersion, original.criteriaVersion + 1)

  extraction({
    filename: "history-reject.pdf",
    rules: [rule({ field: "fico", operator: "min", unit: "fico", value: 700, unspecified: false, sourceText: "FICO 700" })],
  })
  const rejectDoc = await uploadSheet(actor(), deal.id, "history-reject.pdf", "history-reject-doc")
  const rejectedProposal = await scanFunderCriteria(actor(), { funderId: funder.id, documentId: rejectDoc.id })
  assert.equal(rejectedProposal.version, 2)
  const rejected = await rejectCriteriaScan(actor(), rejectedProposal.id)
  assert.equal(rejected.status, "rejected")
  assert.equal(findRule((await listFunderCriteria(actor(), funder.id)).rules, "fico")?.value, 640)

  const rolled = await rollbackCriteriaScan(actor(), proposed.id)
  assert.ok(rolled.proposal.rolledBackAt)
  assert.equal(findRule(rolled.criteria.rules, "fico")?.value, 620)
  const history = await listCriteriaScans(actor(), funder.id)
  assert.equal(history.length, 2)
  assert.equal(history[0]?.id, rejectedProposal.id)
  assert.equal(history[1]?.id, proposed.id)
  const replay = await acceptCriteriaScan(actor(), proposed.id)
  assert.equal(replay.proposal.id, proposed.id)
  assert.equal(replay.proposal.status, "accepted")
})

test("concurrent accept and reject commit exactly one consistent decision", async () => {
  const funder = (await createFunder(actor(), { idempotencyKey: "decision-race-funder", legalName: "Decision Race Capital LLC" })).funder
  const original = await publishFunderCriteria(actor(), funder.id, [
    { field: "fico", operator: "min", unit: "fico", value: 610, unspecified: false },
  ])
  const deal = (await createDeal(actor(), { idempotencyKey: "decision-race-deal", legalName: "Decision Race Merchant LLC" })).deal
  extraction({
    filename: "decision-race.pdf",
    rules: [rule({ field: "fico", operator: "min", unit: "fico", value: 680, unspecified: false, sourceText: "FICO 680" })],
  })
  const document = await uploadSheet(actor(), deal.id, "decision-race.pdf", "decision-race-document")
  const proposal = await scanFunderCriteria(actor(), { funderId: funder.id, documentId: document.id })

  const release = await holdFunderLock(ids.workspace, funder.id)
  const decisions = [acceptCriteriaScan(actor(), proposal.id), rejectCriteriaScan(actor(), proposal.id)]
  await new Promise((resolve) => setTimeout(resolve, 100))
  await release()
  const settled = await Promise.allSettled(decisions)
  assert.equal(settled.filter((result) => result.status === "fulfilled").length, 1)
  assert.equal(settled.filter((result) => result.status === "rejected").length, 1)

  const finalScan = (await listCriteriaScans(actor(), funder.id)).find((item) => item.id === proposal.id)
  const finalCriteria = await listFunderCriteria(actor(), funder.id)
  assert.ok(finalScan)
  if (finalScan.status === "accepted") {
    assert.equal(findRule(finalCriteria.rules, "fico")?.value, 680)
    assert.equal(finalCriteria.criteriaVersion, original.criteriaVersion + 1)
  } else {
    assert.equal(finalScan.status, "rejected")
    assert.equal(findRule(finalCriteria.rules, "fico")?.value, 610)
    assert.equal(finalCriteria.criteriaVersion, original.criteriaVersion)
  }
})

test("MIC-194 only clean vault PDF/PNG/JPEG can be scanned", async () => {
  const funder = (await createFunder(actor(), { idempotencyKey: "vault-funder", legalName: "Vault Capital LLC" })).funder
  const deal = (await createDeal(actor(), { idempotencyKey: "vault-deal", legalName: "Vault Merchant LLC" })).deal
  extraction({
    filename: "clean.png",
    rules: [rule({ field: "positions", operator: "max", unit: "count", value: 3, unspecified: false, sourceText: "Max 3 positions" })],
  })
  extraction({
    filename: "clean.jpg",
    rules: [rule({ field: "positions", operator: "max", unit: "count", value: 2, unspecified: false, sourceText: "Max 2 positions" })],
  })
  const pngDoc = await uploadSheet(actor(), deal.id, "clean.png", "vault-png", png("png-sheet"), "image/png")
  const jpegDoc = await uploadSheet(actor(), deal.id, "clean.jpg", "vault-jpeg", jpeg("jpeg-sheet"), "image/jpeg")
  const pngScan = await scanFunderCriteria(actor(), { funderId: funder.id, documentId: pngDoc.id })
  const jpegScan = await scanFunderCriteria(actor(), { funderId: funder.id, documentId: jpegDoc.id })
  assert.equal(findRule(pngScan.rules, "positions")?.value, 3)
  assert.equal(findRule(jpegScan.rules, "positions")?.value, 2)
  const quarantined = await uploadSheet(actor(), deal.id, "dirty.pdf", "vault-dirty", pdf("dirty"), "application/pdf", "infected")
  await assert.rejects(
    () => scanFunderCriteria(actor(), { funderId: funder.id, documentId: quarantined.id }),
    (error: { status?: number; code?: string }) => error.status === 423 && error.code === "document_not_clean",
  )
  const listed = await listCriteriaScanDocuments(actor(), deal.id)
  assert.equal(listed.some((item) => item.id === pngDoc.id), true)
  assert.equal(listed.some((item) => item.id === jpegDoc.id), true)
  assert.equal(listed.some((item) => item.id === quarantined.id), false)
})

test("MIC-194 retries preserve proposal identity and missing provider fails closed", async () => {
  const funder = (await createFunder(actor(), { idempotencyKey: "retry-funder", legalName: "Retry Capital LLC" })).funder
  const deal = (await createDeal(actor(), { idempotencyKey: "retry-deal", legalName: "Retry Merchant LLC" })).deal
  extraction({
    filename: "retry.pdf",
    rules: [rule({ field: "time_in_business", operator: "min", unit: "months", value: 12, unspecified: false, sourceText: "12 months TIB" })],
  })
  const document = await uploadSheet(actor(), deal.id, "retry.pdf", "retry-doc")
  const first = await scanFunderCriteria(actor(), { funderId: funder.id, documentId: document.id })
  const second = await scanFunderCriteria(actor(), { funderId: funder.id, documentId: document.id })
  assert.equal(second.id, first.id)
  assert.equal(second.version, first.version)
  assert.equal(extractCalls.filter((name) => name === "retry.pdf").length, 1)
  setCriteriaScanProviderForTests()
  delete process.env.MCA_DOCUMENT_AI_PROVIDER
  const other = (await createFunder(actor(), { idempotencyKey: "retry-provider", legalName: "No Provider LLC" })).funder
  extraction({ filename: "no-provider.pdf", rules: [] })
  const missingDoc = await uploadSheet(actor(), deal.id, "no-provider.pdf", "retry-missing")
  await assert.rejects(
    () => scanFunderCriteria(actor(), { funderId: other.id, documentId: missingDoc.id }),
    (error: { status?: number; code?: string }) => error.status === 503 && error.code === "provider_unavailable",
  )
})

test("MIC-194 yearly revenue converts and industry aliases are preserved as source text", async () => {
  const funder = (await createFunder(actor(), { idempotencyKey: "convert-funder", legalName: "Convert Capital LLC" })).funder
  await upsertIndustryAlias(actor(), { alias: "restaurants", naics: "722511", normalizedIndustry: "Food Services" })
  const deal = (await createDeal(actor(), { idempotencyKey: "convert-deal", legalName: "Convert Merchant LLC" })).deal
  extraction({
    filename: "convert.pdf",
    rules: [
      rule({ field: "revenue", operator: "min", unit: "usd_annual", value: 120000, unspecified: false, sourceText: "Minimum $120,000 annual revenue" }),
      rule({ field: "industry", operator: "not_in", unit: "naics", value: ["restaurants"], unspecified: false, sourceText: "No restaurants" }),
    ],
  })
  const document = await uploadSheet(actor(), deal.id, "convert.pdf", "convert-doc")
  const proposal = await scanFunderCriteria(actor(), { funderId: funder.id, documentId: document.id })
  const revenue = findRule(proposal.rules, "revenue")
  const industry = findRule(proposal.rules, "industry")
  assert.equal(revenue?.unit, "usd_monthly")
  assert.equal(revenue?.value, 10000)
  assert.equal(revenue?.sourceText, "Minimum $120,000 annual revenue")
  assert.deepEqual(industry?.value, ["Food Services"])
  assert.equal(industry?.sourceText, "No restaurants")
})

test("MIC-194 HTTP permissions, isolation, accept/reject, and retries", async () => {
  const local = (await createFunder(actor(), { idempotencyKey: "http-local", legalName: "HTTP Local LLC" })).funder
  const remote = (await createFunder(actor(ids.otherWorkspace), { idempotencyKey: "http-remote", legalName: "HTTP Remote LLC" })).funder
  const deal = (await createDeal(actor(), { idempotencyKey: "http-deal", legalName: "HTTP Merchant LLC" })).deal
  extraction({
    filename: "http.pdf",
    rules: [rule({ field: "deposit_count", operator: "min", unit: "count", value: 8, unspecified: false, sourceText: "8 deposits" })],
  })
  const document = await uploadSheet(actor(), deal.id, "http.pdf", "http-doc")
  const created = await scanPost(cookieRequest("/api/mca/funders/scan", tokens.admin, {
    method: "POST",
    body: JSON.stringify({ funderId: local.id, documentId: document.id }),
  }))
  assert.equal(created.status, 200)
  const body = await created.json() as { id: string; status: string; rules: Array<{ field: string; value: number }> }
  assert.equal(body.status, "proposed")
  assert.equal(body.rules[0]?.field, "deposit_count")

  const replay = await scanPost(cookieRequest("/api/mca/funders/scan", tokens.admin, {
    method: "POST",
    body: JSON.stringify({ funderId: local.id, documentId: document.id }),
  }))
  assert.equal(replay.status, 200)
  assert.equal((await replay.json() as { id: string }).id, body.id)

  const listed = await scanGet(cookieRequest(`/api/mca/funders/scan?funderId=${local.id}`, tokens.admin))
  assert.equal(listed.status, 200)
  assert.equal((await listed.json() as { proposals: Array<{ id: string }> }).proposals.some((item) => item.id === body.id), true)

  const item = await scanItemGet(cookieRequest(`/api/mca/funders/scan/${body.id}`, tokens.rep), params(body.id))
  assert.equal(item.status, 200)

  const repWrite = await scanPost(cookieRequest("/api/mca/funders/scan", tokens.rep, {
    method: "POST",
    body: JSON.stringify({ funderId: local.id, documentId: document.id }),
  }))
  assert.equal(repWrite.status, 403)

  const intake = await scanGet(bearerRequest(`/api/mca/funders/scan?funderId=${local.id}`, `intake-secret-${runId}`))
  assert.equal(intake.status, 403)
  assert.equal((await intake.json() as { error: { code: string } }).error.code, "scope_required")
  const readable = await scanGet(bearerRequest(`/api/mca/funders/scan?funderId=${local.id}`, `read-secret-${runId}`))
  assert.equal(readable.status, 200)

  const stolen = await scanGet(cookieRequest(`/api/mca/funders/scan?funderId=${local.id}`, tokens.other))
  assert.equal(stolen.status, 404)
  const foreign = await scanPost(cookieRequest("/api/mca/funders/scan", tokens.admin, {
    method: "POST",
    body: JSON.stringify({ funderId: remote.id, documentId: document.id }),
  }))
  assert.equal(foreign.status, 404)

  const accepted = await scanAccept(cookieRequest(`/api/mca/funders/scan/${body.id}/accept`, tokens.admin, {
    method: "POST",
    body: "{}",
  }), params(body.id))
  assert.equal(accepted.status, 200)
  assert.equal((await accepted.json() as { proposal: { status: string }; criteria: { rules: unknown[] } }).proposal.status, "accepted")

  const rolled = await scanRollback(cookieRequest(`/api/mca/funders/scan/${body.id}/rollback`, tokens.admin, {
    method: "POST",
    body: "{}",
  }), params(body.id))
  assert.equal(rolled.status, 200)

  extraction({
    filename: "http-reject.pdf",
    rules: [rule({ field: "fico", operator: "min", unit: "fico", value: 500, unspecified: false, sourceText: "500" })],
  })
  const rejectDoc = await uploadSheet(actor(), deal.id, "http-reject.pdf", "http-reject-doc")
  const toReject = await scanPost(cookieRequest("/api/mca/funders/scan", tokens.admin, {
    method: "POST",
    body: JSON.stringify({ funderId: local.id, documentId: rejectDoc.id }),
  }))
  const rejectBody = await toReject.json() as { id: string }
  const rejected = await scanReject(cookieRequest(`/api/mca/funders/scan/${rejectBody.id}/reject`, tokens.admin, {
    method: "POST",
    body: "{}",
  }), params(rejectBody.id))
  assert.equal(rejected.status, 200)
  assert.equal((await rejected.json() as { status: string }).status, "rejected")
})
