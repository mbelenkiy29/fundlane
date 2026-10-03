import "server-only"

import { providerReadinessView } from "../submissions/provider-readiness"
import { createHash } from "node:crypto"
import { decryptSensitive, encryptSensitive } from "../crypto"
import { getDatabase, newId, nowIso, withTransaction } from "../db"
import type { DealActor } from "../deals/schema"
import { getDealForDocument } from "../deals/service"
import { listSubmissionDocuments } from "../documents/service"
import { AppError } from "../errors"
import { getFunder } from "../funders/directory"
import { checkCompleteness } from "../underwriting/completeness"
import { findLatestAnalysisRun } from "../underwriting/analysis-repository"
import { confirmAnalysisReview } from "../underwriting/review-mail"
import { findIntake, getIntegration } from "./repository"
import { intakeProgress } from "./processing"
import { autoSelectableFunderIds, getDealScores } from "../underwriting/scoring"
import { evaluateUnderwritingSendGates, underwritingSendGateError } from "../underwriting/send-gates"
import type { ApprovedSubmissionPackage, QueuedJobSummary } from "../submissions/contracts"
import { prepareApprovedSubmissionEmail, displayFrom } from "../submissions/email-templates"
import { prepareOutgoingPackage } from "../submissions/package"
import { preflightDestination, probeSubmissionSender } from "../submissions/preflight"
import { queueSubmissions } from "../submissions/queue"
import { listJobsForDeal } from "../submissions/repository"
import { toQueuedSummary } from "../submissions/jobs"
import { backgroundJobsEnabled } from "../jobs/queue"
import { resolveWebhookTarget } from "../submissions/webhook"
import { processJobDelivery } from "../submissions/outbox"
import type { ApplicationSubmissionPreview } from "./review-contracts"

function fingerprint(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex")
}

function refreshRequired(): never {
  throw new AppError(409, "submission_preview_stale", "The application or submission package changed. Prepare a new preview.")
}

async function visibleDeal(actor: DealActor, intakeId: string) {
  const intake = await getDatabase().prepare<{ deal_id: string | null }>("SELECT deal_id FROM intake_events WHERE workspace_id = ? AND id = ?").get(actor.workspaceId, intakeId)
  if (!intake?.deal_id) throw new AppError(404, "intake_not_found", "The requested application was not found.")
  return getDealForDocument(actor, intake.deal_id)
}

function selectedIds(value: unknown): string[] {
  if (!Array.isArray(value) || !value.length || value.length > 200 || value.some((id) => typeof id !== "string" || !id.trim() || id.length > 128)) {
    throw new AppError(422, "validation_failed", "Select between one and 200 eligible lenders.")
  }
  return [...new Set(value.map((id: string) => id.trim()))].sort()
}

async function currentSnapshot(actor: DealActor, intakeId: string, funderIds: string[]) {
  const deal = await visibleDeal(actor, intakeId)
  const intake = await findIntake(actor.workspaceId, intakeId)
  const integration = intake?.integrationId ? await getIntegration(actor.workspaceId, intake.integrationId) : undefined
  if (intake?.integrationId && !integration?.enabled) throw new AppError(409, "integration_disabled", "This application connection is disabled.")
  const progress = await intakeProgress(actor.workspaceId, intakeId)
  if (progress?.state !== "ready_for_review") throw new AppError(409, "application_not_ready", "Wait for this application to finish processing before preparing a submission.")
  await checkCompleteness(actor, deal.id)
  const gates = await evaluateUnderwritingSendGates(actor, deal.id)
  if (!gates.ok) throw underwritingSendGateError(gates)
  const scores = await getDealScores(actor, deal.id)
  const run = await findLatestAnalysisRun(actor.workspaceId, deal.id)
  if (!scores.snapshot || scores.stale || !run || run.snapshotId !== scores.snapshot.id) refreshRequired()
  const selectable = new Set(autoSelectableFunderIds(scores.snapshot.scores))
  for (const id of funderIds) {
    if (!selectable.has(id)) {
      throw new AppError(422, "funder_not_eligible", "Select only eligible lenders from the current analysis.")
    }
  }
  const documents = (await listSubmissionDocuments(actor, deal.id)).sort((a, b) => a.id.localeCompare(b.id))
  const sender = await probeSubmissionSender(actor)
  const destinations = []
  for (const id of funderIds) {
    const funder = await getFunder(actor, id)
    const preflight = preflightDestination({ funder, documents, sender })
    if (preflight.errors.length) throw new AppError(422, "submission_preflight_failed", preflight.errors.map((error) => error.message).join(" "))
    const packaged = await prepareOutgoingPackage({ originals: preflight.originals, funderId: id })
    const approved: ApprovedSubmissionPackage = { filenames: Object.fromEntries(documents.map((document) => [document.id, document.displayFilename])), route: preflight.route, originalVersions: documents.map((document) => ({ documentId: document.id, checksum: document.checksum, category: document.category })), documents: packaged.documents }
    if (preflight.route.kind === "email") approved.email = await prepareApprovedSubmissionEmail(actor, deal, funder, preflight.route, documents, packaged.documents)
    destinations.push({ funderId: id, name: preflight.displayName, route: preflight.route, approved })
  }
  const configuration = await Promise.all([
    getDatabase().prepare("SELECT * FROM mca_stamp_settings WHERE workspace_id = ?").all(actor.workspaceId),
    getDatabase().prepare("SELECT * FROM mca_watermark_settings WHERE workspace_id = ?").all(actor.workspaceId),
    getDatabase().prepare("SELECT * FROM mca_compress_settings WHERE workspace_id = ?").all(actor.workspaceId),
    getDatabase().prepare<{funder_id: string | null}>("SELECT * FROM mca_submission_templates WHERE workspace_id = ? ORDER BY id").all(actor.workspaceId).then((rows) => rows.filter((row) => !row.funder_id || funderIds.includes(row.funder_id))),
    getDatabase().prepare("SELECT id, updated_at FROM mca_email_senders WHERE workspace_id = ? ORDER BY id").all(actor.workspaceId),
  ])
  return { configurationFingerprint: fingerprint(configuration), dealId: deal.id, dealVersion: deal.version, analysisRunId: run.id, analysis: scores.snapshot, documents: documents.map(({ id, checksum, category, displayFilename, byteLength }) => ({ id, checksum, category, displayFilename, byteLength })), destinations }
}

type Snapshot = Awaited<ReturnType<typeof currentSnapshot>>

function previewView(id: string, expiresAt: string, snapshot: Snapshot): ApplicationSubmissionPreview {
  return { id, expiresAt, destinations: snapshot.destinations.map(({ funderId, name, route, approved }) => ({
    funderId, name, method: route.kind, ...providerReadinessView(route),
    // Webhook routes can contain credentials. Only show the destination's host/path.
    destination: route.kind === "custom_webhook" ? safeWebhookDestination(route.destination) : route.destination,
    documents: approved.documents.map((document) => ({ id: document.documentId, filename: snapshot.documents.find((original) => original.id === document.originalDocumentId)?.displayFilename ?? document.documentId })),
    email: approved.email ? { from: displayFrom(approved.email), to: approved.email.to, cc: approved.email.cc, replyTo: approved.email.replyTo, subject: approved.email.subject, body: approved.email.body } : undefined,
    errors: [],
  })) }
}

function safeWebhookDestination(destination: string): string {
  const target = resolveWebhookTarget(destination)
  return target.ok ? target.target.url : "Webhook"
}

export async function prepareApplicationSubmission(actor: DealActor, intakeId: string, funderIds: unknown): Promise<ApplicationSubmissionPreview> {
  const snapshot = await currentSnapshot(actor, intakeId, selectedIds(funderIds))
  const id = newId()
  const createdAt = nowIso()
  const expiresAt = new Date(Date.now() + 30 * 60_000).toISOString()
  await getDatabase().prepare(`INSERT INTO intake_submission_previews
    (id, workspace_id, intake_id, deal_id, created_by_user_id, snapshot_cipher, fingerprint, created_at, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, actor.workspaceId, intakeId, snapshot.dealId, actor.userId, encryptSensitive(JSON.stringify(snapshot), actor.workspaceId), fingerprint(snapshot), createdAt, expiresAt)
  return previewView(id, expiresAt, snapshot)
}

export async function sendApplicationSubmission(actor: DealActor, intakeId: string, previewId: unknown): Promise<{ ok: true; jobs: QueuedJobSummary[] }> {
  if (actor.source !== "user" || !actor.userId) throw new AppError(403, "broker_review_required", "A broker must review and approve this submission.")
  if (typeof previewId !== "string" || !previewId.trim() || previewId.length > 128) throw new AppError(422, "validation_failed", "Prepare a submission preview first.")
  const deal = await visibleDeal(actor, intakeId)
  await withTransaction(async (db) => {
    await db.prepare("SELECT pg_advisory_xact_lock(hashtextextended(?, 0))").get(`application-send:${actor.workspaceId}:${deal.id}`)
    const row = await db.prepare<{ snapshot_cipher: string; fingerprint: string; expires_at: string; confirmed_at: string | null }>(`SELECT snapshot_cipher, fingerprint, expires_at, confirmed_at FROM intake_submission_previews
      WHERE id = ? AND workspace_id = ? AND intake_id = ? AND deal_id = ? FOR UPDATE`).get(previewId, actor.workspaceId, intakeId, deal.id)
    if (!row) throw new AppError(404, "preview_not_found", "The requested submission preview was not found.")
    if (row.confirmed_at) return
    if (Date.parse(row.expires_at) <= Date.now()) refreshRequired()
    const approved = JSON.parse(decryptSensitive(row.snapshot_cipher, actor.workspaceId)) as Snapshot
    const ids = approved.destinations.map((destination) => destination.funderId)
    const current = await currentSnapshot(actor, intakeId, ids)
    if (fingerprint(current) !== row.fingerprint || fingerprint(approved) !== row.fingerprint) refreshRequired()
    await confirmAnalysisReview(actor, { dealId: deal.id, selectedFunderIds: ids })
    await queueSubmissions({ actor, dealId: deal.id, funderIds: ids, confirmationKey: previewId, analysisRunId: approved.analysisRunId, approvedPackages: Object.fromEntries(approved.destinations.map((destination) => [destination.funderId, destination.approved])), deferDelivery: true })
    await db.prepare("UPDATE intake_submission_previews SET confirmed_at = ? WHERE id = ? AND workspace_id = ?").run(nowIso(), previewId, actor.workspaceId)
  })
  const jobs = (await listJobsForDeal(actor.workspaceId, deal.id)).filter((job) => job.confirmationKey === previewId)
  // Provider calls happen after commit. The unique attempt reservation makes retries safe.
  if (!backgroundJobsEnabled()) {
    for (const job of jobs) await processJobDelivery(job)
  }
  return { ok: true, jobs: (await listJobsForDeal(actor.workspaceId, deal.id)).filter((job) => job.confirmationKey === previewId).map(toQueuedSummary) }
}
