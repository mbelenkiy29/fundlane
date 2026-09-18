let supabaseFixture
import { createSupabaseHttpFixture } from "./helpers/supabase-http.mjs"
import test, { after, before } from "node:test"
import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { mkdtempSync, rmSync } from "node:fs"
import { randomBytes } from "node:crypto"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createPostgresTestDatabase } from "./helpers/postgres-test-db.mjs"

const root = new URL("../", import.meta.url).pathname
const temp = mkdtempSync(join(tmpdir(), "mca-documents-http-"))
const port = 5600 + (process.pid % 300)
const baseUrl = `http://localhost:${port}`
const dist = ".next-test-documents"
let server, output = "", testDatabase

async function waitForServer() {
  const deadline = Date.now() + 45_000
  while (Date.now() < deadline) {
    if (server.exitCode !== null) throw new Error(`Next.js stopped:\n${output}`)
    try { await fetch(`${baseUrl}/api/auth/session`); return } catch { await new Promise((resolve) => setTimeout(resolve, 200)) }
  }
  throw new Error(`Next.js startup timed out:\n${output}`)
}

before(async () => {
  testDatabase = await createPostgresTestDatabase("documents_http")
  supabaseFixture = await createSupabaseHttpFixture(testDatabase)
  server = spawn(process.execPath, ["node_modules/next/dist/bin/next", "dev", "--hostname", "localhost", "--port", String(port)], {
    cwd: root,
    env: testDatabase.env({
      ...supabaseFixture.env, NODE_ENV: "development", NEXT_DIST_DIR: dist, MCA_DOCUMENT_STORAGE_PATH: join(temp, "vault"), MCA_APP_ORIGIN: baseUrl, MCA_DATA_ENCRYPTION_KEY: randomBytes(32).toString("base64url"), MCA_DOCUMENT_TOKEN_SECRET: randomBytes(32).toString("base64url"), MCA_BOOTSTRAP_WORKSPACE_NAME: "Documents Test", MCA_BOOTSTRAP_ADMIN_EMAIL: "documents@example.test", MCA_BOOTSTRAP_ADMIN_PASSWORD: "Correct Documents Password 99!", MCA_DOCUMENT_SCANNER: "", MCA_BACKGROUND_JOBS: "", VERCEL: "", MCA_DOCUMENT_AI_PROVIDER: "", OPENAI_API_KEY: "", MCA_DOCUMENT_AI_MODEL: "" }),
    stdio: ["ignore", "pipe", "pipe"],
  })
  server.stdout.on("data", (chunk) => { output += chunk }); server.stderr.on("data", (chunk) => { output += chunk })
  await waitForServer()
})
after(async () => {
  if (server?.exitCode === null) { server.kill("SIGTERM"); await Promise.race([new Promise((resolve) => server.once("exit", resolve)), new Promise((resolve) => setTimeout(resolve, 2_000))]) }
  if (supabaseFixture) await supabaseFixture.close()
  if (testDatabase) await testDatabase.close()
  rmSync(temp, { recursive: true, force: true }); rmSync(join(root, dist), { recursive: true, force: true })
})

async function json(path, { method = "GET", cookie, bearer, body } = {}) {
  const response = await fetch(`${baseUrl}${path}`, { method, headers: { ...(await supabaseFixture.headers(cookie)), ...(bearer ? { authorization: `Bearer ${bearer}` } : {}), ...(body ? { "content-type": "application/json", origin: baseUrl } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) })
  return { response, payload: await response.json(), cookie: response.headers.get("set-cookie")?.split(";")[0] }
}
async function key(cookie, name, scopes) {
  const result = await json("/api/api-keys", { method: "POST", cookie, body: { name, scopes } }); assert.equal(result.response.status, 201, JSON.stringify(result.payload)); return result.payload.secret
}
async function upload(path, cookieOrBearer, fields) {
  const form = new FormData()
  for (const [name, value] of Object.entries(fields)) form.set(name, value)
  form.set("file", new File([Buffer.from("%PDF-1.4\n%%EOF\n")], "merchant.pdf", { type: "application/pdf" }))
  const isBearer = !cookieOrBearer.includes("=")
  const response = await fetch(`${baseUrl}${path}`, { method: "POST", headers: { ...(isBearer ? { authorization: `Bearer ${cookieOrBearer}` } : await supabaseFixture.headers(cookieOrBearer)), origin: baseUrl }, body: form })
  return { response, payload: await response.json() }
}

test("document routes enforce scopes and expose recoverable unavailable-provider states", async () => {
  const login = await supabaseFixture.login("documents@example.test", "Correct Documents Password 99!")
  assert.equal(login.response.status, 200, JSON.stringify(login.payload))
  const cookie = login.cookie
  const readKey = await key(cookie, "Docs read", ["deals:read"]), writeKey = await key(cookie, "Docs write", ["deals:write"]), intakeKey = await key(cookie, "Intake only", ["intake:write"])
  const deal = await json("/api/mca/deals", { method: "POST", cookie, body: { idempotencyKey: "docs-http-deal", legalName: "HTTP Merchant LLC", contactEmail: "real@example.test" } })
  assert.equal(deal.response.status, 201, JSON.stringify(deal.payload))

  const saved = await upload("/api/mca/documents", cookie, { dealId: deal.payload.id, idempotencyKey: "http-document", category: "statement", source: "http-test" })
  assert.equal(saved.response.status, 201, JSON.stringify(saved.payload)); assert.equal(saved.payload.processingState, "pending_scan")
  assert.equal((await json(`/api/mca/documents?dealId=${deal.payload.id}`, { bearer: readKey })).response.status, 200)
  assert.equal((await json(`/api/mca/documents?dealId=${deal.payload.id}`, { bearer: writeKey })).response.status, 403)
  assert.equal((await json(`/api/mca/documents?dealId=${deal.payload.id}`, { bearer: intakeKey })).response.status, 403)
  assert.equal((await upload("/api/mca/documents", intakeKey, { dealId: deal.payload.id, idempotencyKey: "denied", category: "application", source: "test" })).response.status, 403)
  const locked = await json(`/api/mca/documents/${saved.payload.id}/download-token`, { method: "POST", cookie, body: {} })
  assert.equal(locked.response.status, 423); assert.equal(locked.payload.error.code, "document_not_clean")
  const status = await json("/api/mca/documents/status", { cookie })
  assert.equal(status.payload.scanner.configured, false); assert.equal(status.payload.extraction.configured, false)
  const retry = await json(`/api/mca/documents/${saved.payload.id}/scan`, { method: "POST", cookie, body: {} })
  assert.equal(retry.response.status, 200, JSON.stringify(retry.payload)); assert.equal(retry.payload.processingState, "pending_scan")
  const category = await json(`/api/mca/documents/${saved.payload.id}/category`, { method: "POST", cookie, body: { category: "other_stip" } })
  assert.equal(category.payload.category, "other_stip")

  const draft = await upload("/api/mca/documents/application/drafts", cookie, { idempotencyKey: "http-draft" })
  assert.equal(draft.response.status, 201); assert.equal(draft.payload.processingState, "pending_scan")
  const extract = await json(`/api/mca/documents/application/drafts/${draft.payload.id}/extract`, { method: "POST", cookie, body: {} })
  assert.equal(extract.response.status, 423); assert.equal(extract.payload.error.code, "document_not_clean")

  const signed = await json("/api/mca/documents/pdf/generate", { method: "POST", cookie, body: { dealId: deal.payload.id, idempotencyKey: "signed-denied", contactMode: "redacted", signedOnBehalf: true } })
  assert.equal(signed.response.status, 422); assert.equal(signed.payload.error.code, "merchant_authorization_required")
  const generated = await json("/api/mca/documents/pdf/generate", { method: "POST", cookie, body: { dealId: deal.payload.id, idempotencyKey: "unsigned-pdf", contactMode: "redacted", signedOnBehalf: false } })
  assert.equal(generated.response.status, 200, JSON.stringify(generated.payload)); assert.equal(generated.payload.document.category, "api_application")
  const replay = await json("/api/mca/documents/pdf/generate", { method: "POST", cookie, body: { dealId: deal.payload.id, idempotencyKey: "unsigned-pdf", contactMode: "redacted", signedOnBehalf: false } })
  assert.equal(replay.payload.replayed, true); assert.equal(replay.payload.document.id, generated.payload.document.id)
})
