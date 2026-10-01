import "server-only"

import { getDatabase, nowIso } from "../db"
import type { DealActor } from "../deals/schema"
import type { RunCommsJobsResult } from "./contracts"
import { runCommsJobs } from "./jobs"
import { WORKFLOW_WEBHOOK_MAX_ATTEMPTS } from "./webhooks"

const emptyFollowups = { attempted: 0, sent: 0, skipped: 0 }
const emptyDigests = { attempted: 0, sent: 0, skipped: 0 }
const emptyWebhooks = { attempted: 0, delivered: 0, failed: 0 }

function systemActor(workspaceId: string, clock: string): DealActor {
  return {
    workspaceId,
    userId: null,
    membershipId: null,
    role: "admin",
    managedMembershipIds: [],
    activeMembershipIds: [],
    source: "system",
    correlationId: `cron-comms:${workspaceId}:${clock}`,
  }
}

function addCounts<T extends Record<string, number>>(left: T, right: T): T {
  const next = { ...left }
  for (const key of Object.keys(right) as Array<keyof T>) {
    next[key] = ((left[key] ?? 0) + (right[key] ?? 0)) as T[keyof T]
  }
  return next
}

export interface ScheduledCommsJobsResult {
  workspaces: number
  followups: RunCommsJobsResult["followups"]
  digests: RunCommsJobsResult["digests"]
  webhooks: RunCommsJobsResult["webhooks"]
  notifications?: Awaited<ReturnType<typeof import("../notifications/worker").runScheduledNotifications>>
}

/** Runtime-agnostic tick for signed webhook retries and due daily report emails. */
export async function runScheduledCommsJobs(nowIsoValue = nowIso()): Promise<ScheduledCommsJobsResult> {
  const notificationDeadline=Date.now()+230_000
  await import("./digest")
  await import("./webhooks")
  const rows = await getDatabase().prepare<{ workspace_id: string }>(
    `SELECT workspace_id FROM (
       SELECT workspace_id FROM mca_workflow_webhook_outbox
         WHERE state = 'pending' AND attempts < ?
       UNION
       SELECT workspace_id FROM mca_digest_subscriptions
         WHERE enabled = 1
     ) due
     ORDER BY workspace_id`,
  ).all(WORKFLOW_WEBHOOK_MAX_ATTEMPTS)
  let result: ScheduledCommsJobsResult = {
    workspaces: 0,
    followups: emptyFollowups,
    digests: emptyDigests,
    webhooks: emptyWebhooks,
  }
  for (const row of rows) {
    const next = await runCommsJobs({
      actor: systemActor(row.workspace_id, nowIsoValue),
      nowIso: nowIsoValue,
      kinds: ["digest", "webhook_outbox"],
    })
    result = {
      workspaces: result.workspaces + 1,
      followups: result.followups,
      digests: addCounts(result.digests, next.digests),
      webhooks: addCounts(result.webhooks, next.webhooks),
    }
  }
  if(process.env.MCA_NOTIFICATION_RUNTIME === "enabled") {
    const {runScheduledNotifications}=await import("../notifications/worker")
    result.notifications=await runScheduledNotifications(nowIsoValue,25,{deadlineMs:notificationDeadline})
  }
  return result
}
