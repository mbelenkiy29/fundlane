import "server-only"

import { AppError } from "../errors"
import type { CommsJobHandler, CommsJobKind, RunCommsJobsInput, RunCommsJobsResult } from "./contracts"

const empty: RunCommsJobsResult = {
  followups: { attempted: 0, sent: 0, skipped: 0 },
  digests: { attempted: 0, sent: 0, skipped: 0 },
  webhooks: { attempted: 0, delivered: 0, failed: 0 },
}

const handlers = new Map<CommsJobKind, CommsJobHandler>()

export function registerCommsJob(kind: CommsJobKind, handler: CommsJobHandler): void {
  handlers.set(kind, handler)
}

function merge(base: RunCommsJobsResult, patch: Partial<RunCommsJobsResult>): RunCommsJobsResult {
  return {
    followups: patch.followups ?? base.followups,
    digests: patch.digests ?? base.digests,
    webhooks: patch.webhooks ?? base.webhooks,
  }
}

export async function runCommsJobs(input: RunCommsJobsInput): Promise<RunCommsJobsResult> {
  if (!input.nowIso || !Number.isFinite(Date.parse(input.nowIso))) {
    throw new AppError(422, "invalid_clock", "Provide a valid ISO-8601 nowIso for scheduled communications.")
  }
  const kinds = input.kinds?.length ? input.kinds : (["followup", "digest", "webhook_outbox"] as CommsJobKind[])
  let result = empty
  for (const kind of kinds) {
    const handler = handlers.get(kind)
    if (!handler) continue
    result = merge(result, await handler(input))
  }
  return result
}
