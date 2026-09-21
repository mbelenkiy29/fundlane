import "server-only"

import { createHash } from "node:crypto"
import { getDatabase, nowIso } from "../db"
import { getDeal } from "../deals/service"
import type { DealActor } from "../deals/schema"
import { AppError } from "../errors"
import { intakeProgress } from "./processing"
import { findIntake } from "./repository"
import type { ApplicationNotice } from "./review-contracts"

// Both insertion and reading resolve today's recipients; former assignees cannot
// retain access through a previously issued notification.
const recipient = `(EXISTS (SELECT 1 FROM deal_assignments a
  WHERE a.workspace_id=e.workspace_id AND a.deal_id=e.deal_id AND a.membership_id=m.id)
  OR (m.role IN ('admin','super_admin') AND NOT EXISTS (
    SELECT 1 FROM deal_assignments a JOIN memberships active ON active.id=a.membership_id
    AND active.workspace_id=a.workspace_id AND active.status='active'
    WHERE a.workspace_id=e.workspace_id AND a.deal_id=e.deal_id)))`

export async function syncApplicationNotifications(workspaceId: string, intakeId?: string): Promise<void> {
  const rows = await getDatabase().prepare<{ intake_id: string; user_id: string; created_at: string }>(`
    SELECT e.id intake_id,m.user_id,e.created_at FROM intake_events e
    JOIN memberships m ON m.workspace_id=e.workspace_id AND m.status='active'
    WHERE e.workspace_id=? AND e.answers_cipher IS NOT NULL
    AND e.provider IN ('native','fundlane','jotform','highlevel','zoho','custom','fillout','docuseal')
    ${intakeId ? "AND e.id=?" : ""} AND ${recipient}
    AND NOT EXISTS (SELECT 1 FROM intake_notifications n WHERE n.workspace_id=e.workspace_id
      AND n.intake_id=e.id AND n.user_id=m.user_id)
  `).all(workspaceId, ...(intakeId ? [intakeId] : []))
  for (const row of rows) {
    const id = createHash("sha256").update(JSON.stringify([workspaceId,row.intake_id,row.user_id])).digest("hex")
    await getDatabase().prepare(`INSERT INTO intake_notifications(id,workspace_id,intake_id,user_id,created_at)
      VALUES (?,?,?,?,?) ON CONFLICT (workspace_id,intake_id,user_id) DO NOTHING`).run(id,workspaceId,row.intake_id,row.user_id,row.created_at)
  }
}

function requireRecipient(actor: DealActor): void {
  if (!actor.userId || !actor.membershipId || !actor.activeMembershipIds.includes(actor.membershipId)) {
    throw new AppError(403,"notification_access_denied","Sign in as an active company member to view notifications.")
  }
}

async function recipientNotices(actor: DealActor, id?: string) {
  requireRecipient(actor)
  return getDatabase().prepare<{id:string;intake_id:string;created_at:string;read_at:string|null}>(`
    SELECT n.id,n.intake_id,n.created_at,n.read_at FROM intake_notifications n
    JOIN intake_events e ON e.id=n.intake_id AND e.workspace_id=n.workspace_id
    JOIN memberships m ON m.workspace_id=n.workspace_id AND m.user_id=n.user_id AND m.status='active'
    WHERE n.workspace_id=? AND n.user_id=? AND m.id=? ${id ? "AND n.id=?" : ""}
    AND ${recipient} ORDER BY n.created_at DESC
  `).all(actor.workspaceId,actor.userId,actor.membershipId,...(id ? [id] : []))
}

export async function listApplicationNotifications(actor: DealActor): Promise<{unread:number;notifications:ApplicationNotice[]}> {
  requireRecipient(actor)
  await syncApplicationNotifications(actor.workspaceId)
  const rows=await recipientNotices(actor)
  const notifications:ApplicationNotice[]=[]
  let unread=0
  for (const row of rows) {
    const intake=await findIntake(actor.workspaceId,row.intake_id)
    if (!intake) continue
    let merchantName="Application needs review"
    if (intake.dealId) {
      try { merchantName=(await getDeal(actor,intake.dealId)).legalName || merchantName }
      catch(error) { if(error instanceof AppError && [403,404].includes(error.status)) continue; throw error }
    } else if (!['admin','super_admin'].includes(actor.role ?? '')) continue
    if(!row.read_at) unread++
    if(notifications.length>=100) continue
    const progress=await intakeProgress(actor.workspaceId,intake.intakeId)
    notifications.push({id:row.id,intakeId:intake.intakeId,merchantName,state:progress?.state ?? (intake.state==='error'?'needs_attention':'received'),message:progress?.message,createdAt:row.created_at,readAt:row.read_at})
  }
  return {unread,notifications}
}

export async function markApplicationNotificationRead(actor: DealActor, id: unknown): Promise<void> {
  if(typeof id!=="string" || !id || id.length>128) throw new AppError(422,"invalid_notification","Choose a valid notification.")
  const [notice]=await recipientNotices(actor,id)
  if(!notice) throw new AppError(404,"notification_not_found","The notification was not found.")
  const intake=await findIntake(actor.workspaceId,notice.intake_id)
  if(intake?.dealId) await getDeal(actor,intake.dealId)
  await getDatabase().prepare("UPDATE intake_notifications SET read_at=COALESCE(read_at,?) WHERE workspace_id=? AND user_id=? AND id=?").run(nowIso(),actor.workspaceId,actor.userId,id)
}
