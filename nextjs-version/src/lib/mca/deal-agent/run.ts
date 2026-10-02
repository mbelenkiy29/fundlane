import "server-only"

import type { DealActor } from "../deals/schema"
import { documentScanActor } from "../documents/scan-job"
import { enqueueBackgroundJob, type BackgroundJob } from "../jobs/queue"
import { getWorkspaceSettings } from "../workspaces"

const DEBOUNCE_MS = 120_000

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
    availableAt: new Date(Date.now() + DEBOUNCE_MS).toISOString(),
  })
}

export async function processDealAgentJob(_job: BackgroundJob, _actor: DealActor): Promise<{ skipped: "not_implemented" }> {
  return { skipped: "not_implemented" }
}
