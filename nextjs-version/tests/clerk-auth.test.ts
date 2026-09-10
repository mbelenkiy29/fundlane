import test, { before, after } from "node:test"
import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { createPostgresTestDatabase } from "./helpers/postgres-test-db.mjs"
import { createWorkspaceWithAdmin } from "../src/lib/mca/workspaces"
import { getDatabase, nowIso, closeDatabaseForTests } from "../src/lib/mca/db"
import { resolveClerkMembership } from "../src/lib/mca/clerk-auth"
import { authenticateSessionToken } from "../src/lib/mca/auth"
import { processClerkWebhook } from "../src/lib/mca/clerk-webhooks"
import { safeAuthReturnTo } from "../src/lib/mca/auth-navigation"
import type { WebhookEvent } from "@clerk/nextjs/server"

let database: Awaited<ReturnType<typeof createPostgresTestDatabase>>
before(async () => {
  database = await createPostgresTestDatabase("clerk_auth")
  process.env.DATABASE_URL = database.databaseUrl
})
after(async () => {
  await closeDatabaseForTests()
  await database.close()
})
async function fixture(role = "admin") {
  const suffix = randomUUID()
  const email = `${suffix}@example.test`
  const local = await createWorkspaceWithAdmin({
    workspaceName: "Clerk isolation",
    adminName: "Owner",
    adminEmail: email,
    password: "Unused legacy password 99!",
    role: "admin",
  })
  const userId = `user_${suffix}`,
    orgId = `org_${suffix}`,
    remoteMemberId = `orgmem_${suffix}`
  await getDatabase()
    .prepare("UPDATE users SET clerk_user_id = ? WHERE id = ?")
    .run(userId, local.userId)
  await getDatabase()
    .prepare("UPDATE workspaces SET clerk_organization_id = ? WHERE id = ?")
    .run(orgId, local.workspaceId)
  await getDatabase()
    .prepare("UPDATE memberships SET role = ? WHERE id = ?")
    .run(role, local.membershipId)
  const state = { present: true, invites: [] as unknown[] }
  const client = {
    organizations: {
      getOrganizationMembershipList: async () => ({
        data: state.present ? [{ id: remoteMemberId }] : [],
        totalCount: state.present ? 1 : 0,
      }),
      getOrganizationInvitationList: async () => ({
        data: state.invites,
        totalCount: state.invites.length,
      }),
    },
  }
  const identity = {
    user: { id: userId, externalId: null },
    email,
    client,
    orgId,
    sessionId: "sess_test",
  } as unknown as Parameters<typeof resolveClerkMembership>[0]
  return {
    ...local,
    email,
    userId,
    orgId,
    remoteMemberId,
    state,
    client,
    identity,
  }
}

test("Clerk maps stable MCA IDs and preserves all four local roles", async () => {
  for (const role of ["rep", "manager", "admin", "super_admin"]) {
    const f = await fixture(role)
    const context = await resolveClerkMembership(f.identity)
    assert.equal(context?.role, role)
    assert.equal(
      context?.userId,
      (await getDatabase()
        .prepare<{ user_id: string }>(
          "SELECT user_id FROM memberships WHERE id = ?"
        )
        .get(f.membershipId))!.user_id
    )
    assert.equal(context?.workspaceId, f.workspaceId)
    assert.equal(context?.membershipId, f.membershipId)
  }
})
test("missing provider membership, foreign org, and local deactivation deny access", async () => {
  const f = await fixture()
  f.state.present = false
  assert.equal(await resolveClerkMembership(f.identity), null)
  f.state.present = true
  assert.equal(
    await resolveClerkMembership({ ...f.identity, orgId: "org_foreign" }),
    null
  )
  await getDatabase()
    .prepare("UPDATE memberships SET status='deactivated' WHERE id=?")
    .run(f.membershipId)
  assert.equal(await resolveClerkMembership(f.identity), null)
})
test("accepted invitation links a pending record once without changing its role or manager", async () => {
  const f = await fixture("rep")
  const id = randomUUID()
  const localUser = (await getDatabase()
    .prepare<{ user_id: string }>("SELECT user_id FROM memberships WHERE id=?")
    .get(f.membershipId))!.user_id
  await getDatabase()
    .prepare("UPDATE memberships SET status='pending' WHERE id=?")
    .run(f.membershipId)
  await getDatabase()
    .prepare("UPDATE users SET clerk_user_id=NULL WHERE id=?")
    .run(localUser)
  await getDatabase()
    .prepare(
      `INSERT INTO invitations (id,workspace_id,membership_id,email,token_hash,expires_at,status,delivery_status,delivery_correlation_id,created_by,created_at,updated_at)
    VALUES (?,?,?,?,?,?,'pending','sent',?,?,?,?)`
    )
    .run(
      id,
      f.workspaceId,
      f.membershipId,
      f.email,
      randomUUID(),
      new Date(Date.now() + 86400000).toISOString(),
      randomUUID(),
      localUser,
      nowIso(),
      nowIso()
    )
  f.state.invites = [
    {
      id: "inv_remote",
      emailAddress: f.email,
      publicMetadata: { mcaInvitationId: id },
    },
  ]
  const first = await resolveClerkMembership(f.identity)
  const second = await resolveClerkMembership(f.identity)
  assert.equal(first?.membershipId, f.membershipId)
  assert.equal(second?.role, "rep")
  assert.equal(
    (
      await getDatabase()
        .prepare<{ status: string }>(
          "SELECT status FROM invitations WHERE id=?"
        )
        .get(id)
    )?.status,
    "accepted"
  )
})
test("provider membership or matching email alone cannot activate an unapproved employee", async () => {
  const f = await fixture()
  await getDatabase()
    .prepare("UPDATE memberships SET status='pending' WHERE id=?")
    .run(f.membershipId)
  f.state.invites = [
    { id: "external_invite", emailAddress: f.email, publicMetadata: {} },
  ]
  assert.equal(await resolveClerkMembership(f.identity), null)
})
test("webhook retries are idempotent and stale deletion cannot remove a current provider membership", async () => {
  const f = await fixture()
  const event = {
    type: "organizationMembership.deleted",
    data: {
      organization: { id: f.orgId },
      public_user_data: { user_id: f.userId },
    },
  } as WebhookEvent
  const client = f.client as unknown as Parameters<
    typeof processClerkWebhook
  >[2]
  await processClerkWebhook("evt_reordered", event, client)
  await processClerkWebhook("evt_reordered", event, client)
  assert.equal(
    (
      await getDatabase()
        .prepare<{ status: string }>(
          "SELECT status FROM memberships WHERE id=?"
        )
        .get(f.membershipId)
    )?.status,
    "active"
  )
  f.state.present = false
  await processClerkWebhook("evt_revoked", event, client)
  f.state.present = true
  await processClerkWebhook(
    "evt_created",
    { ...event, type: "organizationMembership.created" } as WebhookEvent,
    client
  )
  assert.equal(await resolveClerkMembership(f.identity), null)
})
test("legacy session cookies are rejected and return URLs cannot escape the application", async () => {
  assert.equal(await authenticateSessionToken("old-session"), null)
  for (const value of [
    "https://evil.test",
    "//evil.test",
    "/dashboard\\@evil.test",
    "/sign-in",
    null,
  ])
    assert.equal(safeAuthReturnTo(value), "/dashboard")
  assert.equal(
    safeAuthReturnTo("/deals?deal=123&addDocument=1"),
    "/deals?deal=123&addDocument=1"
  )
})
