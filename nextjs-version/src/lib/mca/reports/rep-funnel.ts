import "server-only"

import { requireWorkspaceAccess } from "../auth"
import { getDatabase } from "../db"
import { actorForDeals } from "../deals/service"
import type { DealActor } from "../deals/schema"
import { AppError } from "../errors"
import { requestCorrelationId } from "../http"
import { effectivePageVisibility, isActionAllowed } from "../policy"
import { getWorkspaceSettings } from "../workspaces"
import { REPORT_BASES, type ReportFilters, type ReportPermissionState } from "./contracts"

export const FUNNEL_STAGES = ["created", "submitted", "approved", "funded"] as const
export type FunnelStage = (typeof FUNNEL_STAGES)[number]

/** Full credit on every assigned originator and closer. Company totals stay unique-deal. */
export const SHARED_REP_ATTRIBUTION = {
  dealCredit: "full_per_assigned_rep",
  companyTotals: "unique_deals",
  distributions: "recipient_membership",
  assignmentKinds: ["originator", "closer"],
} as const

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/
const SUBMITTED_SUBMISSION_STATUSES = new Set(["sent", "errored", "declined", "approved"])
const SUBMITTED_JOB_STATES = new Set(["sent", "sending", "pending_portal"])
const APPROVED_SUBMISSION_STATUSES = new Set(["approved"])
const APPROVED_OFFER_STATUSES = new Set(["received", "presented", "accepted"])
const APPROVED_ACTIVITY = new Set(["offer", "contract", "funded"])
const SUBMITTED_ACTIVITY = new Set(["submitted", "resubmitting"])

export interface StageMetric {
  dealCount: number
  knownAmountCents: number
  unknownAmountCount: number
  complete: boolean
  restricted: boolean
}

export interface ConversionMetric {
  from: FunnelStage
  to: FunnelStage
  numerator: number
  denominator: number
  rate: number | null
}

export interface DistributionMetric {
  visible: boolean
  expectedCents?: number
  paidCents?: number
  count?: number
  reason?: ReportPermissionState["reason"]
}

export interface RepFunnelRow {
  membershipId: string | null
  name: string
  stages: Record<FunnelStage, StageMetric>
  conversions: ConversionMetric[]
  distributions: DistributionMetric
}

export interface FunnelDealRow {
  dealId: string
  displayId: string
  legalName: string
  stage: FunnelStage
  occurredOn: string | null
  amountCents: number | null
  attributedMembershipIds: string[]
  shared: boolean
}

export interface FunnelPeriod {
  from?: string
  to?: string
  timezone: string
  complete: boolean
  label: string
}

export interface RepFunnelReport {
  filters: ReportFilters
  period: FunnelPeriod
  permission: ReportPermissionState
  attribution: typeof SHARED_REP_ATTRIBUTION
  totals: RepFunnelRow
  reps: RepFunnelRow[]
  unassigned: RepFunnelRow | null
  drilldown: Record<FunnelStage, FunnelDealRow[]>
}

interface DealFacts {
  id: string
  displayId: string
  legalName: string
  requestedAmountCents: number | null
  createdAt: string
  createdOn: string
  submittedAt: string | null
  submittedOn: string | null
  approvedAt: string | null
  approvedOn: string | null
  fundedAt: string | null
  fundedOn: string | null
  submitted: boolean
  approved: boolean
  funded: boolean
  approvedAmountCents: number | null
  fundedAmountCents: number | null
  membershipIds: string[]
  funderIds: string[]
  sourceIds: string[]
  batchIds: string[]
}

interface DistributionFact {
  id: string
  dealId: string
  recipientMembershipId: string
  amountCents: number
  status: "expected" | "paid"
  occurredAt: string
  occurredOn: string
}

function isReportBasis(value: string | null): value is ReportFilters["basis"] {
  return value != null && (REPORT_BASES as readonly string[]).includes(value)
}

function uniqueIds(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))]
}

function collectIds(search: URLSearchParams, key: string): string[] {
  return uniqueIds(search.getAll(key).flatMap((value) => value.split(",")))
}

function assertDateOnly(name: string, value: string | undefined): void {
  if (value && !DATE_ONLY.test(value)) {
    throw new AppError(422, "invalid_filter", `${name} must use YYYY-MM-DD.`, { [name]: ["Use YYYY-MM-DD."] })
  }
  if (value) {
    const parsed = new Date(`${value}T00:00:00.000Z`)
    if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
      throw new AppError(422, "invalid_filter", `${name} must be a real calendar date.`, { [name]: ["Use a real calendar date."] })
    }
  }
}

export function parseReportFilters(search: URLSearchParams): ReportFilters {
  const basis = search.get("basis")
  if (!isReportBasis(basis)) {
    throw new AppError(422, "invalid_filter", "basis is required and must be event or cohort.", { basis: ["Choose event or cohort."] })
  }
  const from = search.get("from")?.trim() || undefined
  const to = search.get("to")?.trim() || undefined
  assertDateOnly("from", from)
  assertDateOnly("to", to)
  if (from && to && from > to) {
    throw new AppError(422, "invalid_filter", "from must be on or before to.", { from: ["from must be on or before to."] })
  }
  const membershipIds = collectIds(search, "membershipIds")
  const funderIds = collectIds(search, "funderIds")
  const sourceIds = collectIds(search, "sourceIds")
  const batchIds = collectIds(search, "batchIds")
  return {
    basis,
    ...(from ? { from } : {}),
    ...(to ? { to } : {}),
    ...(membershipIds.length ? { membershipIds } : {}),
    ...(funderIds.length ? { funderIds } : {}),
    ...(sourceIds.length ? { sourceIds } : {}),
    ...(batchIds.length ? { batchIds } : {}),
  }
}

export function calendarDateInTimeZone(value: string, timeZone: string): string {
  if (DATE_ONLY.test(value)) return value
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ""
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(date)
  const year = parts.find((part) => part.type === "year")?.value
  const month = parts.find((part) => part.type === "month")?.value
  const day = parts.find((part) => part.type === "day")?.value
  return year && month && day ? `${year}-${month}-${day}` : ""
}

export function dateInInclusiveRange(date: string | null | undefined, from?: string, to?: string): boolean {
  if (!date) return false
  if (from && date < from) return false
  if (to && date > to) return false
  return true
}

export function requestedAmountToCents(value: unknown): number | null {
  if (value == null || value === "") return null
  const numeric = typeof value === "number" ? value : Number(value)
  if (!Number.isFinite(numeric) || numeric < 0) return null
  const cents = Math.round(numeric * 100)
  return Number.isSafeInteger(cents) ? cents : null
}

export function conversionRate(numerator: number, denominator: number): number | null {
  if (denominator <= 0) return null
  return numerator / denominator
}

export function conversionsFor(stages: Record<FunnelStage, StageMetric>): ConversionMetric[] {
  const pairs: Array<[FunnelStage, FunnelStage]> = [
    ["created", "submitted"],
    ["submitted", "approved"],
    ["approved", "funded"],
    ["created", "funded"],
  ]
  return pairs.map(([from, to]) => {
    const denominator = stages[from].dealCount
    const numerator = stages[to].dealCount
    return { from, to, numerator, denominator, rate: conversionRate(numerator, denominator) }
  })
}

export function stageMetric(deals: Array<{ amountCents: number | null }>, restricted: boolean): StageMetric {
  if (restricted) {
    return { dealCount: deals.length, knownAmountCents: 0, unknownAmountCount: 0, complete: false, restricted: true }
  }
  let knownAmountCents = 0
  let unknownAmountCount = 0
  for (const deal of deals) {
    if (deal.amountCents == null) unknownAmountCount += 1
    else knownAmountCents += deal.amountCents
  }
  return {
    dealCount: deals.length,
    knownAmountCents,
    unknownAmountCount,
    complete: unknownAmountCount === 0,
    restricted: false,
  }
}

export function drilldownReconciles(report: Pick<RepFunnelReport, "totals" | "drilldown">): boolean {
  return FUNNEL_STAGES.every((stage) => {
    const rows = report.drilldown[stage]
    const metric = report.totals.stages[stage]
    if (rows.length !== metric.dealCount) return false
    if (new Set(rows.map((row) => row.dealId)).size !== rows.length) return false
    if (metric.restricted) return true
    const unknown = rows.filter((row) => row.amountCents == null).length
    const known = rows.reduce((sum, row) => sum + (row.amountCents ?? 0), 0)
    return unknown === metric.unknownAmountCount && known === metric.knownAmountCents
  })
}

function earliest(values: Array<string | null | undefined>): string | null {
  const usable = values.filter((value): value is string => Boolean(value))
  if (!usable.length) return null
  return usable.reduce((min, value) => (value < min ? value : min))
}

function emptyDistributions(permission: ReportPermissionState): DistributionMetric {
  if (!permission.paymentsVisible) {
    return { visible: false, reason: "payment_permission_required" }
  }
  return { visible: true, expectedCents: 0, paidCents: 0, count: 0 }
}

function addDistribution(metric: DistributionMetric, amountCents: number, status: "expected" | "paid"): DistributionMetric {
  if (!metric.visible) return metric
  return {
    visible: true,
    expectedCents: (metric.expectedCents ?? 0) + (status === "expected" ? amountCents : 0),
    paidCents: (metric.paidCents ?? 0) + (status === "paid" ? amountCents : 0),
    count: (metric.count ?? 0) + 1,
  }
}

function periodFor(filters: ReportFilters, timezone: string, nowIso: string): FunnelPeriod {
  const today = calendarDateInTimeZone(nowIso, timezone)
  const complete = Boolean(filters.to && filters.to < today)
  const label = !filters.to
    ? "No end date — later events may still arrive."
    : filters.to >= today
      ? "This period includes today or a future date and is incomplete."
      : `Inclusive ${filters.from ?? "start"} to ${filters.to} (${timezone}).`
  return { from: filters.from, to: filters.to, timezone, complete, label }
}

export async function requireRepFunnelActor(request: Request): Promise<DealActor> {
  const context = await requireWorkspaceAccess(request, {
    sessionOnly: true,
    roles: ["admin", "super_admin"],
    scopes: ["deals:read"],
  })
  const settings = await getWorkspaceSettings(context.workspaceId)
  const pages = context.role ? effectivePageVisibility(context.role, settings.pageVisibility, settings.featureFlags) : null
  if (!pages?.reports) {
    throw new AppError(403, "reports_disabled", "Reports are disabled for this workspace.")
  }
  return { ...await actorForDeals(context), correlationId: requestCorrelationId(request) }
}

async function reportPermission(actor: DealActor): Promise<ReportPermissionState> {
  const settings = await getWorkspaceSettings(actor.workspaceId)
  const pages = actor.role ? effectivePageVisibility(actor.role, settings.pageVisibility, settings.featureFlags) : null
  if (!pages?.reports) {
    return { allowed: false, paymentsVisible: false, companyTotalsVisible: false, reason: "reports_disabled" }
  }
  const paymentsVisible = Boolean(pages.payments && actor.role && isActionAllowed(actor.role, "viewPaymentTable", settings.actionVisibility))
  const companyTotalsVisible = Boolean(actor.role && isActionAllowed(actor.role, "viewCompanyFinancials", settings.actionVisibility))
  const reason = !paymentsVisible
    ? "payment_permission_required"
    : !companyTotalsVisible
      ? "company_totals_restricted"
      : undefined
  return { allowed: true, paymentsVisible, companyTotalsVisible, reason }
}

async function assertKnownIds(workspaceId: string, table: string, column: string, ids: string[] | undefined, field: string, message: string): Promise<void> {
  if (!ids?.length) return
  const rows = await getDatabase().prepare<{ id: string }>(
    `SELECT ${column} AS id FROM ${table} WHERE workspace_id = ? AND ${column} IN (${ids.map(() => "?").join(",")})`,
  ).all(workspaceId, ...ids)
  if (rows.length !== new Set(ids).size) {
    throw new AppError(422, "invalid_filter", message, { [field]: [message] })
  }
}

function inRangeForStage(on: string | null, filters: ReportFilters, createdOn: string): boolean {
  if (filters.basis === "cohort") return dateInInclusiveRange(createdOn, filters.from, filters.to)
  return dateInInclusiveRange(on, filters.from, filters.to)
}

function amountRestricted(permission: ReportPermissionState, companyRow: boolean): boolean {
  return companyRow && !permission.companyTotalsVisible
}

function buildRow(
  membershipId: string | null,
  name: string,
  stageDeals: Record<FunnelStage, FunnelDealRow[]>,
  distributions: DistributionMetric,
  permission: ReportPermissionState,
  companyRow: boolean,
): RepFunnelRow {
  const restricted = amountRestricted(permission, companyRow)
  const stages = {
    created: stageMetric(stageDeals.created, restricted),
    submitted: stageMetric(stageDeals.submitted, restricted),
    approved: stageMetric(stageDeals.approved, restricted),
    funded: stageMetric(stageDeals.funded, restricted),
  }
  return { membershipId, name, stages, conversions: conversionsFor(stages), distributions }
}

function parseIncomplete(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String)
  if (typeof value !== "string" || !value) return []
  try {
    const parsed = JSON.parse(value) as unknown
    return Array.isArray(parsed) ? parsed.map(String) : []
  } catch {
    return []
  }
}

export async function getRepFunnelReport(actor: DealActor, filters: ReportFilters, nowIso = new Date().toISOString()): Promise<RepFunnelReport> {
  const permission = await reportPermission(actor)
  if (!permission.allowed) {
    throw new AppError(403, "reports_disabled", "Reports are disabled for this workspace.")
  }
  const settings = await getWorkspaceSettings(actor.workspaceId)
  const timezone = settings.timezone
  await assertKnownIds(actor.workspaceId, "memberships", "id", filters.membershipIds, "membershipIds", "One or more membership filters are not in this workspace.")
  await assertKnownIds(actor.workspaceId, "mca_funders", "id", filters.funderIds, "funderIds", "One or more funder filters are not in this workspace.")
  await assertKnownIds(actor.workspaceId, "import_sources", "id", filters.sourceIds, "sourceIds", "One or more source filters are not in this workspace.")
  await assertKnownIds(actor.workspaceId, "lead_batches", "id", filters.batchIds, "batchIds", "One or more batch filters are not in this workspace.")

  const db = getDatabase()
  const [
    dealRows,
    assignmentRows,
    activityRows,
    submissionRows,
    jobRows,
    manualRows,
    offerRows,
    revisionRows,
    selectionRows,
    legacyOfferRows,
    fundingRows,
    distributionRows,
    memberRows,
    acquisitionRows,
    importLinkRows,
  ] = await Promise.all([
    db.prepare<{ id: string; display_id: string; legal_name: string | null; requested_amount: number | string | null; created_at: string }>(
      "SELECT id, display_id, legal_name, requested_amount, created_at FROM deals WHERE workspace_id = ?",
    ).all(actor.workspaceId),
    db.prepare<{ deal_id: string; membership_id: string }>(
      "SELECT deal_id, membership_id FROM deal_assignments WHERE workspace_id = ?",
    ).all(actor.workspaceId),
    db.prepare<{ deal_id: string; action: string; to_status: string | null; created_at: string }>(
      "SELECT deal_id, action, to_status, created_at FROM deal_activity WHERE workspace_id = ? AND action IN ('created', 'status_changed')",
    ).all(actor.workspaceId),
    db.prepare<{ deal_id: string; funder_id: string | null; status: string }>(
      "SELECT deal_id, funder_id, status FROM deal_submissions WHERE workspace_id = ?",
    ).all(actor.workspaceId),
    db.prepare<{ deal_id: string; funder_id: string | null; state: string; created_at: string }>(
      "SELECT deal_id, funder_id, state, created_at FROM mca_submission_jobs WHERE workspace_id = ?",
    ).all(actor.workspaceId),
    db.prepare<{ deal_id: string; funder_id: string | null; state: string; historical_at: string; created_at: string }>(
      "SELECT deal_id, funder_id, state, historical_at, created_at FROM mca_manual_submissions WHERE workspace_id = ?",
    ).all(actor.workspaceId),
    db.prepare<{ id: string; deal_id: string; funder_id: string | null; created_at: string; current_revision_id: string | null }>(
      "SELECT id, deal_id, funder_id, created_at, current_revision_id FROM mca_offers WHERE workspace_id = ?",
    ).all(actor.workspaceId),
    db.prepare<{ id: string; offer_id: string; amount_cents: number | null; state: string; created_at: string; effective_at: string; incomplete_fields_json: string }>(
      "SELECT id, offer_id, amount_cents, state, created_at, effective_at, incomplete_fields_json FROM mca_offer_revisions WHERE workspace_id = ?",
    ).all(actor.workspaceId),
    db.prepare<{ offer_id: string; offer_revision_id: string; deal_id: string }>(
      "SELECT offer_id, offer_revision_id, deal_id FROM mca_offer_selections WHERE workspace_id = ? AND active = 1",
    ).all(actor.workspaceId),
    db.prepare<{ deal_id: string; status: string; amount: number | string | null }>(
      "SELECT deal_id, status, amount FROM deal_offers WHERE workspace_id = ?",
    ).all(actor.workspaceId),
    db.prepare<{ deal_id: string; offer_id: string; amount_cents: number; funded_at: string; state: string }>(
      "SELECT deal_id, offer_id, amount_cents, funded_at, state FROM mca_funding_events WHERE workspace_id = ?",
    ).all(actor.workspaceId),
    permission.paymentsVisible
      ? db.prepare<{ id: string; recipient_membership_id: string; amount_cents: number; status: string; paid_at: string | null; expected_at: string | null; created_at: string; deal_id: string }>(
        `SELECT d.id, d.recipient_membership_id, d.amount_cents, d.status, d.paid_at, d.expected_at, d.created_at, a.deal_id
         FROM mca_payment_distributions d
         JOIN mca_accounting_payments p ON p.workspace_id = d.workspace_id AND p.id = d.payment_id
         JOIN mca_advances a ON a.workspace_id = d.workspace_id AND a.id = p.advance_id
         WHERE d.workspace_id = ? AND d.status IN ('expected', 'paid') AND p.status <> 'void'`,
      ).all(actor.workspaceId)
      : Promise.resolve([]),
    db.prepare<{ id: string; name: string }>(
      "SELECT m.id, u.name FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.workspace_id = ?",
    ).all(actor.workspaceId),
    db.prepare<{ deal_id: string; source_id: string | null; batch_id: string | null }>(
      "SELECT deal_id, source_id, batch_id FROM mca_deal_acquisition_events WHERE workspace_id = ?",
    ).all(actor.workspaceId),
    db.prepare<{ deal_id: string; source_id: string; batch_id: string }>(
      `SELECT ir.deal_id, r.source_id, r.batch_id
       FROM import_rows ir
       JOIN import_runs r ON r.id = ir.run_id AND r.workspace_id = ir.workspace_id
       WHERE ir.workspace_id = ? AND ir.deal_id IS NOT NULL`,
    ).all(actor.workspaceId),
  ])

  const assignments = new Map<string, string[]>()
  for (const row of assignmentRows) {
    const current = assignments.get(row.deal_id) ?? []
    current.push(row.membership_id)
    assignments.set(row.deal_id, uniqueIds(current))
  }

  const createdAt = new Map<string, string>()
  const submittedAt = new Map<string, string>()
  const approvedAt = new Map<string, string>()
  const fundedActivityAt = new Map<string, string>()
  for (const row of activityRows) {
    if (row.action === "created") {
      const current = createdAt.get(row.deal_id)
      if (!current || row.created_at < current) createdAt.set(row.deal_id, row.created_at)
    }
    if (row.to_status && SUBMITTED_ACTIVITY.has(row.to_status)) {
      const current = submittedAt.get(row.deal_id)
      if (!current || row.created_at < current) submittedAt.set(row.deal_id, row.created_at)
    }
    if (row.to_status && APPROVED_ACTIVITY.has(row.to_status)) {
      const current = approvedAt.get(row.deal_id)
      if (!current || row.created_at < current) approvedAt.set(row.deal_id, row.created_at)
    }
    if (row.to_status === "funded") {
      const current = fundedActivityAt.get(row.deal_id)
      if (!current || row.created_at < current) fundedActivityAt.set(row.deal_id, row.created_at)
    }
  }

  const submittedFlag = new Map<string, boolean>()
  const submittedFunders = new Map<string, string[]>()
  function markSubmitted(dealId: string, at: string | null | undefined, funderId: string | null) {
    submittedFlag.set(dealId, true)
    if (at) {
      const current = submittedAt.get(dealId)
      if (!current || at < current) submittedAt.set(dealId, at)
    }
    if (funderId) {
      const current = submittedFunders.get(dealId) ?? []
      current.push(funderId)
      submittedFunders.set(dealId, uniqueIds(current))
    }
  }
  for (const row of submissionRows) {
    if (SUBMITTED_SUBMISSION_STATUSES.has(row.status)) markSubmitted(row.deal_id, null, row.funder_id)
  }
  for (const row of jobRows) {
    if (SUBMITTED_JOB_STATES.has(row.state)) markSubmitted(row.deal_id, row.created_at, row.funder_id)
  }
  for (const row of manualRows) {
    markSubmitted(row.deal_id, earliest([row.historical_at, row.created_at]), row.funder_id)
  }

  const revisionsByOffer = new Map<string, typeof revisionRows>()
  for (const row of revisionRows) {
    const list = revisionsByOffer.get(row.offer_id) ?? []
    list.push(row)
    revisionsByOffer.set(row.offer_id, list)
  }
  const selectedByOffer = new Map(selectionRows.map((row) => [row.offer_id, row.offer_revision_id]))
  const approvedFlag = new Map<string, boolean>()
  const approvedFunders = new Map<string, string[]>()
  const approvedCandidates = new Map<string, Array<{ funderId: string | null; amountCents: number | null; rank: number }>>()

  function markApproved(dealId: string, at: string | null | undefined, funderId: string | null, amountCents: number | null, rank = 0) {
    approvedFlag.set(dealId, true)
    if (at) {
      const current = approvedAt.get(dealId)
      if (!current || at < current) approvedAt.set(dealId, at)
    }
    if (funderId) {
      const current = approvedFunders.get(dealId) ?? []
      current.push(funderId)
      approvedFunders.set(dealId, uniqueIds(current))
    }
    const list = approvedCandidates.get(dealId) ?? []
    list.push({ funderId, amountCents, rank })
    approvedCandidates.set(dealId, list)
  }

  function approvedAmountFor(dealId: string, allowedFunders: Set<string> | null): number | null {
    const candidates = (approvedCandidates.get(dealId) ?? []).filter((item) => !allowedFunders || (item.funderId != null && allowedFunders.has(item.funderId)) || item.funderId == null)
    if (!candidates.length) return null
    const ranked = [...candidates].sort((a, b) => b.rank - a.rank)
    const known = ranked.find((item) => item.amountCents != null)
    return known?.amountCents ?? null
  }

  for (const row of submissionRows) {
    if (APPROVED_SUBMISSION_STATUSES.has(row.status)) markApproved(row.deal_id, null, row.funder_id, null, 1)
  }
  for (const row of manualRows) {
    if (row.state === "approved" || row.state === "funded") {
      markApproved(row.deal_id, earliest([row.historical_at, row.created_at]), row.funder_id, null, row.state === "funded" ? 3 : 2)
    }
  }
  for (const row of legacyOfferRows) {
    if (APPROVED_OFFER_STATUSES.has(row.status)) markApproved(row.deal_id, null, null, requestedAmountToCents(row.amount), row.status === "accepted" ? 3 : 1)
  }
  for (const offer of offerRows) {
    const revisions = revisionsByOffer.get(offer.id) ?? []
    const selectedId = selectedByOffer.get(offer.id)
    const selected = revisions.find((item) => item.id === selectedId)
    const fundedRevision = revisions.find((item) => item.state === "funded")
    const current = revisions.find((item) => item.id === offer.current_revision_id)
    const chosen = selected ?? fundedRevision ?? current ?? revisions[0]
    const incomplete = chosen ? parseIncomplete(chosen.incomplete_fields_json) : []
    const amount = chosen && !incomplete.includes("amountCents") && chosen.amount_cents != null ? Number(chosen.amount_cents) : null
    const at = earliest([offer.created_at, chosen?.effective_at, chosen?.created_at, ...revisions.map((item) => item.created_at)])
    const rank = fundedRevision ? 4 : selected ? 3 : 1
    markApproved(offer.deal_id, at, offer.funder_id, Number.isSafeInteger(amount) ? amount : null, rank)
  }

  const fundedAmountParts = new Map<string, Array<{ funderId: string | null; amountCents: number }>>()
  const fundedAt = new Map<string, string>()
  const fundedFlag = new Map<string, boolean>()
  const fundedFunders = new Map<string, string[]>()
  const offerFunder = new Map(offerRows.map((row) => [row.id, row.funder_id]))
  for (const row of fundingRows) {
    if (row.state !== "committed") continue
    fundedFlag.set(row.deal_id, true)
    const funderId = offerFunder.get(row.offer_id) ?? null
    const parts = fundedAmountParts.get(row.deal_id) ?? []
    parts.push({ funderId, amountCents: Number(row.amount_cents) })
    fundedAmountParts.set(row.deal_id, parts)
    const current = fundedAt.get(row.deal_id)
    if (!current || row.funded_at < current) fundedAt.set(row.deal_id, row.funded_at)
    if (funderId) {
      const list = fundedFunders.get(row.deal_id) ?? []
      list.push(funderId)
      fundedFunders.set(row.deal_id, uniqueIds(list))
    }
  }

  function fundedAmountFor(dealId: string, allowedFunders: Set<string> | null): number | null {
    const parts = fundedAmountParts.get(dealId)
    if (!parts?.length) return null
    const selected = parts.filter((item) => !allowedFunders || (item.funderId != null && allowedFunders.has(item.funderId)))
    if (!selected.length) return null
    return selected.reduce((sum, item) => sum + item.amountCents, 0)
  }

  const sources = new Map<string, string[]>()
  const batches = new Map<string, string[]>()
  for (const row of [...acquisitionRows, ...importLinkRows]) {
    if (!row.deal_id) continue
    if (row.source_id) {
      const current = sources.get(row.deal_id) ?? []
      current.push(row.source_id)
      sources.set(row.deal_id, uniqueIds(current))
    }
    if (row.batch_id) {
      const current = batches.get(row.deal_id) ?? []
      current.push(row.batch_id)
      batches.set(row.deal_id, uniqueIds(current))
    }
  }

  const memberName = new Map(memberRows.map((row) => [row.id, row.name]))
  const funderSet = filters.funderIds?.length ? new Set(filters.funderIds) : null
  const sourceSet = filters.sourceIds?.length ? new Set(filters.sourceIds) : null
  const batchSet = filters.batchIds?.length ? new Set(filters.batchIds) : null
  const membershipSet = filters.membershipIds?.length ? new Set(filters.membershipIds) : null
  const deals: DealFacts[] = dealRows.map((row) => {
    const createdStamp = createdAt.get(row.id) ?? row.created_at
    const submittedStamp = submittedAt.get(row.id) ?? null
    const approvedStamp = approvedAt.get(row.id) ?? null
    const fundedStamp = fundedAt.get(row.id) ?? fundedActivityAt.get(row.id) ?? null
    const submittedFundersForDeal = submittedFunders.get(row.id) ?? []
    const approvedFundersForDeal = approvedFunders.get(row.id) ?? []
    const fundedFundersForDeal = fundedFunders.get(row.id) ?? []
    const submitted = Boolean(submittedFlag.get(row.id) || submittedStamp) && (!funderSet || submittedFundersForDeal.some((id) => funderSet.has(id)))
    const approved = Boolean(approvedFlag.get(row.id) || approvedStamp) && (!funderSet || approvedFundersForDeal.some((id) => funderSet.has(id)))
    const funded = Boolean(fundedFlag.get(row.id)) && (!funderSet || fundedFundersForDeal.some((id) => funderSet.has(id)))
    return {
      id: row.id,
      displayId: row.display_id,
      legalName: row.legal_name?.trim() || "Untitled draft",
      requestedAmountCents: requestedAmountToCents(row.requested_amount),
      createdAt: createdStamp,
      createdOn: calendarDateInTimeZone(createdStamp, timezone),
      submittedAt: submittedStamp,
      submittedOn: submittedStamp ? calendarDateInTimeZone(submittedStamp, timezone) : null,
      approvedAt: approvedStamp,
      approvedOn: approvedStamp ? calendarDateInTimeZone(approvedStamp, timezone) : null,
      fundedAt: fundedStamp,
      fundedOn: fundedStamp ? calendarDateInTimeZone(fundedStamp, timezone) : null,
      submitted,
      approved,
      funded,
      approvedAmountCents: approvedAmountFor(row.id, funderSet),
      fundedAmountCents: funded ? fundedAmountFor(row.id, funderSet) : null,
      membershipIds: assignments.get(row.id) ?? [],
      funderIds: uniqueIds([
        ...(submittedFunders.get(row.id) ?? []),
        ...(approvedFunders.get(row.id) ?? []),
        ...(fundedFunders.get(row.id) ?? []),
      ]),
      sourceIds: sources.get(row.id) ?? [],
      batchIds: batches.get(row.id) ?? [],
    }
  })

  const scoped = deals.filter((deal) => {
    if (funderSet && !deal.funderIds.some((id) => funderSet.has(id))) return false
    if (sourceSet && !deal.sourceIds.some((id) => sourceSet.has(id))) return false
    if (batchSet && !deal.batchIds.some((id) => batchSet.has(id))) return false
    if (membershipSet && !deal.membershipIds.some((id) => membershipSet.has(id))) return false
    return true
  })

  function rowFor(deal: DealFacts, stage: FunnelStage, occurredOn: string | null, amountCents: number | null): FunnelDealRow {
    return {
      dealId: deal.id,
      displayId: deal.displayId,
      legalName: deal.legalName,
      stage,
      occurredOn,
      amountCents,
      attributedMembershipIds: deal.membershipIds,
      shared: deal.membershipIds.length > 1,
    }
  }

  const drilldown: Record<FunnelStage, FunnelDealRow[]> = { created: [], submitted: [], approved: [], funded: [] }
  for (const deal of scoped) {
    if (inRangeForStage(deal.createdOn, filters, deal.createdOn)) {
      drilldown.created.push(rowFor(deal, "created", deal.createdOn, deal.requestedAmountCents))
    }
    if (deal.submitted && inRangeForStage(deal.submittedOn, filters, deal.createdOn)) {
      drilldown.submitted.push(rowFor(deal, "submitted", deal.submittedOn, deal.requestedAmountCents))
    }
    if (deal.approved && inRangeForStage(deal.approvedOn, filters, deal.createdOn)) {
      drilldown.approved.push(rowFor(deal, "approved", deal.approvedOn, deal.approvedAmountCents))
    }
    if (deal.funded && inRangeForStage(deal.fundedOn, filters, deal.createdOn)) {
      drilldown.funded.push(rowFor(deal, "funded", deal.fundedOn, deal.fundedAmountCents))
    }
  }

  const createdIds = new Set(drilldown.created.map((row) => row.dealId))
  const distributionFacts: DistributionFact[] = []
  if (permission.paymentsVisible) {
    for (const row of distributionRows) {
      const occurredAt = row.status === "paid" ? (row.paid_at ?? row.created_at) : (row.expected_at ?? row.created_at)
      const occurredOn = calendarDateInTimeZone(occurredAt, timezone)
      const deal = deals.find((item) => item.id === row.deal_id)
      if (!deal) continue
      if (funderSet && !deal.funderIds.some((id) => funderSet.has(id))) continue
      if (sourceSet && !deal.sourceIds.some((id) => sourceSet.has(id))) continue
      if (batchSet && !deal.batchIds.some((id) => batchSet.has(id))) continue
      if (membershipSet && !membershipSet.has(row.recipient_membership_id)) continue
      const include = filters.basis === "cohort"
        ? createdIds.has(row.deal_id) || dateInInclusiveRange(deal.createdOn, filters.from, filters.to)
        : dateInInclusiveRange(occurredOn, filters.from, filters.to)
      if (!include) continue
      distributionFacts.push({
        id: row.id,
        dealId: row.deal_id,
        recipientMembershipId: row.recipient_membership_id,
        amountCents: Number(row.amount_cents),
        status: row.status === "paid" ? "paid" : "expected",
        occurredAt,
        occurredOn,
      })
    }
  }

  const totalsDistributions = distributionFacts.reduce(
    (metric, item) => addDistribution(metric, item.amountCents, item.status),
    emptyDistributions(permission),
  )
  const totals = buildRow("totals", "All reps (unique deals)", drilldown, totalsDistributions, permission, true)

  const seenMembers = new Set<string>()
  const repRows: RepFunnelRow[] = []
  const membersToShow = uniqueIds([
    ...scoped.flatMap((deal) => deal.membershipIds),
    ...distributionFacts.map((item) => item.recipientMembershipId),
    ...(filters.membershipIds ?? []),
  ]).sort((a, b) => (memberName.get(a) ?? a).localeCompare(memberName.get(b) ?? b))

  for (const membershipId of membersToShow) {
    if (seenMembers.has(membershipId)) continue
    seenMembers.add(membershipId)
    const stageDeals: Record<FunnelStage, FunnelDealRow[]> = {
      created: drilldown.created.filter((row) => row.attributedMembershipIds.includes(membershipId)),
      submitted: drilldown.submitted.filter((row) => row.attributedMembershipIds.includes(membershipId)),
      approved: drilldown.approved.filter((row) => row.attributedMembershipIds.includes(membershipId)),
      funded: drilldown.funded.filter((row) => row.attributedMembershipIds.includes(membershipId)),
    }
    const distributions = distributionFacts
      .filter((item) => item.recipientMembershipId === membershipId)
      .reduce((metric, item) => addDistribution(metric, item.amountCents, item.status), emptyDistributions(permission))
    const hasActivity = FUNNEL_STAGES.some((stage) => stageDeals[stage].length) || (distributions.count ?? 0) > 0
    if (!hasActivity && !filters.membershipIds?.includes(membershipId)) continue
    repRows.push(buildRow(membershipId, memberName.get(membershipId) ?? "Unknown member", stageDeals, distributions, permission, false))
  }

  const unassignedDeals: Record<FunnelStage, FunnelDealRow[]> = {
    created: drilldown.created.filter((row) => row.attributedMembershipIds.length === 0),
    submitted: drilldown.submitted.filter((row) => row.attributedMembershipIds.length === 0),
    approved: drilldown.approved.filter((row) => row.attributedMembershipIds.length === 0),
    funded: drilldown.funded.filter((row) => row.attributedMembershipIds.length === 0),
  }
  const unassignedHasActivity = FUNNEL_STAGES.some((stage) => unassignedDeals[stage].length)
  const unassigned = unassignedHasActivity
    ? buildRow(null, "Unassigned", unassignedDeals, emptyDistributions(permission), permission, false)
    : null

  return {
    filters,
    period: periodFor(filters, timezone, nowIso),
    permission,
    attribution: SHARED_REP_ATTRIBUTION,
    totals,
    reps: repRows,
    unassigned,
    drilldown,
  }
}
