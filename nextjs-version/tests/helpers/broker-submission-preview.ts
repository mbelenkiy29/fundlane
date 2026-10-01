/** Synthetic-only durable preview fixture; never calls a delivery provider. */
import { createHash } from "node:crypto"
import { encryptSensitive } from "../../src/lib/mca/crypto"
import { getDatabase, newId, nowIso } from "../../src/lib/mca/db"
import type { DealActor } from "../../src/lib/mca/deals/schema"
import { getDealForDocument } from "../../src/lib/mca/deals/service"
import { listSubmissionDocuments } from "../../src/lib/mca/documents/service"
import { getFunder } from "../../src/lib/mca/funders/directory"
import { prepareApprovedSubmissionEmail } from "../../src/lib/mca/submissions/email-templates"
import { prepareOutgoingPackage } from "../../src/lib/mca/submissions/package"
import { preflightDestination, probeSubmissionSender } from "../../src/lib/mca/submissions/preflight"
import { createDeal } from "../../src/lib/mca/deals/service"
import type { SubmissionJob, ApprovedSubmissionPackage } from "../../src/lib/mca/submissions/contracts"

export async function syntheticApprovedPackages(actor: DealActor, dealId: string, funderIds: string[], confirmationKey: string) {
  const deal = await getDealForDocument(actor, dealId)
  const documents = await listSubmissionDocuments(actor, dealId)
  const sender = await probeSubmissionSender(actor)
  const packages: Record<string, ApprovedSubmissionPackage> = {}
  for (const funderId of funderIds) {
    const funder = await getFunder(actor, funderId)
    const preflight = preflightDestination({ funder, documents, sender })
    const packaged = await prepareOutgoingPackage({ originals: preflight.originals, funderId })
    packages[funderId] = { route: preflight.route, originalVersions: documents.map(d => ({ documentId: d.id, checksum: d.checksum, category: d.category })), filenames: Object.fromEntries(documents.map(d => [d.id, d.displayFilename])), documents: packaged.documents }
    if (preflight.route.kind === "email") packages[funderId].email = await prepareApprovedSubmissionEmail(actor, deal, funder, preflight.route, documents, packaged.documents)
  }
  const intakeId = newId(), now = nowIso()
  await getDatabase().prepare(`INSERT INTO intake_events (id,workspace_id,provider,provider_event_id,payload_checksum,application_cipher,state,deal_id,created_at,updated_at)
    VALUES (?,?,'t2-fixture',?,'fixture',?,'created',?,?,?)`).run(intakeId, actor.workspaceId, intakeId, encryptSensitive("{}", actor.workspaceId), dealId, now, now)
  const snapshot = JSON.stringify({ dealId, dealVersion: deal.version, destinations: funderIds.map(funderId => ({ funderId, approved: packages[funderId] })) })
  await getDatabase().prepare(`INSERT INTO intake_submission_previews (id,workspace_id,intake_id,deal_id,created_by_user_id,snapshot_cipher,fingerprint,created_at,expires_at,confirmed_at)
    VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT (id) DO NOTHING`).run(confirmationKey, actor.workspaceId, intakeId, dealId, actor.userId, encryptSensitive(snapshot, actor.workspaceId), createHash("sha256").update(snapshot).digest("hex"), now, now, now)
  return packages
}


/** Exact durable approval for transport-only simulated adapter fixtures. */
export async function syntheticApprovedJob(actor: DealActor, job: SubmissionJob): Promise<SubmissionJob> {
  const deal = (await createDeal({ ...actor, activeMembershipIds: actor.membershipId ? [actor.membershipId] : [] }, { idempotencyKey: newId(), legalName: "T2 adapter fixture" })).deal
  const approved: ApprovedSubmissionPackage = { route: job.route, originalVersions: job.documentVersions, filenames: {}, documents: [] }
  const snapshot = JSON.stringify({ dealId: deal.id, dealVersion: deal.version, destinations: [{ funderId: job.funderId, approved }] })
  const now = nowIso()
  await getDatabase().prepare(`INSERT INTO intake_submission_previews (id,workspace_id,intake_id,deal_id,created_by_user_id,snapshot_cipher,fingerprint,created_at,expires_at,confirmed_at)
    VALUES (?,?,NULL,?,?,?,?,?,?,?) ON CONFLICT (id) DO UPDATE SET deal_id=EXCLUDED.deal_id,snapshot_cipher=EXCLUDED.snapshot_cipher,fingerprint=EXCLUDED.fingerprint`)
    .run(job.attemptKey, actor.workspaceId, deal.id, actor.userId, encryptSensitive(snapshot, actor.workspaceId), createHash("sha256").update(snapshot).digest("hex"), now, now, now)
  return { ...job, dealId: deal.id, dealVersion: deal.version, confirmationKey: job.attemptKey, approvedPackage: approved }
}

/** Preserve queue-policy coverage while giving simulated successful deliveries a durable human fixture. */
export async function queueWithSyntheticApproval(input: import("../../src/lib/mca/submissions/contracts").QueueSubmissionsInput) {
  const { queueSubmissions } = await import("../../src/lib/mca/submissions/queue")
  const exists = await getDatabase().prepare<{ id: string }>("SELECT id FROM intake_submission_previews WHERE id=?").get(input.confirmationKey)
  const approvedPackages = exists ? undefined : await syntheticApprovedPackages(input.actor, input.dealId, input.funderIds, input.confirmationKey)
  return queueSubmissions({ ...input, approvedPackages: approvedPackages ?? input.approvedPackages })
}

/** Exercise the actual two-step HTTP path for session-backed broker fixtures. */
export async function brokerConfirmHttp(request: Request, context: { params: Promise<{ dealId: string }> }) {
  const { POST } = await import("../../src/app/api/mca/submissions/[dealId]/route")
  const body = await request.clone().json() as Record<string, unknown>
  if (request.headers.has("authorization") || body.action || body.previewId) return POST(request, context)
  const response = await POST(new Request(request.url, { method: "POST", headers: request.headers, body: JSON.stringify({ action: "preview", funderIds: body.funderIds }) }), context)
  if (!response.ok) return response
  const preview = await response.json() as { id: string }
  return POST(new Request(request.url, { method: "POST", headers: request.headers, body: JSON.stringify({ ...body, previewId: preview.id }) }), context)
}

export async function approvePersistedFixture(actor: DealActor, job: SubmissionJob): Promise<SubmissionJob> {
  const documents = await listSubmissionDocuments(actor, job.dealId)
  const packaged = await prepareOutgoingPackage({ originals: documents.filter(d => job.packageDocumentIds.includes(d.id)).map(d => ({ documentId: d.id, originalDocumentId: d.id, checksum: d.checksum, byteLength: d.byteLength, stage: "original" as const })), funderId: job.funderId })
  const approved: ApprovedSubmissionPackage = { route: job.route, originalVersions: job.documentVersions, filenames: Object.fromEntries(documents.map(d => [d.id, d.displayFilename])), documents: packaged.documents }
  if (job.route.kind === "email") approved.email = await prepareApprovedSubmissionEmail(actor, await getDealForDocument(actor, job.dealId), await getFunder(actor, job.funderId), job.route, documents, packaged.documents)
  const snapshot = JSON.stringify({ dealId: job.dealId, dealVersion: job.dealVersion, destinations: [{ funderId: job.funderId, approved }] })
  const now = nowIso()
  await getDatabase().prepare(`INSERT INTO intake_submission_previews(id,workspace_id,intake_id,deal_id,created_by_user_id,snapshot_cipher,fingerprint,created_at,expires_at,confirmed_at) VALUES (?,?,NULL,?,?,?,?,?,?,?) ON CONFLICT (id) DO NOTHING`).run(job.confirmationKey, actor.workspaceId, job.dealId, actor.userId, encryptSensitive(snapshot, actor.workspaceId), createHash("sha256").update(snapshot).digest("hex"), now, now, now)
  await getDatabase().prepare("UPDATE mca_submission_jobs SET approved_package_cipher=? WHERE id=?").run(encryptSensitive(JSON.stringify(approved), actor.workspaceId), job.id)
  return { ...job, approvedPackage: approved }
}
