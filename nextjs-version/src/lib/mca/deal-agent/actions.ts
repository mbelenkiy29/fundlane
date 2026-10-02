import "server-only"

import { addDate, dateInZone } from "../calendar/contracts"
import { saveActivity } from "../calendar/service"
import { createStipulation, previewStipulationRequest, sendRequestPreview } from "../closing/service"
import { getDatabase, nowIso, parseJson, recordAuditEvent } from "../db"
import type { DealActor } from "../deals/schema"
import { getDealForDocument } from "../deals/service"
import { AppError } from "../errors"
import { prepareDealSubmission } from "../submissions/broker-preview"
import { confirmSubmissions } from "../submissions/queue"
import { getWorkspaceSettings } from "../workspaces"

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

async function review(actor: DealActor, dealId: string, action: ActionRow, input: { senderId?: string; origin: string }): Promise<{ id: string }> {
  const payload = parseJson<Record<string, unknown>>(action.payload_json, {})
  if (action.kind === "submit_to_funder") return prepareDealSubmission(actor, dealId, [payload.funderId])
  if (action.kind !== "request_documents") throw new AppError(422, "review_not_applicable", "This action has no preview; approve or dismiss it.")
  if (!input.senderId) throw new AppError(422, "sender_required", "Choose a merchant sender before reviewing the request.")
  // Open stipulations are what the existing request preview is built from; they stay visible in Closing.
  // Reuse an item still open from an earlier request so the merchant never holds two live links for one document.
  const stipulationIds: string[] = []
  for (const item of payload.items as Array<{ category: string; label: string; period?: string }>) {
    const open = await getDatabase().prepare<{ id: string }>("SELECT id FROM mca_closing_stipulations WHERE workspace_id=? AND deal_id=? AND status='open' AND document_category=? AND label=? ORDER BY created_at LIMIT 1")
      .get(actor.workspaceId, dealId, item.category, item.label)
    stipulationIds.push(open?.id ?? (await createStipulation(actor, { dealId, documentCategory: item.category, label: item.label, idempotencyKey: `deal-agent:${action.id}:${item.category}${item.period ? `:${item.period}` : ""}` })).id)
  }
  return previewStipulationRequest(actor, { dealId, stipulationIds, senderId: input.senderId, channel: "email", idempotencyKey: `deal-agent:${action.id}:${input.senderId}`, origin: input.origin })
}

async function execute(actor: DealActor, dealId: string, action: ActionRow & { preview_id: string | null }): Promise<unknown> {
  if (action.kind === "submit_to_funder") return confirmSubmissions(actor, dealId, { previewId: action.preview_id })
  if (action.kind === "request_documents") return sendRequestPreview(actor, action.preview_id!, `deal-agent:${action.id}`)
  const payload = parseJson<{ title: string; dueInDays: number }>(action.payload_json, { title: "Follow up", dueInDays: 2 })
  const { timezone } = await getWorkspaceSettings(actor.workspaceId)
  const today = dateInZone(new Date(), timezone)
  return saveActivity(actor, { dealId, assigneeId: actor.membershipId, kind: "followup", title: payload.title, notes: "Proposed by Deal Agent: check whether the merchant uploaded the requested documents.", allDay: true, start: addDate(today, payload.dueInDays), end: addDate(today, payload.dueInDays + 1), timezone })
}

/** Only an interactive broker reaches this; every external effect is the existing manual path, run as that broker. */
export async function decideDealAgentAction(actor: DealActor, input: { dealId: string; actionId: string; decision: "review" | "approve" | "dismiss"; senderId?: string; note?: string; previewId?: string; origin: string }): Promise<{ action: ActionView; preview?: unknown; result?: unknown }> {
  const deal = await getDealForDocument(actor, input.dealId)
  const action = await readAction(actor, deal.id, input.actionId)
  if (action.status !== "pending") throw new AppError(409, "action_not_pending", "This action was already decided.")
  const now = nowIso()
  if (input.decision === "dismiss") {
    const dismissed = await getDatabase().prepare(`UPDATE mca_deal_agent_actions SET status='dismissed',decided_by_user_id=?,decided_at=?,decision_note=?,updated_at=?
      WHERE workspace_id=? AND deal_id=? AND id=? AND status='pending'`).run(actor.userId, now, input.note ?? null, now, actor.workspaceId, deal.id, action.id)
    if (!dismissed.changes) throw new AppError(409, "action_not_pending", "This action was already decided.")
    await audit(actor, "deal_agent.action_dismissed", action, deal.id)
    return { action: toView(await readAction(actor, deal.id, action.id)) }
  }
  if (input.decision === "review") {
    const preview = await review(actor, deal.id, action, input)
    const stored = await getDatabase().prepare("UPDATE mca_deal_agent_actions SET preview_id=?,error_code=NULL,updated_at=? WHERE workspace_id=? AND deal_id=? AND id=? AND status='pending'")
      .run(preview.id, now, actor.workspaceId, deal.id, action.id)
    if (!stored.changes) throw new AppError(409, "action_not_pending", "This action was already decided.")
    await audit(actor, "deal_agent.action_reviewed", action, deal.id, { previewId: preview.id })
    return { action: toView(await readAction(actor, deal.id, action.id)), preview }
  }

  if (action.kind !== "schedule_follow_up") {
    if (!action.preview_id) throw new AppError(409, "review_required", "Review the exact preview before approving.")
    // The client only echoes the preview it displayed; the stored one is what gets sent.
    if (input.previewId !== action.preview_id) throw new AppError(409, "preview_changed", "This proposal was reviewed again elsewhere. Review it before approving.")
  }
  const claimed = await getDatabase().prepare<ActionRow & { preview_id: string | null }>(`UPDATE mca_deal_agent_actions SET status='executing',updated_at=?
    WHERE workspace_id=? AND deal_id=? AND id=? AND status='pending' RETURNING *`).get(now, actor.workspaceId, deal.id, action.id)
  if (!claimed) throw new AppError(409, "action_not_pending", "This action was already decided.")
  let result: unknown
  try {
    result = await execute(actor, deal.id, claimed)
  } catch (error) {
    // A rejection before anything left the building returns the proposal to the queue; anything else needs a human check.
    const retryable = error instanceof AppError && error.status < 500
    await getDatabase().prepare("UPDATE mca_deal_agent_actions SET status=?,error_code=?,updated_at=? WHERE workspace_id=? AND id=? AND status='executing'")
      .run(retryable ? "pending" : "failed", error instanceof AppError ? error.code : "processing_failed", nowIso(), actor.workspaceId, action.id)
    await audit(actor, "deal_agent.action_failed", action, deal.id, { code: error instanceof AppError ? error.code : "processing_failed", returnedToPending: retryable })
    throw error
  }
  const failed = (result as { state?: string }).state === "failed"
  const decidedAt = nowIso()
  await getDatabase().prepare(`UPDATE mca_deal_agent_actions SET status=?,result_json=?,error_code=?,decided_by_user_id=?,decided_at=?,updated_at=?
    WHERE workspace_id=? AND id=? AND status='executing'`).run(failed ? "failed" : "approved", JSON.stringify(result), failed ? "delivery_failed" : null, actor.userId, decidedAt, decidedAt, actor.workspaceId, action.id)
  await audit(actor, failed ? "deal_agent.action_failed" : "deal_agent.action_approved", action, deal.id)
  return { action: toView(await readAction(actor, deal.id, action.id)), result }
}
