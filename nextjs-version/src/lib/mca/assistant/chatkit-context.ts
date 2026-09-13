import "server-only"
import { getDatabase } from "../db"
import { requireLiveSupabaseSession } from "../supabase-auth"
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
export async function delegatedContext(claims: Delegation, verifySession = requireLiveSupabaseSession): Promise<AssistantContext> {
  const db = getDatabase()
  const active = await db.prepare(`SELECT id FROM mca_chatkit_requests WHERE id=? AND user_id=? AND workspace_id=? AND expires_at > ?`)
    .get(claims.requestId, claims.userId, claims.workspaceId, new Date().toISOString())
  if (!active) throw new AppError(401, "request_expired", "The assistant request has ended.")
  const row = await db.prepare<{ role: Role; supabase_user_id: string }>(`SELECT m.role,u.supabase_user_id
    FROM memberships m JOIN users u ON u.id=m.user_id
    WHERE m.id=? AND m.workspace_id=? AND m.user_id=? AND m.status='active'`)
    .get(claims.membershipId,claims.workspaceId,claims.userId)
  if (!row?.supabase_user_id) throw new AppError(403,"membership_inactive","Your company access has changed.")
  await verifySession(claims.sessionId,row.supabase_user_id)
  return assistantContext({ authType: "session", userId: claims.userId, workspaceId: claims.workspaceId,
    membershipId: claims.membershipId, sessionId: claims.sessionId, role: row.role, scopes: [] })
}
