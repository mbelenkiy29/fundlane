import { postgresConnection } from "../src/lib/mca/db-connection"
import "./helpers/business-auth";
import test, { after, before } from "node:test"
import assert from "node:assert/strict"
import { Client } from "pg"
import { closeDatabaseForTests, getDatabase } from "../src/lib/mca/db"
import { createPostgresTestDatabase } from "./helpers/postgres-test-db.mjs"
import { hashOpaqueToken } from "../src/lib/mca/crypto"
import type { DealActor } from "../src/lib/mca/deals/schema"
import type { Role } from "../src/lib/mca/types"
import {
  assertSelectableFunder,
  createFunder,
  createGroup,
  getFunder,
  getGroup,
  listFunders,
  resolveGroup,
  updateFunder,
  updateGroup,
} from "../src/lib/mca/funders/directory"
import { GET as listFundersGet, POST as listFundersPost } from "../src/app/api/mca/funders/route"
import { GET as funderGet, PATCH as funderPatch, POST as funderSelect } from "../src/app/api/mca/funders/[id]/route"
import { GET as groupsGet, POST as groupsPost } from "../src/app/api/mca/funders/groups/route"
import { GET as groupGet } from "../src/app/api/mca/funders/groups/[id]/route"

let testDatabase: Awaited<ReturnType<typeof createPostgresTestDatabase>>

const ids = {
  workspace: "workspace-funders",
  otherWorkspace: "workspace-other",
  adminUser: "funder-admin-user",
  adminMember: "funder-admin-member",
  repUser: "funder-rep-user",
  repMember: "funder-rep-member",
  otherUser: "funder-other-user",
  otherMember: "funder-other-member",
}

const actor = (workspaceId = ids.workspace, role: Role | null = "admin"): DealActor => ({
  workspaceId,
  userId: workspaceId === ids.otherWorkspace ? ids.otherUser : role === "rep" ? ids.repUser : ids.adminUser,
  membershipId: workspaceId === ids.otherWorkspace ? ids.otherMember : role === "rep" ? ids.repMember : ids.adminMember,
  role,
  managedMembershipIds: [],
  activeMembershipIds: [],
  source: role ? "user" : "api_key",
  correlationId: `corr-${workspaceId}-${role ?? "key"}`,
})

async function seed() {
  const database = getDatabase()
  const now = new Date().toISOString()
  const visibility = JSON.stringify({ dashboard: true, deals: true, users: true, reports: true, payments: true, workspace: true, integrations: true })
  const actions = JSON.stringify({ createDeal: true, exportDeals: true, inviteUsers: true, manageApiKeys: true, viewPaymentTable: true, viewCompanyFinancials: true })
  const flags = JSON.stringify({ reports: true, payments: true, integrations: true })
  for (const [id, name] of [[ids.workspace, "Funders Test"], [ids.otherWorkspace, "Other Workspace"]] as const) {
    await database.prepare(`INSERT INTO workspaces (id,name,timezone,seat_limit,feature_flags,page_visibility,action_visibility,created_at,updated_at)
      VALUES (?, ?, 'America/New_York', 5, ?, ?, ?, ?, ?)`).run(id, name, flags, visibility, actions, now, now)
  }
  for (const [userId, memberId, email, workspaceId, role] of [
    [ids.adminUser, ids.adminMember, "funders-admin@example.test", ids.workspace, "admin"],
    [ids.repUser, ids.repMember, "funders-rep@example.test", ids.workspace, "rep"],
    [ids.otherUser, ids.otherMember, "funders-other@example.test", ids.otherWorkspace, "admin"],
  ] as const) {
    await database.prepare(`INSERT INTO users (id,email,password_hash,name,phone,application_identifier,created_at,updated_at)
      VALUES (?, ?, NULL, ?, NULL, ?, ?, ?)`).run(userId, email, email, `APP-${userId.slice(-6)}`, now, now)
    await database.prepare(`INSERT INTO memberships (id,workspace_id,user_id,role,manager_membership_id,status,sender_association,created_at,updated_at)
      VALUES (?, ?, ?, ?, NULL, 'active', NULL, ?, ?)`).run(memberId, workspaceId, userId, role, now, now)
  }
  await database.prepare(`INSERT INTO sessions (id,user_id,membership_id,token_hash,expires_at,created_at,last_seen_at)
    VALUES (?, ?, ?, ?, '2099-01-01T00:00:00.000Z', ?, ?)`).run("funder-admin-session", ids.adminUser, ids.adminMember, hashOpaqueToken("admin-session-token"), now, now)
  await database.prepare(`INSERT INTO sessions (id,user_id,membership_id,token_hash,expires_at,created_at,last_seen_at)
    VALUES (?, ?, ?, ?, '2099-01-01T00:00:00.000Z', ?, ?)`).run("funder-rep-session", ids.repUser, ids.repMember, hashOpaqueToken("rep-session-token"), now, now)
  await database.prepare(`INSERT INTO sessions (id,user_id,membership_id,token_hash,expires_at,created_at,last_seen_at)
    VALUES (?, ?, ?, ?, '2099-01-01T00:00:00.000Z', ?, ?)`).run("funder-other-session", ids.otherUser, ids.otherMember, hashOpaqueToken("other-session-token"), now, now)
  const addKey = async (id: string, secret: string, scopes: string[], workspaceId: string, createdBy: string) => {
    await database.prepare(`INSERT INTO api_keys
      (id,workspace_id,name,prefix,secret_hash,scopes,expires_at,last_used_at,revoked_at,rate_limit_per_minute,created_by,created_at)
      VALUES (?, ?, ?, 'mca_test', ?, ?, NULL, NULL, NULL, 60, ?, ?)`).run(id, workspaceId, id, hashOpaqueToken(`mca_${secret}`), JSON.stringify(scopes), createdBy, now)
  }
  await addKey("intake-key", "intake-secret", ["intake:write"], ids.workspace, ids.adminUser)
  await addKey("read-key", "read-secret", ["deals:read"], ids.workspace, ids.adminUser)
}

before(async () => {
  testDatabase = await createPostgresTestDatabase("funders_directory")
  Object.assign(process.env, testDatabase.env())
  await seed()
})
after(async () => {
  await closeDatabaseForTests()
  await testDatabase.close()
})

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

async function holdRowLock(table: "mca_funders" | "mca_funder_groups", workspaceId: string, id: string) {
  const client = new Client(postgresConnection(testDatabase.databaseUrlUnpooled))
  await client.connect()
  await client.query("BEGIN")
  await client.query(`SELECT id FROM ${table} WHERE workspace_id = $1 AND id = $2 FOR UPDATE`, [workspaceId, id])
  return async () => {
    await client.query("COMMIT")
    await client.end()
  }
}

test("MIC-192 inactive funder cannot be selected but remains readable by id", async () => {
  const created = await createFunder(actor(), {
    idempotencyKey: "inactive-readable",
    legalName: "Archived Capital LLC",
    nickname: "Archived",
    website: "https://archived.example.test",
    domains: ["archived.example.test"],
    products: ["MCA"],
    contacts: [{ name: "Dana Desk", email: "dana@archived.example.test", role: "ISO" }],
    routes: [{ kind: "email", label: "Submissions", destination: "subs@archived.example.test", documentExceptions: [], active: true }],
  })
  assert.equal(created.funder.active, true)
  assert.equal(created.funder.profileVersion, 1)
  const archived = await updateFunder(actor(), created.funder.id, { active: false })
  assert.equal(archived.active, false)
  assert.equal(archived.profileVersion, 2)
  assert.equal((await listFunders(actor())).some((item) => item.id === archived.id), false)
  assert.equal((await listFunders(actor(), { includeInactive: true })).some((item) => item.id === archived.id), true)
  const historical = await getFunder(actor(), archived.id)
  assert.equal(historical.id, archived.id)
  assert.equal(historical.active, false)
  assert.equal(historical.legalName, "Archived Capital LLC")
  await assert.rejects(assertSelectableFunder(actor(), archived.id), (error: { status?: number; code?: string }) => error.status === 422 && error.code === "inactive_funder")
  const row = await getDatabase().prepare<{ count: string }>("SELECT COUNT(*) AS count FROM mca_funders WHERE id = ?").get(archived.id)
  assert.equal(Number(row?.count), 1)

  const listed = await listFundersGet(cookieRequest("/api/mca/funders", "admin-session-token"))
  assert.equal(listed.status, 200)
  const listedBody = await listed.json() as { funders: Array<{ id: string }> }
  assert.equal(listedBody.funders.some((item) => item.id === archived.id), false)
  const withInactive = await listFundersGet(cookieRequest("/api/mca/funders?includeInactive=true", "admin-session-token"))
  assert.equal((await withInactive.json() as { funders: Array<{ id: string }> }).funders.some((item) => item.id === archived.id), true)
  const byId = await funderGet(cookieRequest(`/api/mca/funders/${archived.id}`, "admin-session-token"), params(archived.id))
  assert.equal(byId.status, 200)
  assert.equal((await byId.json() as { id: string; active: boolean }).active, false)
  const selected = await funderSelect(cookieRequest(`/api/mca/funders/${archived.id}`, "admin-session-token", { method: "POST", body: "{}" }), params(archived.id))
  assert.equal(selected.status, 422)
  assert.equal((await selected.json() as { error: { code: string } }).error.code, "inactive_funder")
})

test("MIC-192 group [A, A, inactive B] resolves to unique active [A]", async () => {
  const funderA = (await createFunder(actor(), { idempotencyKey: "group-a", legalName: "Alpha Funding LLC" })).funder
  const funderB = (await createFunder(actor(), { idempotencyKey: "group-b", legalName: "Beta Funding LLC" })).funder
  await updateFunder(actor(), funderB.id, { active: false })
  const group = await createGroup(actor(), { name: "Core book", funderIds: [funderA.id, funderA.id, funderB.id] })
  assert.deepEqual(group.funderIds, [funderA.id, funderA.id, funderB.id])
  assert.deepEqual(await resolveGroup(actor(), group.id), [funderA.id])
  const updated = await updateGroup(actor(), group.id, { funderIds: [funderB.id, funderA.id, funderA.id] })
  assert.deepEqual(await resolveGroup(actor(), updated.id), [funderA.id])
})

test("MIC-192 create and list are isolated across workspaces", async () => {
  const local = (await createFunder(actor(), { idempotencyKey: "shared-key", legalName: "Local Funder LLC" })).funder
  const remote = (await createFunder(actor(ids.otherWorkspace), { idempotencyKey: "shared-key", legalName: "Remote Funder LLC" })).funder
  assert.notEqual(local.id, remote.id)
  assert.equal((await listFunders(actor())).some((item) => item.id === remote.id), false)
  assert.equal((await listFunders(actor(ids.otherWorkspace))).some((item) => item.id === local.id), false)
  await assert.rejects(getFunder(actor(ids.otherWorkspace), local.id), (error: { status?: number; code?: string }) => error.status === 404 && error.code === "funder_not_found")
  await assert.rejects(getFunder(actor(), remote.id), (error: { status?: number; code?: string }) => error.status === 404 && error.code === "funder_not_found")
  await assert.rejects(createGroup(actor(ids.otherWorkspace), { name: "Stolen", funderIds: [local.id] }), (error: { status?: number; code?: string }) => error.status === 404 && (error.code === "funder_not_found" || error.code === "group_funder_not_found"))
})

test("MIC-192 idempotent create returns the same id and increments profileVersion on updates", async () => {
  const first = await createFunder(actor(), {
    idempotencyKey: "idempotent-alpha",
    legalName: "Idempotent Capital",
    products: ["MCA", "ACH"],
    routes: [{ kind: "api", label: "ISO API", destination: "https://iso.example.test/submit", documentExceptions: ["voided_check"], active: true }],
  })
  const replay = await createFunder(actor(), { idempotencyKey: "idempotent-alpha", legalName: "Changed Name LLC" })
  assert.equal(replay.created, false)
  assert.equal(replay.funder.id, first.funder.id)
  assert.equal(replay.funder.legalName, "Idempotent Capital")
  const httpFirst = await listFundersPost(cookieRequest("/api/mca/funders", "admin-session-token", {
    method: "POST",
    body: JSON.stringify({ idempotencyKey: "idempotent-http", legalName: "HTTP Capital LLC" }),
  }))
  assert.equal(httpFirst.status, 201)
  const created = await httpFirst.json() as { id: string }
  const httpReplay = await listFundersPost(cookieRequest("/api/mca/funders", "admin-session-token", {
    method: "POST",
    body: JSON.stringify({ idempotencyKey: "idempotent-http", legalName: "HTTP Capital LLC" }),
  }))
  assert.equal(httpReplay.status, 200)
  assert.equal((await httpReplay.json() as { id: string }).id, created.id)
  const patched = await funderPatch(cookieRequest(`/api/mca/funders/${created.id}`, "admin-session-token", {
    method: "PATCH",
    body: JSON.stringify({ nickname: "HTTP", contacts: [{ name: "Pat", email: "pat@http.example.test" }] }),
  }), params(created.id))
  assert.equal(patched.status, 200)
  const updated = await patched.json() as { profileVersion: number; nickname?: string }
  assert.equal(updated.nickname, "HTTP")
  assert.equal(updated.profileVersion, 2)
})

test("concurrent disjoint funder and group edits preserve both patches", async () => {
  const first = (await createFunder(actor(), { idempotencyKey: "concurrent-edit-a", legalName: "Concurrent Alpha LLC" })).funder
  const second = (await createFunder(actor(), { idempotencyKey: "concurrent-edit-b", legalName: "Concurrent Beta LLC" })).funder
  const releaseFunder = await holdRowLock("mca_funders", ids.workspace, first.id)
  const nicknameUpdate = updateFunder(actor(), first.id, { nickname: "Alpha" })
  const websiteUpdate = updateFunder(actor(), first.id, { website: "https://alpha.concurrent.test" })
  await new Promise((resolve) => setTimeout(resolve, 100))
  await releaseFunder()
  await Promise.all([nicknameUpdate, websiteUpdate])
  const savedFunder = await getFunder(actor(), first.id)
  assert.equal(savedFunder.nickname, "Alpha")
  assert.equal(savedFunder.website, "https://alpha.concurrent.test")
  assert.equal(savedFunder.profileVersion, 3)

  const group = await createGroup(actor(), { name: "Concurrent group", funderIds: [first.id] })
  const releaseGroup = await holdRowLock("mca_funder_groups", ids.workspace, group.id)
  const nameUpdate = updateGroup(actor(), group.id, { name: "Renamed concurrent group" })
  const membersUpdate = updateGroup(actor(), group.id, { funderIds: [first.id, second.id] })
  await new Promise((resolve) => setTimeout(resolve, 100))
  await releaseGroup()
  await Promise.all([nameUpdate, membersUpdate])
  const savedGroup = await getGroup(actor(), group.id)
  assert.equal(savedGroup.name, "Renamed concurrent group")
  assert.deepEqual(savedGroup.funderIds, [first.id, second.id])
})

test("MIC-192 intake:write API keys cannot list or mutate funders", async () => {
  const listed = await listFundersGet(bearerRequest("/api/mca/funders", "intake-secret"))
  assert.equal(listed.status, 403)
  assert.equal((await listed.json() as { error: { code: string } }).error.code, "scope_required")
  const created = await listFundersPost(bearerRequest("/api/mca/funders", "intake-secret", {
    method: "POST",
    body: JSON.stringify({ idempotencyKey: "intake-denied", legalName: "Denied LLC" }),
  }))
  assert.equal(created.status, 403)
  const groups = await groupsGet(bearerRequest("/api/mca/funders/groups", "intake-secret"))
  assert.equal(groups.status, 403)
  const groupCreate = await groupsPost(bearerRequest("/api/mca/funders/groups", "intake-secret", {
    method: "POST",
    body: JSON.stringify({ name: "Denied group", funderIds: [] }),
  }))
  assert.equal(groupCreate.status, 403)
  const readable = await listFundersGet(bearerRequest("/api/mca/funders", "read-secret"))
  assert.equal(readable.status, 200)
})

test("MIC-192 rep session cannot POST funders or groups", async () => {
  const created = await listFundersPost(cookieRequest("/api/mca/funders", "rep-session-token", {
    method: "POST",
    body: JSON.stringify({ idempotencyKey: "rep-denied", legalName: "Rep Funder LLC" }),
  }))
  assert.equal(created.status, 403)
  assert.equal((await created.json() as { error: { code: string } }).error.code, "permission_denied")
  const group = await groupsPost(cookieRequest("/api/mca/funders/groups", "rep-session-token", {
    method: "POST",
    body: JSON.stringify({ name: "Rep group", funderIds: [] }),
  }))
  assert.equal(group.status, 403)
  const listed = await listFundersGet(cookieRequest("/api/mca/funders", "rep-session-token"))
  assert.equal(listed.status, 200)
  const cross = await listFundersGet(cookieRequest("/api/mca/funders", "other-session-token"))
  const crossBody = await cross.json() as { funders: Array<{ workspaceId: string }> }
  assert.equal(crossBody.funders.every((item) => item.workspaceId === ids.otherWorkspace), true)
  const resolved = await groupGet(cookieRequest("/api/mca/funders/groups/missing", "admin-session-token"), params("missing"))
  assert.equal(resolved.status, 404)
})
