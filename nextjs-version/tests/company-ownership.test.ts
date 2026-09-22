import test, { before, after } from "node:test"
import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { createPostgresTestDatabase } from "./helpers/postgres-test-db.mjs"
import { createWorkspaceWithAdmin } from "../src/lib/mca/workspaces"
import { getDatabase, nowIso, closeDatabaseForTests } from "../src/lib/mca/db"
import { transferCompanyOwnership } from "../src/lib/mca/company-ownership"
import { updateMembership, deactivateMembership } from "../src/lib/mca/memberships"
import type { MembershipContext } from "../src/lib/mca/types"

let database: Awaited<ReturnType<typeof createPostgresTestDatabase>>
before(async () => {
  database = await createPostgresTestDatabase("company_ownership")
  process.env.DATABASE_URL = database.databaseUrl
})
after(async () => { await closeDatabaseForTests(); await database?.close() })

async function fixture() {
  const owner = await createWorkspaceWithAdmin({ workspaceName: "Ownership test", adminName: "Owner", adminEmail: `${randomUUID()}@example.test`, password: "Fixture password 123!", role: "admin" })
  const db = getDatabase(), now = nowIso()
  await db.prepare("INSERT INTO workspace_owners(workspace_id,membership_id,updated_at) VALUES (?,?,?)").run(owner.workspaceId, owner.membershipId, now)
  const other = await createWorkspaceWithAdmin({ workspaceName: "Other company", adminName: "Other", adminEmail: `${randomUUID()}@example.test`, password: "Fixture password 123!", role: "admin" })
  const memberId = randomUUID()
  await db.prepare("INSERT INTO memberships(id,workspace_id,user_id,role,status,created_at,updated_at) VALUES (?,?,?,'rep','active',?,?)").run(memberId, owner.workspaceId, other.userId, now, now)
  const context: MembershipContext = { authType: "session", userId: owner.userId, membershipId: owner.membershipId, workspaceId: owner.workspaceId, role: "admin", scopes: [], sessionId: randomUUID() }
  return { owner, other, memberId, context }
}

test("ownership transfer rejects non-owners, other-company members, and pending members", async () => {
  const f = await fixture()
  await assert.rejects(transferCompanyOwnership({ ...f.context, userId: f.other.userId, membershipId: f.memberId, role: "super_admin" }, f.memberId), { code: "owner_required" })
  await assert.rejects(transferCompanyOwnership(f.context, f.other.membershipId), { code: "active_member_required" })
  await getDatabase().prepare("UPDATE memberships SET status='pending' WHERE id=?").run(f.memberId)
  await assert.rejects(transferCompanyOwnership(f.context, f.memberId), { code: "active_member_required" })
})

test("owners cannot be demoted or deactivated before transferring ownership", async () => {
  const f = await fixture()
  await assert.rejects(updateMembership(f.context, f.owner.membershipId, { role: "rep" }), { code: "owner_protected" })
  await assert.rejects(deactivateMembership({ ...f.context, membershipId: f.memberId, userId: f.other.userId }, f.owner.membershipId), { code: "owner_protected" })
})

test("transfer promotes the successor, records an audit event, and rejects stale owner authority", async () => {
  const f = await fixture()
  await transferCompanyOwnership(f.context, f.memberId)
  const db = getDatabase()
  assert.equal((await db.prepare<{ membership_id: string }>("SELECT membership_id FROM workspace_owners WHERE workspace_id=?").get(f.owner.workspaceId))?.membership_id, f.memberId)
  assert.equal((await db.prepare<{ role: string }>("SELECT role FROM memberships WHERE id=?").get(f.memberId))?.role, "admin")
  assert.ok(await db.prepare("SELECT id FROM audit_events WHERE workspace_id=? AND action='company.ownership_transferred'").get(f.owner.workspaceId))
  await assert.rejects(transferCompanyOwnership(f.context, f.owner.membershipId), { code: "owner_required" })
})

test("concurrent transfers serialize and only one successor is committed", async () => {
  const f = await fixture(), thirdId = randomUUID(), now = nowIso()
  const third = await createWorkspaceWithAdmin({ workspaceName: "Third", adminName: "Third", adminEmail: `${randomUUID()}@example.test`, password: "Fixture password 123!", role: "admin" })
  await getDatabase().prepare("INSERT INTO memberships(id,workspace_id,user_id,role,status,created_at,updated_at) VALUES (?,?,?,'rep','active',?,?)").run(thirdId, f.owner.workspaceId, third.userId, now, now)
  const results = await Promise.allSettled([transferCompanyOwnership(f.context, f.memberId), transferCompanyOwnership(f.context, thirdId)])
  assert.equal(results.filter(result => result.status === "fulfilled").length, 1)
  assert.equal(results.filter(result => result.status === "rejected").length, 1)
})
