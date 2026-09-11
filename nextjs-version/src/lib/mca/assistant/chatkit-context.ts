import "server-only"
import { getDatabase } from "../db"
import { getClerkClient } from "../clerk-client"
import { AppError } from "../errors"
import { actorForDeals } from "../deals/service"
import { getWorkspaceSettings } from "../workspaces"
import { effectiveActionVisibility, effectivePageVisibility } from "../policy"
import { bodyHash, type Delegation } from "./security"
import type { MembershipContext, Role } from "../types"

export async function assistantContext(context: MembershipContext) {
  const settings = await getWorkspaceSettings(context.workspaceId)
  const pages = effectivePageVisibility(context.role, settings.pageVisibility, settings.featureFlags)
  if (!pages.deals) throw new AppError(403, "assistant_access_denied", "Deal access is required to use the assistant.")
  const actions = effectiveActionVisibility(context.role, settings.actionVisibility)
  return { context, actor: await actorForDeals(context), financials: actions.viewCompanyFinancials,
    accessStamp: bodyHash(JSON.stringify({ role: context.role, pages, actions })) }
}
export type AssistantContext = Awaited<ReturnType<typeof assistantContext>>

/** Callback authentication never accepts client-selected roles or a workspace-wide API key. */
export async function delegatedContext(claims: Delegation, client = getClerkClient()): Promise<AssistantContext> {
  const db = getDatabase()
  const active = await db.prepare(`SELECT id FROM mca_chatkit_requests WHERE id=? AND user_id=? AND workspace_id=? AND expires_at > ?`)
    .get(claims.requestId, claims.userId, claims.workspaceId, new Date().toISOString())
  if (!active) throw new AppError(401, "request_expired", "The assistant request has ended.")
  const row = await db.prepare<{ role: Role; clerk_user_id: string; clerk_organization_id: string }>(`SELECT m.role, u.clerk_user_id, w.clerk_organization_id
    FROM memberships m JOIN users u ON u.id=m.user_id JOIN workspaces w ON w.id=m.workspace_id
    WHERE m.id=? AND m.workspace_id=? AND m.user_id=? AND m.status='active'`)
    .get(claims.membershipId, claims.workspaceId, claims.userId)
  if (!row?.clerk_user_id || !row.clerk_organization_id) throw new AppError(403, "membership_inactive", "Your company access has changed.")
  const [session, user, members] = await Promise.all([
    client.sessions.getSession(claims.sessionId), client.users.getUser(row.clerk_user_id),
    client.organizations.getOrganizationMembershipList({ organizationId: row.clerk_organization_id, userId: [row.clerk_user_id], limit: 1 }),
  ])
  if (session.status !== "active" || session.userId !== row.clerk_user_id || session.expireAt <= Date.now() || user.banned || user.locked || !user.passwordEnabled || !user.emailAddresses.some(email => email.id === user.primaryEmailAddressId && email.verification?.status === "verified") || !members.data.length) {
    throw new AppError(401, "session_expired", "Sign in again to use the assistant.")
  }
  return assistantContext({ authType: "session", userId: claims.userId, workspaceId: claims.workspaceId,
    membershipId: claims.membershipId, sessionId: claims.sessionId, role: row.role, scopes: [] })
}
