import "server-only";
import { membershipProfileNameSql, membershipProfilePhoneSql } from "./membership-profile";
import { deliverSupabaseInvitation, syncSupabaseMember } from "./supabase-team";
import { assertBillingCapacity, billingSeatSyncEnabled, seatsCountPendingInvites, ensureSyncedSeatCapacity, licensedSeatCount, syncWorkspaceBilling, type StripeBillingClient } from "./billing";

import { createOpaqueToken, hashOpaqueToken, hashPassword } from "./crypto";
import { hashSupabaseInvitationToken } from "./invitation-token";
import { getDatabase, newId, nowIso, recordAuditEvent, withImmediateTransaction } from "./db";
import { assertEmailDeliveryConfigured, deliverEmail } from "./email";
import { AppError } from "./errors";
import { createSession } from "./sessions";
import type { InvitationResult, MembershipContext, MembershipSummary, Role } from "./types";
import { isActionAllowed } from "./policy";
import { getWorkspaceSettings } from "./workspaces";
import { getCompanyAccess } from "./company-access";

interface MembershipRow {
  id: string;
  user_id: string;
  workspace_id: string;
  name: string;
  email: string;
  phone: string | null;
  application_identifier: string;
  sender_association: string | null;
  role: Role;
  manager_membership_id: string | null;
  status: "pending" | "active" | "deactivated";
  created_at: string;
  updated_at: string;
  pending_invitation_id: string | null;
  invitation_expires_at: string | null;
  invitation_delivery_status: "pending" | "sent" | "preview" | "failed" | null;
}

function mapMembership(row: MembershipRow): MembershipSummary {
  return {
    id: row.id,
    userId: row.user_id,
    workspaceId: row.workspace_id,
    name: row.name,
    email: row.email,
    phone: row.phone,
    applicationIdentifier: row.application_identifier,
    senderAssociation: row.sender_association,
    role: row.role,
    managerMembershipId: row.manager_membership_id,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    pendingInvitationId: row.pending_invitation_id,
    invitationExpiresAt: row.invitation_expires_at,
    invitationDeliveryStatus: row.invitation_delivery_status,
  };
}

export async function listMemberships(workspaceId: string): Promise<MembershipSummary[]> {
  return (await getDatabase().prepare<MembershipRow>(`SELECT m.*,
      ${membershipProfileNameSql} AS name,
      u.email, ${membershipProfilePhoneSql} AS phone, u.application_identifier,
      (SELECT i.id FROM invitations i WHERE i.membership_id = m.id AND i.status = 'pending' ORDER BY i.created_at DESC LIMIT 1) pending_invitation_id,
      (SELECT i.expires_at FROM invitations i WHERE i.membership_id = m.id AND i.status = 'pending' ORDER BY i.created_at DESC LIMIT 1) invitation_expires_at,
      (SELECT i.delivery_status FROM invitations i WHERE i.membership_id = m.id AND i.status = 'pending' ORDER BY i.created_at DESC LIMIT 1) invitation_delivery_status
    FROM memberships m JOIN users u ON u.id = m.user_id
    WHERE m.workspace_id = ? ORDER BY lower(${membershipProfileNameSql})`).all(workspaceId)).map(mapMembership);
}

export async function getMembership(workspaceId: string, membershipId: string): Promise<MembershipSummary> {
  const row = await getDatabase().prepare<MembershipRow>(`SELECT m.*,
      ${membershipProfileNameSql} AS name,
      u.email, ${membershipProfilePhoneSql} AS phone, u.application_identifier,
      (SELECT i.id FROM invitations i WHERE i.membership_id = m.id AND i.status = 'pending' ORDER BY i.created_at DESC LIMIT 1) pending_invitation_id,
      (SELECT i.expires_at FROM invitations i WHERE i.membership_id = m.id AND i.status = 'pending' ORDER BY i.created_at DESC LIMIT 1) invitation_expires_at,
      (SELECT i.delivery_status FROM invitations i WHERE i.membership_id = m.id AND i.status = 'pending' ORDER BY i.created_at DESC LIMIT 1) invitation_delivery_status
    FROM memberships m JOIN users u ON u.id = m.user_id
    WHERE m.workspace_id = ? AND m.id = ?`).get(workspaceId, membershipId);
  if (!row) throw new AppError(404, "membership_not_found", "Team member not found.");
  return mapMembership(row);
}

async function validateManager(database: ReturnType<typeof getDatabase>, workspaceId: string, managerId: string | null | undefined, memberId?: string): Promise<void> {
  if (!managerId) return;
  if (managerId === memberId) throw new AppError(400, "invalid_manager", "A team member cannot manage themselves.");
  const manager = await database.prepare<{ role: Role }>(`SELECT role FROM memberships
    WHERE id = ? AND workspace_id = ? AND status = 'active'`).get(managerId, workspaceId);
  if (!manager || !["manager", "admin", "super_admin"].includes(manager.role)) {
    throw new AppError(400, "invalid_manager", "Select an active manager from this workspace.");
  }
  if (memberId) {
    const cycle = await database.prepare(`WITH RECURSIVE descendants(id) AS (
      SELECT id FROM memberships WHERE manager_membership_id = ? AND workspace_id = ?
      UNION ALL
      SELECT m.id FROM memberships m JOIN descendants d ON m.manager_membership_id = d.id WHERE m.workspace_id = ?
    ) SELECT id FROM descendants WHERE id = ? LIMIT 1`).get(memberId, workspaceId, workspaceId, managerId);
    if (cycle) throw new AppError(400, "manager_cycle", "This manager assignment would create a reporting cycle.");
  }
}

function assertRoleAssignment(actorRole: Role, targetRole: Role): void {
  if (targetRole === "super_admin" && actorRole !== "super_admin") {
    throw new AppError(403, "permission_denied", "Only a super administrator can assign that role.");
  }
}

async function assertSeatAvailable(database: ReturnType<typeof getDatabase>, workspaceId: string, excludingMembershipId?: string): Promise<void> {
  const workspace = await database.prepare<{ seat_limit: number }>("SELECT seat_limit FROM workspaces WHERE id = ? FOR UPDATE").get(workspaceId);
  if (!workspace) throw new AppError(404, "workspace_not_found", "Workspace not found.");
  const row = await database.prepare<{ count: number }>(`SELECT count(*)::int count FROM memberships
    WHERE workspace_id = ? AND status IN ('pending','active') AND (?::text IS NULL OR id <> ?)`).get(
      workspaceId,
      excludingMembershipId ?? null,
      excludingMembershipId ?? null,
    );
  if (!row) throw new Error("Seat count query did not return a row.");
  if (row.count >= workspace.seat_limit) throw new AppError(409, "seat_limit_reached", "No workspace seats are available.");
}

function pendingInvitationLimit(): number {
  const configured = Number(process.env.MCA_BILLING_MAX_PENDING_INVITATIONS);
  return Number.isSafeInteger(configured) && configured > 0 ? configured : 25;
}

async function assertPendingInvitationCapacity(database: ReturnType<typeof getDatabase>, workspaceId: string): Promise<void> {
  const row = await database.prepare<{ count: number }>("SELECT count(*)::int count FROM memberships WHERE workspace_id = ? AND status = 'pending'").get(workspaceId);
  if (!row) throw new Error("Pending invitation count query did not return a row.");
  if (row.count >= pendingInvitationLimit()) throw new AppError(409, "pending_invitation_limit_reached", "This workspace has too many pending invitations. Activate or deactivate an invited member before sending another.");
}

export async function inviteMember(
  context: MembershipContext,
  input: {
    email: string;
    name: string;
    phone?: string | null;
    role: Role;
    managerMembershipId?: string | null;
    senderAssociation?: string | null;
  },
  appOrigin: string,
  billingClient?: StripeBillingClient,
): Promise<InvitationResult> {

  if (!isActionAllowed(context.role, "inviteUsers", (await getWorkspaceSettings(context.workspaceId)).actionVisibility)) {
    throw new AppError(403, "action_disabled", "Inviting team members is disabled for this workspace.");
  }
  assertRoleAssignment(context.role, input.role);
  const token = createOpaqueToken();
  const created = await withImmediateTransaction(async (database) => {
    await database.prepare("SELECT id FROM workspaces WHERE id = ? FOR UPDATE").get(context.workspaceId);
    if (!billingSeatSyncEnabled()) {
      await assertBillingCapacity(context.workspaceId);
      await assertSeatAvailable(database, context.workspaceId);
    }
    await validateManager(database, context.workspaceId, input.managerMembershipId);
    const timestamp = nowIso();
    const email = input.email.trim().toLowerCase();
    const proposedUserId = newId();
    const inserted = await database.prepare<{ id: string }>(`INSERT INTO users
        (id, email, password_hash, name, phone, application_identifier, created_at, updated_at)
        VALUES (?, ?, NULL, ?, ?, ?, ?, ?)
        ON CONFLICT (lower(email)) DO NOTHING RETURNING id`).get(
          proposedUserId,
          email,
          input.name,
          input.phone ?? null,
          `MCA-${proposedUserId.slice(0, 8).toUpperCase()}`,
          timestamp,
          timestamp,
        );
    const user = inserted
      ?? await database.prepare<{ id: string }>("SELECT id FROM users WHERE lower(email) = lower(?)").get(email);
    if (!user) throw new Error("Unable to resolve invited user account.");
    // Users are shared across companies. An invitation may reserve a membership,
    // but must not overwrite an existing account's profile before acceptance.
    const prior = await database.prepare<{ id: string; status: string }>("SELECT id, status FROM memberships WHERE workspace_id = ? AND user_id = ? FOR UPDATE")
      .get(context.workspaceId, user.id);
    if (billingSeatSyncEnabled() && prior?.status === "pending") {
      const retry = await database.prepare<{ id: string; delivery_status: string }>("SELECT id, delivery_status FROM invitations WHERE membership_id = ? AND status = 'pending' FOR UPDATE").get(prior.id);
      if (retry && ["pending", "failed"].includes(retry.delivery_status)) {
        const expiresAt = new Date(Date.now() + 72 * 60 * 60 * 1_000).toISOString();
        await database.prepare("UPDATE invitations SET token_hash = ?, expires_at = ?, delivery_status = 'pending', updated_at = ? WHERE id = ?")
          .run(hashSupabaseInvitationToken(token), expiresAt, timestamp, retry.id);
        return { invitationId: retry.id, membershipId: prior.id, email, expiresAt, token, needsSync: true };
      }
    }
    if (prior?.status === "active" || prior?.status === "pending") {
      throw new AppError(409, "membership_exists", "This person already has a reserved seat in the workspace.");
    }
    if (billingSeatSyncEnabled()) await assertPendingInvitationCapacity(database, context.workspaceId);
    let needsSync = billingSeatSyncEnabled();
    if (needsSync) {
      const mapped = await database.prepare("SELECT workspace_id FROM workspace_stripe_customers WHERE workspace_id=?").get(context.workspaceId);
      const current = mapped ? await syncWorkspaceBilling(context.workspaceId,billingClient,false) : null;
      const access = await getCompanyAccess(context.workspaceId);
      if (!access.allowed) throw new AppError(402,"company_paused","Recover company access in Plans & Billing before inviting users.");
      const reduction = await database.prepare<{pending_seats:number|null}>("SELECT pending_seats FROM company_subscription_state WHERE workspace_id=?").get(context.workspaceId);
      const target = await licensedSeatCount(context.workspaceId,database) + (seatsCountPendingInvites() ? 1 : 0);
      needsSync = target > access.seatLimit || !!(reduction?.pending_seats && target > reduction.pending_seats) || !!(current?.subscriptionId && target > current.seatLimit);
    }
    const membershipId = prior?.id ?? newId();
    if (prior) {
      await database.prepare(`UPDATE memberships SET role = ?, manager_membership_id = ?, status = 'pending',
        sender_association = ?, updated_at = ? WHERE id = ? AND workspace_id = ?`).run(
          input.role, input.managerMembershipId ?? null, input.senderAssociation ?? null, timestamp, membershipId, context.workspaceId,
        );
    } else {
      await database.prepare(`INSERT INTO memberships
        (id, workspace_id, user_id, role, manager_membership_id, status, sender_association, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?)`).run(
          membershipId, context.workspaceId, user.id, input.role, input.managerMembershipId ?? null,
          input.senderAssociation ?? null, timestamp, timestamp,
        );
    }
    await database.prepare("UPDATE invitations SET status = 'superseded', updated_at = ? WHERE membership_id = ? AND status = 'pending'")
      .run(timestamp, membershipId);
    const invitationId = newId();
    const expiresAt = new Date(Date.now() + 72 * 60 * 60 * 1_000).toISOString();
    const correlationId = newId();
    await database.prepare(`INSERT INTO invitations
      (id, workspace_id, membership_id, email, token_hash, expires_at, status, delivery_status,
       delivery_correlation_id, created_by, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 'pending', 'pending', ?, ?, ?, ?)`).run(
        invitationId, context.workspaceId, membershipId, email, hashSupabaseInvitationToken(token), expiresAt,
        correlationId, context.userId, timestamp, timestamp,
      );
    return { invitationId, membershipId, email, expiresAt, token, needsSync };
  });
  // The reservation is durable before any Stripe write. A failed payment or process
  // interruption leaves an undelivered invitation that the same request can retry.
  if (created.needsSync) {
    try { await ensureSyncedSeatCapacity(context.workspaceId,context.userId,0,billingClient); }
    catch (error) {
      await getDatabase().prepare("UPDATE invitations SET delivery_status = 'failed', updated_at = ? WHERE id = ? AND delivery_status = 'pending'").run(nowIso(),created.invitationId);
      throw error;
    }
  }
  return finishInvitationDelivery(context, created, appOrigin);
}

async function finishInvitationDelivery(
  context: MembershipContext,
  created: { invitationId: string; membershipId: string; email: string; expiresAt: string; token: string },
  appOrigin: string,
): Promise<InvitationResult> {
  try {
    const result = await deliverSupabaseInvitation(context, created.invitationId, appOrigin, created.token);
    await getDatabase().prepare("UPDATE invitations SET delivery_status = ?, delivery_correlation_id = ?, updated_at = ? WHERE id = ?")
      .run(result.delivery, result.correlationId, nowIso(), created.invitationId);
    await recordAuditEvent({ context, action: "membership.invited", resourceType: "membership", resourceId: created.membershipId, metadata: { invitationId: created.invitationId, delivery: result.delivery } });
    return {
      id: created.invitationId,
      membershipId: created.membershipId,
      email: created.email,
      expiresAt: created.expiresAt,
      delivery: result.delivery,
      ...(result.previewUrl ? { previewUrl: result.previewUrl } : {}),
    };
  } catch (error) {
    await getDatabase().prepare("UPDATE invitations SET delivery_status = 'failed', updated_at = ? WHERE id = ?").run(nowIso(), created.invitationId);
    throw error;
  }
}

export async function resendInvitation(context: MembershipContext, invitationId: string, appOrigin: string, billingClient?: StripeBillingClient): Promise<InvitationResult> {

  if (!isActionAllowed(context.role, "inviteUsers", (await getWorkspaceSettings(context.workspaceId)).actionVisibility)) {
    throw new AppError(403, "action_disabled", "Inviting team members is disabled for this workspace.");
  }
  const token = createOpaqueToken();
  const created = await withImmediateTransaction(async (database) => {
    const previous = await database.prepare<{ membership_id: string; email: string; status: string }>(`SELECT i.membership_id, i.email, m.status
      FROM invitations i JOIN memberships m ON m.id = i.membership_id
      WHERE i.id = ? AND i.workspace_id = ? FOR UPDATE`).get(invitationId, context.workspaceId);
    if (!previous) throw new AppError(404, "invitation_not_found", "Invitation not found.");
    if (previous.status !== "pending") throw new AppError(409, "membership_not_pending", "This team member has already accepted or is inactive.");
    const timestamp = nowIso();
    // Keep the approved invitation identity stable across delivery retries. An acceptance
    // racing a resend must still reconcile to this pending membership.
    const current = await database.prepare<{ id: string }>("SELECT id FROM invitations WHERE membership_id = ? AND status = 'pending' FOR UPDATE").get(previous.membership_id);
    if (!current) throw new AppError(409, "invitation_not_pending", "This invitation is no longer pending.");
    const expiresAt = new Date(Date.now() + 72 * 60 * 60 * 1_000).toISOString();
    await database.prepare("UPDATE invitations SET token_hash = ?, expires_at = ?, delivery_status = 'pending', updated_at = ? WHERE id = ?")
      .run(hashSupabaseInvitationToken(token), expiresAt, timestamp, current.id);
    return { invitationId: current.id, membershipId: previous.membership_id, email: previous.email, expiresAt, token };
  });
  if (billingSeatSyncEnabled()) {
    try { await ensureSyncedSeatCapacity(context.workspaceId,context.userId,0,billingClient); }
    catch (error) {
      await getDatabase().prepare("UPDATE invitations SET delivery_status = 'failed', updated_at = ? WHERE id = ? AND delivery_status = 'pending'").run(nowIso(),created.invitationId);
      throw error;
    }
  }
  return finishInvitationDelivery(context, created, appOrigin);
}

export async function acceptInvitation(input: { token: string; password: string; name?: string; phone?: string | null }): Promise<{
  token: string;
  expiresAt: string;
}> {
  const passwordHash = hashPassword(input.password);
  const activated = await withImmediateTransaction(async (database) => {
    const timestamp = nowIso();
    const row = await database.prepare<{ invitation_id: string; email: string; membership_id: string; user_id: string; status: string; expires_at: string }>(`SELECT i.id invitation_id, i.email, i.membership_id, i.expires_at, m.user_id, m.status
      FROM invitations i JOIN memberships m ON m.id = i.membership_id AND m.workspace_id = i.workspace_id
      WHERE i.token_hash = ? AND i.status = 'pending' FOR UPDATE`).get(hashSupabaseInvitationToken(input.token));
    if (!row) throw new AppError(400, "invitation_invalid", "This invitation is invalid or has already been used.");
    if (row.expires_at <= timestamp) {
      await database.prepare("UPDATE invitations SET status = 'expired', updated_at = ? WHERE id = ?").run(timestamp, row.invitation_id);
      throw new AppError(400, "invitation_expired", "This invitation has expired. Ask an administrator to resend it.");
    }
    if (row.status !== "pending") throw new AppError(409, "membership_not_pending", "This membership cannot be activated.");
    await database.prepare(`UPDATE users SET password_hash = ?, name = COALESCE(?, name), phone = COALESCE(?, phone),
      updated_at = ? WHERE id = ? AND lower(email) = lower(?)`).run(
        passwordHash, input.name ?? null, input.phone ?? null, timestamp, row.user_id, row.email,
      );
    await database.prepare("UPDATE memberships SET status = 'active', updated_at = ? WHERE id = ?").run(timestamp, row.membership_id);
    await database.prepare("UPDATE invitations SET status = 'accepted', updated_at = ? WHERE id = ?").run(timestamp, row.invitation_id);
    return { userId: row.user_id, membershipId: row.membership_id };
  });
  return createSession(activated.userId, activated.membershipId);
}

export async function updateMembership(
  context: MembershipContext,
  membershipId: string,
  patch: { name?: string; phone?: string | null; role?: Role; managerMembershipId?: string | null; senderAssociation?: string | null },
): Promise<MembershipSummary> {
  await withImmediateTransaction(async (database) => {
    await database.prepare("SELECT id FROM workspaces WHERE id = ? FOR UPDATE").get(context.workspaceId);
    const member = await database.prepare<{ user_id: string; role: Role }>("SELECT user_id, role FROM memberships WHERE id = ? AND workspace_id = ? FOR UPDATE").get(membershipId, context.workspaceId);
    if (!member) throw new AppError(404, "membership_not_found", "Team member not found.");
    if (member.role === "super_admin" && context.role !== "super_admin") throw new AppError(403, "permission_denied", "Only a super administrator can manage that member.");
    if (patch.role) assertRoleAssignment(context.role, patch.role);
    if (patch.role && patch.role !== member.role && await database.prepare("SELECT workspace_id FROM workspace_owners WHERE workspace_id=? AND membership_id=?").get(context.workspaceId, membershipId)) {
      throw new AppError(409, "owner_protected", "Transfer company ownership before changing the owner's role.");
    }
    await validateManager(database, context.workspaceId, patch.managerMembershipId, membershipId);
    if (member.role === "super_admin" && patch.role && patch.role !== "super_admin") {
      const remaining = await database.prepare<{ count: number }>(`SELECT count(*)::int count FROM memberships
        WHERE workspace_id = ? AND role = 'super_admin' AND status = 'active' AND id <> ?`).get(context.workspaceId, membershipId);
      if (!remaining || remaining.count === 0) throw new AppError(409, "last_super_admin", "Assign another super administrator before changing this role.");
    }
    const timestamp = nowIso();
    await database.prepare(`UPDATE memberships SET role = COALESCE(?, role),
      manager_membership_id = CASE WHEN ? = 1 THEN ? ELSE manager_membership_id END,
      sender_association = CASE WHEN ? = 1 THEN ? ELSE sender_association END, updated_at = ?
      WHERE id = ? AND workspace_id = ?`).run(
        patch.role ?? null,
        Object.prototype.hasOwnProperty.call(patch, "managerMembershipId") ? 1 : 0,
        patch.managerMembershipId ?? null,
        Object.prototype.hasOwnProperty.call(patch, "senderAssociation") ? 1 : 0,
        patch.senderAssociation ?? null,
        timestamp, membershipId, context.workspaceId,
      );
    if (patch.name !== undefined || patch.phone !== undefined) {
      await database.prepare(`UPDATE users SET name = COALESCE(?, name),
        phone = CASE WHEN ? = 1 THEN ? ELSE phone END, updated_at = ? WHERE id = ?`).run(
          patch.name ?? null, Object.prototype.hasOwnProperty.call(patch, "phone") ? 1 : 0, patch.phone ?? null, timestamp, member.user_id,
        );
    }
  });
  await recordAuditEvent({ context, action: "membership.updated", resourceType: "membership", resourceId: membershipId });
  await syncSupabaseMember(context.workspaceId, membershipId);
  return getMembership(context.workspaceId, membershipId);
}

export async function deactivateMembership(context: MembershipContext, membershipId: string, _billingClient?: StripeBillingClient): Promise<void> {
  void _billingClient;
  if (membershipId === context.membershipId) throw new AppError(409, "cannot_deactivate_self", "Ask another administrator to deactivate your account.");
  await withImmediateTransaction(async (database) => {
    await database.prepare("SELECT id FROM workspaces WHERE id = ? FOR UPDATE").get(context.workspaceId);
    if (await database.prepare("SELECT workspace_id FROM workspace_owners WHERE workspace_id=? AND membership_id=?").get(context.workspaceId, membershipId)) {
      throw new AppError(409, "owner_protected", "Transfer company ownership before deactivating the owner.");
    }
    const member = await database.prepare<{ user_id: string; role: Role; status: string }>("SELECT user_id, role, status FROM memberships WHERE id = ? AND workspace_id = ? FOR UPDATE").get(membershipId, context.workspaceId);
    if (!member) throw new AppError(404, "membership_not_found", "Team member not found.");
    if (member.role === "super_admin") {
      if (context.role !== "super_admin") throw new AppError(403, "permission_denied", "Only a super administrator can manage that member.");
      const remaining = await database.prepare<{ count: number }>(`SELECT count(*)::int count FROM memberships
        WHERE workspace_id = ? AND role = 'super_admin' AND status = 'active' AND id <> ?`).get(context.workspaceId, membershipId);
      if (!remaining) throw new Error("Super administrator count did not return a row.");
      if (remaining.count === 0) throw new AppError(409, "last_super_admin", "Assign another super administrator before deactivating this account.");
    }
    const timestamp = nowIso();
    await database.prepare("UPDATE memberships SET status = 'deactivated', sender_association = NULL, updated_at = ? WHERE id = ? AND workspace_id = ?")
      .run(timestamp, membershipId, context.workspaceId);
    await database.prepare("DELETE FROM sessions WHERE membership_id = ?").run(membershipId);
    await database.prepare("UPDATE invitations SET status = 'superseded', updated_at = ? WHERE membership_id = ? AND status = 'pending'")
      .run(timestamp, membershipId);
  });
  await syncSupabaseMember(context.workspaceId, membershipId);
  await recordAuditEvent({ context, action: "membership.deactivated", resourceType: "membership", resourceId: membershipId });
}

export async function requestPasswordRecovery(email: string, appOrigin: string): Promise<{ previewUrl?: string }> {
  assertEmailDeliveryConfigured();
  const token = createOpaqueToken();
  const actionUrl = `${appOrigin}/reset-password?token=${encodeURIComponent(token)}`;
  const user = await getDatabase().prepare<{ id: string; email: string }>(`SELECT DISTINCT u.id, u.email FROM users u
    JOIN memberships m ON m.user_id = u.id WHERE lower(u.email) = lower(?) AND m.status = 'active' LIMIT 1`)
    .get(email.trim());
  // A local preview remains enumeration-neutral by returning an unusable decoy link for unknown addresses.
  if (!user) return process.env.NODE_ENV === "production" ? {} : { previewUrl: actionUrl };
  const expiresAt = new Date(Date.now() + 30 * 60 * 1_000).toISOString();
  await withImmediateTransaction(async (database) => {
    await database.prepare("UPDATE recovery_tokens SET used_at = ? WHERE user_id = ? AND used_at IS NULL").run(nowIso(), user.id);
    await database.prepare(`INSERT INTO recovery_tokens (id, user_id, token_hash, expires_at, used_at, created_at)
      VALUES (?, ?, ?, ?, NULL, ?)`).run(newId(), user.id, hashOpaqueToken(token), expiresAt, nowIso());
  });
  const delivery = await deliverEmail({ recipient: user.email, template: "account_recovery", actionUrl, expiresAt });
  return delivery.previewUrl ? { previewUrl: delivery.previewUrl } : {};
}
