import "server-only"

import { getDatabase, nowIso } from "../db"
import type { DealActor } from "../deals/schema"
import { isDocumentReady } from "./contracts"
import { enqueueBackgroundJob } from "../jobs/queue"

export function documentScanActor(input: { workspaceId: string; dealId: string; id: string }): DealActor {
  return {
    workspaceId: input.workspaceId,
    userId: null,
    membershipId: null,
    role: null,
    managedMembershipIds: [],
    activeMembershipIds: [],
    source: "system",
    intakeDealId: input.dealId,
    correlationId: input.id,
  }
}

/** Enqueue only when no queued/running scan exists. Reset complete/failed rows for not-ready docs; do not clobber a running lease. */
export async function enqueueDocumentScan(record: { id: string; workspaceId: string; dealId: string; processingState: string }): Promise<void> {
  if (isDocumentReady(record.processingState) || record.processingState === "quarantined") return
  const actor = documentScanActor(record)
  const existing = await getDatabase().prepare<{ id: string; state: string }>(
    "SELECT id, state FROM mca_background_jobs WHERE workspace_id=? AND kind='document_scan' AND resource_id=? ORDER BY created_at DESC",
  ).all(record.workspaceId, record.id)
  if (existing.some((job) => job.state === "queued" || job.state === "running")) return
  const finished = existing.find((job) => job.state === "complete" || job.state === "failed")
  if (finished) {
    const reset = await getDatabase().prepare(
      `UPDATE mca_background_jobs SET state='queued',attempts=0,available_at=?,lease_token=NULL,lease_expires_at=NULL,error_code=NULL,result_json=NULL,actor_json=?,updated_at=?
       WHERE id=? AND workspace_id=? AND kind='document_scan' AND state IN ('complete','failed')`,
    ).run(nowIso(), JSON.stringify(actor), nowIso(), finished.id, record.workspaceId)
    if (reset.changes > 0) return
    const live = await getDatabase().prepare<{ state: string }>(
      "SELECT state FROM mca_background_jobs WHERE workspace_id=? AND kind='document_scan' AND resource_id=? AND state IN ('queued','running')",
    ).get(record.workspaceId, record.id)
    if (live) return
  }
  await enqueueBackgroundJob({
    actor,
    kind: "document_scan",
    resourceId: record.id,
    idempotencyKey: `document_scan:${record.id}`,
    payload: { documentId: record.id },
  })
}
