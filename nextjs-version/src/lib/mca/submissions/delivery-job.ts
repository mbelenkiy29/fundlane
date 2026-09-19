import "server-only"

import type { DealActor } from "../deals/schema"
import { enqueueBackgroundJob } from "../jobs/queue"

export function submissionDeliveryActor(job: { workspaceId: string; dealId: string; id: string }): DealActor {
  return {
    workspaceId: job.workspaceId,
    userId: null,
    membershipId: null,
    role: null,
    managedMembershipIds: [],
    activeMembershipIds: [],
    source: "system",
    intakeDealId: job.dealId,
    correlationId: job.id,
  }
}

export async function enqueueSubmissionDelivery(job: { workspaceId: string; dealId: string; id: string }): Promise<void> {
  await enqueueBackgroundJob({
    actor: submissionDeliveryActor(job),
    kind: "submission_delivery",
    resourceId: job.id,
    idempotencyKey: job.id,
    payload: { jobId: job.id },
  })
}
