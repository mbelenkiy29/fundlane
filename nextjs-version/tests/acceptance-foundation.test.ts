import assert from "node:assert/strict"
import { spawn, type ChildProcess } from "node:child_process"
import { once } from "node:events"
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { backup } from "../scripts/ops/backup-database"
import { restoreDrill } from "../scripts/ops/restore-drill"
import { sha256 } from "../scripts/ops/safety"
import { claimBackgroundJob, completeBackgroundJob, type BackgroundJob } from "../src/lib/mca/jobs/queue"
import { closeDatabaseForTests } from "../src/lib/mca/db"
import { createDeal, getDealForDocument } from "../src/lib/mca/deals/service"
import type { DealActor } from "../src/lib/mca/deals/schema"
import { getDocument, getDocumentContent, storeDocument } from "../src/lib/mca/documents/service"
import { setDocumentScannerForTests } from "../src/lib/mca/documents/scanner"
import { FilesystemDocumentStorage, setDocumentStorageForTests } from "../src/lib/mca/documents/storage"
import { createPostgresTestDatabase } from "./helpers/postgres-test-db.mjs"

// Test-only envelope. Production ops use age; this does not replace that format.
function seal(bytes: Buffer, key: Buffer): Buffer {
  const nonce = randomBytes(12)
  const cipher = createCipheriv("aes-256-gcm", key, nonce)
  const ciphertext = Buffer.concat([cipher.update(bytes), cipher.final()])
  return Buffer.concat([nonce, cipher.getAuthTag(), ciphertext])
}
function unseal(bytes: Buffer, key: Buffer): Buffer {
  const decipher = createDecipheriv("aes-256-gcm", key, bytes.subarray(0, 12))
  decipher.setAuthTag(bytes.subarray(12, 28))
  return Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()])
}
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex")
const actor = (workspaceId = "t0-company-a"): DealActor => ({ workspaceId, userId: null, membershipId: null, role: "admin", managedMembershipIds: [], activeMembershipIds: [], source: "system", correlationId: "t0-synthetic" })
const denied = (code: string) => (error: unknown) => (error as { code?: string }).code === code

test("T0 encrypted local restore preserves linked SQL and private bytes with tenant/role/quarantine denial", async (t) => {
  const source = await createPostgresTestDatabase("t0_source")
  const target = await createPostgresTestDatabase("t0_restore", { migrateSchema: false })
  const root = await mkdtemp(join(tmpdir(), "fundlane-t0-restore-"))
  const oldDatabase = process.env.DATABASE_URL
  const storage = new FilesystemDocumentStorage(join(root, "source-files"))
  const restoredStorage = new FilesystemDocumentStorage(join(root, "restored-files"))
  const started = performance.now()
  try {
    process.env.DATABASE_URL = source.databaseUrl
    setDocumentStorageForTests(storage)
    const now = new Date().toISOString()
    for (const id of ["t0-company-a", "t0-company-b"]) {
      await source.query(`INSERT INTO workspaces (id,name,timezone,seat_limit,feature_flags,page_visibility,action_visibility,created_at,updated_at)
        VALUES ($1,$1,'UTC',5,'{}','{}','{"createDeal":true}',$2,$2)`, [id, now])
    }
    await source.query(`INSERT INTO users (id,email,name,application_identifier,created_at,updated_at)
      VALUES ('t0-rep','t0-rep@example.test','Synthetic Rep','T0-REP',$1,$1)`, [now])
    await source.query(`INSERT INTO memberships (id,workspace_id,user_id,role,status,created_at,updated_at)
      VALUES ('t0-membership','t0-company-a','t0-rep','rep','active',$1,$1)`, [now])
    await source.query(`INSERT INTO company_billing_invoices (stripe_invoice_id,workspace_id,status,currency,amount_due,amount_paid,amount_remaining,created_at,synced_at)
      VALUES ('t0-invoice','t0-company-a','paid','usd',100,100,0,$1,$1)`, [now])
    await source.query(`INSERT INTO company_billing_payments (stripe_payment_id,stripe_invoice_id,workspace_id,status,amount_paid,currency,synced_at)
      VALUES ('t0-payment','t0-invoice','t0-company-a','succeeded',100,'usd',$1)`, [now])
    await source.query(`INSERT INTO mca_credit_accounts (id,workspace_id,user_id,created_at) VALUES ('t0-account','t0-company-a','t0-rep',$1)`, [now])
    await source.query(`INSERT INTO mca_credit_ledger (id,account_id,event_key,kind,amount,source,created_at) VALUES ('t0-ledger','t0-account','t0-credit','purchase',100,'synthetic',$1)`, [now])
    const deal = (await createDeal(actor(), { idempotencyKey: "t0-deal", legalName: "Synthetic Restore Merchant" })).deal
    const bytes = Buffer.from("%PDF-1.4\nSynthetic private recovery marker\n%%EOF\n")
    setDocumentScannerForTests({ name: "safe-clean-fixture", async scan() { return { status: "clean", provider: "safe-clean-fixture", evidence: { engineVerified: true } } } })
    const clean = await storeDocument(actor(), { dealId: deal.id, idempotencyKey: "t0-clean", filename: "synthetic.pdf", mimeType: "application/pdf", bytes, category: "statement", source: "test" })
    setDocumentScannerForTests({ name: "safe-infected-response", async scan() { return { status: "infected", provider: "safe-infected-response", evidence: { signatureDetected: true } } } })
    const blocked = await storeDocument(actor(), { dealId: deal.id, idempotencyKey: "t0-blocked", filename: "synthetic-blocked.pdf", mimeType: "application/pdf", bytes, category: "statement", source: "test" })
    const records = await source.query("SELECT id,storage_key,checksum,byte_length,processing_state FROM mca_documents ORDER BY id")
    const files = await Promise.all(records.rows.map(async (row) => ({ key: row.storage_key as string, bytes: Buffer.from(await storage.get(row.storage_key)).toString("base64") })))
    const result = await backup(["--confirm", "--kind", "pre-migration", "--directory", root, "--synthetic"], { MCA_OPS_BACKUP_ENABLED: "true", MCA_OPS_SOURCE_DATABASE_URL: source.databaseUrl })
    const dumpPath = result.match(/^Archive: (.+)$/m)![1]
    const key = randomBytes(32)
    const encrypted = seal(Buffer.from(JSON.stringify({ dump: (await readFile(dumpPath)).toString("base64"), files })), key)
    const archive = join(root, "synthetic.bundle.aesgcm")
    await writeFile(archive, encrypted, { mode: 0o600 })
    assert.equal(encrypted.includes(bytes), false)
    assert.equal(encrypted.includes(Buffer.from("PGDMP")), false)
    assert.throws(() => unseal(encrypted, randomBytes(32)))
    const tampered = Buffer.from(encrypted); tampered[tampered.length - 1] ^= 1
    assert.throws(() => unseal(tampered, key))
    await rm(dumpPath)
    await rm(join(root, "source-files"), { recursive: true })
    await closeDatabaseForTests()
    // Source database is deleted: restoration cannot silently read it.
    await source.close()
    const decoded = JSON.parse(unseal(await readFile(archive), key).toString()) as { dump: string; files: { key: string; bytes: string }[] }
    const restoredDump = join(root, "restore.dump")
    await writeFile(restoredDump, Buffer.from(decoded.dump, "base64"), { mode: 0o600 })
    const verification = await restoreDrill(["--confirm", "--archive", restoredDump, "--sha256", await sha256(restoredDump)], { MCA_OPS_RESTORE_DRILL_ENABLED: "true", MCA_OPS_TARGET_DATABASE_URL: target.databaseUrl, MCA_OPS_SOURCE_DATABASE_URL: source.databaseUrl })
    assert.match(verification, /integrity_ok/)
    assert.deepEqual((await target.query("SELECT id,storage_key,checksum,byte_length,processing_state FROM mca_documents ORDER BY id")).rows, records.rows)
    for (const file of decoded.files) await restoredStorage.putImmutable(file.key, Buffer.from(file.bytes, "base64"))
    for (const row of records.rows) {
      const restored = await restoredStorage.get(row.storage_key)
      assert.equal(restored.byteLength, row.byte_length)
      assert.equal(hash(restored), row.checksum)
    }
    assert.equal((await target.query("SELECT p.amount_paid,i.status FROM company_billing_payments p JOIN company_billing_invoices i USING(stripe_invoice_id) WHERE p.stripe_payment_id='t0-payment'")).rows[0].amount_paid, "100")
    assert.equal((await target.query("SELECT l.amount FROM mca_credit_ledger l JOIN mca_credit_accounts a ON a.id=l.account_id WHERE a.workspace_id='t0-company-a'")).rows[0].amount, 100)
    assert.equal((await target.query("SELECT m.role FROM memberships m JOIN users u ON u.id=m.user_id JOIN workspaces w ON w.id=m.workspace_id WHERE m.id='t0-membership'")).rows[0].role, "rep")
    process.env.DATABASE_URL = target.databaseUrl
    setDocumentStorageForTests(restoredStorage)
    assert.deepEqual(Buffer.from((await getDocumentContent(actor(), clean.id)).bytes), bytes)
    await assert.rejects(getDocumentContent(actor("t0-company-b"), clean.id), denied("document_not_found"))
    await assert.rejects(getDealForDocument(actor("t0-company-b"), deal.id))
    const rep: DealActor = { ...actor(), source: "user", role: "rep", userId: "t0-rep", membershipId: "t0-membership", activeMembershipIds: ["t0-membership"] }
    await assert.rejects(getDocumentContent(rep, clean.id))
    await assert.rejects(getDocumentContent(actor(), blocked.id), denied("document_not_clean"))
    const record = await getDocument(actor(), clean.id)
    await writeFile(join(root, "restored-files", record.storageKey), Buffer.alloc(bytes.length, 1))
    await assert.rejects(getDocumentContent(actor(), clean.id), denied("document_integrity_failed"))
    await writeFile(join(root, "restored-files", record.storageKey), bytes.subarray(0, bytes.length - 1))
    await assert.rejects(getDocumentContent(actor(), clean.id), denied("document_integrity_failed"))
    await rm(join(root, "restored-files", record.storageKey))
    await assert.rejects(getDocumentContent(actor(), clean.id), denied("document_storage_unavailable"))
    t.diagnostic(JSON.stringify({ environment: "local-disposable-postgres", encryptedBundleSha256: hash(encrypted), restoredDocuments: records.rows.length, documentBytes: bytes.length, restoreDurationMs: Math.round(performance.now() - started), externalSends: 0, hostedProof: false }))
  } finally {
    setDocumentStorageForTests(); setDocumentScannerForTests()
    await closeDatabaseForTests()
    if (oldDatabase === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = oldDatabase
    await source.close(); await target.close()
    await rm(root, { recursive: true, force: true })
  }
})

test("T0 SIGKILL after claim reclaims the same job and fences stale completion", { timeout: 20_000 }, async (t) => {
  const database = await createPostgresTestDatabase("t0_sigkill")
  const oldDatabase = process.env.DATABASE_URL
  let child: ChildProcess | undefined
  try {
    process.env.DATABASE_URL = database.databaseUrl
    const now = new Date().toISOString()
    await database.query(`INSERT INTO workspaces (id,name,timezone,seat_limit,feature_flags,page_visibility,action_visibility,created_at,updated_at)
      VALUES ('t0-company-a','Synthetic','UTC',5,'{}','{}','{}',$1,$1)`, [now])
    await database.query(`INSERT INTO mca_background_jobs
      (id,workspace_id,kind,resource_id,idempotency_key,actor_json,payload_json,payload_hash,state,attempts,available_at,created_at,updated_at)
      VALUES ('t0-killed-job','t0-company-a','export','t0-resource','t0-killed-job',$1,'{}','synthetic','queued',0,$2,$2,$2)`, [JSON.stringify(actor()), now])
    child = spawn(process.execPath, ["--conditions=react-server", "--import", "tsx", "--input-type=module", "--eval", `
      const { default: queue } = await import('./src/lib/mca/jobs/queue.ts');
      const { claimBackgroundJob } = queue;
      process.send(await claimBackgroundJob(['export']));
      setInterval(() => {}, 1000);
    `], { cwd: process.cwd(), env: { PATH: process.env.PATH, LC_ALL: "C", NODE_ENV: "test", DATABASE_URL: database.databaseUrl }, stdio: ["ignore", "ignore", "pipe", "ipc"] })
    const worker = child
    let diagnostics = ""
    worker.stderr!.on("data", (chunk: Buffer) => { diagnostics += chunk.toString() })
    const first = await new Promise<BackgroundJob>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Synthetic child did not claim within 10 seconds.")), 10_000)
      child!.once("message", (job) => { clearTimeout(timer); resolve(job as BackgroundJob) })
      child!.once("error", (error) => { clearTimeout(timer); reject(error) })
      child!.once("exit", () => { clearTimeout(timer); reject(new Error(`Synthetic child exited before claim: ${diagnostics}`)) })
    })
    assert.equal(first.id, "t0-killed-job")
    assert.equal(first.attempts, 1)
    const exit = once(worker, "exit")
    assert.equal(worker.kill("SIGKILL"), true)
    const [code, signal] = await exit
    assert.equal(code, null); assert.equal(signal, "SIGKILL")
    assert.equal(await claimBackgroundJob(["export"]), undefined)
    // Advance only this disposable row's lease, avoiding a five-minute wall-clock wait.
    await database.query("UPDATE mca_background_jobs SET lease_expires_at='2000-01-01T00:00:00Z' WHERE id='t0-killed-job'")
    const retry = await claimBackgroundJob(["export"])
    assert.equal(retry!.id, first.id); assert.equal(retry!.attempts, 2)
    assert.notEqual(retry!.lease_token, first.lease_token)
    await assert.rejects(completeBackgroundJob(first, { stale: true }), /background_job_lease_lost/)
    await completeBackgroundJob(retry!, { synthetic: true })
    assert.deepEqual((await database.query("SELECT id,state,attempts FROM mca_background_jobs")).rows, [{ id: first.id, state: "complete", attempts: 2 }])
    t.diagnostic(JSON.stringify({ signal, jobId: first.id, retryJobId: retry!.id, attempts: 2, staleCompletionDenied: true, externalSends: 0, leaseClockAdvanced: true }))
  } finally {
    if (child?.pid && child.exitCode === null && child.signalCode === null) {
      const exit = once(child, "exit"); child.kill("SIGKILL"); await exit
    }
    await closeDatabaseForTests()
    if (oldDatabase === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = oldDatabase
    await database.close()
  }
})
