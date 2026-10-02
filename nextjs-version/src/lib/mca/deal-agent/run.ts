import "server-only"

import { createHash } from "node:crypto"
import { getDatabase, newId, nowIso, recordAuditEvent, withTransaction } from "../db"
import type { DealActor, DealRecord, DealStatus } from "../deals/schema"
import { getDealForDocument } from "../deals/service"
import { isDocumentReady } from "../documents/contracts"
import { listDocumentRecords } from "../documents/repository"
import { documentScanActor } from "../documents/scan-job"
import { AppError } from "../errors"
import { enqueueBackgroundJob, type BackgroundJob } from "../jobs/queue"
import { getSubmissionSelection, type SubmissionSelection } from "../submissions/queue"
import { readAnalysisSettings } from "../underwriting/analysis-repository"
import { checkCompleteness } from "../underwriting/completeness"
import type { CompletenessResult } from "../underwriting/contracts"
import { getLenderFit } from "../underwriting/lender-fit"
import type { LenderFitResponse } from "../underwriting/lender-fit-contracts"
import { scoreDeal } from "../underwriting/scoring"
import { statementExtractionStatus } from "../underwriting/statement-extraction"
import { analyzeDealStatements } from "../underwriting/statements"
import { getWorkspaceSettings } from "../workspaces"

const DEBOUNCE_MS = 120_000
const STALE_RUN_MS = 10 * 60_000
const ACTIVE_STATUSES: ReadonlySet<DealStatus> = new Set(["lead", "new_application", "missing_documents", "ready_to_submit", "submitted", "resubmitting"])
// A prior job in any other state means this funder already has (or had) the package.
const RETRYABLE_JOB_STATES = new Set(["failed", "preflight_failed", "skipped"])
const STIPULATIONS: Record<string, { category: string; label: string }> = {
  missing_application: { category: "application", label: "Signed merchant application" },
  missing_driver_license: { category: "driver_license", label: "Driver license (front)" },
  missing_voided_check: { category: "voided_check", label: "Voided business check" },
}

export type Proposal = { kind: "request_documents" | "submit_to_funder" | "schedule_follow_up"; targetKey: string; fingerprint: string; payload: Record<string, unknown> }
type Step = { step: string; outcome: "ok" | "skipped" | "failed"; summary: string; code?: string; at: string }

/** Global kill switch plus the company opt-in; both default off. */
export async function dealAgentEnabled(workspaceId: string): Promise<boolean> {
  if (process.env.MCA_DEAL_AGENT_ENABLED !== "true") return false
  return (await getWorkspaceSettings(workspaceId)).featureFlags.dealAgent
}

/** Debounced so multi-file uploads and the intake job settle before the run. */
export async function enqueueDealAgentRun(record: { id: string; workspaceId: string; dealId: string }): Promise<void> {
  if (!(await dealAgentEnabled(record.workspaceId))) return
  await enqueueBackgroundJob({
    actor: documentScanActor(record),
    kind: "deal_agent",
    resourceId: record.dealId,
    idempotencyKey: `deal-agent:${record.id}`,
    payload: { documentId: record.id },
    availableAt: new Date(Date.now() + DEBOUNCE_MS).toISOString(),
  })
}

export function documentProposals(completeness: CompletenessResult, deal: Pick<DealRecord, "displayId">): Proposal[] {
  if (completeness.ready) return []
  const items: Array<{ category: string; label: string; code: string; period?: string }> = []
  const otherFindings: string[] = []
  // Unextracted statements leave every month "missing"; asking the merchant again would request files already on hand.
  const periodsUnknown = completeness.findings.some(finding => finding.code === "unknown_statement_period")
  for (const finding of completeness.findings) {
    const known = STIPULATIONS[finding.code]
    if (known) items.push({ ...known, code: finding.code })
    else if (finding.code.startsWith("missing_statement_") && finding.period && !periodsUnknown) items.push({ category: "statement", label: `Business bank statement for ${finding.period}`, code: finding.code, period: finding.period })
    else otherFindings.push(finding.message)
  }
  if (!items.length) return []
  const fingerprint = `c${completeness.version}`
  return [
    { kind: "request_documents", targetKey: "request_documents", fingerprint, payload: { items, otherFindings } },
    { kind: "schedule_follow_up", targetKey: "follow_up", fingerprint, payload: { title: `Follow up: missing documents for ${deal.displayId}`, dueInDays: 2 } },
  ]
}

export function submissionProposals(fit: LenderFitResponse, topN: number, selection: Pick<SubmissionSelection, "funders" | "jobs">): { proposals: Proposal[]; skipped: Array<{ funderId: string; reason: string }> } {
  const proposals: Proposal[] = []
  const skipped: Array<{ funderId: string; reason: string }> = []
  if (!fit.snapshotId) return { proposals, skipped }
  for (const lender of fit.lenders) {
    if (lender.status !== "matched" || lender.rank === null || lender.score === null || lender.rank > topN) continue
    if (selection.jobs.some(job => job.funderId === lender.funderId && !RETRYABLE_JOB_STATES.has(job.state))) {
      skipped.push({ funderId: lender.funderId, reason: "already_submitted" })
      continue
    }
    const errors = selection.funders.find(funder => funder.id === lender.funderId)?.preflightErrors ?? [{ field: "funderId", message: "Funder is unavailable for submission." }]
    if (errors.length) {
      skipped.push({ funderId: lender.funderId, reason: `preflight: ${errors.map(error => error.message).join("; ")}` })
      continue
    }
    proposals.push({ kind: "submit_to_funder", targetKey: `submit:${lender.funderId}`, fingerprint: `s${fit.snapshotId}`, payload: {
      funderId: lender.funderId, name: lender.name, rank: lender.rank, score: lender.score,
      reasons: lender.reasons.filter(reason => reason.result === "pass").map(reason => reason.detail),
      missingData: lender.missingData, disclaimer: fit.disclaimer,
    } })
  }
  return { proposals, skipped }
}

/** Serialized per deal. Never touches dismissed/approved rows, so a decision sticks until inputs change. */
export async function upsertProposals(actor: DealActor, dealId: string, runId: string, proposals: Proposal[]): Promise<{ inserted: number; superseded: number; unchanged: number } | { skipped: "newer_run" }> {
  return withTransaction(async (database) => {
    await database.prepare("SELECT pg_advisory_xact_lock(hashtext(?))").get(`deal-agent:${actor.workspaceId}:${dealId}`)
    const newer = await database.prepare(`SELECT 1 FROM mca_deal_agent_runs newer JOIN mca_deal_agent_runs mine ON mine.workspace_id=newer.workspace_id AND mine.id=?
      WHERE newer.workspace_id=? AND newer.deal_id=? AND newer.state<>'failed' AND newer.created_at>mine.created_at`).get(runId, actor.workspaceId, dealId)
    if (newer) return { skipped: "newer_run" as const }
    const now = nowIso()
    let inserted = 0, superseded = 0, unchanged = 0
    for (const proposal of proposals) {
      superseded += (await database.prepare(`UPDATE mca_deal_agent_actions SET status='superseded',updated_at=?
        WHERE workspace_id=? AND deal_id=? AND target_key=? AND fingerprint<>? AND status='pending'`).run(now, actor.workspaceId, dealId, proposal.targetKey, proposal.fingerprint)).changes
      // An executing approval for the same target keeps its slot; the next run proposes again.
      // A superseded twin comes back; dismissed/approved ones stay decided.
      const added = await database.prepare(`INSERT INTO mca_deal_agent_actions (id,workspace_id,deal_id,run_id,kind,target_key,fingerprint,payload_json,status,created_at,updated_at)
        SELECT ?,?,?,?,?,?,?,?,'pending',?,? WHERE NOT EXISTS (SELECT 1 FROM mca_deal_agent_actions WHERE workspace_id=? AND deal_id=? AND target_key=? AND status='executing')
        ON CONFLICT (workspace_id,deal_id,target_key,fingerprint) DO UPDATE SET status='pending',run_id=EXCLUDED.run_id,payload_json=EXCLUDED.payload_json,
          preview_id=NULL,error_code=NULL,updated_at=EXCLUDED.updated_at WHERE mca_deal_agent_actions.status='superseded'`)
        .run(newId(), actor.workspaceId, dealId, runId, proposal.kind, proposal.targetKey, proposal.fingerprint, JSON.stringify(proposal.payload), now, now, actor.workspaceId, dealId, proposal.targetKey)
      if (added.changes) inserted += 1
      else unchanged += 1
    }
    const keys = proposals.map(proposal => proposal.targetKey)
    superseded += (await database.prepare(`UPDATE mca_deal_agent_actions SET status='superseded',updated_at=?
      WHERE workspace_id=? AND deal_id=? AND status='pending'${keys.length ? ` AND target_key NOT IN (${keys.map(() => "?").join(",")})` : ""}`).run(now, actor.workspaceId, dealId, ...keys)).changes
    return { inserted, superseded, unchanged }
  })
}

function inputKey(documents: Array<{ category: string; checksum: string }>): string {
  return createHash("sha256").update([...new Set(documents.map(document => `${document.category}:${document.checksum}`))].sort().join("\n")).digest("hex")
}

export async function processDealAgentJob(job: BackgroundJob, actor: DealActor): Promise<{ runId?: string; skipped?: "disabled" | "deal_stage" | "unchanged" }> {
  if (!(await dealAgentEnabled(actor.workspaceId))) return { skipped: "disabled" }
  const deal = await getDealForDocument(actor, job.resource_id)
  if (!ACTIVE_STATUSES.has(deal.status)) return { skipped: "deal_stage" }
  const documents = (await listDocumentRecords(actor.workspaceId, deal.id)).filter(document => isDocumentReady(document.processingState))
  const now = nowIso()
  const run = await getDatabase().prepare<{ id: string }>(`INSERT INTO mca_deal_agent_runs (id,workspace_id,deal_id,input_key,trigger_document_id,state,created_at,updated_at)
    VALUES (?,?,?,?,?,'running',?,?) ON CONFLICT (workspace_id,deal_id,input_key) DO UPDATE SET state='running',steps_json='[]',error_code=NULL,updated_at=EXCLUDED.updated_at
    WHERE mca_deal_agent_runs.state='failed' OR (mca_deal_agent_runs.state='running' AND mca_deal_agent_runs.updated_at<?) RETURNING id`)
    .get(newId(), actor.workspaceId, deal.id, inputKey(documents), JSON.parse(job.payload_json).documentId ?? null, now, now, new Date(Date.now() - STALE_RUN_MS).toISOString())
  if (!run) return { skipped: "unchanged" }

  const steps: Step[] = []
  const record = async (step: Omit<Step, "at">) => {
    steps.push({ ...step, at: nowIso() })
    await getDatabase().prepare("UPDATE mca_deal_agent_runs SET steps_json=?,updated_at=? WHERE workspace_id=? AND id=?").run(JSON.stringify(steps), nowIso(), actor.workspaceId, run.id)
  }
  try {
    if (!statementExtractionStatus().configured) await record({ step: "statements", outcome: "skipped", code: "provider_unavailable", summary: "Statement extraction is not configured." })
    else {
      try {
        const statements = await analyzeDealStatements(actor, deal.id)
        await record({ step: "statements", outcome: "ok", summary: `${statements.months.length} statement month(s) on file.` })
      } catch (error) {
        if (!(error instanceof AppError)) throw error
        await record({ step: "statements", outcome: "failed", code: error.code, summary: error.message })
      }
    }

    const completeness = await checkCompleteness(actor, deal.id, { skipAutoSubmit: true })
    await record({ step: "completeness", outcome: "ok", summary: completeness.ready ? `Complete (version ${completeness.version}).` : `${completeness.findings.length} open finding(s) (version ${completeness.version}).` })

    let submissions: ReturnType<typeof submissionProposals> = { proposals: [], skipped: [] }
    let snapshotId: string | null = null
    const { topN } = await readAnalysisSettings(actor.workspaceId)
    // ponytail: fit only matters once the file is complete; submissions are never proposed before that.
    if (!completeness.ready) await record({ step: "lender_fit", outcome: "skipped", code: "deal_incomplete", summary: "Lender fit waits for a complete file." })
    else {
      try {
        await scoreDeal(actor, deal.id, { mode: "analyze_only", topN })
        const fit = await getLenderFit(actor, deal.id)
        snapshotId = fit.snapshotId
        if (!snapshotId) throw new AppError(409, "lender_fit_unscored", "No current lender-fit snapshot.")
        submissions = submissionProposals(fit, topN, await getSubmissionSelection(actor, deal.id))
        const matched = fit.lenders.filter(lender => lender.status === "matched").length
        await record({ step: "lender_fit", outcome: "ok", summary: `${matched} matched lender(s); considering the top ${topN}.` })
      } catch (error) {
        if (!(error instanceof AppError)) throw error
        await record({ step: "lender_fit", outcome: "skipped", code: error.code, summary: error.message })
      }
    }

    const proposals = [...documentProposals(completeness, deal), ...submissions.proposals]
    const skippedSummary = submissions.skipped.map(item => ` Skipped ${item.funderId}: ${item.reason}.`).join("")
    await record({ step: "proposals", outcome: "ok", summary: (proposals.length ? `Proposed ${proposals.map(proposal => proposal.targetKey).join(", ")}.` : "Nothing to propose.") + skippedSummary })

    const written = await upsertProposals(actor, deal.id, run.id, proposals)
    await record("skipped" in written
      ? { step: "write", outcome: "skipped", code: "newer_run", summary: "A newer run already updated this deal." }
      : { step: "write", outcome: "ok", summary: `${written.inserted} new, ${written.unchanged} unchanged, ${written.superseded} superseded.` })

    const done = nowIso()
    await getDatabase().prepare("UPDATE mca_deal_agent_runs SET state='completed',inputs_json=?,completed_at=?,updated_at=? WHERE workspace_id=? AND id=?")
      .run(JSON.stringify({ documentCount: documents.length, completenessVersion: completeness.version, snapshotId, topN }), done, done, actor.workspaceId, run.id)
    await recordAuditEvent({ context: actor, action: "deal_agent.run_completed", resourceType: "deal_agent_run", resourceId: run.id, metadata: { dealId: deal.id, proposals: proposals.length }, correlationId: actor.correlationId })
    return { runId: run.id }
  } catch (error) {
    await getDatabase().prepare("UPDATE mca_deal_agent_runs SET state='failed',error_code=?,updated_at=? WHERE workspace_id=? AND id=?")
      .run(error instanceof AppError ? error.code : "processing_failed", nowIso(), actor.workspaceId, run.id)
    throw error
  }
}
