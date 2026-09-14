import { createSupabaseHttpFixture } from "./helpers/supabase-http.mjs"
import test, { after, before } from "node:test"
import assert from "node:assert/strict"
import { randomBytes } from "node:crypto"
import { spawn } from "node:child_process"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { deflateRawSync } from "node:zlib"
import { createPostgresTestDatabase } from "./helpers/postgres-test-db.mjs"

const root = new URL("../", import.meta.url).pathname
const temp = mkdtempSync(join(tmpdir(), "mca-imports-http-"))
const port = 6000 + (process.pid % 300)
const baseUrl = `http://localhost:${port}`
const dist = ".next-test-imports"
let server
let output = ""
let supabaseFixture
let testDatabase

async function waitForServer() {
  const deadline = Date.now() + 45_000
  while (Date.now() < deadline) {
    if (server.exitCode !== null) throw new Error(`Next.js stopped:\n${output}`)
    try { await fetch(`${baseUrl}/api/auth/session`); return } catch { await new Promise((resolve) => setTimeout(resolve, 200)) }
  }
  throw new Error(`Next.js startup timed out:\n${output}`)
}

before(async () => {
  testDatabase = await createPostgresTestDatabase("imports_http")
  supabaseFixture = await createSupabaseHttpFixture(testDatabase)
  server = spawn(process.execPath, ["node_modules/next/dist/bin/next", "dev", "--hostname", "localhost", "--port", String(port)], {
    cwd: root,
    env: testDatabase.env({
      ...supabaseFixture.env,
      NODE_ENV: "development",
      NEXT_DIST_DIR: dist,
      MCA_DOCUMENT_STORAGE_PATH: join(temp, "vault"),
      MCA_APP_ORIGIN: baseUrl,
      MCA_DATA_ENCRYPTION_KEY: randomBytes(32).toString("base64url"),
      MCA_DOCUMENT_TOKEN_SECRET: randomBytes(32).toString("base64url"),
      MCA_BOOTSTRAP_WORKSPACE_NAME: "Imports HTTP Test",
      MCA_BOOTSTRAP_ADMIN_EMAIL: "imports-http@example.test",
      MCA_BOOTSTRAP_ADMIN_PASSWORD: "Correct Imports Password 99!",
      MCA_DOCUMENT_SCANNER: "",
      MCA_DOCUMENT_AI_PROVIDER: "",
      OPENAI_API_KEY: "",
    }),
    stdio: ["ignore", "pipe", "pipe"],
  })
  server.stdout.on("data", (chunk) => { output += chunk })
  server.stderr.on("data", (chunk) => { output += chunk })
  await waitForServer()
})

after(async () => {
  if (server?.exitCode === null) {
    server.kill("SIGTERM")
    await Promise.race([new Promise((resolve) => server.once("exit", resolve)), new Promise((resolve) => setTimeout(resolve, 2_000))])
  }
  if (supabaseFixture) await supabaseFixture.close()
  if (testDatabase) await testDatabase.close()
  rmSync(temp, { recursive: true, force: true })
  rmSync(join(root, dist), { recursive: true, force: true })
})

async function json(path, { method = "GET", cookie, bearer, body, origin = baseUrl } = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      ...(await supabaseFixture.headers(cookie)),
      ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
      ...(body !== undefined ? { "content-type": "application/json", origin } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
  const payload = await response.json()
  return { response, payload, cookie: response.headers.get("set-cookie")?.split(";")[0] }
}

async function multipart(path, cookie, fields, files = []) {
  const form = new FormData()
  for (const [name, value] of Object.entries(fields)) form.set(name, String(value))
  for (const file of files) form.append(file.field, new File([file.bytes], file.name, { type: file.type }))
  const response = await fetch(`${baseUrl}${path}`, { method: "POST", headers: { ...(await supabaseFixture.headers(cookie)), origin: baseUrl }, body: form })
  return { response, payload: await response.json() }
}

function crc32(data) {
  let crc = 0xffffffff
  for (const byte of data) { crc ^= byte; for (let index = 0; index < 8; index += 1) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0) }
  return (crc ^ 0xffffffff) >>> 0
}

function zip(name, data) {
  const filename = Buffer.from(name)
  const raw = Buffer.from(data)
  const compressed = deflateRawSync(raw)
  const checksum = crc32(raw)
  const local = Buffer.alloc(30)
  local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4); local.writeUInt16LE(8, 8)
  local.writeUInt32LE(checksum, 14); local.writeUInt32LE(compressed.length, 18); local.writeUInt32LE(raw.length, 22); local.writeUInt16LE(filename.length, 26)
  const central = Buffer.alloc(46)
  central.writeUInt32LE(0x02014b50); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(8, 10)
  central.writeUInt32LE(checksum, 16); central.writeUInt32LE(compressed.length, 20); central.writeUInt32LE(raw.length, 24); central.writeUInt16LE(filename.length, 28)
  const offset = local.length + filename.length + compressed.length
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10)
  end.writeUInt32LE(central.length + filename.length, 12); end.writeUInt32LE(offset, 16)
  return Buffer.concat([local, filename, compressed, central, filename, end])
}

test("import routes enforce sessions and support reviewed create/update replay with category validation", async () => {
  const unauthenticated = await json("/api/mca/imports/registry")
  assert.equal(unauthenticated.response.status, 401)

  const login = await supabaseFixture.login("imports-http@example.test", "Correct Imports Password 99!")
  assert.equal(login.response.status, 200, JSON.stringify(login.payload))
  const cookie = login.cookie

  const key = await json("/api/api-keys", { method: "POST", cookie, body: { name: "Import route rejection", scopes: ["deals:write"] } })
  assert.equal(key.response.status, 201, JSON.stringify(key.payload))
  const apiKeyAttempt = await json("/api/mca/imports/registry", { bearer: key.payload.secret })
  assert.equal(apiKeyAttempt.response.status, 403)

  const crossSite = await json("/api/mca/imports/registry", { method: "POST", cookie, origin: "https://attacker.example", body: { kind: "source", name: "Denied" } })
  assert.equal(crossSite.response.status, 403)

  const source = await json("/api/mca/imports/registry", { method: "POST", cookie, body: { kind: "source", name: "HTTP referrals", sourceKind: "spreadsheet" } })
  assert.equal(source.response.status, 201, JSON.stringify(source.payload))
  const batch = await json("/api/mca/imports/registry", { method: "POST", cookie, body: { kind: "batch", sourceId: source.payload.id, name: "HTTP September" } })
  assert.equal(batch.response.status, 201, JSON.stringify(batch.payload))

  const preview = await multipart("/api/mca/imports/preview", cookie, {
    sourceId: source.payload.id,
    batchId: batch.payload.id,
    mapping: JSON.stringify({ Merchant: "legalName", Amount: "requestedAmount" }),
    assignmentPool: "[]",
  }, [{ field: "file", name: "merchant-import.csv", type: "text/csv", bytes: Buffer.from("Merchant,Amount\nHTTP Import LLC,125000\nMalformed LLC,not-a-number") }])
  assert.equal(preview.response.status, 201, JSON.stringify(preview.payload))
  assert.equal(preview.payload.mapping.Merchant, "legalName")
  assert.equal(preview.payload.rows[0].application.requestedAmount, 125000)
  assert.match(preview.payload.rows[1].errors.join(" "), /number/i)

  const committed = await json(`/api/mca/imports/${preview.payload.runId}/commit`, { method: "POST", cookie, body: { expectedPreviewRevision: preview.payload.previewRevision } })
  assert.equal(committed.response.status, 200, JSON.stringify(committed.payload))
  assert.equal(committed.payload.created, 1)
  assert.equal(committed.payload.skipped, 1)
  const replay = await json(`/api/mca/imports/${preview.payload.runId}/commit`, { method: "POST", cookie, body: { expectedPreviewRevision: preview.payload.previewRevision } })
  assert.equal(replay.response.status, 200)
  assert.equal(replay.payload.resultsCsv, committed.payload.resultsCsv)
  const status = await json(`/api/mca/imports/${preview.payload.runId}`, { cookie })
  assert.equal(status.response.status, 200)
  assert.equal(status.payload.state, "completed")

  const createdLine = committed.payload.resultsCsv.split(/\r?\n/).find((line) => line.includes(",created,"))
  assert.ok(createdLine)
  const dealId = createdLine.split(",")[2]
  const deal = await json(`/api/mca/deals/${dealId}`, { cookie })
  assert.equal(deal.response.status, 200)

  const updatePreview = await multipart("/api/mca/imports/update/preview", cookie, {
    sourceId: source.payload.id,
    batchId: batch.payload.id,
    mapping: JSON.stringify({ Record: "dealId", Version: "expectedVersion", Name: "legalName" }),
  }, [{ field: "file", name: "mapped-update.csv", type: "text/csv", bytes: Buffer.from(`Record,Version,Name\n${dealId},${deal.payload.version},HTTP Import Renamed LLC`) }])
  assert.equal(updatePreview.response.status, 201, JSON.stringify(updatePreview.payload))
  assert.equal(updatePreview.payload.rows[0].before.legalName, "HTTP Import LLC")
  assert.equal(updatePreview.payload.rows[0].changes.legalName, "HTTP Import Renamed LLC")
  const updateCommit = await json(`/api/mca/imports/update/${updatePreview.payload.runId}/commit`, { method: "POST", cookie, body: { expectedPreviewRevision: updatePreview.payload.previewRevision } })
  assert.equal(updateCommit.response.status, 200, JSON.stringify(updateCommit.payload))
  assert.equal(updateCommit.payload.created, 1)

  const forbiddenUpdate = await multipart("/api/mca/imports/update/preview", cookie, {
    sourceId: source.payload.id,
    batchId: batch.payload.id,
    mapping: JSON.stringify({ Record: "dealId", Owner: "owners.0.firstName" }),
  }, [{ field: "file", name: "forbidden-update.csv", type: "text/csv", bytes: Buffer.from(`Record,Owner\n${dealId},Injected`) }])
  assert.equal(forbiddenUpdate.response.status, 422)
  assert.equal(forbiddenUpdate.payload.error.code, "update_field_forbidden")

  const archive = zip("HTTP Import LLC/statement.pdf", "%PDF-1.4\n%%EOF\n")
  const archivePreview = await multipart("/api/mca/imports/archives/preview", cookie, { runId: preview.payload.runId }, [
    { field: "archives", name: "merchant-docs.zip", type: "application/zip", bytes: archive },
  ])
  assert.equal(archivePreview.response.status, 200, JSON.stringify(archivePreview.payload))
  const matched = archivePreview.payload[0]
  const invalidArchiveCategory = await multipart("/api/mca/imports/archives/apply", cookie, {
    runId: preview.payload.runId,
    confirmations: JSON.stringify([{ archiveName: matched.archiveName, path: matched.path, rowId: preview.payload.rows[0].id, category: "not-a-document-category" }]),
  }, [{ field: "archives", name: "merchant-docs.zip", type: "application/zip", bytes: archive }])
  assert.equal(invalidArchiveCategory.response.status, 422)
  assert.equal(invalidArchiveCategory.payload.error.code, "document_category_invalid")

  const invalidDriveCategory = await json("/api/mca/imports/drive", { method: "POST", cookie, body: {
    action: "apply", runId: preview.payload.runId, confirmations: [{ fileId: "drive-file", rowId: preview.payload.rows[0].id, category: "not-a-document-category" }],
  } })
  assert.equal(invalidDriveCategory.response.status, 422)
  assert.equal(invalidDriveCategory.payload.error.code, "document_category_invalid")
})

test("historical CSV preview accepts small files and retries without creating business records", async () => {
  const path = "/api/mca/historical/preview"
  const login = await supabaseFixture.login("historical-http@example.test", "Synthetic Preview Password 99!")
  const preview = async (batchId, size, cookie = login.cookie) => multipart(path, cookie, { sourceId: "historical-http", batchId }, [{
    field: "file", name: "synthetic.csv", type: "text/csv",
    bytes: Buffer.from("external_id,legal_name,funder_name,funded_at,amount_cents\n" + Array.from({ length: size }, (_, i) => `${batchId}-${i},Synthetic Merchant,Synthetic Funder,2025-01-01,10000`).join("\n")),
  }])
  assert.equal((await preview("denied", 1, null)).response.status, 401)
  const tables = ["deals", "mca_funding_events", "mca_accounting_payments"]
  const counts = async () => Promise.all(tables.map(async (table) => Number((await testDatabase.query(`SELECT count(*) FROM ${table}`)).rows[0].count)))
  const before = await counts()
  for (const size of [1, 99]) {
    const { response, payload } = await preview(`small-${size}`, size)
    assert.equal(response.status, 201, JSON.stringify(payload))
    assert.ok(response.headers.get("x-request-id"))
    assert.equal(payload.totals.valid, size)
    assert.equal(payload.totals.principalCents, size * 10000)
    assert.equal(payload.rows.at(-1).rowNumber, size + 1)
    const replay = await preview(`small-${size}`, size)
    assert.equal(replay.payload.runId, payload.runId)
    assert.deepEqual(replay.payload.rows, payload.rows)
  }
  assert.deepEqual(await counts(), before)
  const malformed = await multipart(path, login.cookie, { sourceId: "historical-http", batchId: "bad" }, [{ field: "file", name: "bad.csv", type: "text/csv", bytes: Buffer.from("legal_name,funder_name\nExample,Funder") }])
  assert.equal(malformed.response.status, 422)
  assert.match(malformed.payload.error.message, /Missing required column/)
  const member = (await testDatabase.query("SELECT m.id FROM memberships m JOIN users u ON u.id=m.user_id WHERE u.email=$1", ["historical-http@example.test"])).rows[0]
  await testDatabase.query("UPDATE memberships SET role='rep' WHERE id=$1", [member.id])
  try { assert.equal((await preview("rep-denied", 1)).response.status, 403) }
  finally { await testDatabase.query("UPDATE memberships SET role='admin' WHERE id=$1", [member.id]) }
})
