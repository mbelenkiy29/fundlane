import "server-only"

import { getDatabase, parseJson } from "../db"
import { findFunderById, toFunderRecord } from "../funders/directory-repository"
import { evaluateUnderwritingSendGates } from "../underwriting/send-gates"
import { adapterReadiness } from "./adapters/registry"
import { resolveAdapterEnvironment, resolveAdapterSecrets } from "./adapters/credentials"
import type { SubmissionJob } from "./contracts"
import { submissionDeliveryActor } from "./delivery-job"

/** Check durable automatic intent again at the provider boundary. Manual jobs are unaffected. */
export async function autoDeliveryBlockReason(job: SubmissionJob): Promise<string | undefined> {
  if (!job.autoSubmitDecisionId) return undefined
  if (process.env.MCA_AUTO_SUBMIT_ENABLED !== "true") return "Auto-submit was disabled before delivery."
  const settings = await getDatabase().prepare<{ mode: string; eligible_funder_ids: string; min_match_score: number; max_funders_per_deal: number }>(
    "SELECT mode,eligible_funder_ids,min_match_score,max_funders_per_deal FROM mca_auto_submit_settings WHERE workspace_id=?",
  ).get(job.workspaceId)
  if (settings?.mode !== "auto_submit" || !parseJson<string[]>(settings.eligible_funder_ids, []).includes(job.funderId)) {
    return "This workspace no longer allows automatic delivery to the funder."
  }
  const decision = await getDatabase().prepare<{ outcome: string; score: number; deal_version: number; completeness_version: number }>(
    "SELECT outcome,score,deal_version,completeness_version FROM mca_auto_submit_decisions WHERE workspace_id=? AND id=? AND deal_id=? AND funder_id=?",
  ).get(job.workspaceId, job.autoSubmitDecisionId, job.dealId, job.funderId)
  if (!decision || !["pending", "submit"].includes(decision.outcome)) return "Automatic submission is no longer approved."
  const reserved = await getDatabase().prepare<{ n: number }>(
    "SELECT count(*)::integer AS n FROM mca_auto_submit_decisions WHERE workspace_id=? AND deal_id=? AND outcome IN ('pending','submit')",
  ).get(job.workspaceId, job.dealId)
  if (decision.score < settings.min_match_score || (reserved?.n ?? 0) > settings.max_funders_per_deal) {
    return "The workspace's automatic match threshold or funder limit changed before delivery."
  }
  const deal = await getDatabase().prepare<{ version: number }>("SELECT version FROM deals WHERE workspace_id=? AND id=?").get(job.workspaceId, job.dealId)
  const completeness = await getDatabase().prepare<{ version: number; ready: boolean }>(
    "SELECT version,ready FROM mca_completeness_results WHERE workspace_id=? AND deal_id=? ORDER BY version DESC LIMIT 1",
  ).get(job.workspaceId, job.dealId)
  if (deal?.version !== job.dealVersion || decision.deal_version !== job.dealVersion
    || !completeness?.ready || (decision.completeness_version !== 0 && completeness.version !== decision.completeness_version)) {
    return "The deal changed or is no longer ready for automatic delivery."
  }
  if (!(await evaluateUnderwritingSendGates(submissionDeliveryActor(job), job.dealId)).ok) {
    return "Underwriting send requirements changed before automatic delivery."
  }
  const stored = await findFunderById(job.workspaceId, job.funderId)
  const funder = stored ? toFunderRecord(stored) : undefined
  const activeRoute = funder?.routes.find(route => route.active)
  const environment = resolveAdapterEnvironment()
  const readiness = adapterReadiness(job.route.destination)
  const environmentReady = (readiness === "live" && environment === "production" && !funder?.sandbox)
    || (readiness === "sandbox" && environment === "development" && Boolean(funder?.sandbox))
  if (!funder?.active || job.routeKind !== "api" || activeRoute?.kind !== "api"
    || JSON.stringify(activeRoute) !== JSON.stringify(job.route) || !environmentReady) {
    return "The funder API route is no longer ready for automatic delivery."
  }
  const credential = await resolveAdapterSecrets({ workspaceId: job.workspaceId, funderId: job.funderId, environment, adapterSlug: job.route.destination })
  if (!credential?.capabilities.submit) return "The funder API credential is no longer ready for automatic delivery."
  return undefined
}

export async function recordAutoDeliveryCancellation(job: SubmissionJob, reason: string): Promise<void> {
  if (!job.autoSubmitDecisionId) return
  await getDatabase().prepare(`UPDATE mca_auto_submit_decisions SET outcome='skipped',reason=?
    WHERE workspace_id=? AND id=? AND deal_id=? AND funder_id=? AND outcome IN ('pending','submit')`)
    .run(reason, job.workspaceId, job.autoSubmitDecisionId, job.dealId, job.funderId)
}
