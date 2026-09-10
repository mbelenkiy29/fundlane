import "server-only"
import { getClerkClient } from "./clerk-client"
import { billingEnabled, billingRole } from "./billing"
import {
  getDatabase,
  newId,
  nowIso,
  recordAuditEvent,
  withImmediateTransaction,
} from "./db"
import { AppError } from "./errors"
import type { MembershipContext, Role } from "./types"
import {
  DEFAULT_ACTION_VISIBILITY,
  DEFAULT_FEATURE_FLAGS,
  DEFAULT_PAGE_VISIBILITY,
} from "./workspaces"

export async function clerkIdentity() {
  const { auth } = await import("@clerk/nextjs/server")
  const session = await auth()
  if (!session.userId || !session.sessionId) return null
  const client = getClerkClient()
  const pair = await Promise.all([
    client.users.getUser(session.userId),
    client.sessions.getSession(session.sessionId),
  ]).catch((error: unknown) => {
    if (
      error &&
      typeof error === "object" &&
      "status" in error &&
      error.status === 404
    )
      return null
    throw new AppError(
      503,
      "identity_unavailable",
      "Account verification is temporarily unavailable. Please retry."
    )
  })
  if (!pair) return null
  const [user, remoteSession] = pair
  if (
    remoteSession.status !== "active" ||
    remoteSession.userId !== session.userId
  )
    return null
  if (user.banned || user.locked) return null
  const email = user.emailAddresses.find(
    (e) =>
      e.id === user.primaryEmailAddressId &&
      e.verification?.status === "verified"
  )
  if (!email || !user.passwordEnabled) return null
  return {
    client,
    user,
    email: email.emailAddress.toLowerCase(),
    orgId: session.orgId,
    sessionId: session.sessionId,
  }
}

type Identity = NonNullable<Awaited<ReturnType<typeof clerkIdentity>>>

export async function providerMembership(
  identity: Identity,
  organizationId: string
) {
  const result = await identity.client.organizations
    .getOrganizationMembershipList({
      organizationId,
      userId: [identity.user.id],
      limit: 1,
    })
    .catch((error: unknown) => {
      if (
        error &&
        typeof error === "object" &&
        "status" in error &&
        error.status === 404
      )
        return null
      throw new AppError(
        503,
        "identity_unavailable",
        "Company verification is temporarily unavailable. Please retry."
      )
    })
  return result?.data[0] ?? null
}

/** Only stable migration IDs or an accepted, server-issued invitation can link an old user. */
async function localUser(identity: Identity, invitedUserId?: string) {
  const db = getDatabase()
  const linked = await db
    .prepare<{ id: string }>("SELECT id FROM users WHERE clerk_user_id = ?")
    .get(identity.user.id)
  if (linked) {
    if (invitedUserId && linked.id !== invitedUserId)
      throw new AppError(
        409,
        "identity_conflict",
        "The invitation belongs to a different account record. Contact an administrator."
      )
    return linked.id
  }
  const trustedId = invitedUserId ?? identity.user.externalId
  if (trustedId) {
    const updated = await db
      .prepare<{ id: string }>(
        `UPDATE users SET clerk_user_id = ?, updated_at = ?
      WHERE id = ? AND (clerk_user_id IS NULL OR clerk_user_id = ?) AND lower(email) = ? RETURNING id`
      )
      .get(
        identity.user.id,
        nowIso(),
        trustedId,
        identity.user.id,
        identity.email
      )
    if (updated) return updated.id
    throw new AppError(
      409,
      "identity_conflict",
      "This account needs administrator reconciliation before it can be linked."
    )
  }
  const id = newId(),
    now = nowIso()
  const inserted = await db
    .prepare<{ id: string }>(
      `INSERT INTO users
    (id, email, name, application_identifier, clerk_user_id, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING RETURNING id`
    )
    .get(
      id,
      identity.email,
      [identity.user.firstName, identity.user.lastName]
        .filter(Boolean)
        .join(" ") || identity.email,
      `MCA-${id.slice(0, 8).toUpperCase()}`,
      identity.user.id,
      now,
      now
    )
  if (!inserted)
    throw new AppError(
      409,
      "account_migration_required",
      "An existing account must be migrated by an administrator before you can continue."
    )
  return inserted.id
}

async function acceptedInvitation(
  identity: Identity,
  organizationId: string,
  workspaceId: string
) {
  // Read Clerk's authoritative current state; webhook payloads never grant access.
  for (let offset = 0; ; offset += 100) {
    const page =
      await identity.client.organizations.getOrganizationInvitationList({
        organizationId,
        status: ["accepted"],
        limit: 100,
        offset,
      })
    for (const invitation of page.data) {
      if (invitation.emailAddress.toLowerCase() !== identity.email) continue
      const localId = invitation.publicMetadata.mcaInvitationId
      if (typeof localId !== "string") continue
      const row = await getDatabase()
        .prepare<{ id: string; user_id: string; membership_id: string }>(
          `SELECT i.id, m.user_id, m.id membership_id
        FROM invitations i JOIN memberships m ON m.id = i.membership_id
        WHERE i.id = ? AND i.workspace_id = ? AND i.status = 'pending' AND m.status = 'pending'
        AND lower(i.email) = ?`
        )
        .get(localId, workspaceId, identity.email)
      if (row) return row
    }
    if (offset + page.data.length >= page.totalCount || page.data.length === 0)
      return null
  }
}

export async function resolveClerkMembership(
  identity: Identity
): Promise<MembershipContext | null> {
  if (!identity.orgId) return null
  const remote = await providerMembership(identity, identity.orgId)
  if (!remote) return null
  const workspace = await getDatabase()
    .prepare<{ id: string }>(
      "SELECT id FROM workspaces WHERE clerk_organization_id = ?"
    )
    .get(identity.orgId)
  if (!workspace) return null
  let member = await getDatabase()
    .prepare<{ id: string; user_id: string; role: Role; status: string }>(
      `SELECT m.id, m.user_id, m.role, m.status
    FROM memberships m JOIN users u ON u.id = m.user_id WHERE u.clerk_user_id = ? AND m.workspace_id = ?`
    )
    .get(identity.user.id, workspace.id)
  if (member?.status === "deactivated") return null
  if (!member || member.status === "pending") {
    const invite = await acceptedInvitation(
      identity,
      identity.orgId,
      workspace.id
    )
    if (!invite) return null
    await withImmediateTransaction(async (db) => {
      await db
        .prepare("SELECT id FROM workspaces WHERE id = ? FOR UPDATE")
        .get(workspace.id)
      // Resends and deactivation can invalidate the invitation after the provider read.
      const current = await db
        .prepare(
          "SELECT i.id FROM invitations i JOIN memberships m ON m.id = i.membership_id WHERE i.id = ? AND i.workspace_id = ? AND i.status = 'pending' AND m.status = 'pending' FOR UPDATE OF i, m"
        )
        .get(invite.id, workspace.id)
      if (!current) return
      await localUser(identity, invite.user_id)
      const activated = await db
        .prepare(
          `UPDATE memberships SET status = 'active', clerk_membership_id = ?, updated_at = ?
        WHERE id = ? AND workspace_id = ? AND status = 'pending' RETURNING id`
        )
        .get(remote.id, nowIso(), invite.membership_id, workspace.id)
      if (activated)
        await db
          .prepare(
            "UPDATE invitations SET status = 'accepted', updated_at = ? WHERE id = ? AND status = 'pending'"
          )
          .run(nowIso(), invite.id)
    })
    member = await getDatabase()
      .prepare<{ id: string; user_id: string; role: Role; status: string }>(
        "SELECT id, user_id, role, status FROM memberships WHERE id = ? AND workspace_id = ?"
      )
      .get(invite.membership_id, workspace.id)
  }
  if (!member || member.status !== "active") return null
  if (billingEnabled() && remote.role !== billingRole(member.role)) {
    // Reconcile privileged provider capabilities to the current local role, including downgrades.
    await identity.client.organizations.updateOrganizationMembership({ organizationId: identity.orgId, userId: identity.user.id, role: billingRole(member.role) })
  }
  await getDatabase()
    .prepare(
      "UPDATE memberships SET clerk_membership_id = ? WHERE id = ? AND clerk_membership_id IS DISTINCT FROM ?"
    )
    .run(remote.id, member.id, remote.id)
  await getDatabase()
    .prepare(
      "UPDATE sms_companies SET email_verified_at = COALESCE(email_verified_at, ?) WHERE workspace_id = ? AND owner_user_id = ?"
    )
    .run(nowIso(), workspace.id, member.user_id)
  return {
    authType: "session",
    userId: member.user_id,
    membershipId: member.id,
    workspaceId: workspace.id,
    role: member.role,
    scopes: [],
    sessionId: identity.sessionId,
  }
}

export async function authenticateClerkSession(
  request?: Request
): Promise<MembershipContext | null> {
  void request // Accepted for business-test gateway stubs; identity comes only from Clerk.
  const identity = await clerkIdentity()
  return identity ? resolveClerkMembership(identity) : null
}

export async function completeCompanyOnboarding() {
  const identity = await clerkIdentity()
  if (!identity)
    throw new AppError(
      403,
      "account_setup_required",
      "Verify your email and set a password before continuing."
    )
  if (!identity.orgId)
    throw new AppError(
      409,
      "organization_required",
      "Create or select your company first."
    )
  const existing = await resolveClerkMembership(identity)
  if (existing) return existing
  const organization = await identity.client.organizations.getOrganization({
    organizationId: identity.orgId,
  })
  if (
    organization.createdBy !== identity.user.id ||
    !(await providerMembership(identity, identity.orgId))
  ) {
    throw new AppError(
      403,
      "invitation_required",
      "Ask your company administrator for an MCA invitation."
    )
  }
  await withImmediateTransaction(async (db) => {
    await db
      .prepare("SELECT pg_advisory_xact_lock(hashtext(?))")
      .get(`clerk-company:${identity.orgId}`)
    // Never treat an existing organization with a missing/deactivated membership as a new company.
    const created = await db
      .prepare<{ id: string }>(
        "SELECT id FROM workspaces WHERE clerk_organization_id = ?"
      )
      .get(identity.orgId)
    if (created) {
      // Another request may have completed this same setup while we waited for the lock.
      const active = await db
        .prepare(
          "SELECT m.id FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.workspace_id = ? AND u.clerk_user_id = ? AND m.status = 'active'"
        )
        .get(created.id, identity.user.id)
      if (active) return
      throw new AppError(
        403,
        "membership_inactive",
        "Your company membership is not active. Contact an administrator."
      )
    }
    const userId = await localUser(identity)
    const workspaceId = newId(),
      membershipId = newId(),
      now = nowIso()
    await db
      .prepare(
        `INSERT INTO workspaces (id, name, timezone, seat_limit, feature_flags, page_visibility, action_visibility, clerk_organization_id, created_at, updated_at)
      VALUES (?, ?, 'America/New_York', 5, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        workspaceId,
        organization.name,
        JSON.stringify(DEFAULT_FEATURE_FLAGS),
        JSON.stringify(DEFAULT_PAGE_VISIBILITY),
        JSON.stringify(DEFAULT_ACTION_VISIBILITY),
        identity.orgId,
        now,
        now
      )
    await db
      .prepare(
        `INSERT INTO memberships (id, workspace_id, user_id, role, status, created_at, updated_at) VALUES (?, ?, ?, 'admin', 'active', ?, ?)`
      )
      .run(membershipId, workspaceId, userId, now, now)
    await db
      .prepare(
        "INSERT INTO sms_companies (workspace_id, owner_user_id, email_verified_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?)"
      )
      .run(workspaceId, userId, now, now, now)
    await recordAuditEvent({
      context: { workspaceId, userId },
      action: "company.signup",
      resourceType: "workspace",
      resourceId: workspaceId,
      executor: db,
    })
  })
  const result = await resolveClerkMembership(identity)
  if (!result)
    throw new AppError(
      409,
      "onboarding_retry",
      "Company setup is pending. Please retry."
    )
  return result
}
