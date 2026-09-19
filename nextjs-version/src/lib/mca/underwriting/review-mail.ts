import "server-only"

import { createHash, createHmac, timingSafeEqual } from "node:crypto"
import { assertEmailDeliveryConfigured, deliverEmail } from "../email"
import { getDatabase, newId, nowIso, parseJson, recordAuditEvent, withTransaction } from "../db"
import { getDeal, getDealForDocument } from "../deals/service"
import type { DealActor } from "../deals/schema"
import { AppError } from "../errors"
import { listMemberships } from "../memberships"
import { canManageWorkspace } from "../policy"
import { ROLES, type Role } from "../types"
import { getDealAnalysis, type AnalysisRunView } from "./analysis"
import type { AnalysisDestination } from "./analysis-repository"
import { getCompleteness } from "./completeness"
import type { AnalysisSnapshot, FunderScore } from "./contracts"
import { autoSelectableFunderIds, getDealScores } from "./scoring"
import { evaluateUnderwritingSendGates, underwritingSendGateMessage } from "./send-gates"

export const REVIEW_TOKEN_TTL_MS = 5 * 60_000
export const DEFAULT_REVIEW_ROLES: Role[] = ["admin", "manager", "super_admin"]

export interface ReviewSettings {
  recipientRoles: Role[]
  ccEmails: string[]
}

export interface ReviewRecipient {
  email: string
  role?: Role
  source: "role" | "cc"
}

export interface ReviewCandidate {
  funderId: string
  name: string
  score: number
  grade: FunderScore["grade"]
  eligible: boolean
  selected: boolean
  blocked: boolean
  reasons: FunderScore["reasons"]
  outcome?: AnalysisDestination["outcome"]
  reason?: string
}

export interface ReviewApproval {
  id: string
  runId: string
  snapshotId: string
  selectedFunderIds: string[]
  createdAt: string
}

export interface AnalysisReview {
  dealId: string
  dealName: string
  settings: ReviewSettings
  run: AnalysisRunView | null
  destinations: AnalysisDestination[]
  snapshot: AnalysisSnapshot | null
  funders: Array<{ id: string; legalName: string; nickname?: string; active: boolean }>
  candidates: ReviewCandidate[]
  completenessReady: boolean
  completenessVersion: number
  stale: boolean
  staleReasons: string[]
  disclaimer: string
  approval: ReviewApproval | null
  tokenValid: boolean
  expiresAt?: string
}

export interface SendReviewResult {
  dealId: string
  runId: string
  snapshotId: string
  token: string
  actionUrl: string
  expiresAt: string
  recipients: ReviewRecipient[]
  deliveries: Array<{ recipient: string; delivery: "sent" | "preview"; correlationId: string; previewUrl?: string }>
}

export interface ConfirmReviewResult extends AnalysisReview {
  run: AnalysisRunView
  snapshot: AnalysisSnapshot
  approval: ReviewApproval
}

type RunRow = {
  id: string
  workspace_id: string
  deal_id: string
  snapshot_id: string
  completeness_version: number
  trigger: string
  mode: string
  state: string
  top_n: number
  review_notification_channel: string
  selected_funder_ids: string
  destinations_json: string
  settings_snapshot: string
  reason: string
  queued: number | boolean
  created_at: string
}

type SnapshotRow = {
  id: string
  deal_id: string
  policy_version: number
  underwriting_version: number
  completeness_version: number
  mode: string
  top_n: number
  scores_json: string
  created_at: string
}

type ApprovalRow = {
  id: string
  run_id: string
  snapshot_id: string
  selected_funder_ids: string
  created_at: string
}

function tokenSecret(): Buffer {
  const configured = process.env.MCA_REVIEW_TOKEN_SECRET || process.env.MCA_DOCUMENT_TOKEN_SECRET
  if (configured && configured.length >= 32) return Buffer.from(configured)
  if (process.env.NODE_ENV === "production") {
    throw new AppError(503, "review_tokens_unavailable", "Configure MCA_REVIEW_TOKEN_SECRET before issuing review links.")
  }
  return createHash("sha256").update("mca-local-review-token-secret").digest()
}

function signToken(payload: string): string {
  return createHmac("sha256", tokenSecret()).update(payload).digest("base64url")
}

function invalidLink(): never {
  throw new AppError(404, "review_link_invalid", "This review link is invalid or expired.")
}

function sameIds(left: string[], right: string[]): boolean {
  if (left.length !== right.length) return false
  const other = [...right].sort()
  return [...left].sort().every((id, index) => id === other[index])
}

function uniqueIds(ids: unknown): string[] {
  if (!Array.isArray(ids)) {
    throw new AppError(422, "validation_failed", "Select at least one eligible funder.", {
      selectedFunderIds: ["Select at least one eligible funder."],
    })
  }
  const seen = new Set<string>()
  const values: string[] = []
  for (const id of ids) {
    if (typeof id !== "string") {
      throw new AppError(422, "validation_failed", "Select at least one eligible funder.", {
        selectedFunderIds: ["Choose funders from this analysis snapshot."],
      })
    }
    const value = id.trim()
    if (!value || seen.has(value)) continue
    seen.add(value)
    values.push(value)
  }
  return values
}

function parseRoles(value: unknown, fallback: Role[]): Role[] {
  if (value == null) return [...fallback]
  if (!Array.isArray(value) || value.some((role) => typeof role !== "string" || !(ROLES as readonly string[]).includes(role))) {
    throw new AppError(422, "validation_failed", "Review recipient roles must be workspace roles.", {
      recipientRoles: ["Choose one or more of rep, manager, admin, or super_admin."],
    })
  }
  return [...new Set(value as Role[])]
}

function parseEmails(value: unknown, fallback: string[]): string[] {
  if (value == null) return [...fallback]
  if (!Array.isArray(value) || value.some((email) => typeof email !== "string")) {
    throw new AppError(422, "validation_failed", "Workspace CC must be a list of email addresses.", {
      ccEmails: ["Enter valid email addresses."],
    })
  }
  const emails: string[] = []
  const seen = new Set<string>()
  for (const raw of value as string[]) {
    const email = raw.trim().toLowerCase()
    if (!email) continue
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      throw new AppError(422, "validation_failed", "Workspace CC must be a list of email addresses.", {
        ccEmails: ["Enter valid email addresses."],
      })
    }
    if (seen.has(email)) continue
    seen.add(email)
    emails.push(email)
  }
  if (emails.length > 25) {
    throw new AppError(422, "validation_failed", "Workspace CC is limited to 25 addresses.", {
      ccEmails: ["Remove extra CC addresses. 25 is the maximum."],
    })
  }
  return emails
}

function mapRun(row: RunRow): AnalysisRunView {
  const settingsSnapshot = parseJson<Record<string, unknown>>(row.settings_snapshot, {
    mode: "review_first",
    topN: 5,
    reviewNotificationChannel: "both",
    automaticSendEnabled: false,
  })
  const snapshotMode = settingsSnapshot.mode
  const snapshotChannel = settingsSnapshot.reviewNotificationChannel
  return {
    id: String(row.id),
    workspaceId: String(row.workspace_id),
    dealId: String(row.deal_id),
    snapshotId: String(row.snapshot_id),
    completenessVersion: Number(row.completeness_version),
    trigger: row.trigger === "readiness" ? "readiness" : "manual",
    mode: row.mode === "analyze_only" || row.mode === "automatic_send" ? row.mode : "review_first",
    state: row.state as AnalysisRunView["state"],
    topN: Number(row.top_n),
    reviewNotificationChannel: row.review_notification_channel === "select_only" || row.review_notification_channel === "email_only"
      ? row.review_notification_channel
      : "both",
    selectedFunderIds: parseJson<string[]>(row.selected_funder_ids, []),
    destinations: parseJson<AnalysisDestination[]>(row.destinations_json, []),
    settingsSnapshot: {
      mode: snapshotMode === "analyze_only" || snapshotMode === "automatic_send" ? snapshotMode : "review_first",
      topN: Number(settingsSnapshot.topN) || 5,
      reviewNotificationChannel: snapshotChannel === "select_only" || snapshotChannel === "email_only" ? snapshotChannel : "both",
      automaticSendEnabled: Boolean(settingsSnapshot.automaticSendEnabled),
    },
    reason: String(row.reason),
    queued: Boolean(row.queued),
    createdAt: String(row.created_at),
  }
}

function mapSnapshot(row: SnapshotRow): AnalysisSnapshot {
  return {
    id: String(row.id),
    dealId: String(row.deal_id),
    policyVersion: Number(row.policy_version),
    underwritingVersion: Number(row.underwriting_version),
    completenessVersion: Number(row.completeness_version),
    mode: row.mode === "review_first" || row.mode === "automatic_send" ? row.mode : "analyze_only",
    topN: Number(row.top_n),
    scores: parseJson<FunderScore[]>(row.scores_json, []),
    createdAt: String(row.created_at),
  }
}

function mapApproval(row: ApprovalRow): ReviewApproval {
  return {
    id: String(row.id),
    runId: String(row.run_id),
    snapshotId: String(row.snapshot_id),
    selectedFunderIds: parseJson<string[]>(row.selected_funder_ids, []),
    createdAt: String(row.created_at),
  }
}

function mapSettings(row: { recipient_roles: string; cc_emails: string } | undefined): ReviewSettings {
  if (!row) return { recipientRoles: [...DEFAULT_REVIEW_ROLES], ccEmails: [] }
  const roles = parseJson<string[]>(row.recipient_roles, DEFAULT_REVIEW_ROLES)
    .filter((role): role is Role => (ROLES as readonly string[]).includes(role))
  return {
    recipientRoles: roles.length ? roles : [...DEFAULT_REVIEW_ROLES],
    ccEmails: parseJson<string[]>(row.cc_emails, []),
  }
}

function funderName(funders: AnalysisReview["funders"], funderId: string): string {
  const match = funders.find((funder) => funder.id === funderId)
  return match?.nickname || match?.legalName || funderId
}

function candidatesFor(run: AnalysisRunView, snapshot: AnalysisSnapshot, funders: AnalysisReview["funders"], approval: ReviewApproval | null): ReviewCandidate[] {
  const selected = new Set(
    approval?.selectedFunderIds.length
      ? approval.selectedFunderIds
      : run.selectedFunderIds.length
        ? run.selectedFunderIds
        : run.destinations.filter((row) => row.outcome === "selected").map((row) => row.funderId),
  )
  const destinations = new Map(run.destinations.map((row) => [row.funderId, row]))
  return [...snapshot.scores]
    .sort((left, right) => left.rank - right.rank || left.funderId.localeCompare(right.funderId))
    .map((score) => {
      const destination = destinations.get(score.funderId)
      const eligible = score.eligible && score.grade !== "DQ"
      return {
        funderId: score.funderId,
        name: funderName(funders, score.funderId),
        score: score.score,
        grade: score.grade,
        eligible,
        selected: selected.has(score.funderId),
        blocked: !eligible,
        reasons: score.reasons,
        ...(destination ? { outcome: destination.outcome, reason: destination.reason } : {}),
      }
    })
}

async function findRun(workspaceId: string, runId: string): Promise<AnalysisRunView | undefined> {
  const row = await getDatabase().prepare<RunRow>(
    `SELECT * FROM mca_analysis_runs WHERE workspace_id = ? AND id = ?`,
  ).get(workspaceId, runId)
  return row ? mapRun(row) : undefined
}

async function findSnapshot(workspaceId: string, snapshotId: string): Promise<AnalysisSnapshot | undefined> {
  const row = await getDatabase().prepare<SnapshotRow>(
    `SELECT id, deal_id, policy_version, underwriting_version, completeness_version, mode, top_n, scores_json, created_at
     FROM mca_score_snapshots WHERE workspace_id = ? AND id = ?`,
  ).get(workspaceId, snapshotId)
  return row ? mapSnapshot(row) : undefined
}

async function findApproval(workspaceId: string, runId: string, snapshotId: string): Promise<ReviewApproval | undefined> {
  const row = await getDatabase().prepare<ApprovalRow>(
    `SELECT id, run_id, snapshot_id, selected_funder_ids, created_at
     FROM mca_review_approvals WHERE workspace_id = ? AND run_id = ? AND snapshot_id = ?`,
  ).get(workspaceId, runId, snapshotId)
  return row ? mapApproval(row) : undefined
}

function parseReviewToken(token: string, actor: DealActor, now: number): {
  runId: string
  snapshotId: string
  dealId: string
  workspaceId: string
  expiresAt: number
} {
  const [payload, signature] = token.split(".")
  if (!payload || !signature) invalidLink()
  const expected = Buffer.from(signToken(payload))
  const supplied = Buffer.from(signature)
  if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) invalidLink()
  let data: { r?: string; s?: string; d?: string; w?: string; e?: number }
  try {
    data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as typeof data
  } catch {
    invalidLink()
  }
  if (!data.r || !data.s || !data.d || !data.w || !data.e) invalidLink()
  if (data.w !== actor.workspaceId || data.e < now) invalidLink()
  return { runId: data.r, snapshotId: data.s, dealId: data.d, workspaceId: data.w, expiresAt: data.e }
}

function createReviewToken(input: { runId: string; snapshotId: string; dealId: string; workspaceId: string; now: number }): { token: string; expiresAt: string; expires: number } {
  const expires = input.now + REVIEW_TOKEN_TTL_MS
  const payload = Buffer.from(JSON.stringify({
    r: input.runId,
    s: input.snapshotId,
    d: input.dealId,
    w: input.workspaceId,
    e: expires,
  })).toString("base64url")
  return { token: `${payload}.${signToken(payload)}`, expiresAt: new Date(expires).toISOString(), expires }
}

async function buildReview(actor: DealActor, run: AnalysisRunView | null, options: {
  dealId: string
  tokenValid: boolean
  expiresAt?: string
  snapshot?: AnalysisSnapshot | null
}): Promise<AnalysisReview> {
  const deal = await getDeal(actor, options.dealId)
  const [settings, scores, completeness, snapshot, approval] = await Promise.all([
    getReviewSettings(actor),
    getDealScores(actor, deal.id),
    getCompleteness(actor, deal.id),
    options.snapshot !== undefined
      ? Promise.resolve(options.snapshot)
      : run ? findSnapshot(actor.workspaceId, run.snapshotId) : Promise.resolve(null),
    run ? findApproval(actor.workspaceId, run.id, run.snapshotId) : Promise.resolve(undefined),
  ])
  const bound = snapshot ?? scores.snapshot
  const stale = Boolean(run) && (scores.stale || !scores.snapshot || scores.snapshot.id !== run!.snapshotId)
  const staleReasons = stale
    ? (scores.snapshot?.id !== run!.snapshotId && !scores.staleReasons.includes("later analysis snapshot")
      ? [...scores.staleReasons, "later analysis snapshot"]
      : scores.staleReasons)
    : []
  return {
    dealId: deal.id,
    dealName: deal.legalName?.trim() || deal.displayId,
    settings,
    run,
    destinations: run?.destinations ?? [],
    snapshot: bound,
    funders: scores.funders,
    candidates: run && bound ? candidatesFor(run, bound, scores.funders, approval ?? null) : [],
    completenessReady: Boolean(completeness?.ready),
    completenessVersion: completeness?.version ?? run?.completenessVersion ?? 0,
    stale,
    staleReasons,
    disclaimer: scores.disclaimer,
    approval: approval ?? null,
    tokenValid: options.tokenValid,
    ...(options.expiresAt ? { expiresAt: options.expiresAt } : {}),
  }
}

export async function getReviewSettings(actor: DealActor): Promise<ReviewSettings> {
  const row = await getDatabase().prepare<{ recipient_roles: string; cc_emails: string }>(
    `SELECT recipient_roles, cc_emails FROM mca_review_settings WHERE workspace_id = ?`,
  ).get(actor.workspaceId)
  return mapSettings(row)
}

export async function updateReviewSettings(actor: DealActor, patch: {
  recipientRoles?: Role[]
  ccEmails?: string[]
}): Promise<ReviewSettings> {
  if (!actor.role || !canManageWorkspace(actor.role)) {
    throw new AppError(403, "permission_denied", "Only workspace administrators can update review recipients.")
  }
  const current = await getReviewSettings(actor)
  const next: ReviewSettings = {
    recipientRoles: parseRoles(patch.recipientRoles, current.recipientRoles),
    ccEmails: parseEmails(patch.ccEmails, current.ccEmails),
  }
  await getDatabase().prepare(`INSERT INTO mca_review_settings
    (workspace_id, recipient_roles, cc_emails, updated_at, updated_by_user_id)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(workspace_id) DO UPDATE SET
      recipient_roles = excluded.recipient_roles,
      cc_emails = excluded.cc_emails,
      updated_at = excluded.updated_at,
      updated_by_user_id = excluded.updated_by_user_id`).run(
    actor.workspaceId,
    JSON.stringify(next.recipientRoles),
    JSON.stringify(next.ccEmails),
    nowIso(),
    actor.userId,
  )
  await recordAuditEvent({
    context: actor,
    action: "review.settings_updated",
    resourceType: "workspace",
    resourceId: actor.workspaceId,
    metadata: { recipientRoles: next.recipientRoles, ccCount: next.ccEmails.length },
    correlationId: actor.correlationId,
  })
  return next
}

export async function resolveReviewRecipients(actor: DealActor): Promise<ReviewRecipient[]> {
  const settings = await getReviewSettings(actor)
  const members = await listMemberships(actor.workspaceId)
  const recipients: ReviewRecipient[] = []
  const seen = new Set<string>()
  for (const member of members) {
    if (member.status !== "active") continue
    if (!settings.recipientRoles.includes(member.role)) continue
    const email = member.email.trim().toLowerCase()
    if (!email || seen.has(email)) continue
    seen.add(email)
    recipients.push({ email, role: member.role, source: "role" })
  }
  for (const email of settings.ccEmails) {
    if (seen.has(email)) continue
    seen.add(email)
    recipients.push({ email, source: "cc" })
  }
  return recipients
}

function assertReviewable(run: AnalysisRunView | null | undefined): asserts run is AnalysisRunView {
  if (!run) throw new AppError(409, "no_analysis_run", "Run funder analysis before sending a review.")
  if (run.state !== "review_pending" && run.state !== "approved") {
    throw new AppError(409, "review_not_pending", "This analysis run is not waiting for review.")
  }
}

export async function sendAnalysisReview(actor: DealActor, dealId: string, options: {
  origin?: string
  now?: number
} = {}): Promise<SendReviewResult> {
  assertEmailDeliveryConfigured()
  const deal = await getDealForDocument(actor, dealId)
  await getDeal(actor, deal.id)
  const analysis = await getDealAnalysis(actor, deal.id)
  assertReviewable(analysis.run)
  const recipients = await resolveReviewRecipients(actor)
  if (!recipients.length) {
    throw new AppError(422, "no_review_recipients", "No active members or CC addresses are configured for review email.")
  }
  const now = options.now ?? Date.now()
  const signed = createReviewToken({
    runId: analysis.run.id,
    snapshotId: analysis.run.snapshotId,
    dealId: deal.id,
    workspaceId: actor.workspaceId,
    now,
  })
  const origin = (options.origin || process.env.MCA_APP_ORIGIN || "http://localhost:3000").replace(/\/$/, "")
  const actionUrl = `${origin}/review/${encodeURIComponent(signed.token)}`
  const deliveries: SendReviewResult["deliveries"] = []
  for (const recipient of recipients) {
    const result = await deliverEmail({
      recipient: recipient.email,
      template: "funder_analysis_review",
      actionUrl,
      expiresAt: signed.expiresAt,
    })
    deliveries.push({
      recipient: recipient.email,
      delivery: result.delivery,
      correlationId: result.correlationId,
      ...(result.previewUrl ? { previewUrl: result.previewUrl } : {}),
    })
  }
  await recordAuditEvent({
    context: actor,
    action: "review.email_sent",
    resourceType: "deal",
    resourceId: deal.id,
    metadata: {
      runId: analysis.run.id,
      snapshotId: analysis.run.snapshotId,
      recipientCount: recipients.length,
      expiresAt: signed.expiresAt,
    },
    correlationId: actor.correlationId,
  })
  return {
    dealId: deal.id,
    runId: analysis.run.id,
    snapshotId: analysis.run.snapshotId,
    token: signed.token,
    actionUrl,
    expiresAt: signed.expiresAt,
    recipients,
    deliveries,
  }
}

export async function getDealReview(actor: DealActor, dealId: string): Promise<AnalysisReview> {
  const deal = await getDealForDocument(actor, dealId)
  await getDeal(actor, deal.id)
  const analysis = await getDealAnalysis(actor, deal.id)
  return buildReview(actor, analysis.run, { dealId: deal.id, tokenValid: false, snapshot: analysis.snapshot })
}

export async function getReviewByToken(actor: DealActor, token: string, now = Date.now()): Promise<AnalysisReview> {
  const parsed = parseReviewToken(token, actor, now)
  const run = await findRun(actor.workspaceId, parsed.runId)
  if (!run || run.dealId !== parsed.dealId || run.snapshotId !== parsed.snapshotId) invalidLink()
  await getDealForDocument(actor, run.dealId)
  const snapshot = await findSnapshot(actor.workspaceId, run.snapshotId)
  if (!snapshot) invalidLink()
  return buildReview(actor, run, {
    dealId: run.dealId,
    tokenValid: true,
    expiresAt: new Date(parsed.expiresAt).toISOString(),
    snapshot,
  })
}

async function persistApproval(actor: DealActor, run: AnalysisRunView, selectedFunderIds: string[]): Promise<ReviewApproval> {
  return withTransaction(async (database) => {
    await database.prepare("SELECT id FROM mca_analysis_runs WHERE workspace_id = ? AND id = ? AND snapshot_id = ? FOR UPDATE")
      .get(actor.workspaceId, run.id, run.snapshotId)
    const existing = await findApproval(actor.workspaceId, run.id, run.snapshotId)
    const createdAt = existing?.createdAt ?? nowIso()
    const id = existing?.id ?? newId()
    await database.prepare(`INSERT INTO mca_review_approvals
      (id, workspace_id, deal_id, run_id, snapshot_id, selected_funder_ids, actor_user_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (workspace_id, run_id, snapshot_id) DO UPDATE SET
        selected_funder_ids = excluded.selected_funder_ids`).run(
      id,
      actor.workspaceId,
      run.dealId,
      run.id,
      run.snapshotId,
      JSON.stringify(selectedFunderIds),
      actor.userId,
      createdAt,
    )
    await database.prepare(`UPDATE mca_analysis_runs
      SET state = 'approved', selected_funder_ids = ?, reason = 'approved'
      WHERE id = ? AND workspace_id = ? AND snapshot_id = ?`).run(
      JSON.stringify(selectedFunderIds),
      run.id,
      actor.workspaceId,
      run.snapshotId,
    )
    const saved = await findApproval(actor.workspaceId, run.id, run.snapshotId)
    if (!saved) throw new AppError(500, "internal_error", "The review approval could not be stored.")
    return saved
  })
}

export async function confirmAnalysisReview(actor: DealActor, input: {
  token?: string
  dealId?: string
  selectedFunderIds: unknown
  now?: number
}): Promise<ConfirmReviewResult> {
  const selectedFunderIds = uniqueIds(input.selectedFunderIds)
  if (!selectedFunderIds.length) {
    throw new AppError(422, "validation_failed", "Select at least one eligible funder.", {
      selectedFunderIds: ["Select at least one eligible funder."],
    })
  }
  let run: AnalysisRunView | undefined
  let snapshot: AnalysisSnapshot | undefined
  let tokenValid = false
  let expiresAt: string | undefined
  if (input.token) {
    const parsed = parseReviewToken(input.token, actor, input.now ?? Date.now())
    run = await findRun(actor.workspaceId, parsed.runId)
    if (!run || run.dealId !== parsed.dealId || run.snapshotId !== parsed.snapshotId) invalidLink()
    snapshot = await findSnapshot(actor.workspaceId, run.snapshotId)
    if (!snapshot) invalidLink()
    tokenValid = true
    expiresAt = new Date(parsed.expiresAt).toISOString()
  } else if (input.dealId) {
    const deal = await getDealForDocument(actor, input.dealId)
    const analysis = await getDealAnalysis(actor, deal.id)
    assertReviewable(analysis.run)
    run = analysis.run
    snapshot = analysis.snapshot ?? await findSnapshot(actor.workspaceId, run.snapshotId)
  } else {
    throw new AppError(422, "validation_failed", "A review token or deal is required.")
  }
  assertReviewable(run)
  await getDealForDocument(actor, run.dealId)
  const existing = await findApproval(actor.workspaceId, run.id, run.snapshotId)
  if (existing && sameIds(existing.selectedFunderIds, selectedFunderIds)) {
    const view = await buildReview(actor, { ...run, state: "approved", selectedFunderIds, reason: "approved" }, {
      dealId: run.dealId,
      tokenValid,
      expiresAt,
      snapshot: snapshot ?? null,
    })
    return { ...view, run: view.run!, snapshot: view.snapshot!, approval: existing }
  }
  const gate = await evaluateUnderwritingSendGates(actor, run.dealId)
  if (!gate.completenessReady) {
    throw new AppError(409, "deal_not_ready", underwritingSendGateMessage("completeness_not_ready"))
  }
  if (gate.proposedPositionCount > 0) {
    throw new AppError(409, "positions_unconfirmed", underwritingSendGateMessage("positions_unconfirmed"))
  }
  const scores = await getDealScores(actor, run.dealId)
  if (scores.stale || !scores.snapshot || scores.snapshot.id !== run.snapshotId) {
    throw new AppError(409, "scores_stale", "Funder scores changed. Re-run analysis before confirming this snapshot.")
  }
  const bound = snapshot ?? scores.snapshot
  const allowed = new Set(autoSelectableFunderIds(bound.scores))
  if (selectedFunderIds.some((id) => !allowed.has(id))) {
    throw new AppError(422, "validation_failed", "Disqualified funders cannot be selected.", {
      selectedFunderIds: ["Choose eligible funders from this analysis snapshot."],
    })
  }
  const approval = await persistApproval(actor, run, selectedFunderIds)
  await recordAuditEvent({
    context: actor,
    action: "review.approved",
    resourceType: "deal",
    resourceId: run.dealId,
    metadata: {
      approvalId: approval.id,
      runId: run.id,
      snapshotId: run.snapshotId,
      selectedCount: selectedFunderIds.length,
    },
    correlationId: actor.correlationId,
  })
  const updated = { ...run, state: "approved" as const, selectedFunderIds, reason: "approved" }
  const view = await buildReview(actor, updated, { dealId: run.dealId, tokenValid, expiresAt, snapshot: bound })
  return { ...view, run: view.run!, snapshot: view.snapshot!, approval }
}
