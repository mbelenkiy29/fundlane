import "server-only"

import { newId } from "../db"
import type { DealActor } from "../deals/schema"
import type { QueueSubmissionsResult } from "../submissions/contracts"
import { queueSubmissions as enqueueSubmissions } from "../submissions/queue"

export async function queueSubmissions(input: {
  actor: DealActor
  dealId: string
  funderIds: string[]
  analysisRunId?: string
}): Promise<QueueSubmissionsResult> {
  const confirmationKey = input.analysisRunId?.trim() || newId()
  return enqueueSubmissions({
    actor: input.actor,
    dealId: input.dealId,
    funderIds: input.funderIds,
    analysisRunId: input.analysisRunId,
    confirmationKey,
  })
}
