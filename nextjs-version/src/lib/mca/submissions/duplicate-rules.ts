export const DUPLICATE_RETRY_MS = 2 * 60 * 1000
export const DUPLICATE_RESUBMIT_MS = 24 * 60 * 60 * 1000

export const DUPLICATE_RULE_COPY = {
  summary:
    "The same deal cannot be sent to the same funder again for 2 minutes. Re-submitting that pair within 24 hours is blocked unless you provide an explicit override reason. The 2-minute rule cannot be overridden.",
  retryTooSoon: (eligibleAt: string) =>
    `This deal was already submitted to this funder within the last 2 minutes. You can retry after ${eligibleAt}. The 2-minute rule cannot be overridden.`,
  recentDuplicate: (eligibleAt: string) =>
    `This deal was already submitted to this funder within the last 24 hours. You can retry after ${eligibleAt}, or submit with an explicit override reason.`,
  inFlight:
    "A submission of this deal to this funder is already in progress. Wait 2 minutes before retrying. The 2-minute rule cannot be overridden.",
  overrideHint:
    "Override the 24-hour same-funder rule. This is recorded in the audit log. The 2-minute retry block cannot be overridden.",
} as const

const IGNORED_STATES = new Set(["blocked_duplicate", "skipped"])

export type DuplicateWindowCode = "retry_too_soon" | "recent_duplicate"

export type DuplicateWindowDecision = {
  allowed: false
  code: DuplicateWindowCode
  eligibleAt: string
  reason: string
}

export type DuplicateWindowJob = {
  state: string
  createdAt: string
}

function parseTime(iso: string): number {
  const ms = Date.parse(iso)
  return Number.isFinite(ms) ? ms : Number.NaN
}

export function isCountingSubmissionState(state: string): boolean {
  return Boolean(state) && !IGNORED_STATES.has(state)
}

export function latestCountingSubmissionAt(jobs: readonly DuplicateWindowJob[]): number | undefined {
  let latest: number | undefined
  for (const job of jobs) {
    if (!isCountingSubmissionState(job.state)) continue
    const created = parseTime(job.createdAt)
    if (!Number.isFinite(created)) continue
    if (latest === undefined || created > latest) latest = created
  }
  return latest
}

export function evaluateDuplicateWindows(
  jobs: readonly DuplicateWindowJob[],
  nowMs: number,
): DuplicateWindowDecision | undefined {
  const latest = latestCountingSubmissionAt(jobs)
  if (latest === undefined) return undefined
  const retryAt = latest + DUPLICATE_RETRY_MS
  if (nowMs < retryAt) {
    const eligibleAt = new Date(retryAt).toISOString()
    return {
      allowed: false,
      code: "retry_too_soon",
      eligibleAt,
      reason: DUPLICATE_RULE_COPY.retryTooSoon(eligibleAt),
    }
  }
  const resubmitAt = latest + DUPLICATE_RESUBMIT_MS
  if (nowMs < resubmitAt) {
    const eligibleAt = new Date(resubmitAt).toISOString()
    return {
      allowed: false,
      code: "recent_duplicate",
      eligibleAt,
      reason: DUPLICATE_RULE_COPY.recentDuplicate(eligibleAt),
    }
  }
  return undefined
}
