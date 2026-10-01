import "server-only"

import { providerReadinessView } from "./provider-readiness"
import { createHash } from "node:crypto"
import { decryptSensitive, encryptSensitive } from "../crypto"
import { getDatabase, newId, nowIso, recordAuditEvent, withTransaction } from "../db"
import type { DealActor } from "../deals/schema"
import { getDealForDocument } from "../deals/service"
import { listSubmissionDocuments } from "../documents/service"
import { AppError } from "../errors"
import { backgroundJobsEnabled } from "../jobs/queue"
import type { ApprovedSubmissionPackage, QueueSubmissionsResult } from "./contracts"
import { prepareApprovedSubmissionEmail } from "./email-templates"
import { eligibleAtFromReason } from "./duplicate-rules"
import { toQueuedSummary } from "./jobs"
import { processJobDelivery } from "./outbox"
import { prepareOutgoingPackage } from "./package"
import { preflightDestination, probeSubmissionSender, loadFunderForDestination } from "./preflight"
import { assertSubmissionSendGates, queueSubmissions } from "./queue"
import { resolveWebhookTarget } from "./webhook"
import { listJobsForDeal } from "./repository"

function hash(value: unknown) { return createHash("sha256").update(JSON.stringify(value)).digest("hex") }
function assertBroker(actor: DealActor) {
  if (actor.source !== "user" || !actor.userId || !actor.role) throw new AppError(403, "broker_review_required", "A broker must review and approve this submission.")
}
function stale(): never { throw new AppError(409, "submission_preview_stale", "The deal or submission package changed. Prepare a new preview.") }
function ids(value: unknown): string[] {
  if (!Array.isArray(value) || !value.length || value.length > 200 || value.some(id => typeof id !== "string" || !id.trim() || id.length > 128)) throw new AppError(422, "validation_failed", "Select between one and 200 funders.", { funderIds: ["Select between one and 200 funders."] })
  return [...new Set(value.map((id: string) => id.trim()))].sort()
}
async function snapshotFor(actor: DealActor, dealId: string, funderIds: string[]) {
  const deal = await getDealForDocument(actor, dealId)
  await assertSubmissionSendGates(actor, dealId)
  const documents = (await listSubmissionDocuments(actor, dealId)).sort((a, b) => a.id.localeCompare(b.id))
  const sender = await probeSubmissionSender(actor)
  const destinations: Array<{ funderId: string; name: string; route: ApprovedSubmissionPackage["route"]; errors: string[]; approved?: ApprovedSubmissionPackage }> = []
  for (const funderId of funderIds) {
    const funder = await loadFunderForDestination(actor, funderId)
    const preflight = preflightDestination({ funder, documents, sender })
    if (preflight.errors.length) {
      destinations.push({ funderId, name: preflight.displayName, route: preflight.route, errors: preflight.errors.map(error => error.message) })
      continue
    }
    const packaged = await prepareOutgoingPackage({ originals: preflight.originals, funderId })
    const approved: ApprovedSubmissionPackage = { route: preflight.route, originalVersions: documents.map(d => ({ documentId: d.id, checksum: d.checksum, category: d.category })), filenames: Object.fromEntries(documents.map(d => [d.id, d.displayFilename])), documents: packaged.documents }
    if (preflight.route.kind === "email") approved.email = await prepareApprovedSubmissionEmail(actor, deal, funder!, preflight.route, documents, packaged.documents)
    destinations.push({ funderId, name: preflight.displayName, route: preflight.route, errors: [], approved })
  }
  return { dealId, dealVersion: deal.version, destinations }
}
type Snapshot = Awaited<ReturnType<typeof snapshotFor>>

export interface BrokerSubmissionPreview {
  id: string
  expiresAt: string
  destinations: Array<{ funderId: string; name: string; method: string; destination: string; providerReadiness?: string; errors: string[]; documents: Array<{ id: string; filename: string; checksum: string }>; email?: { from: string; to: string[]; cc: string[]; replyTo: string; subject: string; body: string } }>
}
function previewView(id: string, expiresAt: string, snapshot: Snapshot): BrokerSubmissionPreview {
  return { id, expiresAt, destinations: snapshot.destinations.map(({ funderId, name, route, errors, approved }) => {
    let destination = route.destination
    if (route.kind === "custom_webhook") { const target = resolveWebhookTarget(destination); destination = target.ok ? target.target.url : "Webhook" }
    return { funderId, name, method: route.kind, destination, ...providerReadinessView(route), errors, documents: (approved?.documents ?? []).map(d => ({ id: d.documentId, filename: approved?.filenames[d.originalDocumentId] ?? d.documentId, checksum: d.checksum })), email: approved?.email ? { from: approved.email.fromAddress, to: approved.email.to, cc: approved.email.cc, replyTo: approved.email.replyTo, subject: approved.email.subject, body: approved.email.body } : undefined }
  }) }
}
export async function prepareDealSubmission(actor: DealActor, dealId: string, funderIds: unknown): Promise<BrokerSubmissionPreview> {
  assertBroker(actor)
  const snapshot = await snapshotFor(actor, dealId, ids(funderIds))
  const id = newId(), createdAt = nowIso(), expiresAt = new Date(Date.now() + 30 * 60_000).toISOString()
  await getDatabase().prepare(`INSERT INTO intake_submission_previews (id,workspace_id,intake_id,deal_id,created_by_user_id,snapshot_cipher,fingerprint,created_at,expires_at)
    VALUES (?,?,NULL,?,?,?,?,?,?)`).run(id, actor.workspaceId, dealId, actor.userId, encryptSensitive(JSON.stringify(snapshot), actor.workspaceId), hash(snapshot), createdAt, expiresAt)
  await recordAuditEvent({ context: actor, action: "submission.package_previewed", resourceType: "submission_preview", resourceId: id, metadata: { dealId, funderIds: snapshot.destinations.map(d => d.funderId) }, correlationId: actor.correlationId })
  return previewView(id, expiresAt, snapshot)
}
/** Revalidate the already displayed durable package; never create a replacement approval. */
export async function readDealSubmissionPreview(actor: DealActor, dealId: string, previewId: unknown): Promise<BrokerSubmissionPreview> {
  assertBroker(actor)
  if (typeof previewId !== "string" || !previewId.trim() || previewId.length > 128) throw new AppError(409, "broker_approval_required", "Prepare a new exact submission preview before approving.")
  await getDealForDocument(actor, dealId)
  const row = await getDatabase().prepare<{snapshot_cipher:string;fingerprint:string;expires_at:string}>("SELECT snapshot_cipher,fingerprint,expires_at FROM intake_submission_previews WHERE id=? AND workspace_id=? AND deal_id=? AND intake_id IS NULL").get(previewId,actor.workspaceId,dealId)
  if (!row) throw new AppError(404,"preview_not_found","The requested submission preview was not found.")
  if (Date.parse(row.expires_at) <= Date.now()) stale()
  const snapshot=JSON.parse(decryptSensitive(row.snapshot_cipher,actor.workspaceId)) as Snapshot
  if (hash(snapshot)!==row.fingerprint || hash(await snapshotFor(actor,dealId,snapshot.destinations.map(d=>d.funderId)))!==row.fingerprint) stale()
  return previewView(previewId,row.expires_at,snapshot)
}
export async function confirmDealSubmission(actor: DealActor, dealId: string, input: { previewId?: unknown; privilegedRetry?: unknown; privilegedReason?: unknown }) {
  assertBroker(actor)
  if (typeof input.previewId !== "string" || !input.previewId.trim() || input.previewId.length > 128) throw new AppError(409, "broker_approval_required", "Prepare and review the exact submission preview first.")
  const previewId = input.previewId
  await getDealForDocument(actor, dealId)
  let snapshot: Snapshot | undefined
  let queued: QueueSubmissionsResult | undefined
  await withTransaction(async executor => {
    await executor.prepare("SELECT pg_advisory_xact_lock(hashtextextended(?, 0))").get(`broker-send:${actor.workspaceId}:${dealId}`)
    const row = await executor.prepare<{ snapshot_cipher: string; fingerprint: string; confirmed_at: string | null; expires_at: string }>(`SELECT snapshot_cipher,fingerprint,confirmed_at,expires_at FROM intake_submission_previews
      WHERE id=? AND workspace_id=? AND deal_id=? AND intake_id IS NULL FOR UPDATE`).get(previewId, actor.workspaceId, dealId)
    if (!row) throw new AppError(404, "preview_not_found", "The requested submission preview was not found.")
    snapshot = JSON.parse(decryptSensitive(row.snapshot_cipher, actor.workspaceId)) as Snapshot
    if (row.confirmed_at) return
    if (Date.parse(row.expires_at) <= Date.now()) stale()
    if (hash(snapshot) !== row.fingerprint) stale()
    const funderIds = snapshot.destinations.map(d => d.funderId)
    if (hash(await snapshotFor(actor, dealId, funderIds)) !== row.fingerprint) stale()
    queued = await queueSubmissions({ actor, dealId, funderIds, confirmationKey: previewId, expectedDealVersion: snapshot.dealVersion, approvedPackages: Object.fromEntries(snapshot.destinations.filter(d => d.approved).map(d => [d.funderId, d.approved!])), deferDelivery: true,
      privilegedRetry: input.privilegedRetry === true, privilegedReason: typeof input.privilegedReason === "string" ? input.privilegedReason : undefined })
    await executor.prepare("UPDATE intake_submission_previews SET confirmed_at=? WHERE id=? AND workspace_id=?").run(nowIso(), previewId, actor.workspaceId)
    await recordAuditEvent({ context: actor, action: "submission.package_approved", resourceType: "submission_preview", resourceId: previewId, metadata: { dealId, funderIds, fingerprint: row.fingerprint }, correlationId: actor.correlationId, executor })
  })
  const jobs = () => listJobsForDeal(actor.workspaceId, dealId).then(rows => rows.filter(job => job.confirmationKey === previewId))
  if (!backgroundJobsEnabled()) for (const job of await jobs()) await processJobDelivery(job)
  const persisted = (await jobs()).map(job => { const summary = toQueuedSummary(job); const eligibleAt = job.state === "blocked_duplicate" ? eligibleAtFromReason(job.reason) : undefined; return eligibleAt ? { ...summary, eligibleAt } : summary })
  const persistedFunders = new Set(persisted.map(job => job.funderId))
  const rejected = snapshot!.destinations.filter(destination => destination.name === "Unknown funder" && !persistedFunders.has(destination.funderId)).map(destination => ({
    jobId: `rejected:${hash([previewId, destination.funderId])}`,
    funderId: destination.funderId,
    state: "preflight_failed" as const,
    reason: queued?.jobs.find(job => job.funderId === destination.funderId)?.reason ?? destination.errors[0] ?? "The requested funder was not found.",
  }))
  return { ok: true as const, confirmationKey: previewId, jobs: [...persisted, ...rejected] }
}
