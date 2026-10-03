import test, { after, before } from "node:test"
import assert from "node:assert/strict"
import { closeDatabaseForTests, getDatabase, recordAuditEvent } from "../src/lib/mca/db"
import { createDeal } from "../src/lib/mca/deals/service"
import type { DealActor } from "../src/lib/mca/deals/schema"
import type { DocumentStorage } from "../src/lib/mca/documents/storage"
import { setDocumentStorageForTests } from "../src/lib/mca/documents/storage"
import { setDocumentScannerForTests, type DocumentScanner } from "../src/lib/mca/documents/scanner"
import { findDocumentWithScanSnapshot, markDocumentNotScannedIfUnchanged, updateDocumentScan } from "../src/lib/mca/documents/repository"
import { getDocument, getDocumentContent, listDocuments, storeDocument } from "../src/lib/mca/documents/service"
import { databaseIdentity, isProductionDatabase, productionDatabaseWarning, rescanBypassedDocuments } from "../src/lib/mca/documents/rescan"
import { createPostgresTestDatabase } from "./helpers/postgres-test-db.mjs"
import { spawnSync } from "node:child_process"

delete process.env.MCA_DOCUMENT_SCANNER
delete process.env.MCA_BACKGROUND_JOBS
delete process.env.MCA_DOCUMENT_SCAN_BYPASS
delete process.env.MCA_DEAL_AGENT_ENABLED
delete process.env.VERCEL
let testDatabase: Awaited<ReturnType<typeof createPostgresTestDatabase>>

const WS = "workspace-rescan", OTHER = "workspace-rescan-other"
const actor = (workspaceId = WS): DealActor => ({ workspaceId, userId: null, membershipId: null, role: "admin", managedMembershipIds: [], activeMembershipIds: [], source: "system", correlationId: `corr-${workspaceId}` })
const memory = new Map<string, Uint8Array>()
const storage: DocumentStorage = {
  name: "test-memory",
  async putImmutable(key, bytes) { if (memory.has(key)) throw new Error("duplicate storage key"); memory.set(key, new Uint8Array(bytes)) },
  async get(key) { const value = memory.get(key); if (!value) throw new Error("missing storage key"); return new Uint8Array(value) },
}
const pdf = (label: string) => new Uint8Array(Buffer.from(`%PDF-1.4\n${label}\n%%EOF\n`))
let scans: string[] = []
/** Runs inside scan(), i.e. after the tool read the row and before it writes: simulates a concurrent change. */
let duringScan: ((filename: string) => Promise<void>) | undefined
/** Real-scanner stand-in: the filename decides the verdict. */
const fixtureScanner: DocumentScanner = {
  name: "fixture-av",
  async scan(_bytes, filename) {
    scans.push(filename)
    await duringScan?.(filename)
    if (filename.startsWith("infected")) return { status: "infected", provider: "fixture-av", evidence: { signatureDetected: true } }
    if (filename.startsWith("flaky")) return { status: "error", provider: "fixture-av", evidence: { reason: "fixture_timeout" } }
    return { status: "clean", provider: "fixture-av", evidence: { engineVerified: true } }
  },
}

async function addWorkspace(id: string) {
  const now = new Date().toISOString()
  await getDatabase().prepare(`INSERT INTO workspaces (id,name,timezone,seat_limit,feature_flags,page_visibility,action_visibility,created_at,updated_at)
    VALUES (?, ?, 'America/New_York', 5, ?, ?, ?, ?, ?)`).run(id, id, JSON.stringify({ reports: true, payments: true, integrations: true }), JSON.stringify({ dashboard: true, deals: true, users: true, reports: true, payments: true, workspace: true, integrations: true }), JSON.stringify({ createDeal: true, exportDeals: true, inviteUsers: true, manageApiKeys: true, viewPaymentTable: true, viewCompanyFinancials: true }), now, now)
}

async function withEnv(values: Record<string, string | undefined>, run: () => Promise<void>) {
  const previous = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]))
  for (const [key, value] of Object.entries(values)) { if (value === undefined) delete process.env[key]; else process.env[key] = value }
  try { await run() } finally { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value } }
}

const snapshot = async () => ({
  documents: await getDatabase().prepare("SELECT id, processing_state, scan_provider, scan_evidence, scan_attempted_at, updated_at FROM mca_documents ORDER BY id").all(),
  audits: (await getDatabase().prepare<{ count: number }>("SELECT count(*)::int AS count FROM audit_events").get())?.count,
})

let dealId = "", otherDealId = ""
const docs: Record<string, string> = {}
let confirm = ""

before(async () => {
  testDatabase = await createPostgresTestDatabase("documents_rescan")
  process.env.DATABASE_URL = testDatabase.databaseUrl
  confirm = databaseIdentity()
  setDocumentStorageForTests(storage)
  await addWorkspace(WS); await addWorkspace(OTHER)
  dealId = (await createDeal(actor(), { idempotencyKey: "rescan-deal", legalName: "Rescan staging" })).deal.id
  otherDealId = (await createDeal(actor(OTHER), { idempotencyKey: "rescan-other", legalName: "Other tenant" })).deal.id
  const upload = async (key: string, workspaceId = WS, deal = dealId) => (await storeDocument(actor(workspaceId), { dealId: deal, idempotencyKey: key, filename: `${key}.pdf`, mimeType: "application/pdf", bytes: pdf(key), category: "statement", source: "test" })).id
  // Accepted by the scan bypass: marked scan_provider='not_scanned'.
  await withEnv({ MCA_DOCUMENT_SCAN_BYPASS: "true" }, async () => {
    setDocumentScannerForTests()
    for (const key of ["clean-a", "clean-b", "infected-a", "flaky-a", "corrupt-a"]) docs[key] = await upload(key)
    docs.other = await upload("clean-other", OTHER, otherDealId)
  })
  // A real scan before the bypass: never a candidate.
  setDocumentScannerForTests(fixtureScanner)
  docs.scanned = await upload("clean-scanned")
  // Released under the bypass but later relabelled without the marker (only the ID list or the audit log knows).
  setDocumentScannerForTests()
  await withEnv({ MCA_DOCUMENT_SCAN_BYPASS: "true" }, async () => {
    docs.listed = await upload("clean-listed")
    docs.audited = await upload("clean-audited")
  })
  for (const key of ["listed", "audited"]) await updateDocumentScan(WS, docs[key], "clean", "legacy-release", { released: true }, new Date().toISOString())
  // A quarantined file is never touched.
  docs.blocked = await upload("clean-blocked")
  await updateDocumentScan(WS, docs.blocked, "quarantined", "not_scanned", { scanBypassed: true }, new Date().toISOString())
  const corrupt = await getDocument(actor(), docs["corrupt-a"])
  memory.set(corrupt.storageKey, pdf("tampered"))
  setDocumentScannerForTests(fixtureScanner)
})
after(async () => {
  setDocumentStorageForTests(); setDocumentScannerForTests(); await closeDatabaseForTests(); await testDatabase.close()
})

test("databaseIdentity names user@host/database, never the password or port", () => {
  assert.equal(databaseIdentity("postgres://user:secret@db.example.test:6543/fundlane_prod?sslmode=require"), "user@db.example.test/fundlane_prod")
  assert.equal(databaseIdentity("postgres://db.example.test/fundlane"), "db.example.test/fundlane", "no user, no @")
  assert.equal(databaseIdentity("postgres://mca_app%2Eabc:pw@h.example.test/db"), "mca_app.abc@h.example.test/db", "username is decoded")
  assert.equal(databaseIdentity(""), "")
  assert.equal(databaseIdentity("not a url"), "")
  const testUrl = new URL(testDatabase.databaseUrl)
  assert.equal(confirm, `${decodeURIComponent(testUrl.username)}@${testUrl.hostname}${testUrl.pathname}`)
})

// Prod and staging share the Supabase pooler host and database; the project ref is only in the username.
const POOLER = "aws-0-us-west-2.pooler.supabase.com:6543/postgres"
const PASSWORD = "Sup3r-Secret-Passw0rd-xyz"
const PROD_URL = `postgresql://mca_app.drubsfvhlggmtyiigwxy:${PASSWORD}@${POOLER}`
const STAGING_URL = `postgresql://mca_app.djnhfcxbuigsnqwcpdrz:${PASSWORD}@${POOLER}`

test("pooler URLs that differ only by project ref give different confirm strings; a staging value is refused on prod", async () => {
  assert.equal(databaseIdentity(PROD_URL), "mca_app.drubsfvhlggmtyiigwxy@aws-0-us-west-2.pooler.supabase.com/postgres")
  assert.equal(databaseIdentity(STAGING_URL), "mca_app.djnhfcxbuigsnqwcpdrz@aws-0-us-west-2.pooler.supabase.com/postgres")
  assert.notEqual(databaseIdentity(PROD_URL), databaseIdentity(STAGING_URL))
  const before = await snapshot()
  // The guard runs before any database access, so the fake prod URL is never contacted.
  await withEnv({ DATABASE_URL: PROD_URL }, async () => {
    for (const mode of [{}, { backfillMarker: true, ids: ["x"] }]) {
      await assert.rejects(() => rescanBypassedDocuments(actor(), { ...mode, apply: true, confirmDatabase: databaseIdentity(STAGING_URL) }), (error: Error & { code?: string }) => {
        assert.equal(error.code, "rescan_database_unconfirmed")
        assert.ok(error.message.includes(databaseIdentity(PROD_URL)), "the refusal names the exact expected value")
        assert.ok(!error.message.includes(PASSWORD), "the refusal never prints the password")
        return true
      })
    }
  })
  assert.deepEqual(await snapshot(), before)
})

test("the password never appears in the confirm string, the banner, the result or the script output", async () => {
  for (const url of [PROD_URL, STAGING_URL, `postgres://u:${encodeURIComponent(PASSWORD)}@127.0.0.1:5432/db`]) assert.ok(!databaseIdentity(url).includes(PASSWORD))
  for (const apply of [false, true]) assert.ok(!productionDatabaseWarning(apply).includes(PASSWORD))
  const realPassword = decodeURIComponent(new URL(testDatabase.databaseUrl).password)
  const preview = await rescanBypassedDocuments(actor())
  if (realPassword) assert.ok(!JSON.stringify(preview).includes(realPassword))
  // The script against the disposable test DB: a preview, and an apply refused for a wrong confirm value.
  for (const args of [[], ["--apply", "--confirm-database=wrong"]]) {
    const run = spawnSync(process.execPath, ["--conditions=react-server", "--import", "tsx", "scripts/documents/rescan.ts", `--workspace-id=${WS}`, ...args],
      { encoding: "utf8", env: testDatabase.env({ MCA_DOCUMENT_SCAN_BYPASS: "", MCA_DOCUMENT_SCANNER: "" }), timeout: 60_000 })
    const output = `${run.stdout}${run.stderr}`
    assert.ok(output.includes(confirm), `script output names the target (${args.join(" ") || "preview"})`)
    if (realPassword) assert.ok(!output.includes(realPassword), "script output never contains the password")
    if (args.length) { assert.equal(run.status, 1); assert.match(output, /Refusing to write: pass --confirm-database=/) }
    else assert.equal(run.status, 0, output)
  }
})

test("production database detection matches the prod project ref in host or username only, and the warning leaks nothing", () => {
  const ref = "drubsfvhlggmtyiigwxy"
  for (const url of [
    `postgresql://postgres.${ref}:s3cret-pass@aws-0-us-east-1.pooler.supabase.com:6543/postgres`,
    `postgresql://postgres:s3cret-pass@db.${ref}.supabase.co:5432/postgres`,
    `postgres://POSTGRES.${ref.toUpperCase()}:x@pooler.example.test/postgres`,
    `postgres://postgres%2E${ref}:x@pooler.example.test/postgres`,
  ]) assert.equal(isProductionDatabase(url), true, url.replace(/:[^:@/]+@/, ":***@"))
  for (const url of [
    testDatabase.databaseUrl,
    "postgres://postgres:postgres@127.0.0.1:5432/fundlane_test_documents_rescan_ab12cd34ef",
    "postgresql://postgres.abcdefghijklmnopqrst:x@aws-0-us-east-1.pooler.supabase.com:6543/postgres",
    `postgres://postgres:${ref}@localhost:5432/postgres`,
    `postgres://postgres:x@localhost:5432/${ref}`,
    "",
  ]) assert.equal(isProductionDatabase(url), false, url)
  assert.equal(isProductionDatabase(undefined), false)
  assert.equal(isProductionDatabase(testDatabase.databaseUrl), false)
  for (const apply of [false, true]) {
    const warning = productionDatabaseWarning(apply)
    assert.match(warning, /PRODUCTION DATABASE/)
    assert.match(warning, apply ? /--apply WILL CHANGE PRODUCTION/ : /Preview only/)
    assert.doesNotMatch(warning, /s3cret|postgres:|supabase\.co|pooler/)
  }
})

test("bypassed deal documents carry a not-virus-checked marker; real scans do not", async () => {
  const byId = new Map((await listDocuments(actor(), dealId)).map(doc => [doc.id, doc]))
  assert.equal(byId.get(docs["clean-a"])?.scanBypassed, true)
  assert.equal(byId.get(docs.scanned)?.scanBypassed, undefined)
  assert.equal(byId.get(docs.listed)?.scanBypassed, undefined)
  assert.equal(byId.get(docs.blocked)?.scanBypassed, undefined, "only available files carry the marker")
})

test("rescan refuses non-system actors, unconfirmed databases, the bypass and an unconfigured scanner, writing nothing", async () => {
  const before = await snapshot()
  await assert.rejects(() => rescanBypassedDocuments({ ...actor(), source: "user" }, { apply: true, confirmDatabase: confirm }), { code: "rescan_forbidden" })
  await assert.rejects(() => rescanBypassedDocuments(actor(), { apply: true }), { code: "rescan_database_unconfirmed" })
  await assert.rejects(() => rescanBypassedDocuments(actor(), { apply: true, confirmDatabase: "db.example.test/fundlane_prod" }), { code: "rescan_database_unconfirmed" })
  await withEnv({ DATABASE_URL: undefined }, () => assert.rejects(() => rescanBypassedDocuments(actor(), { apply: true, confirmDatabase: "" }), { code: "rescan_database_unknown" }))
  await withEnv({ MCA_DOCUMENT_SCAN_BYPASS: "true" }, () => assert.rejects(() => rescanBypassedDocuments(actor(), { apply: true, confirmDatabase: confirm }), { code: "rescan_scanner_unavailable" }))
  setDocumentScannerForTests()
  try {
    await assert.rejects(() => rescanBypassedDocuments(actor(), { apply: true, confirmDatabase: confirm }), { code: "rescan_scanner_unavailable" })
    const preview = await rescanBypassedDocuments(actor())
    assert.equal(preview.scannerReady, false)
  } finally { setDocumentScannerForTests(fixtureScanner) }
  await assert.rejects(() => rescanBypassedDocuments(actor(), { backfillMarker: true }), { code: "rescan_ids_required" })
  assert.deepEqual(await snapshot(), before)
})

test("preview lists marked files in this workspace only and writes nothing", async () => {
  const before = await snapshot()
  scans = []
  const preview = await rescanBypassedDocuments(actor(), { ids: [docs.other, "missing-id"] })
  assert.equal(preview.apply, false)
  assert.equal(preview.scannerReady, true)
  assert.equal(preview.database, confirm)
  assert.equal(preview.productionDatabase, false)
  assert.equal(preview.candidates, 5)
  assert.deepEqual(new Set(preview.notFound), new Set([docs.other, "missing-id"]))
  assert.deepEqual(preview.notReady, [{ id: docs.blocked, state: "quarantined" }])
  assert.deepEqual(scans, [])
  assert.deepEqual(await snapshot(), before)
  const withAudit = await rescanBypassedDocuments(actor(), { includeAudit: true })
  assert.equal(withAudit.candidates, 7, "the audit log also finds the relabelled files")
})

test("apply rescans with the real scanner: clean clears the marker, infected quarantines, errors and bad bytes stay as they were; reruns are no-ops", async () => {
  const flakyBefore = await getDatabase().prepare("SELECT * FROM mca_documents WHERE id = ?").get(docs["flaky-a"])
  const corruptBefore = await getDatabase().prepare("SELECT * FROM mca_documents WHERE id = ?").get(docs["corrupt-a"])
  const otherBefore = await getDatabase().prepare("SELECT * FROM mca_documents WHERE id = ?").get(docs.other)
  const result = await rescanBypassedDocuments(actor(), { apply: true, confirmDatabase: confirm, ids: [docs.listed] })
  assert.equal(result.rescannedClean, 3)
  assert.deepEqual(result.quarantined, [docs["infected-a"]])
  assert.deepEqual(new Map(result.failed.map(item => [item.id, item.code])), new Map([[docs["flaky-a"], "scan_error"], [docs["corrupt-a"], "document_integrity_failed"]]))

  const cleared = await getDocument(actor(), docs["clean-a"])
  assert.equal(cleared.processingState, "clean")
  assert.equal(cleared.scanProvider, "fixture-av")
  assert.equal(cleared.scanEvidence?.malwareScanPerformed, true)
  assert.equal(cleared.scanEvidence?.rescannedAfterBypass, true)
  assert.equal(cleared.scanEvidence?.scanBypassed, undefined)
  assert.equal((await listDocuments(actor(), dealId)).find(doc => doc.id === docs["clean-a"])?.scanBypassed, undefined)
  assert.equal((await getDocument(actor(), docs.listed)).scanProvider, "fixture-av")
  const audit = await getDatabase().prepare<{ metadata: string }>("SELECT metadata FROM audit_events WHERE resource_id = ? AND action = 'document.rescanned'").get(docs["clean-a"])
  assert.deepEqual(JSON.parse(audit!.metadata), { state: "clean", provider: "fixture-av", malwareScanPerformed: true, previousProvider: "not_scanned" })

  assert.equal((await getDocument(actor(), docs["infected-a"])).processingState, "quarantined")
  await assert.rejects(() => getDocumentContent(actor(), docs["infected-a"]), { code: "document_not_clean" })
  assert.deepEqual(await getDatabase().prepare("SELECT * FROM mca_documents WHERE id = ?").get(docs["flaky-a"]), flakyBefore)
  assert.deepEqual(await getDatabase().prepare("SELECT * FROM mca_documents WHERE id = ?").get(docs["corrupt-a"]), corruptBefore)
  assert.deepEqual(await getDatabase().prepare("SELECT * FROM mca_documents WHERE id = ?").get(docs.other), otherBefore, "other tenants are untouched")

  scans = []
  const rerun = await rescanBypassedDocuments(actor(), { apply: true, confirmDatabase: confirm, ids: [docs.listed, docs["clean-a"]] })
  assert.equal(rerun.rescannedClean, 0)
  assert.equal(rerun.alreadyScanned, 2)
  assert.deepEqual(rerun.quarantined, [])
  assert.deepEqual(new Set(rerun.failed.map(item => item.id)), new Set([docs["flaky-a"], docs["corrupt-a"]]))
  assert.deepEqual(scans, ["flaky-a.pdf"], "only files still unverified are scanned again")
})

test("opt-in marker backfill labels listed files that lack the marker, without changing state or scan time, once", async () => {
  const before = await getDocument(actor(), docs.audited)
  const preview = await rescanBypassedDocuments(actor(), { backfillMarker: true, ids: [docs.audited, docs.scanned, docs["flaky-a"], docs.blocked] })
  assert.equal(preview.mode, "backfill_marker")
  assert.equal(preview.candidates, 1)
  assert.equal((await getDocument(actor(), docs.audited)).scanProvider, "legacy-release")
  await assert.rejects(() => rescanBypassedDocuments(actor(), { backfillMarker: true, apply: true, ids: [docs.audited] }), { code: "rescan_database_unconfirmed" })
  // The backfill only adds a label, so it does not need a scanner.
  await withEnv({ MCA_DOCUMENT_SCAN_BYPASS: "true" }, async () => {
    const applied = await rescanBypassedDocuments(actor(), { backfillMarker: true, apply: true, confirmDatabase: confirm, ids: [docs.audited, docs.scanned, docs["flaky-a"], docs.blocked] })
    assert.equal(applied.markerBackfilled, 1)
    assert.equal(applied.alreadyScanned, 2, "already scanned by a real scanner, or already marked")
    assert.deepEqual(applied.notReady, [{ id: docs.blocked, state: "quarantined" }])
  })
  const marked = await getDocument(actor(), docs.audited)
  assert.equal(marked.processingState, "clean")
  assert.equal(marked.scanProvider, "not_scanned")
  assert.equal(marked.scanEvidence?.markerBackfilled, true)
  assert.equal(marked.scanAttemptedAt, before.scanAttemptedAt)
  assert.equal((await listDocuments(actor(), dealId)).find(doc => doc.id === docs.audited)?.scanBypassed, true)
  assert.equal((await getDocument(actor(), docs.scanned)).scanProvider, "fixture-av")
  const again = await rescanBypassedDocuments(actor(), { backfillMarker: true, apply: true, confirmDatabase: confirm, ids: [docs.audited] })
  assert.equal(again.markerBackfilled, 0)
  // The marker makes the file a normal rescan candidate.
  const rescan = await rescanBypassedDocuments(actor(), { apply: true, confirmDatabase: confirm })
  assert.equal(rescan.rescannedClean, 1)
  assert.equal((await getDocument(actor(), docs.audited)).scanProvider, "fixture-av")
})

test("audit-log discovery is opt-in and tenant-scoped", async () => {
  await recordAuditEvent({ context: actor(OTHER), action: "document.ready", resourceType: "document", resourceId: docs.other, metadata: { state: "clean", malwareScanPerformed: false, provider: "not_scanned" } })
  const result = await rescanBypassedDocuments(actor(), { includeAudit: true })
  assert.ok(!result.notFound.includes(docs.other))
  assert.equal(result.candidates, 2, "only the still-unverified flaky and corrupt files remain")
})

test("compare-and-set: a concurrent quarantine or real scan wins; skipped files get no audit row and are not failures", async () => {
  const RACE = "workspace-rescan-race"
  await addWorkspace(RACE)
  const raceDeal = (await createDeal(actor(RACE), { idempotencyKey: "race-deal", legalName: "Race staging" })).deal.id
  const ids: Record<string, string> = {}
  setDocumentScannerForTests()
  await withEnv({ MCA_DOCUMENT_SCAN_BYPASS: "true" }, async () => {
    for (const key of ["race-quarantine", "race-realscan", "race-provider", "race-time", "race-marker", "race-ok"]) {
      ids[key] = (await storeDocument(actor(RACE), { dealId: raceDeal, idempotencyKey: key, filename: `${key}.pdf`, mimeType: "application/pdf", bytes: pdf(key), category: "statement", source: "test" })).id
    }
  })
  setDocumentScannerForTests(fixtureScanner)
  const set = (id: string, sql: string, ...values: unknown[]) => getDatabase().prepare(`UPDATE mca_documents SET ${sql} WHERE id = ?`).run(...values, id)
  const later = "2099-01-01T00:00:00.000Z"
  duringScan = async (filename) => {
    const key = filename.replace(/\.pdf$/, "")
    // (1) the status changes: another run quarantined the file.
    if (key === "race-quarantine") await set(ids[key], "processing_state = 'quarantined', scan_provider = 'other-av', scan_evidence = ?, scan_attempted_at = ?", JSON.stringify({ signatureDetected: true }), later)
    // (2) same status, but a real scan cleared it (provider, evidence and time change).
    if (key === "race-realscan") await set(ids[key], "scan_provider = 'real-av', scan_evidence = ?, scan_attempted_at = ?", JSON.stringify({ malwareScanPerformed: true }), later)
    // Same status; only the provider, only the scan time, or only the marker column (scan_evidence) changes.
    if (key === "race-provider") await set(ids[key], "scan_provider = 'real-av'")
    if (key === "race-time") await set(ids[key], "scan_attempted_at = ?", later)
    if (key === "race-marker") await set(ids[key], "scan_evidence = ?", JSON.stringify({ scanBypassed: true, note: "relabelled" }))
    // What the concurrent writer left; the rescan must not change it.
    afterRace[key] = await row(ids[key])
  }
  const row = (id: string) => getDatabase().prepare("SELECT processing_state, scan_provider, scan_evidence, scan_attempted_at, updated_at FROM mca_documents WHERE id = ?").get(id)
  const rows = async () => Object.fromEntries(await Promise.all(Object.entries(ids).map(async ([key, id]) => [key, await row(id)])))
  const afterRace: Record<string, unknown> = {}
  const scanner: DocumentScanner = { name: "fixture-av", async scan(bytes, filename) {
    const verdict = await fixtureScanner.scan(bytes, filename)
    return filename === "race-realscan.pdf" ? { status: "infected", provider: "fixture-av", evidence: { signatureDetected: true } } : verdict
  } }
  setDocumentScannerForTests(scanner)
  try {
    const result = await rescanBypassedDocuments(actor(RACE), { apply: true, confirmDatabase: confirm })
    assert.deepEqual(new Set(result.changedConcurrently), new Set([ids["race-quarantine"], ids["race-realscan"], ids["race-provider"], ids["race-time"], ids["race-marker"]]))
    assert.deepEqual(result.failed, [], "skipped files are not failures, so the exit code is unaffected")
    assert.deepEqual(result.quarantined, [], "the real scan's clean result is not overwritten by this run's infected verdict")
    assert.equal(result.rescannedClean, 1)
    // The concurrently changed rows are exactly as the concurrent writer left them.
    const final = await rows()
    for (const key of ["race-quarantine", "race-realscan", "race-provider", "race-time", "race-marker"]) assert.deepEqual(final[key], afterRace[key], key)
    assert.equal((final["race-quarantine"] as { processing_state: string }).processing_state, "quarantined", "not overwritten to clean")
    assert.equal((final["race-realscan"] as { scan_provider: string }).scan_provider, "real-av")
    const audits = await getDatabase().prepare<{ resource_id: string }>("SELECT resource_id FROM audit_events WHERE workspace_id = ? AND action = 'document.rescanned'").all(RACE)
    assert.deepEqual(audits.map(row => row.resource_id), [ids["race-ok"]], "only the written file has an audit row")
  } finally {
    duringScan = undefined
    setDocumentScannerForTests(fixtureScanner)
  }
})

test("compare-and-set backfill: a stale read writes nothing", async () => {
  const found = (await findDocumentWithScanSnapshot(WS, docs.scanned))!
  await getDatabase().prepare("UPDATE mca_documents SET scan_attempted_at = ? WHERE id = ?").run("2099-02-02T00:00:00.000Z", docs.scanned)
  const before = await getDatabase().prepare("SELECT * FROM mca_documents WHERE id = ?").get(docs.scanned)
  assert.equal(await markDocumentNotScannedIfUnchanged(getDatabase(), WS, docs.scanned, found.seen, { scanBypassed: true }, new Date().toISOString()), false)
  assert.deepEqual(await getDatabase().prepare("SELECT * FROM mca_documents WHERE id = ?").get(docs.scanned), before)
  const fresh = (await findDocumentWithScanSnapshot(WS, docs.scanned))!
  assert.equal(await markDocumentNotScannedIfUnchanged(getDatabase(), "workspace-rescan-other", docs.scanned, fresh.seen, { scanBypassed: true }, new Date().toISOString()), false, "tenant-scoped")
  assert.deepEqual(await getDatabase().prepare("SELECT * FROM mca_documents WHERE id = ?").get(docs.scanned), before)
})
