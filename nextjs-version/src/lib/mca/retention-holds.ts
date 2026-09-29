import "server-only"
import { z } from "zod"
import { getDatabase, newId, nowIso, recordAuditEvent, withTransaction, type DbExecutor } from "./db"
import { AppError } from "./errors"

export const retentionHoldReasons = ["dispute", "chargeback", "subpoena", "regulator_request"] as const
export const placeRetentionHoldSchema = z.object({
  workspaceId: z.string().min(1).max(200),
  dealId: z.string().min(1).max(200).optional(),
  reason: z.enum(retentionHoldReasons),
  note: z.string().trim().min(1).max(2000)
}).strict()

export function retentionHoldsEnabled(): boolean {
  return process.env.MCA_RETENTION_HOLDS_ENABLED === "true"
}

export async function isUnderRetentionHold(workspaceId: string, dealId?: string, executor: DbExecutor = getDatabase()): Promise<boolean> {
  if (!retentionHoldsEnabled()) return false
  const row = await executor.prepare(`SELECT id FROM retention_holds
    WHERE workspace_id=? AND released_at IS NULL AND (deal_id IS NULL OR deal_id=?) LIMIT 1`).get(workspaceId, dealId ?? null)
  return Boolean(row)
}

export async function placeRetentionHold(actorUserId: string, input: z.infer<typeof placeRetentionHoldSchema>) {
  return withTransaction(async tx => {
    const workspace = await tx.prepare("SELECT id FROM workspaces WHERE id=?").get(input.workspaceId)
    if (!workspace) throw new AppError(404, "workspace_not_found", "Company not found.")
    if (input.dealId) {
      const deal = await tx.prepare("SELECT id FROM deals WHERE id=? AND workspace_id=?").get(input.dealId, input.workspaceId)
      if (!deal) throw new AppError(404, "deal_not_found", "Deal not found.")
    }
    const id = newId(), placedAt = nowIso()
    await tx.prepare(`INSERT INTO retention_holds(id,workspace_id,deal_id,reason,note,placed_by,placed_at)
      VALUES (?,?,?,?,?,?,?)`).run(id, input.workspaceId, input.dealId ?? null, input.reason, input.note, actorUserId, placedAt)
    await recordAuditEvent({
      context: { workspaceId: input.workspaceId, userId: actorUserId }, action: "retention_hold.placed",
      resourceType: "retention_hold", resourceId: id,
      metadata: { dealId: input.dealId ?? null, reason: input.reason, note: input.note }, executor: tx
    })
    return { id, workspaceId: input.workspaceId, dealId: input.dealId ?? null, reason: input.reason, note: input.note, placedAt, releasedAt: null }
  })
}

export async function releaseRetentionHold(id: string, actorUserId: string) {
  return withTransaction(async tx => {
    const hold = await tx.prepare<{ workspace_id: string; deal_id: string | null; released_at: string | null }>(
      "SELECT workspace_id,deal_id,released_at FROM retention_holds WHERE id=? FOR UPDATE"
    ).get(id)
    if (!hold) throw new AppError(404, "retention_hold_not_found", "Retention hold not found.")
    if (hold.released_at) throw new AppError(409, "retention_hold_released", "Retention hold was already released.")
    const releasedAt = nowIso()
    await tx.prepare("UPDATE retention_holds SET released_by=?,released_at=? WHERE id=?").run(actorUserId, releasedAt, id)
    await recordAuditEvent({
      context: { workspaceId: hold.workspace_id, userId: actorUserId }, action: "retention_hold.released",
      resourceType: "retention_hold", resourceId: id, metadata: { dealId: hold.deal_id }, executor: tx
    })
    return { id, releasedAt }
  })
}
