let clerkFixture
import { createClerkHttpFixture } from "./helpers/clerk-http.mjs"
import test, { after, before } from "node:test"
import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { mkdtempSync, rmSync } from "node:fs"
import { randomBytes } from "node:crypto"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createPostgresTestDatabase } from "./helpers/postgres-test-db.mjs"

const root = new URL("../", import.meta.url).pathname
const temp = mkdtempSync(join(tmpdir(), "mca-intake-http-"))
const port = 6200 + (process.pid % 300)
const baseUrl = `http://localhost:${port}`
const dist = ".next-test-intake"
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
  testDatabase = await createPostgresTestDatabase("intake_http")
  clerkFixture = await createClerkHttpFixture(testDatabase)
  server = spawn(process.execPath, ["node_modules/next/dist/bin/next", "dev", "--hostname", "localhost", "--port", String(port)], {
    cwd: root,
    env: testDatabase.env({
      MCA_USESEND_API_KEY: "", MCA_USESEND_FROM: "",
      ...clerkFixture.env, NODE_ENV: "development", NEXT_DIST_DIR: dist, MCA_DOCUMENT_STORAGE_PATH: join(temp, "vault"), MCA_APP_ORIGIN: baseUrl, MCA_DATA_ENCRYPTION_KEY: randomBytes(32).toString("base64url"), MCA_DOCUMENT_TOKEN_SECRET: randomBytes(32).toString("base64url"), MCA_BOOTSTRAP_WORKSPACE_NAME: "Intake HTTP Test", MCA_BOOTSTRAP_ADMIN_EMAIL: "intake-http@example.test", MCA_BOOTSTRAP_ADMIN_PASSWORD: "Correct Intake Password 99!", MCA_DOCUMENT_SCANNER: "", MCA_DOCUMENT_AI_PROVIDER: "", OPENAI_API_KEY: "", MCA_DOCUMENT_AI_MODEL: "", MCA_INTAKE_RECEIPT_WEBHOOK_URL: "", MCA_INTAKE_WORKER_TOKEN: "" }),
    stdio: ["ignore", "pipe", "pipe"],
  })
  server.stdout.on("data", (chunk) => { output += chunk }); server.stderr.on("data", (chunk) => { output += chunk })
  await waitForServer()
})
after(async () => {
  if (server?.exitCode === null) { server.kill("SIGTERM"); await Promise.race([new Promise((resolve) => server.once("exit", resolve)), new Promise((resolve) => setTimeout(resolve, 2_000))]) }
  if (clerkFixture) await clerkFixture.close()
  if (testDatabase) await testDatabase.close()
  rmSync(temp, { recursive: true, force: true }); rmSync(join(root, dist), { recursive: true, force: true })
})

async function json(path, { method = "GET", cookie, bearer, body } = {}) {
  const response = await fetch(`${baseUrl}${path}`, { method, headers: { ...(await clerkFixture.headers(cookie)), ...(bearer ? { authorization: `Bearer ${bearer}` } : {}), ...(body ? { "content-type": "application/json", origin: baseUrl } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) })
  return { response, payload: await response.json(), cookie: response.headers.get("set-cookie")?.split(";")[0] }
}
async function key(cookie, name, scopes) {
  const result = await json("/api/api-keys", { method: "POST", cookie, body: { name, scopes } }); assert.equal(result.response.status, 201, JSON.stringify(result.payload)); return result.payload.secret
}

test("MIC-184 HTTP email admission, admin review, retry and receipt authorization", async () => {
  const login = await clerkFixture.login("intake-http@example.test", "Correct Intake Password 99!")
  assert.equal(login.response.status, 200)
  const cookie = login.cookie
  const integration = await json("/api/mca/intake/integrations", { method: "POST", cookie, body: { provider: "email", emailGateway: "postmark", displayName: "HTTP Postmark", inboundAddress: "http@inbound.postmarkapp.com", senderRules: ["@trusted.example"] } })
  assert.equal(integration.response.status, 201)
  const path = `/api/mca/intake/email/${integration.payload.status.id}`
  const authorization = `Basic ${Buffer.from(`mca:${integration.payload.admissionSecret}`).toString("base64")}`
  const payload = { MessageID: "http-email-184", OriginalRecipient: "http@inbound.postmarkapp.com", FromFull: { Email: "broker@trusted.example" }, TextBody: "Unstructured message requires human review." }
  assert.equal((await json(path, { method: "POST", body: payload })).response.status, 401)
  const admitted = await fetch(baseUrl + path, { method: "POST", headers: { authorization, "content-type": "application/json" }, body: JSON.stringify(payload) })
  assert.equal(admitted.status, 200)
  const pending = await admitted.json()
  assert.equal(pending.state, "error")
  const replayPath = `/api/mca/intake/${pending.intakeId}/replay`
  assert.equal((await json(replayPath, { method: "POST", body: {} })).response.status, 401)
  const intakeKey = await key(cookie, "Intake write only", ["intake:write"])
  const review = { reviewedApplication: { legalName: "HTTP Reviewed Bakery LLC" } }
  assert.equal((await json(replayPath, { method: "POST", bearer: intakeKey, body: review })).response.status, 403)
  assert.equal((await json(replayPath, { method: "POST", cookie, body: { reviewedApplication: { legalName: "" } } })).response.status, 400)
  const approved = await json(replayPath, { method: "POST", cookie, body: review })
  assert.equal(approved.response.status, 200, JSON.stringify(approved.payload))
  assert.equal(approved.payload.intakeId, pending.intakeId)
  assert.ok(approved.payload.dealId)
  const replayed = await json(replayPath, { method: "POST", cookie, body: {} })
  assert.equal(replayed.payload.dealId, approved.payload.dealId)
  assert.equal((await json(`/api/mca/deals/${approved.payload.dealId}`)).response.status, 401)
  const deal = await json(`/api/mca/deals/${approved.payload.dealId}`, { cookie })
  assert.equal(deal.payload.legalName, "HTTP Reviewed Bakery LLC")
  assert.equal((await json("/api/mca/intake/receipts/run", { method: "POST", bearer: intakeKey, body: {} })).response.status, 503)
  const receipts = await json("/api/mca/intake/receipts/run", { method: "POST", cookie, body: {} })
  assert.equal(receipts.response.status, 503)
  assert.equal(receipts.payload.error.code, "receipt_delivery_unconfigured")
  const destination = `/deals?deal=${approved.payload.dealId}&addDocument=1`
  const redirect = await fetch(baseUrl + destination, { redirect: "manual" })
  if (redirect.status === 307) {
    assert.equal(new URL(redirect.headers.get("location"), baseUrl).searchParams.get("returnTo"), destination)
  } else {
    // Next.js can emit a streamed redirect after its loading boundary sends HTTP 200.
    assert.equal(redirect.status, 200)
    const html = await redirect.text()
    assert.match(html, /NEXT_REDIRECT/)
    assert.ok(html.includes(encodeURIComponent(destination)))
    assert.equal(html.includes("HTTP Reviewed Bakery LLC"), false)
  }
})
