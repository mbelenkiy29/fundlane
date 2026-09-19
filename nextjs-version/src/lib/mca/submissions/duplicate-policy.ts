import "server-only"

import { parseJson, recordAuditEvent, withImmediateTransaction, type DbExecutor } from "../db"
import type { DealActor } from "../deals/schema"
import { nowIso } from "./clock"
import type { DuplicateDecision, JobState } from "./contracts"

const ERROR_RETRY_MS = 2 * 60 * 1000
const ERROR_STATES = new Set<JobState>(["failed", "preflight_failed"])
const ACTIVE_STATES = new Set<JobState>(["queued", "sending", "sent", "pending_portal"])
const TERMINAL_STATES = new Set<JobState>(["declined", "funded"])

type DestinationJob = {
  id: string
  state: string
  created_at: string
  updated_at: string
  package_fingerprint: string
}

type ClaimRow = {
  metadata: string
}

type Claim = {
  claimedAt: string
  funderId: string
  packageFingerprint: string
}

function parseTime(iso: string): number {
  const ms = Date.parse(iso)
  return Number.isFinite(ms) ? ms : Number.NaN
}

function addMs(iso: string, ms: number): string {
  const start = parseTime(iso)
  return new Date((Number.isFinite(start) ? start : Date.now()) + ms).toISOString()
}

function nowMs(): number {
  const ms = parseTime(nowIso())
  return Number.isFinite(ms) ? ms : Date.now()
}

function claimId(workspaceId: string, merchantKey: string, funderId: string, fingerprint: string): string {
  return `dupclaim:${workspaceId}:${merchantKey}:${funderId}:${fingerprint}`
}

function asJobState(state: string): JobState | undefined {
  if (ERROR_STATES.has(state as JobState) || ACTIVE_STATES.has(state as JobState) || TERMINAL_STATES.has(state as JobState)) {
    return state as JobState
  }
  if (state === "skipped" || state === "blocked_duplicate") return state
  return undefined
}

function samePackage(job: DestinationJob, fingerprint: string): boolean {
  return job.package_fingerprint === fingerprint
}

function jobBlock(job: DestinationJob, now: number, fingerprint: string): DuplicateDecision | undefined {
  const state = asJobState(job.state)
  if (!state) return undefined
  if (ERROR_STATES.has(state)) {
    const eligibleAt = addMs(job.updated_at || job.created_at, ERROR_RETRY_MS)
    if (now < parseTime(eligibleAt)) {
      return {
        allowed: false,
        code: "retry_too_soon",
        eligibleAt,
        reason: `Error retries for this funder are blocked until ${eligibleAt}.`,
      }
    }
    return undefined
  }
  if (!samePackage(job, fingerprint)) return undefined
  if (ACTIVE_STATES.has(state)) {
    return {
      allowed: false,
      code: "active_duplicate",
      reason: "An active submission to this funder already exists for this merchant.",
    }
  }
  if (TERMINAL_STATES.has(state)) {
    return {
      allowed: false,
      code: "package_unchanged",
      reason: "This merchant package was already declined or funded for this funder.",
    }
  }
  return undefined
}

function decisionRank(code: DuplicateDecision["code"]): number {
  if (code === "active_duplicate") return 3
  if (code === "package_unchanged") return 2
  if (code === "retry_too_soon") return 1
  return 0
}

function moreRestrictive(current: DuplicateDecision | undefined, next: DuplicateDecision): DuplicateDecision {
  if (!current) return next
  const currentRank = decisionRank(current.code)
  const nextRank = decisionRank(next.code)
  if (nextRank !== currentRank) return nextRank > currentRank ? next : current
  const currentAt = parseTime(current.eligibleAt ?? "")
  const nextAt = parseTime(next.eligibleAt ?? "")
  if (nextAt > currentAt) return next
  if (currentAt > nextAt) return current
  return next
}

function readClaim(row: ClaimRow | undefined): Claim | undefined {
  if (!row) return undefined
  const metadata = parseJson<Partial<Claim>>(row.metadata, {})
  if (!metadata.claimedAt || !Number.isFinite(parseTime(metadata.claimedAt))) return undefined
  return {
    claimedAt: metadata.claimedAt,
    funderId: metadata.funderId ?? "",
    packageFingerprint: metadata.packageFingerprint ?? "",
  }
}

function inFlightBlock(claim: Claim | undefined, jobs: DestinationJob[], fingerprint: string): DuplicateDecision | undefined {
  if (!claim) return undefined
  if (claim.packageFingerprint && claim.packageFingerprint !== fingerprint) return undefined
  const claimedAtMs = parseTime(claim.claimedAt)
  if (!Number.isFinite(claimedAtMs)) return undefined
  if (jobs.some((job) => {
    if (fingerprint && job.package_fingerprint && job.package_fingerprint !== fingerprint) return false
    return parseTime(job.created_at) >= claimedAtMs
  })) return undefined
  return {
    allowed: false,
    code: "active_duplicate",
    reason: "An active submission to this funder already exists for this merchant.",
  }
}

async function loadJobs(database: DbExecutor, workspaceId: string, merchantKey: string, funderId: string): Promise<DestinationJob[]> {
  return database.prepare<DestinationJob>(
    `SELECT id, state, created_at, updated_at, package_fingerprint
     FROM mca_submission_jobs
     WHERE workspace_id = ? AND merchant_identity_key = ? AND funder_id = ?
     ORDER BY created_at ASC, id ASC
     FOR UPDATE`,
  ).all(workspaceId, merchantKey, funderId)
}

async function loadClaim(database: DbExecutor, id: string): Promise<Claim | undefined> {
  const row = await database.prepare<ClaimRow>("SELECT metadata FROM audit_events WHERE id = ? FOR UPDATE").get(id)
  return readClaim(row)
}

async function writeClaim(database: DbExecutor, input: {
  id: string
  actor: DealActor
  dealId: string
  funderId: string
  claimedAt: string
  packageFingerprint: string
}): Promise<void> {
  const metadata = JSON.stringify({
    funderId: input.funderId,
    claimedAt: input.claimedAt,
    packageFingerprint: input.packageFingerprint,
  })
  await database.prepare(`INSERT INTO audit_events
    (id, workspace_id, actor_user_id, source, action, resource_type, resource_id, metadata, correlation_id, created_at)
    VALUES (?, ?, ?, ?, 'submission.duplicate_claim', 'submission_destination', ?, ?, ?, ?)
    ON CONFLICT (id) DO UPDATE SET
      metadata = EXCLUDED.metadata,
      actor_user_id = EXCLUDED.actor_user_id,
      source = EXCLUDED.source,
      correlation_id = EXCLUDED.correlation_id`).run(
    input.id,
    input.actor.workspaceId,
    input.actor.userId,
    input.actor.source,
    input.dealId,
    metadata,
    input.actor.correlationId,
    input.claimedAt,
  )
}

async function allow(database: DbExecutor, input: {
  actor: DealActor
  dealId: string
  funderId: string
  claimKey: string
  packageFingerprint: string
  decision: DuplicateDecision
}): Promise<DuplicateDecision> {
  await writeClaim(database, {
    id: input.claimKey,
    actor: input.actor,
    dealId: input.dealId,
    funderId: input.funderId,
    claimedAt: nowIso(),
    packageFingerprint: input.packageFingerprint,
  })
  if (input.decision.code === "privileged_retry" && input.decision.reason) {
    await recordAuditEvent({
      context: input.actor,
      action: "submission.privileged_retry",
      resourceType: "deal",
      resourceId: input.dealId,
      metadata: { funderId: input.funderId, privilegedReason: input.decision.reason },
      correlationId: input.actor.correlationId,
      executor: database,
    })
  }
  return input.decision
}

/** Atomic merchant+funder duplicate lock until decline/funded or a new package fingerprint. */
export async function assertDuplicatePolicy(input: {
  actor: DealActor
  dealId: string
  funderId: string
  merchantIdentityKey: string
  packageFingerprint: string
  privilegedRetry?: boolean
  privilegedReason?: string
}): Promise<DuplicateDecision> {
  return withImmediateTransaction(async (database) => {
    await database.execute(
      "SELECT pg_advisory_xact_lock(hashtext(?), hashtext(?))",
      [`mca-dup:${input.actor.workspaceId}:${input.merchantIdentityKey}`, input.funderId],
    )

    const jobs = await loadJobs(database, input.actor.workspaceId, input.merchantIdentityKey, input.funderId)
    const claimKey = claimId(
      input.actor.workspaceId,
      input.merchantIdentityKey,
      input.funderId,
      input.packageFingerprint,
    )
    const claim = await loadClaim(database, claimKey)
    const now = nowMs()
    // Claim covers the gap between this decision and persistNewDestination on concurrent queueSubmissions.
    const inFlight = inFlightBlock(claim, jobs, input.packageFingerprint)
    if (inFlight) return inFlight

    const privilegedReason = input.privilegedReason?.trim()
    if (input.privilegedRetry === true && privilegedReason) {
      return allow(database, {
        actor: input.actor,
        dealId: input.dealId,
        funderId: input.funderId,
        claimKey,
        packageFingerprint: input.packageFingerprint,
        decision: {
          allowed: true,
          code: "privileged_retry",
          reason: privilegedReason,
        },
      })
    }

    let blocked: DuplicateDecision | undefined
    for (const job of jobs) {
      const next = jobBlock(job, now, input.packageFingerprint)
      if (next) blocked = moreRestrictive(blocked, next)
    }
    if (blocked) return blocked

    return allow(database, {
      actor: input.actor,
      dealId: input.dealId,
      funderId: input.funderId,
      claimKey,
      packageFingerprint: input.packageFingerprint,
      decision: { allowed: true },
    })
  })
}
