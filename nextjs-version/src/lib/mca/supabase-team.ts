import "server-only"
import { getDatabase, nowIso, withImmediateTransaction } from "./db"
import { hashSupabaseInvitationToken } from "./invitation-token"
import { deliverEmail } from "./email"
import { AppError } from "./errors"
import { linkSupabaseUser, type SupabaseIdentity } from "./supabase-auth"
import type { MembershipContext } from "./types"
import { assertBillingCapacity, billingSeatSyncEnabled, seatsCountPendingInvites, ensureSyncedSeatCapacity, type StripeBillingClient } from "./billing"

export async function deliverSupabaseInvitation(context: MembershipContext, invitationId: string, appOrigin: string, token: string) {
  const checkExpiry = billingSeatSyncEnabled()
  const row=await getDatabase().prepare<{ email:string; expires_at:string }>(`SELECT i.email,i.expires_at FROM invitations i JOIN memberships m ON m.id=i.membership_id
    WHERE i.id=? AND i.workspace_id=? AND i.token_hash=? AND i.status='pending' ${checkExpiry ? "AND i.expires_at>?" : ""} AND m.status='pending'`).get(invitationId,context.workspaceId,hashSupabaseInvitationToken(token),...(checkExpiry ? [nowIso()] : []))
  if (!row) throw new AppError(409,"invitation_not_pending","This invitation is no longer pending.")
  return deliverEmail({ recipient:row.email,template:"workspace_invitation",actionUrl:`${appOrigin}/accept-invite?token=${encodeURIComponent(token)}`,expiresAt:row.expires_at })
}

export async function inspectSupabaseInvitation(token: string) {
  const row=await getDatabase().prepare<{ email:string; workspace_name:string }>(`SELECT i.email,w.name workspace_name FROM invitations i JOIN workspaces w ON w.id=i.workspace_id JOIN memberships m ON m.id=i.membership_id
    WHERE i.token_hash=? AND i.status='pending' AND i.expires_at>? AND m.status='pending'`).get(hashSupabaseInvitationToken(token),nowIso())
  if (!row) throw new AppError(400,"invitation_invalid","This invitation is invalid or expired. Ask your administrator to resend it.")
  return row
}

export async function acceptSupabaseInvitation(identity: SupabaseIdentity, token: string, billingClient?: StripeBillingClient) {
  return withImmediateTransaction(async db=>{
    // Lock workspace first, matching invite/resend/deactivation order.
    const candidate=await db.prepare<{ workspace_id:string }>("SELECT workspace_id FROM invitations WHERE token_hash=?").get(hashSupabaseInvitationToken(token))
    if (!candidate) throw new AppError(400,"invitation_invalid","This invitation is invalid or has already been used.")
    await db.prepare("SELECT id FROM workspaces WHERE id=? FOR UPDATE").get(candidate.workspace_id)
    const row=await db.prepare<{ id:string; workspace_id:string; membership_id:string; user_id:string; email:string }>(`SELECT i.id,i.workspace_id,i.membership_id,m.user_id,i.email FROM invitations i JOIN memberships m ON m.id=i.membership_id AND m.workspace_id=i.workspace_id
      WHERE i.token_hash=? AND i.status='pending' AND i.expires_at>? AND m.status='pending' FOR UPDATE OF i,m`).get(hashSupabaseInvitationToken(token),nowIso())
    if (!row) throw new AppError(400,"invitation_invalid","This invitation is invalid or expired.")
    if (row.email.toLowerCase() !== identity.email) throw new AppError(403,"invitation_account_mismatch","Sign in using the email address invited to this company.")
    if (billingSeatSyncEnabled()) await ensureSyncedSeatCapacity(row.workspace_id,row.user_id,seatsCountPendingInvites()?0:1,billingClient)
    else await assertBillingCapacity(row.workspace_id,0)
    await linkSupabaseUser(identity,row.user_id)
    await db.prepare("UPDATE memberships SET status='active',updated_at=? WHERE id=?").run(nowIso(),row.membership_id)
    await db.prepare("UPDATE invitations SET status='accepted',updated_at=? WHERE id=?").run(nowIso(),row.id)
    return row.workspace_id
  })
}

export async function syncSupabaseMember(workspaceId: string,membershipId: string) {
  // Local memberships are authoritative. Delete in-flight delegations immediately on deactivation.
  await getDatabase().prepare(`DELETE FROM mca_chatkit_requests WHERE workspace_id=? AND user_id IN
    (SELECT user_id FROM memberships WHERE id=? AND workspace_id=? AND status='deactivated')`).run(workspaceId,membershipId,workspaceId)
}
