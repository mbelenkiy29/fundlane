import "server-only"

import { addDate, dateInZone } from "../calendar/contracts"
import { saveActivity } from "../calendar/service"
import { createStipulation, previewStipulationRequest, sendRequestPreview } from "../closing/service"
import { getDatabase, newId, nowIso, parseJson, recordAuditEvent, withTransaction, type DbExecutor } from "../db"
import type { DealActor } from "../deals/schema"
import { getDealForDocument } from "../deals/service"
import { AppError } from "../errors"
import { prepareDealSubmission } from "../submissions/broker-preview"
import { toQueuedSummary } from "../submissions/jobs"
import { confirmSubmissions } from "../submissions/queue"
import { listJobsForDeal } from "../submissions/repository"
import { getWorkspaceSettings } from "../workspaces"

// Well above the 300s maximum duration of any route that executes an action.
const RECOVER_AFTER_MS = 15 * 60_000

type ActionRow = {
  id: string; run_id: string; kind: "request_documents" | "submit_to_funder" | "schedule_follow_up"; target_key: string; fingerprint: string; status: string
  payload_json: string; next_fingerprint: string | null; next_payload_json: string | null; preview_id: string | null; result_json: string | null; error_code: string | null
  decided_by_user_id: string | null; decided_at: string | null; decision_note: string | null; decided_by: string | null; created_at: string; updated_at: string
}
type ActionView = {
  id: string; kind: ActionRow["kind"]; status: string; payload: Record<string, unknown>; createdAt: string
  decidedAt: string | null; decidedBy: string | null; decisionNote: string | null; errorCode: string | null
}
export type DealAgentView = {
  enabled: true
  runs: Array<{ id: string; state: string; createdAt: string; steps: unknown }>
  actions: ActionView[]
}

const ACTION_SELECT = `SELECT a.id,a.run_id,a.kind,a.target_key,a.fingerprint,a.status,a.payload_json,a.next_fingerprint,a.next_payload_json,a.preview_id,a.result_json,a.error_code,
  a.decided_by_user_id,a.decided_at,a.decision_note,a.created_at,a.updated_at,u.name AS decided_by
  FROM mca_deal_agent_actions a LEFT JOIN users u ON u.id=a.decided_by_user_id`

function toView(row: ActionRow): ActionView {
  return {
    id: row.id, kind: row.kind, status: row.status, payload: parseJson(row.payload_json, {}), createdAt: row.created_at,
    decidedAt: row.decided_at, decidedBy: row.decided_by, decisionNote: row.decision_note, errorCode: row.error_code,
  }
}

export async function listDealAgent(actor: DealActor, dealId: string): Promise<DealAgentView> {
  const deal = await getDealForDocument(actor, dealId)
  await recoverStaleActions(actor, deal.id)
  const runs = await getDatabase().prepare<{ id: string; state: string; created_at: string; steps_json: string }>(
    "SELECT id,state,created_at,steps_json FROM mca_deal_agent_runs WHERE workspace_id=? AND deal_id=? ORDER BY created_at DESC LIMIT 10",
  ).all(actor.workspaceId, deal.id)
  const actions = await getDatabase().prepare<ActionRow>(`${ACTION_SELECT} WHERE a.workspace_id=? AND a.deal_id=? AND a.status<>'superseded'
    ORDER BY (a.status IN ('pending','executing')) DESC, a.updated_at DESC LIMIT 50`).all(actor.workspaceId, deal.id)
  return {
    enabled: true,
    runs: runs.map(run => ({ id: run.id, state: run.state, createdAt: run.created_at, steps: parseJson(run.steps_json, []) })),
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

/**
 * An approval whose process died stays `executing` and blocks its target. Settle it from the downstream record, never by guessing;
 * a row returned to pending is safe to approve again (confirm returns early once confirmed, delivery dedupes on `deal-agent:<id>`).
 */
export async function recoverStaleActions(actor: DealActor, dealId: string): Promise<void> {
  const cutoff = new Date(Date.now() - RECOVER_AFTER_MS).toISOString()
  const rows = await getDatabase().prepare<ActionRow>(`${ACTION_SELECT} WHERE a.workspace_id=? AND a.deal_id=? AND a.status='executing' AND a.updated_at<?`).all(actor.workspaceId, dealId, cutoff)
  for (const row of rows) {
    let outcome: "approved" | "failed" | "pending" = "pending"
    let result: unknown = null
    if (row.kind === "submit_to_funder") {
      const preview = await getDatabase().prepare<{ confirmed_at: string | null }>("SELECT confirmed_at FROM intake_submission_previews WHERE workspace_id=? AND id=?").get(actor.workspaceId, row.preview_id)
      if (preview?.confirmed_at) {
        outcome = "approved"
        result = { ok: true, confirmationKey: row.preview_id, jobs: (await listJobsForDeal(actor.workspaceId, dealId)).filter(job => job.confirmationKey === row.preview_id).map(toQueuedSummary) }
      }
    } else if (row.kind === "request_documents") {
      const preview = await getDatabase().prepare<{ state: string }>("SELECT state FROM mca_closing_previews WHERE workspace_id=? AND id=?").get(actor.workspaceId, row.preview_id)
      if (preview?.state === "sent") outcome = "approved"
      else if (preview?.state === "failed") outcome = "failed"
    } else {
      // saveActivity has no idempotency key: look for the follow-up the claimed approval would have created.
      const activity = await getDatabase().prepare(`SELECT 1 FROM mca_calendar_activities WHERE workspace_id=? AND deal_id=? AND kind='followup' AND title=? AND created_at>=?
        AND assignee_id IN (SELECT id FROM memberships WHERE workspace_id=? AND user_id=?)`)
        .get(actor.workspaceId, dealId, parseJson<{ title?: string }>(row.payload_json, {}).title ?? null, row.updated_at, actor.workspaceId, row.decided_by_user_id)
      if (activity) outcome = "approved"
    }
    const now = nowIso()
    const settled = outcome === "pending"
      ? await getDatabase().prepare(`UPDATE mca_deal_agent_actions SET status='pending',error_code='interrupted',decided_by_user_id=NULL,updated_at=?
        WHERE workspace_id=? AND id=? AND status='executing' AND updated_at<?`).run(now, actor.workspaceId, row.id, cutoff)
      : await getDatabase().prepare(`UPDATE mca_deal_agent_actions SET status=?,result_json=?,error_code=?,next_fingerprint=NULL,next_payload_json=NULL,decided_at=?,updated_at=?
        WHERE workspace_id=? AND id=? AND status='executing' AND updated_at<?`).run(outcome, result === null ? null : JSON.stringify(result), outcome === "failed" ? "delivery_failed" : null, now, now, actor.workspaceId, row.id, cutoff)
    if (settled.changes) await audit(actor, "deal_agent.action_recovered", row, dealId, { outcome })
  }
}

const stipulationKey = (actionId: string, item: { category: string; period?: string }) => `deal-agent:${actionId}:${item.category}${item.period ? `:${item.period}` : ""}`

/** Waives this action's still-open stipulations except `keep`; ones review() reused from an earlier request never match the prefix. */
async function waiveOwnStipulations(actor: DealActor, database: DbExecutor, dealId: string, actionId: string, reason: string, keep: string[] = []) {
  const waived = await database.prepare<{ id: string }>(`UPDATE mca_closing_stipulations SET status='waived',exception_reason=?,updated_at=?
    WHERE workspace_id=? AND deal_id=? AND status='open' AND idempotency_key LIKE ? AND NOT (idempotency_key = ANY(?)) RETURNING id`)
    .all(reason, nowIso(), actor.workspaceId, dealId, `deal-agent:${actionId}:%`, keep)
  for (const stipulation of waived) await recordAuditEvent({ context: actor, action: "closing.stipulation_waived", resourceType: "closing_stipulation", resourceId: stipulation.id, metadata: { dealId, hasDocument: false }, correlationId: actor.correlationId })
}

async function review(actor: DealActor, dealId: string, dealVersion: number, action: ActionRow, input: { senderId?: string; origin: string }): Promise<{ id: string }> {
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
    stipulationIds.push(open?.id ?? (await createStipulation(actor, { dealId, documentCategory: item.category, label: item.label, idempotencyKey: stipulationKey(action.id, item) })).id)
  }
  // The deal version binds the key to the merchant contact it renders and the fingerprint to the items (a promoted proposal);
  // either change gets a fresh preview instead of idempotency_conflict.
  return previewStipulationRequest(actor, { dealId, stipulationIds, senderId: input.senderId, channel: "email", idempotencyKey: `deal-agent:${action.id}:${input.senderId}:${dealVersion}:${action.fingerprint}`, origin: input.origin })
}

async function execute(actor: DealActor, dealId: string, action: ActionRow): Promise<unknown> {
  if (action.kind === "submit_to_funder") return confirmSubmissions(actor, dealId, { previewId: action.preview_id })
  if (action.kind === "request_documents") return sendRequestPreview(actor, action.preview_id!, `deal-agent:${action.id}`)
  const payload = parseJson<{ title: string; dueInDays: number }>(action.payload_json, { title: "Follow up", dueInDays: 2 })
  const { timezone } = await getWorkspaceSettings(actor.workspaceId)
  const today = dateInZone(new Date(), timezone)
  return saveActivity(actor, { dealId, assigneeId: actor.membershipId, kind: "followup", title: payload.title, notes: "Proposed by Deal Agent: check whether the merchant uploaded the requested documents.", allDay: true, start: addDate(today, payload.dueInDays), end: addDate(today, payload.dueInDays + 1), timezone })
}

/** Only an interactive broker reaches this; every external effect is the existing manual path, run as that broker. */
export async function decideDealAgentAction(actor: DealActor, input: { dealId: string; actionId: string; decision: "review" | "approve" | "dismiss"; senderId?: string; note?: string; previewId?: string; origin: string }): Promise<{ preview?: unknown; result?: unknown }> {
  const deal = await getDealForDocument(actor, input.dealId)
  const action = await readAction(actor, deal.id, input.actionId)
  if (action.status !== "pending") throw new AppError(409, "action_not_pending", "This action was already decided.")
  const now = nowIso()
  // Same per-deal lock as upsertProposals, so a run can't interleave with a slot handoff.
  const lock = (database: DbExecutor) => database.prepare("SELECT pg_advisory_xact_lock(hashtext(?))").get(`deal-agent:${actor.workspaceId}:${deal.id}`)
  if (input.decision === "dismiss") {
    await withTransaction(async (database) => {
      await lock(database)
      const dismissed = await database.prepare<ActionRow>(`UPDATE mca_deal_agent_actions SET status='dismissed',decided_by_user_id=?,decided_at=?,decision_note=?,updated_at=?
        WHERE workspace_id=? AND deal_id=? AND id=? AND status='pending' RETURNING *`).get(actor.userId, now, input.note ?? null, now, actor.workspaceId, deal.id, action.id)
      if (!dismissed) throw new AppError(409, "action_not_pending", "This action was already decided.")
      await waiveOwnStipulations(actor, database, deal.id, action.id, "Deal Agent request dismissed.")
      // The proposal parked behind the reviewed row takes its slot; a superseded twin comes back, a decided one stays decided.
      if (dismissed.next_fingerprint) await database.prepare(`INSERT INTO mca_deal_agent_actions (id,workspace_id,deal_id,run_id,kind,target_key,fingerprint,payload_json,status,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,'pending',?,?) ON CONFLICT (workspace_id,deal_id,target_key,fingerprint) DO UPDATE SET status='pending',run_id=EXCLUDED.run_id,payload_json=EXCLUDED.payload_json,
          preview_id=NULL,error_code=NULL,updated_at=EXCLUDED.updated_at WHERE mca_deal_agent_actions.status='superseded'`)
        .run(newId(), actor.workspaceId, deal.id, dismissed.run_id, dismissed.kind, dismissed.target_key, dismissed.next_fingerprint, dismissed.next_payload_json, now, now)
    })
    await audit(actor, "deal_agent.action_dismissed", action, deal.id)
    return {}
  }
  if (input.decision === "review") {
    // Reviewing again uses the newer proposal parked behind this row.
    const current = !action.next_fingerprint ? action : await withTransaction(async (database) => {
      await lock(database)
      // A superseded twin holds the parked fingerprint's unique slot and carries no decision.
      await database.prepare("DELETE FROM mca_deal_agent_actions WHERE workspace_id=? AND deal_id=? AND target_key=? AND fingerprint=? AND status='superseded'")
        .run(actor.workspaceId, deal.id, action.target_key, action.next_fingerprint)
      const promoted = await database.prepare<ActionRow>(`UPDATE mca_deal_agent_actions SET fingerprint=next_fingerprint,payload_json=next_payload_json,next_fingerprint=NULL,next_payload_json=NULL,
        preview_id=NULL,error_code=NULL,updated_at=? WHERE workspace_id=? AND deal_id=? AND id=? AND status='pending' AND next_fingerprint=? RETURNING *`)
        .get(now, actor.workspaceId, deal.id, action.id, action.next_fingerprint)
      if (!promoted) throw new AppError(409, "action_not_pending", "This action was already decided.")
      // Items the new version still asks for keep their stipulation (same key), so review() reuses it.
      await waiveOwnStipulations(actor, database, deal.id, action.id, "Deal Agent request revised.",
        (parseJson<{ items?: Array<{ category: string; period?: string }> }>(promoted.payload_json, {}).items ?? []).map(item => stipulationKey(action.id, item)))
      return promoted
    })
    const preview = await review(actor, deal.id, deal.version, current, input)
    const stored = await getDatabase().prepare("UPDATE mca_deal_agent_actions SET preview_id=?,error_code=NULL,updated_at=? WHERE workspace_id=? AND deal_id=? AND id=? AND status='pending'")
      .run(preview.id, now, actor.workspaceId, deal.id, action.id)
    if (!stored.changes) throw new AppError(409, "action_not_pending", "This action was already decided.")
    await audit(actor, "deal_agent.action_reviewed", action, deal.id, { previewId: preview.id })
    return { preview }
  }

  if (action.kind !== "schedule_follow_up") {
    if (!action.preview_id) throw new AppError(409, "review_required", "Review the exact preview before approving.")
    // The client only echoes the preview it displayed; the stored one is what gets sent.
    if (input.previewId !== action.preview_id) throw new AppError(409, "preview_changed", "This proposal was reviewed again elsewhere. Review it before approving.")
  }
  // Binding the claim to the compared preview closes the gap where a concurrent re-review swaps it.
  // The claim records the approver so recovery can find a follow-up this request already created.
  const claimed = await getDatabase().prepare<ActionRow>(`UPDATE mca_deal_agent_actions SET status='executing',decided_by_user_id=?,updated_at=?
    WHERE workspace_id=? AND deal_id=? AND id=? AND status='pending' AND preview_id IS NOT DISTINCT FROM ? RETURNING *`).get(actor.userId, now, actor.workspaceId, deal.id, action.id, action.preview_id)
  if (!claimed) {
    if ((await readAction(actor, deal.id, action.id)).status === "pending") throw new AppError(409, "preview_changed", "This proposal was reviewed again elsewhere. Review it before approving.")
    throw new AppError(409, "action_not_pending", "This action was already decided.")
  }
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
  await getDatabase().prepare(`UPDATE mca_deal_agent_actions SET status=?,result_json=?,error_code=?,next_fingerprint=NULL,next_payload_json=NULL,decided_by_user_id=?,decided_at=?,updated_at=?
    WHERE workspace_id=? AND id=? AND status='executing'`).run(failed ? "failed" : "approved", JSON.stringify(result), failed ? "delivery_failed" : null, actor.userId, decidedAt, decidedAt, actor.workspaceId, action.id)
  await audit(actor, failed ? "deal_agent.action_failed" : "deal_agent.action_approved", action, deal.id)
  return { result }
}
