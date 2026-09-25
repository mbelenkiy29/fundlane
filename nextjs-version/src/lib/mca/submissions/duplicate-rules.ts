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
const RESUBMIT_STATES = new Set(["queued", "sending", "sent", "pending_portal", "declined", "funded"])

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

const ISO_INSTANT = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z/

function parseTime(iso: string): number {
  const ms = Date.parse(iso)
  return Number.isFinite(ms) ? ms : Number.NaN
}

/** Recover the retry time from a stored blocked-duplicate reason when the live check no longer blocks. */
export function eligibleAtFromReason(reason: string | undefined): string | undefined {
  if (!reason) return undefined
  const match = reason.match(ISO_INSTANT)
  if (!match) return undefined
  const parsed = parseTime(match[0])
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : undefined
}

export function confirmationAttemptFingerprint(input: {
  funderIds: readonly string[]
  override24h: boolean
  overrideReason: string
}): string {
  return JSON.stringify({
    funderIds: [...input.funderIds].sort(),
    override24h: input.override24h,
    overrideReason: input.override24h ? input.overrideReason.trim() : "",
  })
}

export function confirmationKeyForAttempt(
  pending: { fingerprint: string; key: string } | null,
  fingerprint: string,
  createKey: () => string,
): { fingerprint: string; key: string } {
  if (pending?.fingerprint === fingerprint && pending.key) return pending
  return { fingerprint, key: createKey() }
}

export function isCountingSubmissionState(state: string): boolean {
  return Boolean(state) && !IGNORED_STATES.has(state)
}

export function isDeliveredSubmissionState(state: string): boolean {
  return RESUBMIT_STATES.has(state)
}

function latestJobAt(
  jobs: readonly DuplicateWindowJob[],
  include: (state: string) => boolean,
): number | undefined {
  let latest: number | undefined
  for (const job of jobs) {
    if (!include(job.state)) continue
    const created = parseTime(job.createdAt)
    if (!Number.isFinite(created)) continue
    if (latest === undefined || created > latest) latest = created
  }
  return latest
}

export function latestCountingSubmissionAt(jobs: readonly DuplicateWindowJob[]): number | undefined {
  return latestJobAt(jobs, isCountingSubmissionState)
}

export function evaluateDuplicateWindows(
  jobs: readonly DuplicateWindowJob[],
  nowMs: number,
): DuplicateWindowDecision | undefined {
  const latestRetry = latestJobAt(jobs, isCountingSubmissionState)
  if (latestRetry !== undefined) {
    const retryAt = latestRetry + DUPLICATE_RETRY_MS
    if (nowMs < retryAt) {
      const eligibleAt = new Date(retryAt).toISOString()
      return {
        allowed: false,
        code: "retry_too_soon",
        eligibleAt,
        reason: DUPLICATE_RULE_COPY.retryTooSoon(eligibleAt),
      }
    }
  }
  const latestResubmit = latestJobAt(jobs, isDeliveredSubmissionState)
  if (latestResubmit === undefined) return undefined
  const resubmitAt = latestResubmit + DUPLICATE_RESUBMIT_MS
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
