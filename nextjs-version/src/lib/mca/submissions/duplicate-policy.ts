import "server-only"

import { parseJson, recordAuditEvent, withImmediateTransaction, type DbExecutor } from "../db"
import type { DealActor } from "../deals/schema"
import { AppError } from "../errors"
import { nowIso } from "./clock"
import type { DuplicateDecision } from "./contracts"
import {
  DUPLICATE_RETRY_MS,
  DUPLICATE_RULE_COPY,
  evaluateDuplicateWindows,
  isCountingSubmissionState,
} from "./duplicate-rules"

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
  dealId: string
}

function parseTime(iso: string): number {
  const ms = Date.parse(iso)
  return Number.isFinite(ms) ? ms : Number.NaN
}

function nowMs(): number {
  const ms = parseTime(nowIso())
  return Number.isFinite(ms) ? ms : Date.now()
}

function claimId(workspaceId: string, dealId: string, funderId: string): string {
  return `dupclaim:${workspaceId}:${dealId}:${funderId}`
}

function readClaim(row: ClaimRow | undefined): Claim | undefined {
  if (!row) return undefined
  const metadata = parseJson<Partial<Claim>>(row.metadata, {})
  if (!metadata.claimedAt || !Number.isFinite(parseTime(metadata.claimedAt))) return undefined
  return {
    claimedAt: metadata.claimedAt,
    funderId: metadata.funderId ?? "",
    dealId: metadata.dealId ?? "",
  }
}

function inFlightBlock(claim: Claim | undefined, jobs: DestinationJob[], now: number): DuplicateDecision | undefined {
  if (!claim) return undefined
  const claimedAtMs = parseTime(claim.claimedAt)
  if (!Number.isFinite(claimedAtMs)) return undefined
  if (now >= claimedAtMs + DUPLICATE_RETRY_MS) return undefined
  if (jobs.some((job) => {
    if (!isCountingSubmissionState(job.state)) return false
    return parseTime(job.created_at) >= claimedAtMs
  })) return undefined
  const eligibleAt = new Date(claimedAtMs + DUPLICATE_RETRY_MS).toISOString()
  return {
    allowed: false,
    code: "retry_too_soon",
    eligibleAt,
    reason: DUPLICATE_RULE_COPY.inFlight,
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
  const metadata = JSON.stringify({
    funderId: input.funderId,
    dealId: input.dealId,
    claimedAt: input.claimedAt,
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

/** Anyone who can already submit may override the 24-hour rule with an audited reason. */
export function privilegedOverrideAllowed(actor: DealActor): boolean {
  if (actor.source === "user") return Boolean(actor.role)
  return actor.source === "api_key"
}

function assertPrivilegedRetryAllowed(actor: DealActor, privilegedRetry?: boolean): void {
  if (privilegedRetry !== true) return
  if (privilegedOverrideAllowed(actor)) return
  throw new AppError(403, "privileged_retry_forbidden", "The 24-hour duplicate rule can be overridden only by someone who can submit this deal.")
}

/** Deal+funder lock: 2-minute retry block, 24-hour resubmit block with audited override. */
export async function assertDuplicatePolicy(input: {
  actor: DealActor
  dealId: string
  funderId: string
  merchantIdentityKey?: string
  packageFingerprint?: string
  privilegedRetry?: boolean
  privilegedReason?: string
}): Promise<DuplicateDecision> {
  assertPrivilegedRetryAllowed(input.actor, input.privilegedRetry)
  return withImmediateTransaction(async (database) => {
    await database.execute(
      "SELECT pg_advisory_xact_lock(hashtext(?), hashtext(?))",
      [`mca-dup:${input.actor.workspaceId}:${input.dealId}`, input.funderId],
    )

    const jobs = await loadJobs(database, input.actor.workspaceId, input.dealId, input.funderId)
    const claimKey = claimId(input.actor.workspaceId, input.dealId, input.funderId)
    const claim = await loadClaim(database, claimKey)
    const now = nowMs()
    const inFlight = inFlightBlock(claim, jobs, now)
    if (inFlight) return inFlight

    const blocked = evaluateDuplicateWindows(
      jobs.map((job) => ({ state: job.state, createdAt: job.created_at })),
      now,
    )
    if (blocked?.code === "retry_too_soon") return blocked

    const privilegedReason = input.privilegedReason?.trim()
    if (blocked?.code === "recent_duplicate" && input.privilegedRetry === true && privilegedReason) {
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
