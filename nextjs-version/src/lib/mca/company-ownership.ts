import "server-only"
import { nowIso, recordAuditEvent, withImmediateTransaction } from "./db"
import { AppError } from "./errors"
import type { MembershipContext } from "./types"

/** The workspace lock also serializes member edits/deactivation against transfers. */
export async function transferCompanyOwnership(context: MembershipContext, membershipId: string) {
  if (context.authType !== "session") throw new AppError(403, "session_required", "Sign in to transfer ownership.")
  return withImmediateTransaction(async db => {
    await db.prepare("SELECT id FROM workspaces WHERE id=? FOR UPDATE").get(context.workspaceId)
    const owner = await db.prepare<{ membership_id: string }>(`SELECT o.membership_id FROM workspace_owners o
      JOIN memberships m ON m.id=o.membership_id AND m.workspace_id=o.workspace_id
      WHERE o.workspace_id=? AND m.user_id=? AND m.id=? AND m.status='active'`).get(context.workspaceId, context.userId, context.membershipId)
    if (!owner) throw new AppError(403, "owner_required", "Only the current company owner can transfer ownership.")
    const target = await db.prepare<{ role: string }>("SELECT role FROM memberships WHERE id=? AND workspace_id=? AND status='active' FOR UPDATE").get(membershipId, context.workspaceId)
    if (!target) throw new AppError(409, "active_member_required", "Choose an active member of this company.")
    if (owner.membership_id === membershipId) return { ownerMembershipId: membershipId }
    const now = nowIso()
    await db.prepare("UPDATE memberships SET role=?,updated_at=? WHERE id=? AND workspace_id=?")
      .run(target.role === "super_admin" ? "super_admin" : "admin", now, membershipId, context.workspaceId)
    await db.prepare("UPDATE workspace_owners SET membership_id=?,updated_at=? WHERE workspace_id=?").run(membershipId, now, context.workspaceId)
    await recordAuditEvent({ context, action: "company.ownership_transferred", resourceType: "workspace", resourceId: context.workspaceId,
      metadata: { previousOwnerMembershipId: owner.membership_id, ownerMembershipId: membershipId }, executor: db })
    return { ownerMembershipId: membershipId }
  })
}
