import "server-only"

import { getDatabase, nowIso } from "../db"
import type { AuthContext } from "../types"
import { buildWorkspaceSetup, type WorkspaceSetup } from "./contracts"

interface SetupRow {
  name: string
  setup_checklist_dismissed_at: string | null
  funders: number
  deals: number
  members: number
  invitations: number
  verified_senders: number
  intake_enabled: number
  datamerch: number
}

export async function getWorkspaceSetup(workspaceId: string): Promise<WorkspaceSetup> {
  const row = await getDatabase().prepare<SetupRow>(`
    SELECT
      w.name,
      w.setup_checklist_dismissed_at,
      (SELECT count(*)::int FROM mca_funders f WHERE f.workspace_id = w.id) funders,
      (SELECT count(*)::int FROM deals d WHERE d.workspace_id = w.id) deals,
      (SELECT count(*)::int FROM memberships m WHERE m.workspace_id = w.id AND m.status IN ('pending','active')) members,
      (SELECT count(*)::int FROM invitations i WHERE i.workspace_id = w.id AND i.status = 'pending') invitations,
      (SELECT count(*)::int FROM mca_email_senders s WHERE s.workspace_id = w.id AND s.state = 'verified') verified_senders,
      (SELECT count(*)::int FROM intake_integrations ii WHERE ii.workspace_id = w.id AND ii.enabled = 1) intake_enabled,
      (SELECT count(*)::int FROM mca_datamerch_config dm WHERE dm.workspace_id = w.id AND dm.enabled = 1 AND dm.credential_cipher IS NOT NULL) datamerch
    FROM workspaces w
    WHERE w.id = ?
  `).get(workspaceId)
  if (!row) throw new Error("Workspace not found.")
  return buildWorkspaceSetup({
    brokerageName: row.name,
    dismissedAt: row.setup_checklist_dismissed_at,
    funderCount: row.funders,
    dealCount: row.deals,
    memberCount: row.members,
    pendingInvitationCount: row.invitations,
    verifiedSenderCount: row.verified_senders,
    enabledIntakeCount: row.intake_enabled,
    connectedDatamerchCount: row.datamerch,
  })
}

export async function dismissWorkspaceSetup(context: AuthContext): Promise<WorkspaceSetup> {
  const dismissedAt = nowIso()
  await getDatabase()
    .prepare("UPDATE workspaces SET setup_checklist_dismissed_at = COALESCE(setup_checklist_dismissed_at, ?) WHERE id = ?")
    .run(dismissedAt, context.workspaceId)
  return getWorkspaceSetup(context.workspaceId)
}
