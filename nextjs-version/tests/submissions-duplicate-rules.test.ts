import test from "node:test"
import assert from "node:assert/strict"
import {
  confirmationAttemptFingerprint,
  confirmationKeyForAttempt,
  DUPLICATE_RESUBMIT_MS,
  DUPLICATE_RETRY_MS,
  DUPLICATE_RULE_COPY,
  eligibleAtFromReason,
  evaluateDuplicateWindows,
  isCountingSubmissionState,
} from "../src/lib/mca/submissions/duplicate-rules"

const T0 = Date.parse("2026-09-08T12:00:00.000Z")

test("blocked_duplicate and skipped jobs do not count toward retry windows", () => {
  assert.equal(isCountingSubmissionState("pending_portal"), true)
  assert.equal(isCountingSubmissionState("failed"), true)
  assert.equal(isCountingSubmissionState("blocked_duplicate"), false)
  assert.equal(isCountingSubmissionState("skipped"), false)
  assert.equal(evaluateDuplicateWindows([
    { state: "blocked_duplicate", createdAt: "2026-09-08T12:00:00.000Z" },
    { state: "skipped", createdAt: "2026-09-08T12:00:00.000Z" },
  ], T0 + 1), undefined)
})

test("2-minute window precedes the 24-hour window and expires at the boundary", () => {
  const jobs = [{ state: "pending_portal", createdAt: "2026-09-08T12:00:00.000Z" }]
  const early = evaluateDuplicateWindows(jobs, T0 + DUPLICATE_RETRY_MS - 1)
  assert.equal(early?.code, "retry_too_soon")
  assert.equal(early?.eligibleAt, "2026-09-08T12:02:00.000Z")
  assert.match(early?.reason ?? "", /2 minutes/)
  assert.match(early?.reason ?? "", /cannot be overridden/)

  const afterRetry = evaluateDuplicateWindows(jobs, T0 + DUPLICATE_RETRY_MS)
  assert.equal(afterRetry?.code, "recent_duplicate")
  assert.equal(afterRetry?.eligibleAt, "2026-09-09T12:00:00.000Z")
  assert.match(afterRetry?.reason ?? "", /24 hours/)
  assert.match(afterRetry?.reason ?? "", /override/)

  const afterDay = evaluateDuplicateWindows(jobs, T0 + DUPLICATE_RESUBMIT_MS)
  assert.equal(afterDay, undefined)
})

test("failed and preflight jobs only hold the 2-minute retry window", () => {
  const failed = [{ state: "failed", createdAt: "2026-09-08T12:00:00.000Z" }]
  const preflight = [{ state: "preflight_failed", createdAt: "2026-09-08T12:00:00.000Z" }]
  assert.equal(evaluateDuplicateWindows(failed, T0 + DUPLICATE_RETRY_MS - 1)?.code, "retry_too_soon")
  assert.equal(evaluateDuplicateWindows(preflight, T0 + DUPLICATE_RETRY_MS - 1)?.code, "retry_too_soon")
  assert.equal(evaluateDuplicateWindows(failed, T0 + DUPLICATE_RETRY_MS), undefined)
  assert.equal(evaluateDuplicateWindows(preflight, T0 + DUPLICATE_RETRY_MS), undefined)
})

test("duplicate rule copy is documented for the submit UI", () => {
  assert.match(DUPLICATE_RULE_COPY.summary, /2 minutes/)
  assert.match(DUPLICATE_RULE_COPY.summary, /24 hours/)
  assert.match(DUPLICATE_RULE_COPY.overrideHint, /audit/)
})

test("eligibleAtFromReason recovers the ISO retry time from stored copy", () => {
  const eligibleAt = "2026-09-08T12:02:00.000Z"
  assert.equal(eligibleAtFromReason(DUPLICATE_RULE_COPY.retryTooSoon(eligibleAt)), eligibleAt)
  assert.equal(eligibleAtFromReason(DUPLICATE_RULE_COPY.recentDuplicate("2026-09-09T12:00:00.000Z")), "2026-09-09T12:00:00.000Z")
  assert.equal(eligibleAtFromReason(DUPLICATE_RULE_COPY.inFlight), undefined)
  assert.equal(eligibleAtFromReason(undefined), undefined)
})

test("confirmation keys are reused only for the same funder and override payload", () => {
  const first = confirmationAttemptFingerprint({
    funderIds: ["funder-b", "funder-a"],
    override24h: true,
    overrideReason: "  Merchant sent corrected statements.  ",
  })
  const same = confirmationAttemptFingerprint({
    funderIds: ["funder-a", "funder-b"],
    override24h: true,
    overrideReason: "Merchant sent corrected statements.",
  })
  const changedFunders = confirmationAttemptFingerprint({
    funderIds: ["funder-a"],
    override24h: true,
    overrideReason: "Merchant sent corrected statements.",
  })
  const changedOverride = confirmationAttemptFingerprint({
    funderIds: ["funder-b", "funder-a"],
    override24h: false,
    overrideReason: "Merchant sent corrected statements.",
  })
  assert.equal(first, same)
  assert.notEqual(first, changedFunders)
  assert.notEqual(first, changedOverride)

  let minted = 0
  const createKey = () => {
    minted += 1
    return `key-${minted}`
  }
  const pending = confirmationKeyForAttempt(null, first, createKey)
  assert.equal(pending.key, "key-1")
  assert.equal(confirmationKeyForAttempt(pending, first, createKey).key, "key-1")
  assert.equal(confirmationKeyForAttempt(pending, changedFunders, createKey).key, "key-2")
  assert.equal(minted, 2)
})
