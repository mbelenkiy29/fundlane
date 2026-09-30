import { createSupabaseHttpFixture } from "./helpers/supabase-http.mjs"
import test, { after, before } from "node:test"
import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { createHash, randomBytes, randomUUID } from "node:crypto"
import { rmSync } from "node:fs"
import { createServer } from "node:http"
import { join } from "node:path"
import { reserveLoopbackPort } from "./helpers/loopback-port.mjs"
import { createPostgresTestDatabase } from "./helpers/postgres-test-db.mjs"

const projectRoot = new URL("../", import.meta.url).pathname
let baseUrl
const distDirectoryName = ".next-test-deals"
let server
let serverOutput = ""
let emailServer
let supabaseFixture
let testDatabase

async function waitForServer() {
  const deadline = Date.now() + 45_000
  while (Date.now() < deadline) {
    if (server.exitCode !== null) throw new Error(`Next.js exited during startup:\n${serverOutput}`)
    try { await fetch(`${baseUrl}/api/auth/session`); return } catch { await new Promise((resolve) => setTimeout(resolve, 200)) }
  }
  throw new Error(`Timed out starting Next.js:\n${serverOutput}`)
}

before(async () => {
  testDatabase = await createPostgresTestDatabase("deals_http")
  supabaseFixture = await createSupabaseHttpFixture(testDatabase)
  emailServer = createServer((_request, response) => response.writeHead(202).end())
  await new Promise((resolve) => emailServer.listen(0, "127.0.0.1", resolve))
  const emailAddress = emailServer.address()
  const reservation = await reserveLoopbackPort()
  const port = reservation.port
  baseUrl = `http://127.0.0.1:${port}`
  await reservation.release()
  server = spawn(process.execPath, ["node_modules/next/dist/bin/next", "dev", "--hostname", "127.0.0.1", "--port", String(port)], {
    cwd: projectRoot,
    env: testDatabase.env({
      ...supabaseFixture.env,
      NODE_ENV: "development", NEXT_DIST_DIR: distDirectoryName, MCA_APP_ORIGIN: baseUrl,
      MCA_DATA_ENCRYPTION_KEY: randomBytes(32).toString("base64url"), MCA_BOOTSTRAP_WORKSPACE_NAME: "Atlas Capital",
      MCA_BOOTSTRAP_ADMIN_EMAIL: "deals-owner@example.test", MCA_BOOTSTRAP_ADMIN_PASSWORD: "Correct Deal Password 99!",
      MCA_EMAIL_WEBHOOK_URL: `http://127.0.0.1:${emailAddress.port}`,
    }),
    stdio: ["ignore", "pipe", "pipe"],
  })
  server.stdout.on("data", (chunk) => { serverOutput += chunk })
  server.stderr.on("data", (chunk) => { serverOutput += chunk })
  await waitForServer()
})

after(async () => {
  if (server && server.exitCode === null) {
    server.kill("SIGTERM")
    await Promise.race([new Promise((resolve) => server.once("exit", resolve)), new Promise((resolve) => setTimeout(resolve, 2_000))])
  }
  if (emailServer) await new Promise((resolve) => emailServer.close(resolve))
  if (supabaseFixture) await supabaseFixture.close()
  if (testDatabase) await testDatabase.close()
  rmSync(join(projectRoot, distDirectoryName), { recursive: true, force: true })
})

async function request(path, { method = "GET", cookie, bearer, body, origin = baseUrl } = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      ...(body ? { "content-type": "application/json" } : {}),
      ...(await supabaseFixture.headers(cookie)),
      ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
      ...(origin ? { origin } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  })
  const payload = await response.json()
  return { response, payload, cookie: response.headers.get("set-cookie")?.split(";")[0] }
}

async function apiKey(cookie, name, scopes) {
  const result = await request("/api/api-keys", { method: "POST", cookie, body: { name, scopes } })
  assert.equal(result.response.status, 201, JSON.stringify(result.payload))
  return result.payload.secret
}

async function addMembership({ workspaceId, userId, membershipId, role, managerMembershipId = null }) {
  const now = new Date().toISOString()
  await testDatabase.query(`INSERT INTO users (id,email,password_hash,name,phone,application_identifier,created_at,updated_at)
    VALUES ($1, $2, NULL, $3, NULL, $4, $5, $6)`, [userId, `${userId}@example.test`, userId, `APP-${userId}`, now, now])
  await testDatabase.query(`INSERT INTO memberships (id,workspace_id,user_id,role,manager_membership_id,status,sender_association,created_at,updated_at)
    VALUES ($1, $2, $3, $4, $5, 'active', NULL, $6, $7)`, [membershipId, workspaceId, userId, role, managerMembershipId, now, now])
}

async function sessionCookie(userId, membershipId) {
  const token = randomBytes(32).toString("base64url")
  const now = new Date().toISOString()
  await testDatabase.query(`INSERT INTO sessions (id,user_id,membership_id,token_hash,expires_at,created_at,last_seen_at)
    VALUES ($1, $2, $3, $4, $5, $6, $7)`, [randomUUID(), userId, membershipId, createHash("sha256").update(token).digest("hex"), "2099-01-01T00:00:00.000Z", now, now])
  return `mca_session=${token}`
}

test("deal routes satisfy SEN-32 and SEN-35 end to end", async () => {
  const login = await supabaseFixture.login("deals-owner@example.test", "Correct Deal Password 99!")
  assert.equal(login.response.status, 200, JSON.stringify(login.payload))
  const adminCookie = login.cookie
  const workspaceId = login.payload.membership.workspaceId
  const readKey = await apiKey(adminCookie, "Deals read", ["deals:read"])
  const writeKey = await apiKey(adminCookie, "Deals write", ["deals:write"])
  const exportKey = await apiKey(adminCookie, "Deals export", ["deals:export"])
  const intakeKey = await apiKey(adminCookie, "Application intake", ["intake:write"])
  const wrongKey = await apiKey(adminCookie, "Workspace read", ["workspace:read"])

  const draftBody = {
    legalName: "Harbor Coffee LLC", owners: [{ firstName: "Ari", identityLast4: "4321", email: "ari@harbor.test" }],
    idempotencyKey: "harbor-import-row-17", fieldSource: "import",
  }
  const draft = await request("/api/mca/deals", { method: "POST", cookie: adminCookie, body: draftBody })
  assert.equal(draft.response.status, 201, JSON.stringify(draft.payload))
  assert.equal(draft.payload.draftState, "partial")
  assert.ok(draft.payload.missingRequiredFields.includes("requestedAmount"))
  assert.equal(draft.payload.fieldSources.legalName.source, "import")
  assert.equal(draft.payload.owners[0].identityLast4, "••••")
  assert.equal(draft.payload.owners[0].email, "a•••@harbor.test")

  const replay = await request("/api/mca/deals", { method: "POST", cookie: adminCookie, body: draftBody })
  assert.equal(replay.response.status, 200)
  assert.equal(replay.response.headers.get("x-idempotent-replay"), "true")
  assert.equal(replay.payload.id, draft.payload.id)

  const intakeDraft = await request("/api/mca/deals", { method: "POST", bearer: intakeKey, origin: null, body: {
    legalName: "Intake-only Merchant", idempotencyKey: "intake-only-merchant-1", fieldSource: "api",
  } })
  assert.equal(intakeDraft.response.status, 201, JSON.stringify(intakeDraft.payload))
  assert.equal((await request(`/api/mca/deals/${intakeDraft.payload.id}`, { bearer: intakeKey, origin: null })).response.status, 403)
  assert.equal((await request(`/api/mca/deals/${intakeDraft.payload.id}`, { method: "PATCH", bearer: intakeKey, origin: null, body: { expectedVersion: intakeDraft.payload.version, dbaName: "Denied" } })).response.status, 403)

  const listed = await request("/api/mca/deals", { bearer: readKey, origin: null })
  assert.equal(listed.response.status, 200)
  assert.equal(JSON.stringify(listed.payload).includes("4321"), false)
  assert.equal(JSON.stringify(listed.payload).includes("ari@harbor.test"), false)
  const detail = await request(`/api/mca/deals/${draft.payload.id}`, { bearer: readKey, origin: null })
  assert.equal(detail.response.status, 200)
  const writeCannotRead = await request(`/api/mca/deals/${draft.payload.id}`, { bearer: writeKey, origin: null })
  assert.equal(writeCannotRead.response.status, 403)
  const wrongCannotRead = await request(`/api/mca/deals/${draft.payload.id}`, { bearer: wrongKey, origin: null })
  assert.equal(wrongCannotRead.response.status, 403)
  const readCannotNote = await request(`/api/mca/deals/${draft.payload.id}/notes`, { method: "POST", bearer: readKey, origin: null, body: { body: "Call merchant", expectedVersion: draft.payload.version } })
  assert.equal(readCannotNote.response.status, 403)
  const readCannotTransition = await request(`/api/mca/deals/${draft.payload.id}/transition`, { method: "POST", bearer: readKey, origin: null, body: { status: "new_application", expectedVersion: draft.payload.version } })
  assert.equal(readCannotTransition.response.status, 403)

  const ownerRow = (await testDatabase.query("SELECT identity_last4_cipher, email_cipher FROM deal_owners WHERE workspace_id = $1 AND deal_id = $2", [workspaceId, draft.payload.id])).rows[0]
  assert.notEqual(ownerRow.identity_last4_cipher, "4321")
  assert.notEqual(ownerRow.email_cipher, "ari@harbor.test")

  const complete = await request("/api/mca/deals", { method: "POST", cookie: adminCookie, body: {
    idempotencyKey: "complete-restaurant-1", legalName: "Beacon Bistro Inc", entityType: "corporation",
    address: { line1: "100 Main St", city: "Brooklyn", state: "NY", postalCode: "11201" }, contactPhone: "2125550199",
    startDate: "2018-05-10", industry: "Restaurant", naicsCode: "722511", monthlyRevenue: 180000, requestedAmount: 125000,
    fundingPurpose: "Second location", ficoScore: 710,
    owners: [{ firstName: "Nia", lastName: "Patel", ownershipPercent: 100, isPrimary: true, dateOfBirth: "1988-04-03", identityLast4: "9876" }],
  } })
  assert.equal(complete.response.status, 201, JSON.stringify(complete.payload))
  assert.equal(complete.payload.draftState, "submission_ready")

  const firstEdit = await request(`/api/mca/deals/${complete.payload.id}`, { method: "PATCH", cookie: adminCookie, body: { expectedVersion: complete.payload.version, dbaName: "Beacon on Main" } })
  assert.equal(firstEdit.response.status, 200, JSON.stringify(firstEdit.payload))
  const staleEdit = await request(`/api/mca/deals/${complete.payload.id}`, { method: "PATCH", cookie: adminCookie, body: { expectedVersion: complete.payload.version, industry: "Hospitality" } })
  assert.equal(staleEdit.response.status, 409)
  assert.equal(staleEdit.payload.error.code, "version_conflict")
  assert.equal(staleEdit.payload.error.current.version, firstEdit.payload.version)
  assert.deepEqual(staleEdit.payload.error.attemptedFields, ["industry"])
  const resolvedEdit = await request(`/api/mca/deals/${complete.payload.id}`, { method: "PATCH", cookie: adminCookie, body: { expectedVersion: staleEdit.payload.error.current.version, industry: "Hospitality" } })
  assert.equal(resolvedEdit.response.status, 200)

  let current = resolvedEdit.payload
  for (const status of ["new_application", "ready_to_submit", "submitted", "offer", "contract", "funded"]) {
    const moved = await request(`/api/mca/deals/${current.id}/transition`, { method: "POST", cookie: adminCookie, body: { status, expectedVersion: current.version } })
    assert.equal(moved.response.status, 200, `${status}: ${JSON.stringify(moved.payload)}`)
    current = moved.payload.deal
    if (status === "funded") assert.deepEqual(moved.payload.sideEffects, { advanceCreated: false, commissionCreated: false })
  }
  assert.equal(current.status, "funded")
  assert.equal(current.submissions.length, 0)
  assert.equal(current.offers.length, 0)

  await testDatabase.query("INSERT INTO deal_submissions (id,workspace_id,deal_id,funder_name,status) VALUES ($1, $2, $3, 'Rapid Capital', 'sent')", [randomUUID(), workspaceId, current.id])
  const createdDay = current.createdAt.slice(0, 10)
  const filtered = await request(`/api/mca/deals?status=funded&from=${createdDay}&to=${createdDay}&funder=rapid`, { cookie: adminCookie })
  assert.equal(filtered.response.status, 200)
  assert.equal(filtered.payload.total, 1)
  assert.equal(Object.values(filtered.payload.counts).reduce((sum, count) => sum + count, 0), filtered.payload.total)

  const managerUser = randomUUID(), managerMembership = randomUUID(), managedUser = randomUUID(), managedMembership = randomUUID(), outsiderUser = randomUUID(), outsiderMembership = randomUUID()
  const replacementManagerUser = randomUUID(), replacementManagerMembership = randomUUID()
  await addMembership({ workspaceId, userId: managerUser, membershipId: managerMembership, role: "manager" })
  await addMembership({ workspaceId, userId: replacementManagerUser, membershipId: replacementManagerMembership, role: "manager" })
  await addMembership({ workspaceId, userId: managedUser, membershipId: managedMembership, role: "rep", managerMembershipId: managerMembership })
  await addMembership({ workspaceId, userId: outsiderUser, membershipId: outsiderMembership, role: "rep" })
  const managerCookie = await sessionCookie(managerUser, managerMembership)
  const replacementManagerCookie = await sessionCookie(replacementManagerUser, replacementManagerMembership)
  const managedRepCookie = await sessionCookie(managedUser, managedMembership)
  const managedOriginator = await request("/api/mca/deals", { method: "POST", cookie: adminCookie, body: { idempotencyKey: "managed-originator", legalName: "Managed Originator", assignments: [{ membershipId: managedMembership, kind: "originator", isPrimary: true }] } })
  const managedCloserOnly = await request("/api/mca/deals", { method: "POST", cookie: adminCookie, body: { idempotencyKey: "managed-closer", legalName: "Managed Closer", assignments: [{ membershipId: managedMembership, kind: "closer", isPrimary: true }] } })
  assert.equal((await request(`/api/mca/deals/${managedOriginator.payload.id}`, { cookie: managerCookie })).response.status, 200)
  assert.equal((await request(`/api/mca/deals/${managedCloserOnly.payload.id}`, { cookie: managerCookie })).response.status, 404)
  const selfEscalation = await request(`/api/mca/deals/${managedOriginator.payload.id}`, { method: "PATCH", cookie: managerCookie, body: { expectedVersion: managedOriginator.payload.version, assignments: [{ membershipId: outsiderMembership, kind: "originator", isPrimary: true }] } })
  assert.equal(selfEscalation.response.status, 403)

  await testDatabase.query("UPDATE memberships SET manager_membership_id = $1 WHERE id = $2 AND workspace_id = $3", [replacementManagerMembership, managedMembership, workspaceId])
  assert.equal((await request(`/api/mca/deals/${managedOriginator.payload.id}`, { cookie: managerCookie })).response.status, 404)
  assert.equal((await request(`/api/mca/deals/${managedOriginator.payload.id}`, { cookie: replacementManagerCookie })).response.status, 200)

  const repExport = await fetch(`${baseUrl}/api/mca/deals/export`, { headers: await supabaseFixture.headers(managedRepCookie) })
  assert.equal(repExport.status, 403)
  assert.equal((await repExport.json()).error.code, "permission_denied")
  const readScopeExport = await request("/api/mca/deals/export", { bearer: readKey, origin: null })
  assert.equal(readScopeExport.response.status, 403)
  const formulaDraft = await request("/api/mca/deals", { method: "POST", cookie: adminCookie, body: {
    legalName: "=2+3", idempotencyKey: "formula-safe-export-1",
  } })
  assert.equal(formulaDraft.response.status, 201)
  const apiExport = await fetch(`${baseUrl}/api/mca/deals/export`, { headers: { authorization: `Bearer ${exportKey}` } })
  assert.equal(apiExport.status, 200)
  assert.match(apiExport.headers.get("content-type") ?? "", /^text\/csv/)
  assert.match(apiExport.headers.get("cache-control") ?? "", /no-store/)
  const exportedCsv = await apiExport.text()
  assert.match(exportedCsv, /Harbor Coffee LLC/)
  assert.match(exportedCsv, /'=2\+3/)
  assert.equal(exportedCsv.includes("4321"), false)
  assert.equal(exportedCsv.includes("ari@harbor.test"), false)
  const adminExport = await fetch(`${baseUrl}/api/mca/deals/export`, { headers: await supabaseFixture.headers(adminCookie) })
  assert.equal(adminExport.status, 200)
  const disableExport = await request("/api/workspace", { method: "PATCH", cookie: adminCookie, body: { actionVisibility: { exportDeals: false } } })
  assert.equal(disableExport.response.status, 200)
  assert.equal((await fetch(`${baseUrl}/api/mca/deals/export`, { headers: await supabaseFixture.headers(adminCookie) })).status, 403)
  assert.equal((await fetch(`${baseUrl}/api/mca/deals/export`, { headers: { authorization: `Bearer ${exportKey}` } })).status, 403)

  const note = await request(`/api/mca/deals/${draft.payload.id}/notes`, { method: "POST", bearer: writeKey, origin: null, body: { body: "Requested updated statements", expectedVersion: draft.payload.version } })
  assert.equal(note.response.status, 200, JSON.stringify(note.payload))
  assert.equal(note.payload.notes.at(-1).body, "Requested updated statements")
})
