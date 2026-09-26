import "server-only"

import { getDatabase, newId, nowIso, parseJson, recordAuditEvent, withTransaction } from "../db"
import type { DealActor } from "../deals/schema"
import { getDealForDocument } from "../deals/service"
import { AppError } from "../errors"
import { listFunders } from "../funders/directory"
import { enqueueBackgroundJob } from "../jobs/queue"
import { canManageWorkspace } from "../policy"
import { adapterReadiness } from "../submissions/adapters/registry"
import { resolveAdapterEnvironment, resolveAdapterSecrets } from "../submissions/adapters/credentials"
import { queueSubmissions } from "../submissions/queue"
import { findJobByConfirmation } from "../submissions/repository"
import { getCompleteness } from "./completeness"
import { scoreDeal } from "./scoring"
import { evaluateUnderwritingSendGates } from "./send-gates"

export type AutoSubmitMode = "off" | "score_only" | "auto_submit"
export interface AutoSubmitSettings {
  mode: AutoSubmitMode
  minMatchScore: number
  maxFundersPerDeal: number
  eligibleFunderIds: string[]
}
export const DEFAULT_AUTO_SUBMIT_SETTINGS: AutoSubmitSettings = { mode: "off", minMatchScore: 80, maxFundersPerDeal: 3, eligibleFunderIds: [] }
export function autoSubmitEnabled(): boolean { return process.env.MCA_AUTO_SUBMIT_ENABLED === "true" }

export async function getAutoSubmitSettings(workspaceId: string): Promise<AutoSubmitSettings> {
  if (!autoSubmitEnabled()) return { ...DEFAULT_AUTO_SUBMIT_SETTINGS }
  const row = await getDatabase().prepare<{ mode: AutoSubmitMode; min_match_score: number; max_funders_per_deal: number; eligible_funder_ids: string }>(
    "SELECT mode,min_match_score,max_funders_per_deal,eligible_funder_ids FROM mca_auto_submit_settings WHERE workspace_id=?",
  ).get(workspaceId)
  return row ? { mode: row.mode, minMatchScore: Number(row.min_match_score), maxFundersPerDeal: Number(row.max_funders_per_deal), eligibleFunderIds: parseJson<string[]>(row.eligible_funder_ids, []) } : { ...DEFAULT_AUTO_SUBMIT_SETTINGS }
}

export function validateAutoSubmitSettings(value: unknown): AutoSubmitSettings {
  if (!value || typeof value !== "object") throw new AppError(422, "validation_failed", "Invalid auto-submit settings.")
  const input = value as Record<string, unknown>
  if (input.mode !== "off" && input.mode !== "score_only" && input.mode !== "auto_submit") throw new AppError(422, "validation_failed", "Choose a valid auto-submit mode.")
  if (!Number.isInteger(input.minMatchScore) || Number(input.minMatchScore) < 0 || Number(input.minMatchScore) > 100) throw new AppError(422, "validation_failed", "Minimum match score must be 0 to 100.")
  if (!Number.isInteger(input.maxFundersPerDeal) || Number(input.maxFundersPerDeal) < 1 || Number(input.maxFundersPerDeal) > 25) throw new AppError(422, "validation_failed", "Maximum funders must be 1 to 25.")
  if (!Array.isArray(input.eligibleFunderIds) || input.eligibleFunderIds.length > 200 || input.eligibleFunderIds.some(id => typeof id !== "string" || !id || id.length > 128)) throw new AppError(422, "validation_failed", "Choose valid funders.")
  return { mode: input.mode, minMatchScore: Number(input.minMatchScore), maxFundersPerDeal: Number(input.maxFundersPerDeal), eligibleFunderIds: [...new Set(input.eligibleFunderIds as string[])] }
}

export async function setAutoSubmitSettings(actor: DealActor, value: unknown): Promise<AutoSubmitSettings> {
  if (!autoSubmitEnabled()) throw new AppError(404, "feature_unavailable", "Auto-submit is unavailable.")
  if (!actor.role || !canManageWorkspace(actor.role)) throw new AppError(403, "permission_denied", "Only workspace administrators can update auto-submit settings.")
  const next = validateAutoSubmitSettings(value)
  const funders = await listFunders(actor)
  if (next.eligibleFunderIds.some(id => !funders.some(funder => funder.id === id && funder.active))) throw new AppError(422, "validation_failed", "Select active funders in this workspace.")
  await getDatabase().prepare(`INSERT INTO mca_auto_submit_settings (workspace_id,mode,min_match_score,max_funders_per_deal,eligible_funder_ids,updated_at,updated_by_user_id)
    VALUES (?,?,?,?,?,?,?) ON CONFLICT (workspace_id) DO UPDATE SET mode=excluded.mode,min_match_score=excluded.min_match_score,max_funders_per_deal=excluded.max_funders_per_deal,eligible_funder_ids=excluded.eligible_funder_ids,updated_at=excluded.updated_at,updated_by_user_id=excluded.updated_by_user_id`)
    .run(actor.workspaceId, next.mode, next.minMatchScore, next.maxFundersPerDeal, JSON.stringify(next.eligibleFunderIds), nowIso(), actor.userId)
  await recordAuditEvent({ context: actor, action: "auto_submit.settings_updated", resourceType: "workspace", resourceId: actor.workspaceId, metadata: { ...next }, correlationId: actor.correlationId })
  return next
}

export function autoSubmitDecision(input: { mode: AutoSubmitMode; score: number; eligible: boolean; allowedFunder: boolean; adapterReady: boolean; complete: boolean; capacity: boolean; minScore: number }): { outcome: "scored" | "skipped" | "submit"; reason: string } {
  if (input.mode === "score_only") return { outcome: "scored", reason: "score_only" }
  if (!input.complete) return { outcome: "skipped", reason: "deal_incomplete" }
  if (!input.eligible) return { outcome: "skipped", reason: "match_ineligible" }
  if (input.score < input.minScore) return { outcome: "skipped", reason: "below_min_score" }
  if (!input.allowedFunder) return { outcome: "skipped", reason: "funder_not_selected" }
  if (!input.adapterReady) return { outcome: "skipped", reason: "adapter_not_ready" }
  if (!input.capacity) return { outcome: "skipped", reason: "max_funders_reached" }
  return { outcome: "submit", reason: "matched_and_ready" }
}

export async function enqueueAutoSubmitIfEnabled(actor: DealActor, dealId: string, completenessVersion: number, dealVersion: number): Promise<void> {
  if (!autoSubmitEnabled()) return
  const settings = await getAutoSubmitSettings(actor.workspaceId)
  if (settings.mode === "off") return
  await enqueueBackgroundJob({ actor, kind: "auto_submit", resourceId: dealId, idempotencyKey: `auto-submit:${dealId}:${dealVersion}:${completenessVersion}`, payload: { completenessVersion, dealVersion, mode: settings.mode } })
}

export async function processAutoSubmit(actor: DealActor, dealId: string, expectedVersion: number, queuedMode: AutoSubmitMode, expectedDealVersion: number): Promise<{ decisions: number }> {
  if (!autoSubmitEnabled()) return { decisions: 0 }
  const settings = await getAutoSubmitSettings(actor.workspaceId)
  if (settings.mode === "off" || settings.mode !== queuedMode) return { decisions: 0 }
  const deal = await getDealForDocument(actor, dealId)
  if (deal.version !== expectedDealVersion) return { decisions: 0 }
  const completeness = await getCompleteness(actor, deal.id)
  if (expectedVersion === 0 ? Boolean(completeness?.ready) : completeness?.version !== expectedVersion) return { decisions: 0 }
  const scored = await scoreDeal(actor, deal.id, { mode: "analyze_only", topN: settings.maxFundersPerDeal })
  const scoredVersion = await getDatabase().prepare<{ deal_version: number }>(
    "SELECT deal_version FROM mca_score_snapshots WHERE workspace_id=? AND id=?",
  ).get(actor.workspaceId, scored.snapshot.id)
  if (scoredVersion?.deal_version !== expectedDealVersion) return { decisions: 0 }
  const funders = await listFunders(actor)
  const funderById = new Map(funders.map(funder => [funder.id, funder]))
  const gates = settings.mode === "auto_submit" ? await evaluateUnderwritingSendGates(actor, deal.id) : undefined
  const complete = deal.missingRequiredFields.length === 0 && Boolean(completeness?.ready) && Boolean(gates?.ok ?? true)
  for (const score of scored.snapshot.scores) {
    const funder = funderById.get(score.funderId)
    const route = funder?.routes.find(item => item.active)
    const readiness = route ? adapterReadiness(route.destination) : "unavailable"
    const environment = resolveAdapterEnvironment()
    const adapter = route?.kind === "api" ? await resolveAdapterSecrets({ workspaceId: actor.workspaceId, funderId: score.funderId, environment, adapterSlug: route.destination }) : undefined
    const adapterReady = Boolean(route?.kind === "api" && funder?.active && ((readiness === "live" && environment === "production" && !funder.sandbox) || (readiness === "sandbox" && environment === "development" && funder.sandbox))
      && adapter?.capabilities.submit)
    // Lock the deal while reserving capacity so concurrent auto-submit jobs cannot
    // each spend the same remaining slot. Delivery happens after the lock is released.
    const claimed = await withTransaction(async db => {
      const currentDeal = await db.prepare<{ version: number }>("SELECT version FROM deals WHERE workspace_id=? AND id=? FOR UPDATE").get(actor.workspaceId, deal.id)
      if (currentDeal?.version !== expectedDealVersion) return null
      const currentCompleteness = await db.prepare<{ version: number; ready: boolean }>(
        "SELECT version,ready FROM mca_completeness_results WHERE workspace_id=? AND deal_id=? ORDER BY version DESC LIMIT 1",
      ).get(actor.workspaceId, deal.id)
      if (expectedVersion === 0 ? Boolean(currentCompleteness?.ready) : currentCompleteness?.version !== expectedVersion) return null
      const existing = await db.prepare<{ id: string; outcome: string; retry_count: number }>(
        "SELECT id,outcome,retry_count FROM mca_auto_submit_decisions WHERE workspace_id=? AND deal_id=? AND funder_id=?",
      ).get(actor.workspaceId, deal.id, score.funderId)
      if (existing?.outcome === "submit") return null
      const priorSubmission = settings.mode === "auto_submit" ? await db.prepare<{ confirmation_key: string }>(
        "SELECT confirmation_key FROM mca_submission_jobs WHERE workspace_id=? AND deal_id=? AND funder_id=? AND state IN ('queued','sending','sent','pending_portal','declined','funded') AND confirmation_key<>? LIMIT 1",
      ).get(actor.workspaceId, deal.id, score.funderId, existing ? `auto:${existing.id}:${existing.retry_count}` : "") : undefined
      const reserved = await db.prepare<{ n: number }>(
        "SELECT count(*)::integer AS n FROM mca_auto_submit_decisions WHERE workspace_id=? AND deal_id=? AND outcome IN ('pending','submit')",
      ).get(actor.workspaceId, deal.id)
      const capacity = Boolean(existing?.outcome === "pending" || (reserved?.n ?? 0) < settings.maxFundersPerDeal)
      const decision = priorSubmission
        ? { outcome: "skipped" as const, reason: "previous_submission" }
        : autoSubmitDecision({ mode: settings.mode, score: score.score, eligible: score.eligible, allowedFunder: settings.eligibleFunderIds.includes(score.funderId), adapterReady, complete, capacity, minScore: settings.minMatchScore })
      if (existing?.outcome === "pending" && decision.outcome !== "submit" && !priorSubmission) return null
      const id = existing?.id ?? newId()
      await db.prepare(`INSERT INTO mca_auto_submit_decisions (id,workspace_id,deal_id,deal_version,completeness_version,funder_id,score,outcome,reason,created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT (workspace_id,deal_id,funder_id) DO UPDATE SET
        deal_version=excluded.deal_version,completeness_version=excluded.completeness_version,score=excluded.score,
        outcome=excluded.outcome,reason=excluded.reason`)
        .run(id, actor.workspaceId, deal.id, deal.version, expectedVersion, score.funderId, score.score, decision.outcome === "submit" ? "pending" : decision.outcome, decision.reason, nowIso())
      return { id, decision, retryCount: existing?.retry_count ?? 0 }
    })
    if (!claimed) continue
    const { id, decision, retryCount } = claimed
    let outcome: "scored" | "skipped" | "submit" | "failed" = decision.outcome
    let reason = decision.reason
    let submissionJobId: string | null = null
    if (decision.outcome === "submit") {
      const confirmationKey = `auto:${id}:${retryCount}`
      try {
        // A worker can stop after the queue commits but before this decision is
        // updated. Reconcile that durable job before asking the queue again.
        const prior = await findJobByConfirmation(actor.workspaceId, confirmationKey, score.funderId)
        const job = prior
          ? { jobId: prior.id, state: prior.state, reason: prior.reason }
          : (await queueSubmissions({ actor, dealId: deal.id, funderIds: [score.funderId], confirmationKey, autoSubmitDecisionId: id, expectedDealVersion, expectedAutoApiRoute: route })).jobs[0]
        const submitted = Boolean(job && ["queued", "sending", "sent", "pending_portal", "declined", "funded"].includes(job.state))
        const persisted = submitted ? undefined : await findJobByConfirmation(actor.workspaceId, confirmationKey, score.funderId)
        submissionJobId = submitted ? job?.jobId ?? null : persisted?.id ?? null
        outcome = submitted ? "submit" : "failed"
        reason = job?.reason ?? job?.state ?? "submission_unavailable"
        // An attempted delivery can have an uncertain outcome. Require a human
        // retry rather than issuing a second automatic confirmation key.
        if (job?.state === "failed" && persisted) {
          outcome = "skipped"
          reason = "manual_retry_required"
        } else if (job?.state === "skipped" && persisted) {
          outcome = "skipped"
          reason = job.reason ?? "automatic_delivery_cancelled"
        }
      } catch (error) {
        outcome = "failed"
        reason = error instanceof AppError ? error.code : "submission_unavailable"
        const job = await findJobByConfirmation(actor.workspaceId, confirmationKey, score.funderId)
        if (job) {
          submissionJobId = job.id
          if (["queued", "sending", "sent", "pending_portal", "declined", "funded"].includes(job.state)) outcome = "submit"
          else if (job.state === "failed") { outcome = "skipped"; reason = "manual_retry_required" }
          else if (job.state === "skipped") { outcome = "skipped"; reason = job.reason ?? "automatic_delivery_cancelled" }
        }
      }
      await getDatabase().prepare("UPDATE mca_auto_submit_decisions SET outcome=?,reason=?,submission_job_id=?,retry_count=retry_count+? WHERE workspace_id=? AND id=?")
        .run(outcome, reason, submissionJobId, outcome === "failed" ? 1 : 0, actor.workspaceId, id)
    }
    await recordAuditEvent({ context: actor, action: "auto_submit.decision", resourceType: "deal", resourceId: deal.id, metadata: { funderId: score.funderId, score: score.score, outcome, reason, submissionJobId }, correlationId: actor.correlationId })
  }
  return { decisions: scored.snapshot.scores.length }
}

export async function listAutoSubmitDecisions(actor: DealActor, dealId: string) {
  if (!autoSubmitEnabled()) return []
  await getDealForDocument(actor, dealId)
  return getDatabase().prepare<{ funder_id: string; score: number; outcome: string; reason: string; submission_job_id: string | null; created_at: string }>(
    "SELECT funder_id,score,outcome,reason,submission_job_id,created_at FROM mca_auto_submit_decisions WHERE workspace_id=? AND deal_id=? ORDER BY created_at DESC",
  ).all(actor.workspaceId, dealId)
}
