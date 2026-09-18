import "server-only"

import { isDocumentReady } from "../documents/contracts"

import { createHash } from "node:crypto"
import { getDatabase, nowIso, parseJson, recordAuditEvent, withImmediateTransaction } from "../db"
import { actorForDeals, getDeal } from "../deals/service"
import type { DealActor } from "../deals/schema"
import { listDocuments, retryDocumentScan } from "../documents/service"
import { listFunders } from "../funders/directory"
import { AppError } from "../errors"
import { enqueueBackgroundJob, heartbeatBackgroundJob, type BackgroundJob } from "../jobs/queue"
import { analyzeDealStatements, getUnderwritingAggregate } from "../underwriting/statements"
import { checkCompleteness, getRequiredStatementMonths } from "../underwriting/completeness"
import { runAnalysis, getAnalysisSettings } from "../underwriting/analysis"
import { getDealScores } from "../underwriting/scoring"
import { POLICY_VERSION } from "../underwriting/policy"
import { findIntake, getIntegration, listAttachmentJobs, updateAttachmentJob } from "./repository"
import { processAttachmentJob } from "./service"
import { initialIntakeProgress, type IntakeProgress } from "./processing-contracts"

interface Checkpoint {
  intake_id: string; workspace_id: string; fingerprint: string | null; generation: number
  job_id: string | null; progress_json: string; checked_at: string; updated_at: string
}
const supported = new Set(["jotform", "highlevel", "zoho", "custom"])

/** Integration authority is re-resolved for every stage; it is never a browser session or fabricated API key. */
async function authority(workspaceId: string, intakeId: string, integrationId?: string) {
  const intake = await findIntake(workspaceId, intakeId)
  if (!intake?.integrationId || !intake.dealId || (integrationId && integrationId !== intake.integrationId)) {
    throw new AppError(404, "intake_not_found", "This application is not bound to the requested connection.")
  }
  const integration = await getIntegration(workspaceId, intake.integrationId)
  if (!integration?.enabled || !integration.automaticProcessing || integration.approvalState !== "approved" || !supported.has(integration.provider)) {
    throw new AppError(409, "intake_automation_paused", "Automatic processing is paused. Ask an administrator to enable this connection.")
  }
  const base = await actorForDeals({ authType: "api_key", workspaceId, userId: null, membershipId: null, role: null, scopes: [], sessionId: null })
  const actor: DealActor = { ...base, source: "system", intakeDealId: intake.dealId }
  return { actor, intake, integration }
}

async function inputs(actor: DealActor, intakeId: string) {
  const intake = (await findIntake(actor.workspaceId, intakeId))!
  const [deal, documents, aggregate, funders, months, settings, attachments, integration] = await Promise.all([
    getDeal(actor, intake.dealId!), listDocuments(actor, intake.dealId!), getUnderwritingAggregate(actor, intake.dealId!),
    listFunders(actor), getRequiredStatementMonths(actor), getAnalysisSettings(actor),
    listAttachmentJobs(actor.workspaceId, intakeId), getIntegration(actor.workspaceId, intake.integrationId!),
  ])
  return {
    dealVersion: deal.version,
    assigned: deal.assignments.some(a => actor.activeMembershipIds.includes(a.membershipId)),
    documents: documents.map(d => [d.id, d.version, d.checksum, d.category, d.displayFilename, d.processingState]).sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
    underwriting: aggregate,
    funders: funders.map(f => [f.id, f.criteriaVersion, f.profileVersion]).sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
    attachments: attachments.map(a => [a.id, a.state, a.attemptCount, a.documentId]).sort((a,b) => String(a[0]).localeCompare(String(b[0]))),
    integrationVersion: integration?.updatedAt, months, topN: settings.topN, policy: POLICY_VERSION,
    calendarMonth: nowIso().slice(0, 7),
  }
}
function hash(value: unknown) { return createHash("sha256").update(JSON.stringify(value)).digest("hex") }

async function checkpoint(workspaceId: string, intakeId: string) {
  return getDatabase().prepare<Checkpoint>("SELECT * FROM intake_processing WHERE workspace_id=? AND intake_id=?").get(workspaceId, intakeId)
}

export async function intakeProgress(workspaceId: string, intakeId: string): Promise<IntakeProgress | undefined> {
  const row = await checkpoint(workspaceId, intakeId)
  if (!row) return undefined
  const progress = parseJson<IntakeProgress>(row.progress_json, initialIntakeProgress())
  const intake = await findIntake(workspaceId, intakeId)
  const integration = intake?.integrationId ? await getIntegration(workspaceId, intake.integrationId) : undefined
  if (!integration?.enabled || !integration.automaticProcessing) return { ...progress, state: "paused", message: "Automatic processing is paused for this connection." }
  if (row.job_id) {
    const job = await getDatabase().prepare<{ state: string }>("SELECT state FROM mca_background_jobs WHERE workspace_id=? AND id=?").get(workspaceId, row.job_id)
    if (job?.state === "failed" && ["queued", "running"].includes(progress.state)) return { ...progress, state: "failed", message: "Processing stopped after its retry limit. Retry this application." }
  }
  return progress
}

/** Polling is a durable change detector, including edits made outside the intake routes. */
export async function scheduleIntakeProcessing(limit = 25): Promise<number> {
  const candidates = await getDatabase().prepare<{ id: string; workspace_id: string }>(`SELECT e.id,e.workspace_id FROM intake_events e
    JOIN deals d ON d.id=e.deal_id AND d.workspace_id=e.workspace_id
    JOIN intake_integrations i ON i.id=e.integration_id AND i.workspace_id=e.workspace_id
    LEFT JOIN intake_processing p ON p.intake_id=e.id
    WHERE i.enabled=1 AND i.automatic_processing=1 AND i.approval_state='approved'
      AND i.provider IN ('jotform','highlevel','zoho','custom') AND e.deal_id IS NOT NULL
      AND (e.created_at>=i.automatic_since OR p.intake_id IS NOT NULL)
    ORDER BY p.checked_at ASC NULLS FIRST,e.created_at,e.id LIMIT ?`).all(limit)
  let queued = 0
  for (const row of candidates) {
    try { if (await scheduleOne(row.workspace_id, row.id)) queued++ }
    catch (error) { console.error(JSON.stringify({ event: "intake_schedule_failed", intakeId: row.id, code: error instanceof AppError ? error.code : "processing_unavailable" })) }
  }
  return queued
}

async function scheduleOne(workspaceId: string, intakeId: string, force = false): Promise<boolean> {
  const { actor, integration } = await authority(workspaceId, intakeId)
  const fingerprint = hash(await inputs(actor, intakeId))
  return withImmediateTransaction(async db => {
    const now = nowIso()
    await db.prepare(`INSERT INTO intake_processing(intake_id,workspace_id,checked_at,updated_at) VALUES(?,?,?,?) ON CONFLICT(intake_id) DO NOTHING`).run(intakeId, workspaceId, now, now)
    const prior = (await db.prepare<Checkpoint>("SELECT * FROM intake_processing WHERE intake_id=? AND workspace_id=? FOR UPDATE").get(intakeId, workspaceId))!
    await db.prepare("UPDATE intake_processing SET checked_at=? WHERE intake_id=?").run(now, intakeId)
    const current = prior.job_id ? await db.prepare<{ state: string }>("SELECT state FROM mca_background_jobs WHERE id=?").get(prior.job_id) : undefined
    if (current && ["queued", "running"].includes(current.state)) return false
    if (!force && prior.fingerprint === fingerprint) return false
    const generation = Number(prior.generation) + 1
    const job = await enqueueBackgroundJob({ actor, kind: "intake_process", resourceId: intakeId,
      idempotencyKey: `${intakeId}:${generation}`, payload: { integrationId: integration.id, generation } })
    await db.prepare("UPDATE intake_processing SET fingerprint=?,generation=?,job_id=?,progress_json=?,updated_at=? WHERE intake_id=?").run(
      fingerprint, generation, job.id, JSON.stringify(initialIntakeProgress()), now, intakeId)
    return true
  })
}

export async function retryIntakeProcessing(actor: DealActor, intakeId: string): Promise<void> {
  const intake = await findIntake(actor.workspaceId, intakeId)
  if (!intake?.dealId) throw new AppError(404, "intake_not_found", "The application was not found.")
  await getDeal(actor, intake.dealId)
  await authority(actor.workspaceId, intakeId)
  const prior = await checkpoint(actor.workspaceId, intakeId)
  if (prior?.job_id) {
    const job = await getDatabase().prepare<{ state: string }>("SELECT state FROM mca_background_jobs WHERE id=?").get(prior.job_id)
    if (job && ["running", "queued"].includes(job.state)) return
  }
  for (const file of await listAttachmentJobs(actor.workspaceId, intakeId)) {
    if (["failed", "retryable"].includes(file.state)) await updateAttachmentJob(actor.workspaceId, file.id, { state: "pending" })
  }
  await scheduleOne(actor.workspaceId, intakeId, true)
  await recordAuditEvent({ context: actor, action: "intake.processing_retried", resourceType: "intake", resourceId: intakeId })
}

export async function processIntakeJob(job: BackgroundJob, attachmentOptions: Parameters<typeof processAttachmentJob>[1] = {}): Promise<{ intakeId: string }> {
  const payload = JSON.parse(job.payload_json) as { integrationId: string }
  let stage: keyof IntakeProgress["stages"] = "documents"
  const progress = initialIntakeProgress()
  let scoredSnapshotId: string | undefined
  const save = async (fingerprint?: string) => {
    await heartbeatBackgroundJob(job)
    await getDatabase().prepare(`UPDATE intake_processing SET progress_json=?,fingerprint=COALESCE(?,fingerprint),updated_at=?
      WHERE workspace_id=? AND intake_id=? AND job_id=?`).run(JSON.stringify(progress), fingerprint ?? null, nowIso(), job.workspace_id, job.resource_id, job.id)
  }
  const guard = async () => {
    await heartbeatBackgroundJob(job)
    return authority(job.workspace_id, job.resource_id, payload.integrationId)
  }
  try {
    let { actor, intake } = await guard()
    const starting = await inputs(actor, intake.intakeId)
    progress.state = "running"; progress.stages.documents.state = "running"; await save()
    for (const file of await listAttachmentJobs(actor.workspaceId, intake.intakeId)) {
      await guard()
      if (file.state !== "stored") await processAttachmentJob(file, attachmentOptions)
    }
    ;({ actor, intake } = await guard())
    let documents = await listDocuments(actor, intake.dealId!)
    for (const document of documents) {
      if (["pending_scan", "scan_failed", "pending_upload", "upload_failed"].includes(document.processingState)) { await guard(); await retryDocumentScan(actor, document.id) }
    }
    documents = await listDocuments(actor, intake.dealId!)
    const pending = (await listAttachmentJobs(actor.workspaceId, intake.intakeId)).filter(f => f.state !== "stored")
    const unreadable = documents.some(d => ["application", "api_application", "statement"].includes(d.category) && !isDocumentReady(d.processingState))
    if (pending.length || unreadable) {
      progress.state = "needs_attention"
      progress.message = pending.length ? "Some attachments could not be retrieved. Check the connection credentials and retry." : "Document uploads are incomplete or blocked. Check document status before retrying."
      progress.stages.documents = { state: "blocked", message: progress.message }
    } else {
      progress.stages.documents.state = "complete"
      stage = "underwriting"; progress.stages.underwriting.state = "running"; await save()
      await analyzeDealStatements(actor, intake.dealId!, { beforeStep: async () => { await guard() } })
      await guard()
      const completeness = await checkCompleteness(actor, intake.dealId!)
      if (!completeness.ready) {
        progress.state = "needs_attention"; progress.message = completeness.findings.map(f => f.message).join(" ")
        progress.stages.underwriting = { state: "blocked", message: progress.message }
      } else {
        progress.stages.underwriting.state = "complete"
        stage = "matches"; progress.stages.matches.state = "running"; await save()
        await guard()
        // Intake can prepare selections, but can never inherit an automatic-send or email setting.
        const result = await runAnalysis(actor, intake.dealId!, { trigger: "readiness", mode: "review_first", reviewNotificationChannel: "select_only" })
        scoredSnapshotId = result.snapshot.id
        progress.matchedCount = result.run.selectedFunderIds.length
        progress.analysisRunId = result.run.id
        progress.stages.matches.state = "complete"
        progress.state = progress.matchedCount ? "ready_for_review" : "no_matches"
        progress.message = progress.matchedCount ? "Review the analysis and select funders before submitting." : result.funders.length ? "No eligible funders matched. Review financial data and funder criteria." : "Add active funders and their criteria to prepare matches."
      }
    }
    const { actor: currentActor } = await guard()
    const final = await inputs(currentActor, intake.intakeId)
    if (!final.assigned) {
      progress.stages.deal = { state: "blocked", message: "No active rep is assigned. An administrator can assign this deal." }
      progress.state = "needs_attention"; progress.message = progress.stages.deal.message
    }
    // Only consume the document snapshot actually processed. Concurrent edits are picked up on the next tick.
    const scores = scoredSnapshotId ? await getDealScores(currentActor, intake.dealId!) : undefined
    const stable = (!scores || (!scores.stale && scores.snapshot?.id === scoredSnapshotId))
      && starting.months === final.months && starting.topN === final.topN && starting.calendarMonth === final.calendarMonth
      && starting.integrationVersion === final.integrationVersion
      && starting.dealVersion === final.dealVersion && hash(starting.funders) === hash(final.funders)
      && hash(documents.map(d => [d.id,d.version,d.checksum,d.category,d.displayFilename,d.processingState]).sort((a,b) => String(a[0]).localeCompare(String(b[0])))) === hash(final.documents)
    await save(stable ? hash(final) : hash({ invalidatedJob: job.id }))
    return { intakeId: intake.intakeId }
  } catch (error) {
    progress.state = "failed"
    // Never publish provider responses, file URLs, or sensitive document contents.
    progress.message = error instanceof AppError ? ({
      intake_automation_paused: "Automatic processing is paused. Enable the connection to continue.",
      provider_unavailable: "Statement extraction is unavailable. Ask an administrator to check the AI provider configuration and retry.",
      provider_timeout: "Statement analysis timed out. Retry processing.",
      storage_unavailable: "Private document storage is unavailable. Ask an administrator to check its configuration.",
    }[error.code] ?? "Processing could not finish. Check document processing and connection settings, then retry.") : "Processing could not finish. Retry or ask an administrator to check the worker."
    progress.stages[stage] = { state: "failed", message: progress.message }
    await save().catch(() => undefined)
    throw error
  }
}
