import "server-only"
import { getClerkClient } from "./clerk-client"
import { AppError } from "./errors"
import { getDatabase, nowIso, withImmediateTransaction } from "./db"
import type { MembershipContext } from "./types"
import { assertBillingCapacity, billingEnabled, billingRole, BILLING_EMPLOYEE_ROLE } from "./billing"

export async function deliverClerkInvitation(
  context: MembershipContext,
  invitationId: string,
  appOrigin: string,
  resend = false
) {
  return withImmediateTransaction(async (db) => {
    await db.prepare("SELECT id FROM workspaces WHERE id = ? FOR UPDATE").get(context.workspaceId)
    await assertBillingCapacity(context.workspaceId, 0)
    const row = await db
      .prepare<{
        email: string
        membership_id: string
        clerk_organization_id: string
        role: string
      }>(
        `SELECT i.email, i.membership_id, w.clerk_organization_id, m.role
      FROM invitations i JOIN workspaces w ON w.id = i.workspace_id JOIN memberships m ON m.id = i.membership_id
      WHERE i.id = ? AND i.workspace_id = ? AND i.status = 'pending' AND m.status = 'pending' FOR UPDATE OF i, m`
      )
      .get(invitationId, context.workspaceId)
    if (!row?.clerk_organization_id)
      throw new AppError(
        409,
        "clerk_workspace_required",
        "Migrate this workspace to Clerk before inviting employees."
      )
    const client = getClerkClient()
    let matching
    for (let offset = 0; ; offset += 100) {
      const page = await client.organizations.getOrganizationInvitationList({
        organizationId: row.clerk_organization_id,
        status: ["pending", "accepted"],
        limit: 100,
        offset,
      })
      for (const invite of page.data) {
        if (invite.publicMetadata.mcaInvitationId === invitationId) {
          if (resend && invite.status === "pending") {
            await client.organizations.revokeOrganizationInvitation({
              organizationId: row.clerk_organization_id,
              invitationId: invite.id,
            })
          } else if (!matching || invite.status === "accepted")
            matching = invite
        } else if (
          invite.emailAddress.toLowerCase() === row.email.toLowerCase() &&
          invite.status === "pending"
        ) {
          await client.organizations.revokeOrganizationInvitation({
            organizationId: row.clerk_organization_id,
            invitationId: invite.id,
          })
        }
      }
      if (
        offset + page.data.length >= page.totalCount ||
        page.data.length === 0
      )
        break
    }
    const invitation =
      matching ??
      (await client.organizations.createOrganizationInvitation({
        organizationId: row.clerk_organization_id,
        emailAddress: row.email,
        // MCA role assignment is authoritative locally. Clerk membership never grants MCA privileges.
        role: billingEnabled() ? BILLING_EMPLOYEE_ROLE : "org:member",
        expiresInDays: 3,
        publicMetadata: { mcaInvitationId: invitationId },
        redirectUrl: `${appOrigin}/accept-invite`,
      }))
    await db
      .prepare(
        "UPDATE invitations SET clerk_invitation_id = ?, delivery_status = 'sent', delivery_correlation_id = ?, updated_at = ? WHERE id = ?"
      )
      .run(invitation.id, invitation.id, nowIso(), invitationId)
    return { delivery: "sent" as const, correlationId: invitation.id }
  })
}

/** Retrying the same mutation reconciles provider state after a partial failure. Local revocation is immediate. */
export async function syncClerkMember(
  workspaceId: string,
  membershipId: string
) {
  const row = await getDatabase()
    .prepare<{
      clerk_user_id: string | null
      clerk_organization_id: string | null
      status: string
      role: string
    }>(
      `SELECT u.clerk_user_id, w.clerk_organization_id, m.status, m.role
    FROM memberships m JOIN users u ON u.id = m.user_id JOIN workspaces w ON w.id = m.workspace_id WHERE m.id = ? AND m.workspace_id = ?`
    )
    .get(membershipId, workspaceId)
  if (!row?.clerk_user_id || !row.clerk_organization_id) return
  const client = getClerkClient()
  const { data } = await client.organizations.getOrganizationMembershipList({
    organizationId: row.clerk_organization_id,
    userId: [row.clerk_user_id],
    limit: 1,
  })
  if (!data[0]) return
  if (row.status === "deactivated") {
    await client.organizations.deleteOrganizationMembership({
      organizationId: row.clerk_organization_id,
      userId: row.clerk_user_id,
    })
  } else {
    const providerRole = row.status === "active" ? billingRole(row.role) : BILLING_EMPLOYEE_ROLE
    if (billingEnabled() && data[0].role !== providerRole) {
      await client.organizations.updateOrganizationMembership({ organizationId: row.clerk_organization_id, userId: row.clerk_user_id, role: providerRole })
    }
    await client.organizations.updateOrganizationMembershipMetadata({
      organizationId: row.clerk_organization_id,
      userId: row.clerk_user_id,
      publicMetadata: { mcaRole: row.role },
    })
  }
}
