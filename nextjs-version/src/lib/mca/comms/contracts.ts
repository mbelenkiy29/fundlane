import type { DealActor } from "../deals/schema"

export const COMMS_JOB_KINDS = ["followup", "digest", "webhook_outbox"] as const
export type CommsJobKind = (typeof COMMS_JOB_KINDS)[number]

export const MESSAGE_CHANNELS = ["email", "sms"] as const
export type MessageChannel = (typeof MESSAGE_CHANNELS)[number]

export interface RunCommsJobsInput {
  actor: DealActor
  nowIso: string
  kinds?: CommsJobKind[]
}

export interface RunCommsJobsResult {
  followups: { attempted: number; sent: number; skipped: number }
  digests: { attempted: number; sent: number; skipped: number }
  webhooks: { attempted: number; delivered: number; failed: number }
}

export type CommsJobHandler = (input: RunCommsJobsInput) => Promise<Partial<RunCommsJobsResult>>
