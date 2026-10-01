import "server-only"

import { createHash } from "node:crypto"
import { decryptSensitive } from "../crypto"
import { getDatabase } from "../db"
import { AppError } from "../errors"
import type { ApprovedSubmissionPackage, SubmissionJob } from "./contracts"

function reviewRequired(): never {
  throw new AppError(409, "broker_approval_required", "Review and approve the exact submission package and destination before sending.")
}

/** A durable, confirmed application preview authorizes one job/attempt per destination. */
export async function assertBrokerApprovedDelivery(job: SubmissionJob): Promise<void> {
  if (job.autoSubmitDecisionId || !job.approvedPackage || job.attemptKey !== job.confirmationKey) reviewRequired()
  const row = await getDatabase().prepare<{ snapshot_cipher: string; fingerprint: string; confirmed_at: string | null; created_by_user_id: string | null }>(
    `SELECT snapshot_cipher, fingerprint, confirmed_at, created_by_user_id FROM intake_submission_previews
     WHERE workspace_id = ? AND deal_id = ? AND id = ?`,
  ).get(job.workspaceId, job.dealId, job.confirmationKey)
  if (!row?.confirmed_at || !row.created_by_user_id) reviewRequired()
  let snapshot: { dealId: string; dealVersion: number; destinations: Array<{ funderId: string; approved: ApprovedSubmissionPackage }> }
  try {
    const raw = decryptSensitive(row.snapshot_cipher, job.workspaceId)
    if (createHash("sha256").update(raw).digest("hex") !== row.fingerprint) reviewRequired()
    snapshot = JSON.parse(raw)
  } catch { reviewRequired() }
  const destination = snapshot.destinations?.find(item => item.funderId === job.funderId)
  if (snapshot.dealId !== job.dealId || snapshot.dealVersion !== job.dealVersion || !destination
    || JSON.stringify(destination.approved) !== JSON.stringify(job.approvedPackage)
    || JSON.stringify(job.route) !== JSON.stringify(job.approvedPackage.route)
    || job.routeKind !== job.approvedPackage.route.kind) reviewRequired()
}
