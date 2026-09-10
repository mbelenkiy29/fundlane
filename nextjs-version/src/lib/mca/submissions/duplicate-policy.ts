import "server-only"

import { parseJson, recordAuditEvent, withImmediateTransaction, type DbExecutor } from "../db"
import type { DealActor } from "../deals/schema"
import { nowIso } from "./clock"
import type { DuplicateDecision, JobState } from "./contracts"

const ERROR_RETRY_MS = 2 * 60 * 1000
const ACTIVE_DUPLICATE_MS = 24 * 60 * 60 * 1000
const ERROR_STATES = new Set<JobState>(["failed", "preflight_failed"])
const ACTIVE_STATES = new Set<JobState>(["queued", "sending", "sent", "pending_portal"])

type DestinationJob = {
  id: string
  state: string
  created_at: string
  updated_at: string
}

type ClaimRow = {
  metadata: string
}

type Claim = {
  claimedAt: string
  funderId: string
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

function claimId(workspaceId: string, dealId: string, funderId: string): string {
  return `dupclaim:${workspaceId}:${dealId}:${funderId}`
}

function asJobState(state: string): JobState | undefined {
  if (ERROR_STATES.has(state as JobState) || ACTIVE_STATES.has(state as JobState)) return state as JobState
  if (state === "skipped" || state === "blocked_duplicate") return state
  return undefined
}

function jobBlock(job: DestinationJob, now: number): DuplicateDecision | undefined {
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
  if (ACTIVE_STATES.has(state)) {
    const eligibleAt = addMs(job.created_at, ACTIVE_DUPLICATE_MS)
    if (now < parseTime(eligibleAt)) {
      return {
        allowed: false,
        code: "active_duplicate",
        eligibleAt,
        reason: `An active submission to this funder is blocked until ${eligibleAt}.`,
      }
    }
  }
  return undefined
}

function moreRestrictive(current: DuplicateDecision | undefined, next: DuplicateDecision): DuplicateDecision {
  if (!current) return next
  const currentAt = parseTime(current.eligibleAt ?? "")
  const nextAt = parseTime(next.eligibleAt ?? "")
  if (nextAt > currentAt) return next
  if (currentAt > nextAt) return current
  return next.code === "active_duplicate" ? next : current
}

function readClaim(row: ClaimRow | undefined): Claim | undefined {
  if (!row) return undefined
  const metadata = parseJson<Partial<Claim>>(row.metadata, {})
  if (!metadata.claimedAt || !Number.isFinite(parseTime(metadata.claimedAt))) return undefined
  return { claimedAt: metadata.claimedAt, funderId: metadata.funderId ?? "" }
}

function inFlightBlock(claim: Claim | undefined, jobs: DestinationJob[], now: number): DuplicateDecision | undefined {
  if (!claim) return undefined
  const claimedAtMs = parseTime(claim.claimedAt)
  if (!Number.isFinite(claimedAtMs)) return undefined
  if (jobs.some((job) => parseTime(job.created_at) >= claimedAtMs)) return undefined
  const eligibleAt = addMs(claim.claimedAt, ACTIVE_DUPLICATE_MS)
  if (now >= parseTime(eligibleAt)) return undefined
  return {
    allowed: false,
    code: "active_duplicate",
    eligibleAt,
    reason: `An active submission to this funder is blocked until ${eligibleAt}.`,
  }
}

async function loadJobs(database: DbExecutor, workspaceId: string, dealId: string, funderId: string): Promise<DestinationJob[]> {
  return database.prepare<DestinationJob>(
    `SELECT id, state, created_at, updated_at
     FROM mca_submission_jobs
     WHERE workspace_id = ? AND deal_id = ? AND funder_id = ?
     ORDER BY created_at ASC, id ASC
     FOR UPDATE`,
  ).all(workspaceId, dealId, funderId)
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
}): Promise<void> {
  const metadata = JSON.stringify({ funderId: input.funderId, claimedAt: input.claimedAt })
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
  decision: DuplicateDecision
}): Promise<DuplicateDecision> {
  await writeClaim(database, {
    id: input.claimKey,
    actor: input.actor,
    dealId: input.dealId,
    funderId: input.funderId,
    claimedAt: nowIso(),
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

/** Atomic 2-minute error retry and 24-hour active-duplicate rules for one workspace/deal/funder. */
export async function assertDuplicatePolicy(input: {
  actor: DealActor
  dealId: string
  funderId: string
  privilegedRetry?: boolean
  privilegedReason?: string
}): Promise<DuplicateDecision> {
  return withImmediateTransaction(async (database) => {
    await database.execute(
      "SELECT pg_advisory_xact_lock(hashtext(?), hashtext(?))",
      [`mca-dup:${input.actor.workspaceId}:${input.dealId}`, input.funderId],
    )

    const jobs = await loadJobs(database, input.actor.workspaceId, input.dealId, input.funderId)
    const claimKey = claimId(input.actor.workspaceId, input.dealId, input.funderId)
    const claim = await loadClaim(database, claimKey)
    const now = nowMs()
    // Claim covers the gap between this decision and persistNewDestination on concurrent queueSubmissions.
    const inFlight = inFlightBlock(claim, jobs, now)
    if (inFlight) return inFlight

    const privilegedReason = input.privilegedReason?.trim()
    if (input.privilegedRetry === true && privilegedReason) {
      return allow(database, {
        actor: input.actor,
        dealId: input.dealId,
        funderId: input.funderId,
        claimKey,
        decision: {
          allowed: true,
          code: "privileged_retry",
          reason: privilegedReason,
        },
      })
    }

    let blocked: DuplicateDecision | undefined
    for (const job of jobs) {
      const next = jobBlock(job, now)
      if (next) blocked = moreRestrictive(blocked, next)
    }
    if (blocked) return blocked

    return allow(database, {
      actor: input.actor,
      dealId: input.dealId,
      funderId: input.funderId,
      claimKey,
      decision: { allowed: true },
    })
  })
}
