import test, { after, before } from "node:test"
import assert from "node:assert/strict"
import { closeDatabaseForTests, getDatabase } from "../src/lib/mca/db"
import { createDeal } from "../src/lib/mca/deals/service"
import type { DealActor } from "../src/lib/mca/deals/schema"
import type { DocumentStorage } from "../src/lib/mca/documents/storage"
import { setDocumentStorageForTests } from "../src/lib/mca/documents/storage"
import { setDocumentScannerForTests } from "../src/lib/mca/documents/scanner"
import { getDocument, storeDocument } from "../src/lib/mca/documents/service"
import { runAsBackgroundWorker } from "../src/lib/mca/jobs/queue"
import { runNextBackgroundJob } from "../src/lib/mca/jobs/worker"
import { createPostgresTestDatabase } from "./helpers/postgres-test-db.mjs"

delete process.env.MCA_DOCUMENT_SCANNER
const previousJobs = process.env.MCA_BACKGROUND_JOBS
const previousVercel = process.env.VERCEL
let testDatabase: Awaited<ReturnType<typeof createPostgresTestDatabase>>

const actor = (): DealActor => ({
  workspaceId: "workspace-jobs",
  userId: null,
  membershipId: null,
  role: "admin",
  managedMembershipIds: [],
  activeMembershipIds: [],
  source: "system",
  correlationId: "corr-jobs",
})
const memory = new Map<string, Uint8Array>()
const storage: DocumentStorage = {
  name: "test-memory",
  async putImmutable(key, bytes) { if (memory.has(key)) throw new Error("duplicate storage key"); memory.set(key, new Uint8Array(bytes)) },
  async get(key) { const value = memory.get(key); if (!value) throw new Error("missing storage key"); return new Uint8Array(value) },
}
const minimalPdf = new Uint8Array(Buffer.from("%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\n%%EOF\n"))

async function addWorkspace(id: string) {
  const now = new Date().toISOString()
  await getDatabase().prepare(`INSERT INTO workspaces (id,name,timezone,seat_limit,feature_flags,page_visibility,action_visibility,created_at,updated_at)
    VALUES (?, ?, 'America/New_York', 5, ?, ?, ?, ?, ?)`).run(id, id, JSON.stringify({ reports: true, payments: true, integrations: true }), JSON.stringify({ dashboard: true, deals: true, users: true, reports: true, payments: true, workspace: true, integrations: true }), JSON.stringify({ createDeal: true, exportDeals: true, inviteUsers: true, manageApiKeys: true, viewPaymentTable: true, viewCompanyFinancials: true }), now, now)
}

function countingScanner() {
  let scans = 0
  setDocumentScannerForTests({
    name: "fixture-clean",
    async scan() {
      scans++
      return { status: "clean", provider: "fixture-clean", evidence: { engineVerified: true } }
    },
  })
  return { count: () => scans }
}

let dealId = ""
before(async () => {
  process.env.MCA_BACKGROUND_JOBS = "enabled"
  delete process.env.VERCEL
  testDatabase = await createPostgresTestDatabase("jobs_worker")
  process.env.DATABASE_URL = testDatabase.databaseUrl
  setDocumentStorageForTests(storage)
  await addWorkspace("workspace-jobs")
  dealId = (await createDeal(actor(), { idempotencyKey: "jobs-staging", legalName: "Jobs staging" })).deal.id
})
after(async () => {
  setDocumentStorageForTests(); setDocumentScannerForTests(); await closeDatabaseForTests(); await testDatabase.close()
  if (previousJobs === undefined) delete process.env.MCA_BACKGROUND_JOBS
  else process.env.MCA_BACKGROUND_JOBS = previousJobs
  if (previousVercel === undefined) delete process.env.VERCEL
  else process.env.VERCEL = previousVercel
})

test("Vercel/jobs-enabled deal uploads enqueue document_scan and do not promote until the worker runs", async () => {
  const scanner = countingScanner()
  const stored = await storeDocument(actor(), { dealId, idempotencyKey: "jobs-http-upload", filename: "statement.pdf", mimeType: "application/pdf", bytes: minimalPdf, category: "statement", source: "test" })
  assert.equal(stored.processingState, "pending_scan")
  assert.equal(scanner.count(), 0)
  const job = await getDatabase().prepare<{ kind: string; state: string }>("SELECT kind, state FROM mca_background_jobs WHERE workspace_id = ? AND resource_id = ? AND kind = 'document_scan'").get(actor().workspaceId, stored.id)
  assert.equal(job?.kind, "document_scan")
  assert.equal(job?.state, "queued")
  assert.equal(await runNextBackgroundJob(), true)
  assert.equal(scanner.count(), 1)
  assert.equal((await getDocument(actor(), stored.id)).processingState, "clean")
})

test("storeDocument inside the background worker still scans inline without extra document_scan jobs", async () => {
  const scanner = countingScanner()
  const stored = await runAsBackgroundWorker(() => storeDocument(actor(), { dealId, idempotencyKey: "jobs-worker-inline", filename: "inline.pdf", mimeType: "application/pdf", bytes: minimalPdf, category: "other_stip", source: "test" }))
  assert.equal(stored.processingState, "clean")
  assert.equal(scanner.count(), 1)
  const job = await getDatabase().prepare<{ count: number }>("SELECT COUNT(*)::int AS count FROM mca_background_jobs WHERE workspace_id = ? AND resource_id = ? AND kind = 'document_scan'").get(actor().workspaceId, stored.id)
  assert.equal(job?.count, 0)
})
