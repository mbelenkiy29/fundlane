import test, { after, before, mock } from "node:test"
import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { createPostgresTestDatabase } from "./helpers/postgres-test-db.mjs"
import { closeDatabaseForTests, getDatabase, newId } from "../src/lib/mca/db"
import { createWorkspaceWithAdmin } from "../src/lib/mca/workspaces"
import type { MembershipContext } from "../src/lib/mca/types"

// Keep the real invitation service and database; replace only external delivery.
mock.module(new URL("../src/lib/mca/email.ts", import.meta.url).href, {
  namedExports: {
    deliverEmail: async () => ({ delivery: "sent", correlationId: newId() }),
  },
})
let inviteMember: typeof import("../src/lib/mca/memberships").inviteMember
let listMemberships: typeof import("../src/lib/mca/memberships").listMemberships
let getMembership: typeof import("../src/lib/mca/memberships").getMembership
let database: Awaited<ReturnType<typeof createPostgresTestDatabase>>
before(async () => {
  database = await createPostgresTestDatabase("invitation_profiles")
  process.env.DATABASE_URL = database.databaseUrl
  ;({ inviteMember, listMemberships, getMembership } = await import("../src/lib/mca/memberships"))
})
after(async () => { await closeDatabaseForTests(); await database?.close() })

async function company(): Promise<MembershipContext> {
  const local = await createWorkspaceWithAdmin({
    workspaceName: "Synthetic invitation company", adminName: "Existing owner",
    adminEmail: `${randomUUID()}@example.test`, password: "Fixture password only 99!",
  })
  return { ...local, authType: "session", role: "super_admin", scopes: [], sessionId: randomUUID() }
}

test("inviting an existing account from another company preserves its global profile and memberships", async () => {
  const owner = await company(), inviter = await company(), db = getDatabase()
  await db.prepare("UPDATE users SET phone=?,supabase_user_id=? WHERE id=?")
    .run("+12025550100", randomUUID(), owner.userId)
  const readProfile = () => db.prepare<{ email: string }>("SELECT id,email,name,phone,supabase_user_id,updated_at FROM users WHERE id=?").get(owner.userId)
  const original = await readProfile()
  assert.ok(original)
  const invitation = await inviteMember(inviter, {
    email: original.email.toUpperCase(), name: "Unaccepted replacement name", phone: "+12025550199", role: "rep",
  }, "https://fixture.example.test")
  assert.deepEqual(await readProfile(), original)
  assert.deepEqual(await db.prepare("SELECT user_id,workspace_id,role,status FROM memberships WHERE id=?").get(invitation.membershipId), {
    user_id: owner.userId, workspace_id: inviter.workspaceId, role: "rep", status: "pending",
  })
  assert.deepEqual(await db.prepare("SELECT role,status FROM memberships WHERE id=?").get(owner.membershipId), {
    role: "super_admin", status: "active",
  })
  const pending = (await listMemberships(inviter.workspaceId)).find(member => member.id === invitation.membershipId)
  assert.ok(pending)
  assert.deepEqual({ name: pending.name, email: pending.email, phone: pending.phone, status: pending.status }, {
    name: original.email, email: original.email, phone: null, status: "pending",
  })
  const detail = await getMembership(inviter.workspaceId, invitation.membershipId)
  assert.equal(detail.name, original.email)
  assert.equal(detail.phone, null)
})

test("a new invited account retains its submitted name and phone without later invitations overwriting it", async () => {
  const first = await company(), second = await company(), db = getDatabase()
  const email = `${randomUUID()}@example.test`
  const invitation = await inviteMember(first, { email, name: "New teammate", phone: "+12025550101", role: "rep" }, "https://fixture.example.test")
  const profile = await db.prepare("SELECT name,phone FROM users WHERE email=?").get(email)
  assert.deepEqual(profile, { name: "New teammate", phone: "+12025550101" })
  const firstPending = (await listMemberships(first.workspaceId)).find(member => member.id === invitation.membershipId)
  assert.deepEqual({ name: firstPending?.name, phone: firstPending?.phone }, profile)
  const secondInvitation = await inviteMember(second, { email, name: "Other company's label", role: "rep" }, "https://fixture.example.test")
  assert.deepEqual(await db.prepare("SELECT name,phone FROM users WHERE email=?").get(email), profile)
  const secondPending = (await listMemberships(second.workspaceId)).find(member => member.id === secondInvitation.membershipId)
  assert.equal(secondPending?.name, email)
  assert.equal(secondPending?.phone, null)
  const secondDetail = await getMembership(second.workspaceId, secondInvitation.membershipId)
  assert.equal(secondDetail.name, email)
  assert.equal(secondDetail.phone, null)
  assert.equal((await db.prepare<{ status: string }>("SELECT status FROM invitations WHERE id=?").get(invitation.id))?.status, "pending")
})

test("each sharing signal independently masks pending profiles and active memberships reveal the profile", async () => {
  for (const signal of ["supabase", "password", "membership"] as const) {
    const inviter = await company(), db = getDatabase()
    const email = `zz-${randomUUID()}@example.test`
    const invitation = await inviteMember(inviter, { email, name: "Private account name", phone: "+12025550102", role: "rep" }, "https://fixture.example.test")
    if (signal === "membership") {
      const other = await company()
      await inviteMember(other, { email, name: "Other invitation", role: "rep" }, "https://fixture.example.test")
    } else {
      await db.prepare(signal === "supabase"
        ? "UPDATE users SET supabase_user_id=? WHERE email=?"
        : "UPDATE users SET password_hash=? WHERE email=?").run(randomUUID(), email)
    }
    for (const member of [await getMembership(inviter.workspaceId, invitation.membershipId),
      (await listMemberships(inviter.workspaceId)).find(m => m.id === invitation.membershipId)!]) {
      assert.equal(member.name, email, signal)
      assert.equal(member.phone, null, signal)
    }
    const names = (await listMemberships(inviter.workspaceId)).map(member => member.name.toLowerCase())
    assert.deepEqual(names, [...names].sort(), "sort by visible names, not hidden profiles")
    await db.prepare("UPDATE memberships SET status='active' WHERE id=?").run(invitation.membershipId)
    for (const member of [await getMembership(inviter.workspaceId, invitation.membershipId),
      (await listMemberships(inviter.workspaceId)).find(m => m.id === invitation.membershipId)!]) {
      assert.equal(member.name, "Private account name", signal)
      assert.equal(member.phone, "+12025550102", signal)
    }
  }
})
