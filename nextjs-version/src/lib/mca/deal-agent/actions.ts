import "server-only"

import { getDatabase, nowIso, parseJson, recordAuditEvent } from "../db"
import type { DealActor } from "../deals/schema"
import { getDealForDocument } from "../deals/service"
import { AppError } from "../errors"

type ActionRow = {
  id: string; kind: "request_documents" | "submit_to_funder" | "schedule_follow_up"; status: string; payload_json: string; preview_id: string | null
  result_json: string | null; error_code: string | null; decided_at: string | null; decision_note: string | null; decided_by: string | null; created_at: string
}
type ActionView = {
  id: string; kind: ActionRow["kind"]; status: string; payload: Record<string, unknown>; createdAt: string; decidedAt?: string
  decidedBy?: string; decisionNote?: string; result?: unknown; errorCode?: string; hasPreview: boolean
}
export type DealAgentView = {
  enabled: true
  runs: Array<{ id: string; state: string; createdAt: string; completedAt: string | null; inputs: unknown; steps: unknown }>
  actions: ActionView[]
}

const ACTION_SELECT = `SELECT a.id,a.kind,a.status,a.payload_json,a.preview_id,a.result_json,a.error_code,a.decided_at,a.decision_note,a.created_at,u.name AS decided_by
  FROM mca_deal_agent_actions a LEFT JOIN users u ON u.id=a.decided_by_user_id`

function toView(row: ActionRow): ActionView {
  return {
    id: row.id, kind: row.kind, status: row.status, payload: parseJson(row.payload_json, {}), createdAt: row.created_at, hasPreview: Boolean(row.preview_id),
    ...(row.decided_at ? { decidedAt: row.decided_at } : {}), ...(row.decided_by ? { decidedBy: row.decided_by } : {}),
    ...(row.decision_note ? { decisionNote: row.decision_note } : {}), ...(row.result_json ? { result: parseJson(row.result_json, null) } : {}),
    ...(row.error_code ? { errorCode: row.error_code } : {}),
  }
}

export async function listDealAgent(actor: DealActor, dealId: string): Promise<DealAgentView> {
  const deal = await getDealForDocument(actor, dealId)
  const runs = await getDatabase().prepare<{ id: string; state: string; created_at: string; completed_at: string | null; inputs_json: string; steps_json: string }>(
    "SELECT id,state,created_at,completed_at,inputs_json,steps_json FROM mca_deal_agent_runs WHERE workspace_id=? AND deal_id=? ORDER BY created_at DESC LIMIT 10",
  ).all(actor.workspaceId, deal.id)
  const actions = await getDatabase().prepare<ActionRow>(`${ACTION_SELECT} WHERE a.workspace_id=? AND a.deal_id=? AND a.status<>'superseded'
    ORDER BY (a.status IN ('pending','executing')) DESC, a.updated_at DESC LIMIT 50`).all(actor.workspaceId, deal.id)
  return {
    enabled: true,
    runs: runs.map(run => ({ id: run.id, state: run.state, createdAt: run.created_at, completedAt: run.completed_at, inputs: parseJson(run.inputs_json, {}), steps: parseJson(run.steps_json, []) })),
    actions: actions.map(toView),
  }
}

async function readAction(actor: DealActor, dealId: string, actionId: string): Promise<ActionRow> {
  const row = await getDatabase().prepare<ActionRow>(`${ACTION_SELECT} WHERE a.workspace_id=? AND a.deal_id=? AND a.id=?`).get(actor.workspaceId, dealId, actionId)
  if (!row) throw new AppError(404, "action_not_found", "The requested Deal Agent action was not found.")
  return row
}

async function audit(actor: DealActor, action: string, row: Pick<ActionRow, "id" | "kind">, dealId: string, metadata: Record<string, unknown> = {}) {
  await recordAuditEvent({ context: actor, action, resourceType: "deal_agent_action", resourceId: row.id, metadata: { dealId, kind: row.kind, ...metadata }, correlationId: actor.correlationId })
}

export async function decideDealAgentAction(actor: DealActor, input: { dealId: string; actionId: string; decision: "review" | "approve" | "dismiss"; senderId?: string; note?: string; origin: string }): Promise<{ action: ActionView; preview?: unknown; result?: unknown }> {
  const deal = await getDealForDocument(actor, input.dealId)
  const action = await readAction(actor, deal.id, input.actionId)
  if (action.status !== "pending") throw new AppError(409, "action_not_pending", "This action was already decided.")
  if (input.decision === "dismiss") {
    const now = nowIso()
    const dismissed = await getDatabase().prepare(`UPDATE mca_deal_agent_actions SET status='dismissed',decided_by_user_id=?,decided_at=?,decision_note=?,updated_at=?
      WHERE workspace_id=? AND deal_id=? AND id=? AND status='pending'`).run(actor.userId, now, input.note ?? null, now, actor.workspaceId, deal.id, action.id)
    if (!dismissed.changes) throw new AppError(409, "action_not_pending", "This action was already decided.")
    await audit(actor, "deal_agent.action_dismissed", action, deal.id)
    return { action: toView(await readAction(actor, deal.id, action.id)) }
  }
  throw new AppError(422, "decision_unsupported", "This decision is not available yet.")
}
