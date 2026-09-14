import "server-only"

import { assertTrustedMutation, requireMembershipAccess, requireWorkspaceAccess } from "../auth"
import { hashOpaqueToken } from "../crypto"
import { getDatabase, newId, nowIso, parseJson, recordAuditEvent } from "../db"
import { actorForDeals, getDeal, getDealForDocument } from "../deals/service"
import type { DealActor } from "../deals/schema"
import { AppError } from "../errors"
import { requestCorrelationId } from "../http"
import { canManageWorkspace } from "../policy"
import type { ApiKeyScope, AuthContext } from "../types"
import { ANALYSIS_MODES, type AnalysisMode, type AnalysisSnapshot, type FunderScore } from "./contracts"
import { checkCompleteness, getCompleteness } from "./completeness"
import { autoSelectableFunderIds, getDealScores, scoreDeal } from "./scoring"
import { queueSubmissions } from "./submission-port"
import {
  DEFAULT_ANALYSIS_SETTINGS,
  DEFAULT_ANALYSIS_TOP_N,
  REVIEW_NOTIFICATION_CHANNELS,
  findLatestAnalysisRun,
  findMatchingAnalysisRun,
  insertAnalysisRun,
  readAnalysisSettings,
  upsertAnalysisSettings,
  type AnalysisDestination,
  type AnalysisSettings,
  type ReviewNotificationChannel,
  type StoredAnalysisRun,
} from "./analysis-repository"

export {
  DEFAULT_ANALYSIS_SETTINGS,
  DEFAULT_ANALYSIS_TOP_N,
  REVIEW_NOTIFICATION_CHANNELS,
}
export type { AnalysisDestination, AnalysisSettings, ReviewNotificationChannel }

export type AnalysisRunView = StoredAnalysisRun

export interface DealAnalysis {
  settings: AnalysisSettings
  run: AnalysisRunView | null
  destinations: AnalysisDestination[]
  snapshot: AnalysisSnapshot | null
  funders: Array<{ id: string; legalName: string; nickname?: string; active: boolean }>
}

export interface RunAnalysisResult extends DealAnalysis {
  run: AnalysisRunView
  snapshot: AnalysisSnapshot
}

export interface AnalysisRunOverride {
  mode?: AnalysisMode
  topN?: number
  reviewNotificationChannel?: ReviewNotificationChannel
  trigger?: "manual" | "readiness"
}

export interface ReadinessRunResult {
  ran: boolean
  run: AnalysisRunView | null
}

const queueCallLog: Array<{ dealId: string; funderIds: string[]; analysisRunId: string }> = []

export function analysisQueueCallsForTests(): Array<{ dealId: string; funderIds: string[]; analysisRunId: string }> {
  return queueCallLog.map((entry) => ({ ...entry, funderIds: [...entry.funderIds] }))
}

export function resetAnalysisQueueCallsForTests(): void {
  queueCallLog.length = 0
}

function isThenable(value: unknown): value is Promise<unknown> {
  return Boolean(value) && typeof (value as { then?: unknown }).then === "function"
}

async function resolved<T>(value: T | Promise<T>): Promise<T> {
  return isThenable(value) ? await value as T : value
}

async function actorFromContext(context: AuthContext, request: Request): Promise<DealActor> {
  try {
    return { ...await actorForDeals(context), correlationId: requestCorrelationId(request) }
  } catch {
    return {
      workspaceId: context.workspaceId,
      userId: context.userId,
      membershipId: context.membershipId,
      role: context.role,
      managedMembershipIds: [],
      activeMembershipIds: [],
      source: context.authType === "api_key" ? "api_key" : "user",
      correlationId: requestCorrelationId(request),
    }
  }
}

export async function requireAnalysisActor(request: Request, mode: "read" | "write"): Promise<DealActor> {
  if (mode === "write") assertTrustedMutation(request)
  const required = mode === "read" ? "deals:read" : "deals:write"
  const authorization = request.headers.get("authorization")
  if (authorization?.startsWith("Bearer mca_")) {
    const row = await getDatabase().prepare<{ id: string; workspace_id: string; scopes: string; expires_at: string | null }>(
      `SELECT id, workspace_id, scopes, expires_at FROM api_keys WHERE secret_hash = ? AND revoked_at IS NULL`,
    ).get(hashOpaqueToken(authorization.slice(7)))
    if (!row || (row.expires_at && String(row.expires_at) <= nowIso())) {
      throw new AppError(401, "authentication_required", "Sign in to continue.")
    }
    const scopes = parseJson<ApiKeyScope[]>(row.scopes, [])
    if (!scopes.includes(required)) throw new AppError(403, "scope_required", "The API key does not have the required scope.")
    return actorFromContext({
      authType: "api_key",
      userId: null,
      membershipId: null,
      workspaceId: String(row.workspace_id),
      role: null,
      scopes,
      sessionId: null,
    }, request)
  }
  const auth = await resolved(requireWorkspaceAccess(request, { scopes: [required] }))
  if (!auth || typeof auth !== "object" || !("workspaceId" in auth) || typeof auth.workspaceId !== "string") {
    throw new AppError(401, "authentication_required", "Sign in to continue.")
  }
  if (auth.authType === "api_key" && !auth.scopes.includes(required)) {
    throw new AppError(403, "scope_required", "The API key does not have the required scope.")
  }
  return actorFromContext(auth, request)
}

export async function requireAnalysisAdmin(request: Request): Promise<DealActor> {
  assertTrustedMutation(request)
  const auth = await requireMembershipAccess(request, ["admin", "super_admin"])
  return { ...await actorForDeals(auth), correlationId: requestCorrelationId(request) }
}

function assertAdmin(actor: DealActor): void {
  if (!actor.role || !canManageWorkspace(actor.role)) {
    throw new AppError(403, "permission_denied", "Only workspace administrators can update analysis settings.")
  }
}

function parseMode(value: unknown): AnalysisMode | undefined {
  if (value == null) return undefined
  if (typeof value === "string" && (ANALYSIS_MODES as readonly string[]).includes(value)) return value as AnalysisMode
  throw new AppError(422, "validation_failed", "Analysis mode must be analyze_only, review_first, or automatic_send.", {
    mode: ["Choose analyze_only, review_first, or automatic_send."],
  })
}

function parseTopN(value: unknown): number | undefined {
  if (value == null) return undefined
  if (typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 25) return value
  throw new AppError(422, "validation_failed", "Top N must be a whole number from 1 to 25.", {
    topN: ["Enter a whole number from 1 to 25."],
  })
}

function parseChannel(value: unknown): ReviewNotificationChannel | undefined {
  if (value == null) return undefined
  if (typeof value === "string" && REVIEW_NOTIFICATION_CHANNELS.includes(value as ReviewNotificationChannel)) {
    return value as ReviewNotificationChannel
  }
  throw new AppError(422, "validation_failed", "Review notification channel must be select_only, email_only, or both.", {
    reviewNotificationChannel: ["Choose select_only, email_only, or both."],
  })
}

export async function getAnalysisSettings(actor: DealActor): Promise<AnalysisSettings> {
  return readAnalysisSettings(actor.workspaceId)
}

export async function updateAnalysisSettings(actor: DealActor, patch: {
  mode?: AnalysisMode
  topN?: number
  reviewNotificationChannel?: ReviewNotificationChannel
  automaticSendEnabled?: boolean
}): Promise<AnalysisSettings> {
  assertAdmin(actor)
  const current = await readAnalysisSettings(actor.workspaceId)
  const next: AnalysisSettings = {
    mode: parseMode(patch.mode) ?? current.mode,
    topN: parseTopN(patch.topN) ?? current.topN,
    reviewNotificationChannel: parseChannel(patch.reviewNotificationChannel) ?? current.reviewNotificationChannel,
    automaticSendEnabled: typeof patch.automaticSendEnabled === "boolean" ? patch.automaticSendEnabled : current.automaticSendEnabled,
  }
  if (next.mode === "automatic_send" && !next.automaticSendEnabled) {
    throw new AppError(409, "automatic_send_disabled", "Automatic send must be enabled by an administrator before it can be used.")
  }
  const saved = await upsertAnalysisSettings(actor.workspaceId, next, actor.userId, nowIso())
  await recordAuditEvent({
    context: actor,
    action: "analysis.settings_updated",
    resourceType: "workspace",
    resourceId: actor.workspaceId,
    metadata: { mode: saved.mode, topN: saved.topN, automaticSendEnabled: saved.automaticSendEnabled },
    correlationId: actor.correlationId,
  })
  return saved
}

function toView(run: StoredAnalysisRun): AnalysisRunView {
  return run
}

function blockedReason(score: FunderScore): string {
  const failed = score.reasons.find((reason) => reason.result === "fail") ?? score.reasons.find((reason) => reason.result === "unknown")
  return failed?.detail ?? "Disqualified funders cannot be selected."
}

function decideDestinations(
  scores: FunderScore[],
  mode: AnalysisMode,
  topN: number,
  channel: ReviewNotificationChannel,
): { selectedFunderIds: string[]; destinations: AnalysisDestination[]; qualifiedIds: string[] } {
  const qualifiedIds = autoSelectableFunderIds(scores).slice(0, topN)
  const qualifiedSet = new Set(qualifiedIds)
  const preselect = mode !== "analyze_only" && !(mode === "review_first" && channel === "email_only")
  const destinations: AnalysisDestination[] = scores.map((score) => {
    if (!score.eligible || score.grade === "DQ") {
      return { funderId: score.funderId, outcome: "blocked", reason: blockedReason(score) }
    }
    if (mode === "analyze_only") {
      return { funderId: score.funderId, outcome: "excluded", reason: "analyze_only does not change selection" }
    }
    if (!qualifiedSet.has(score.funderId)) {
      return { funderId: score.funderId, outcome: "excluded", reason: "outside top N" }
    }
    if (mode === "review_first" && channel === "email_only") {
      return { funderId: score.funderId, outcome: "selected", reason: "review email candidate" }
    }
    return { funderId: score.funderId, outcome: "selected", reason: "top-N eligible fit" }
  })
  return {
    selectedFunderIds: preselect ? qualifiedIds : [],
    destinations,
    qualifiedIds,
  }
}

async function completenessVersion(actor: DealActor, dealId: string): Promise<number> {
  try {
    const result = await resolved(getCompleteness(actor, dealId))
    if (result && typeof result.version === "number") return result.version
  } catch { /* ignore missing completeness */ }
  return 0
}

function payloadFrom(
  settings: AnalysisSettings,
  run: StoredAnalysisRun | undefined,
  scores: Awaited<ReturnType<typeof getDealScores>>,
): DealAnalysis {
  return {
    settings,
    run: run ? toView(run) : null,
    destinations: run?.destinations ?? [],
    snapshot: scores.snapshot,
    funders: scores.funders,
  }
}

export async function getDealAnalysis(actor: DealActor, dealId: string): Promise<DealAnalysis> {
  const deal = await getDealForDocument(actor, dealId)
  await getDeal(actor, dealId)
  const [settings, run, scores] = await Promise.all([
    readAnalysisSettings(actor.workspaceId),
    findLatestAnalysisRun(actor.workspaceId, deal.id),
    getDealScores(actor, deal.id),
  ])
  return payloadFrom(settings, run, scores)
}

export async function runAnalysis(actor: DealActor, dealId: string, override: AnalysisRunOverride = {}): Promise<RunAnalysisResult> {
  const deal = await getDealForDocument(actor, dealId)
  await getDeal(actor, dealId)
  const workspaceSettings = await readAnalysisSettings(actor.workspaceId)
  const effective: AnalysisSettings = {
    mode: parseMode(override.mode) ?? workspaceSettings.mode,
    topN: parseTopN(override.topN) ?? workspaceSettings.topN,
    reviewNotificationChannel: parseChannel(override.reviewNotificationChannel) ?? workspaceSettings.reviewNotificationChannel,
    automaticSendEnabled: workspaceSettings.automaticSendEnabled,
  }
  const trigger = override.trigger === "readiness" ? "readiness" : "manual"
  const scored = await scoreDeal(actor, deal.id, { mode: effective.mode, topN: effective.topN })
  const version = scored.snapshot.completenessVersion || await completenessVersion(actor, deal.id)
  const existing = await findMatchingAnalysisRun({
    workspaceId: actor.workspaceId,
    dealId: deal.id,
    snapshotId: scored.snapshot.id,
    completenessVersion: version,
    mode: effective.mode,
    topN: effective.topN,
    reviewNotificationChannel: effective.reviewNotificationChannel,
  })
  if (existing) {
    return {
      settings: workspaceSettings,
      run: toView(existing),
      destinations: existing.destinations,
      snapshot: scored.snapshot,
      funders: scored.funders,
    }
  }

  const decided = decideDestinations(scored.snapshot.scores, effective.mode, effective.topN, effective.reviewNotificationChannel)
  let state: StoredAnalysisRun["state"] = "scored"
  let reason = "analyzed"
  let selectedFunderIds = decided.selectedFunderIds
  let queued = false
  const runId = newId()

  if (effective.mode === "analyze_only") {
    selectedFunderIds = []
    state = "scored"
    reason = decided.qualifiedIds.length ? "analyzed" : "no_qualified_funder"
  } else if (effective.mode === "automatic_send" && !effective.automaticSendEnabled) {
    selectedFunderIds = []
    state = "blocked"
    reason = "automatic_send_disabled"
  } else if (decided.qualifiedIds.length === 0) {
    selectedFunderIds = []
    state = "blocked"
    reason = "no_qualified_funder"
  } else if (effective.mode === "review_first") {
    state = "review_pending"
    reason = "review_pending"
  } else {
    queueCallLog.push({ dealId: deal.id, funderIds: [...selectedFunderIds], analysisRunId: runId })
    const queuedJobs = await queueSubmissions({
      actor,
      dealId: deal.id,
      funderIds: selectedFunderIds,
      analysisRunId: runId,
    })
    queued = true
    state = queuedJobs.ok ? "queued" : "submission_unavailable"
    reason = queuedJobs.ok ? "queued" : "submission_unavailable"
  }

  const run = await insertAnalysisRun({
    id: runId,
    workspaceId: actor.workspaceId,
    dealId: deal.id,
    snapshotId: scored.snapshot.id,
    completenessVersion: version,
    trigger,
    mode: effective.mode,
    state,
    topN: effective.topN,
    reviewNotificationChannel: effective.reviewNotificationChannel,
    selectedFunderIds,
    destinations: decided.destinations,
    settingsSnapshot: effective,
    reason,
    queued,
    createdAt: nowIso(),
  })
  await recordAuditEvent({
    context: actor,
    action: "analysis.ran",
    resourceType: "deal",
    resourceId: deal.id,
    metadata: {
      runId: run.id,
      mode: run.mode,
      state: run.state,
      trigger: run.trigger,
      selectedCount: run.selectedFunderIds.length,
      queued: run.queued,
    },
    correlationId: actor.correlationId,
  })
  return {
    settings: workspaceSettings,
    run: toView(run),
    destinations: run.destinations,
    snapshot: scored.snapshot,
    funders: scored.funders,
  }
}

export async function runAnalysisIfReady(actor: DealActor, dealId: string): Promise<ReadinessRunResult> {
  const deal = await getDealForDocument(actor, dealId)
  await getDeal(actor, dealId)
  const completeness = await getCompleteness(actor, deal.id) ?? await checkCompleteness(actor, deal.id)
  if (!completeness.ready) {
    const existing = await findLatestAnalysisRun(actor.workspaceId, deal.id)
    return { ran: false, run: existing ? toView(existing) : null }
  }
  const existing = await findLatestAnalysisRun(actor.workspaceId, deal.id)
  const result = await runAnalysis(actor, deal.id, { trigger: "readiness" })
  return { ran: existing?.id !== result.run.id, run: result.run }
}
