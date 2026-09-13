import "server-only"

import { requireWorkspaceAccess } from "../auth"
import { getDatabase } from "../db"
import { actorForDeals } from "../deals/service"
import type { DealActor } from "../deals/schema"
import { AppError } from "../errors"
import { requestCorrelationId } from "../http"
import { effectivePageVisibility, isActionAllowed } from "../policy"
import { getWorkspaceSettings } from "../workspaces"
import { type ReportFilters, type ReportPermissionState } from "./contracts"
import {
  calendarDateInTimeZone,
  conversionRate,
  dateInInclusiveRange,
  parseReportFilters,
} from "./rep-funnel"

export { calendarDateInTimeZone, conversionRate, dateInInclusiveRange, parseReportFilters }

export const FUNDER_CHANNELS = ["api", "email", "portal", "webhook", "manual", "unknown"] as const
export type FunderChannel = (typeof FUNDER_CHANNELS)[number]

export const FUNDER_DRILLDOWN_KINDS = ["submissions", "approvals", "advances", "payments"] as const
export type FunderDrilldownKind = (typeof FUNDER_DRILLDOWN_KINDS)[number]

/** One approval per submission/offer. Revisions never multiply the count. Earned cents follow the ledger. */
export const FUNDER_ANALYTICS_ATTRIBUTION = {
  submissions: "unique_send_identity",
  merchants: "unique_deal",
  approvals: "unique_submission_or_offer",
  fundings: "committed_funding_events",
  commissions: "ledger_received_non_void",
  revisedOffers: "do_not_double_count",
} as const

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/
export const SUBMITTED_SUBMISSION_STATUSES = new Set(["sent", "errored", "declined", "approved"])
export const SUBMITTED_JOB_STATES = new Set(["sent", "sending", "pending_portal"])
export const APPROVED_SUBMISSION_STATUSES = new Set(["approved"])
export const APPROVED_OFFER_STATUSES = new Set(["received", "presented", "accepted"])
export const APPROVED_MANUAL_STATES = new Set(["approved", "funded"])

export interface FunderCountMetric {
  count: number
  knownAmountCents: number
  unknownAmountCount: number
  complete: boolean
  restricted: boolean
}

export interface FunderRateMetric {
  from: string
  to: string
  numerator: number
  denominator: number
  rate: number | null
}

export interface FunderCommissionMetric {
  visible: boolean
  expectedCents?: number
  collectedCents?: number
  outstandingCents?: number
  count?: number
  reason?: ReportPermissionState["reason"]
}

export interface FunderChannelSplit {
  api: number
  email: number
  other: number
}

export interface FunderAnalyticsRow {
  funderId: string | null
  name: string
  channels: FunderChannelSplit
  submissions: FunderCountMetric
  uniqueMerchants: FunderCountMetric
  approvals: FunderCountMetric
  fundings: FunderCountMetric
  commissions: FunderCommissionMetric
  conversions: FunderRateMetric[]
}

export interface FunderSubmissionRow {
  id: string
  funderId: string | null
  dealId: string
  displayId: string
  legalName: string
  channel: FunderChannel
  sourceKind: "job" | "legacy" | "manual"
  sourceId: string
  occurredOn: string | null
  status: string
}

export interface FunderApprovalRow {
  id: string
  funderId: string | null
  dealId: string
  displayId: string
  legalName: string
  offerId: string | null
  submissionKey: string
  revisionCount: number
  occurredOn: string | null
  amountCents: number | null
  source: string
}

export interface FunderAdvanceRow {
  id: string
  funderId: string | null
  dealId: string
  displayId: string
  legalName: string
  fundingEventId: string
  offerId: string
  source: string
  fundedOn: string | null
  amountCents: number | null
}

export interface FunderPaymentRow {
  id: string
  funderId: string | null
  dealId: string
  displayId: string
  legalName: string
  advanceId: string
  type: "commission" | "fee"
  origin: string
  status: string
  receivedOn: string | null
  expectedCents: number
  collectedCents: number
}

export interface FunderPeriod {
  from?: string
  to?: string
  timezone: string
  complete: boolean
  lifetime: boolean
  label: string
}

export interface FunderAnalyticsReport {
  filters: ReportFilters
  period: FunderPeriod
  permission: ReportPermissionState
  attribution: typeof FUNDER_ANALYTICS_ATTRIBUTION
  totals: FunderAnalyticsRow
  funders: FunderAnalyticsRow[]
  unattributed: FunderAnalyticsRow | null
  drilldown: {
    submissions: FunderSubmissionRow[]
    approvals: FunderApprovalRow[]
    advances: FunderAdvanceRow[]
    payments: FunderPaymentRow[]
  }
}

interface DealMeta {
  id: string
  displayId: string
  legalName: string
  createdOn: string
  membershipIds: string[]
  sourceIds: string[]
  batchIds: string[]
}

function uniqueIds(values: Array<string | null | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value)))]
}

function earliest(values: Array<string | null | undefined>): string | null {
  const usable = values.filter((value): value is string => Boolean(value))
  if (!usable.length) return null
  return usable.reduce((min, value) => (value < min ? value : min))
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

export function channelFromRouteKind(value: string | null | undefined): FunderChannel {
  if (value === "api") return "api"
  if (value === "email") return "email"
  if (value === "manual_portal") return "portal"
  if (value === "custom_webhook") return "webhook"
  if (value === "manual" || value === "historical") return "manual"
  return "unknown"
}

export function inReportPeriod(date: string | null | undefined, filters: ReportFilters, createdOn: string): boolean {
  if (filters.basis === "cohort") return dateInInclusiveRange(createdOn, filters.from, filters.to)
  if (!filters.from && !filters.to) return true
  return dateInInclusiveRange(date, filters.from, filters.to)
}

function emptyChannels(): FunderChannelSplit {
  return { api: 0, email: 0, other: 0 }
}

function addChannel(split: FunderChannelSplit, channel: FunderChannel): FunderChannelSplit {
  if (channel === "api") return { ...split, api: split.api + 1 }
  if (channel === "email") return { ...split, email: split.email + 1 }
  return { ...split, other: split.other + 1 }
}

function countMetric(rows: readonly unknown[], restricted: boolean, withAmounts: boolean): FunderCountMetric {
  if (restricted) {
    return { count: rows.length, knownAmountCents: 0, unknownAmountCount: 0, complete: false, restricted: true }
  }
  if (!withAmounts) {
    return { count: rows.length, knownAmountCents: 0, unknownAmountCount: 0, complete: true, restricted: false }
  }
  let knownAmountCents = 0
  let unknownAmountCount = 0
  for (const row of rows) {
    const amountCents = row && typeof row === "object" && "amountCents" in row ? (row as { amountCents?: number | null }).amountCents : null
    if (amountCents == null) unknownAmountCount += 1
    else knownAmountCents += amountCents
  }
  return {
    count: rows.length,
    knownAmountCents,
    unknownAmountCount,
    complete: unknownAmountCount === 0,
    restricted: false,
  }
}

function emptyCommissions(permission: ReportPermissionState, companyRow: boolean): FunderCommissionMetric {
  if (!permission.paymentsVisible) {
    return { visible: false, reason: "payment_permission_required" }
  }
  if (companyRow && !permission.companyTotalsVisible) {
    return { visible: false, reason: "company_totals_restricted" }
  }
  return { visible: true, expectedCents: 0, collectedCents: 0, outstandingCents: 0, count: 0 }
}

function addCommission(metric: FunderCommissionMetric, expectedCents: number, collectedCents: number): FunderCommissionMetric {
  if (!metric.visible) return metric
  const expected = (metric.expectedCents ?? 0) + expectedCents
  const collected = (metric.collectedCents ?? 0) + collectedCents
  return {
    visible: true,
    expectedCents: expected,
    collectedCents: collected,
    outstandingCents: Math.max(0, expected - collected),
    count: (metric.count ?? 0) + 1,
  }
}

function conversionsFor(submissions: number, approvals: number, fundings: number): FunderRateMetric[] {
  return [
    { from: "submissions", to: "approvals", numerator: approvals, denominator: submissions, rate: conversionRate(approvals, submissions) },
    { from: "approvals", to: "fundings", numerator: fundings, denominator: approvals, rate: conversionRate(fundings, approvals) },
    { from: "submissions", to: "fundings", numerator: fundings, denominator: submissions, rate: conversionRate(fundings, submissions) },
  ]
}

function periodFor(filters: ReportFilters, timezone: string, nowIso: string): FunderPeriod {
  const today = calendarDateInTimeZone(nowIso, timezone)
  const lifetime = !filters.from && !filters.to
  const complete = Boolean(filters.to && filters.to < today)
  const label = lifetime
    ? "Lifetime — later events may still arrive."
    : !filters.to
      ? "No end date — later events may still arrive."
      : filters.to >= today
        ? "This period includes today or a future date and is incomplete."
        : `Inclusive ${filters.from ?? "start"} to ${filters.to} (${timezone}).`
  return { from: filters.from, to: filters.to, timezone, complete, lifetime, label }
}

export async function requireFunderAnalyticsActor(request: Request): Promise<DealActor> {
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

function dealPassesFilters(deal: DealMeta, filters: ReportFilters): boolean {
  if (filters.membershipIds?.length && !deal.membershipIds.some((id) => filters.membershipIds!.includes(id))) return false
  if (filters.sourceIds?.length && !deal.sourceIds.some((id) => filters.sourceIds!.includes(id))) return false
  if (filters.batchIds?.length && !deal.batchIds.some((id) => filters.batchIds!.includes(id))) return false
  return true
}

function amountToCents(value: unknown): number | null {
  if (value == null || value === "") return null
  const numeric = typeof value === "number" ? value : Number(value)
  if (!Number.isFinite(numeric) || numeric < 0) return null
  const cents = Math.round(numeric * 100)
  return Number.isSafeInteger(cents) ? cents : null
}

export function funderAnalyticsReconciles(report: Pick<FunderAnalyticsReport, "totals" | "funders" | "unattributed" | "drilldown" | "permission">): boolean {
  const { drilldown, totals } = report
  if (new Set(drilldown.submissions.map((row) => row.id)).size !== drilldown.submissions.length) return false
  if (new Set(drilldown.approvals.map((row) => row.id)).size !== drilldown.approvals.length) return false
  if (new Set(drilldown.advances.map((row) => row.id)).size !== drilldown.advances.length) return false
  if (drilldown.submissions.length !== totals.submissions.count) return false
  if (new Set(drilldown.submissions.map((row) => row.dealId)).size !== totals.uniqueMerchants.count) return false
  if (drilldown.approvals.length !== totals.approvals.count) return false
  if (drilldown.advances.length !== totals.fundings.count) return false
  if (!totals.approvals.restricted) {
    const unknown = drilldown.approvals.filter((row) => row.amountCents == null).length
    const known = drilldown.approvals.reduce((sum, row) => sum + (row.amountCents ?? 0), 0)
    if (unknown !== totals.approvals.unknownAmountCount || known !== totals.approvals.knownAmountCents) return false
  }
  if (!totals.fundings.restricted) {
    const known = drilldown.advances.reduce((sum, row) => sum + (row.amountCents ?? 0), 0)
    if (known !== totals.fundings.knownAmountCents) return false
  }
  if (totals.commissions.visible) {
    const collected = drilldown.payments.filter((row) => row.type === "commission").reduce((sum, row) => sum + row.collectedCents, 0)
    const expected = drilldown.payments.filter((row) => row.type === "commission").reduce((sum, row) => sum + row.expectedCents, 0)
    if (collected !== (totals.commissions.collectedCents ?? 0)) return false
    if (expected !== (totals.commissions.expectedCents ?? 0)) return false
  } else if (drilldown.payments.length !== 0) {
    return false
  }
  const rows = [...report.funders, ...(report.unattributed ? [report.unattributed] : [])]
  for (const row of rows) {
    const submissions = drilldown.submissions.filter((item) => item.funderId === row.funderId)
    const approvals = drilldown.approvals.filter((item) => item.funderId === row.funderId)
    const advances = drilldown.advances.filter((item) => item.funderId === row.funderId)
    if (submissions.length !== row.submissions.count) return false
    if (new Set(submissions.map((item) => item.dealId)).size !== row.uniqueMerchants.count) return false
    if (approvals.length !== row.approvals.count) return false
    if (advances.length !== row.fundings.count) return false
    if (submissions.filter((item) => item.channel === "api").length !== row.channels.api) return false
    if (submissions.filter((item) => item.channel === "email").length !== row.channels.email) return false
    if (row.commissions.visible) {
      const collected = drilldown.payments.filter((item) => item.funderId === row.funderId && item.type === "commission").reduce((sum, item) => sum + item.collectedCents, 0)
      if (collected !== (row.commissions.collectedCents ?? 0)) return false
    }
  }
  return true
}

function buildRow(
  funderId: string | null,
  name: string,
  submissions: FunderSubmissionRow[],
  approvals: FunderApprovalRow[],
  advances: FunderAdvanceRow[],
  payments: FunderPaymentRow[],
  permission: ReportPermissionState,
  companyRow: boolean,
): FunderAnalyticsRow {
  const restricted = companyRow && !permission.companyTotalsVisible
  const channels = submissions.reduce((split, row) => addChannel(split, row.channel), emptyChannels())
  const uniqueDealIds = new Set(submissions.map((row) => row.dealId))
  const commissions = payments
    .filter((row) => row.type === "commission")
    .reduce((metric, row) => addCommission(metric, row.expectedCents, row.collectedCents), emptyCommissions(permission, companyRow))
  return {
    funderId,
    name,
    channels,
    submissions: countMetric(submissions, false, false),
    uniqueMerchants: countMetric([...uniqueDealIds].map((id) => ({ id })), false, false),
    approvals: countMetric(approvals, restricted, true),
    fundings: countMetric(advances, restricted, true),
    commissions,
    conversions: conversionsFor(submissions.length, approvals.length, advances.length),
  }
}

export async function getFunderAnalyticsReport(
  actor: DealActor,
  filters: ReportFilters,
  nowIso = new Date().toISOString(),
): Promise<FunderAnalyticsReport> {
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
    funderRows,
    jobRows,
    submissionRows,
    manualRows,
    offerRows,
    revisionRows,
    selectionRows,
    legacyOfferRows,
    fundingRows,
    paymentRows,
    acquisitionRows,
    importLinkRows,
  ] = await Promise.all([
    db.prepare<{ id: string; display_id: string; legal_name: string | null; created_at: string }>(
      "SELECT id, display_id, legal_name, created_at FROM deals WHERE workspace_id = ?",
    ).all(actor.workspaceId),
    db.prepare<{ deal_id: string; membership_id: string }>(
      "SELECT deal_id, membership_id FROM deal_assignments WHERE workspace_id = ?",
    ).all(actor.workspaceId),
    db.prepare<{ deal_id: string; action: string; created_at: string }>(
      "SELECT deal_id, action, created_at FROM deal_activity WHERE workspace_id = ? AND action = 'created'",
    ).all(actor.workspaceId),
    db.prepare<{ id: string; legal_name: string; nickname: string | null }>(
      "SELECT id, legal_name, nickname FROM mca_funders WHERE workspace_id = ?",
    ).all(actor.workspaceId),
    db.prepare<{ id: string; deal_id: string; funder_id: string; display_funder_name: string; route_kind: string; state: string; created_at: string }>(
      "SELECT id, deal_id, funder_id, display_funder_name, route_kind, state, created_at FROM mca_submission_jobs WHERE workspace_id = ?",
    ).all(actor.workspaceId),
    db.prepare<{ id: string; deal_id: string; funder_id: string | null; funder_name: string; status: string; job_id: string | null; route_kind: string | null }>(
      "SELECT id, deal_id, funder_id, funder_name, status, job_id, route_kind FROM deal_submissions WHERE workspace_id = ?",
    ).all(actor.workspaceId),
    db.prepare<{ id: string; deal_id: string; funder_id: string | null; funder_name: string; state: string; historical_at: string; created_at: string; offer_id: string | null; source: string }>(
      "SELECT id, deal_id, funder_id, funder_name, state, historical_at, created_at, offer_id, source FROM mca_manual_submissions WHERE workspace_id = ?",
    ).all(actor.workspaceId),
    db.prepare<{ id: string; deal_id: string; submission_id: string | null; funder_id: string | null; funder_name: string; source: string; created_at: string; current_revision_id: string | null }>(
      "SELECT id, deal_id, submission_id, funder_id, funder_name, source, created_at, current_revision_id FROM mca_offers WHERE workspace_id = ?",
    ).all(actor.workspaceId),
    db.prepare<{ id: string; offer_id: string; amount_cents: number | null; state: string; created_at: string; effective_at: string; incomplete_fields_json: string }>(
      "SELECT id, offer_id, amount_cents, state, created_at, effective_at, incomplete_fields_json FROM mca_offer_revisions WHERE workspace_id = ?",
    ).all(actor.workspaceId),
    db.prepare<{ offer_id: string; offer_revision_id: string }>(
      "SELECT offer_id, offer_revision_id FROM mca_offer_selections WHERE workspace_id = ? AND active = 1",
    ).all(actor.workspaceId),
    db.prepare<{ id: string; deal_id: string; submission_id: string; status: string; amount: number | string | null; source: string | null; terms_unknown: number | string | null }>(
      "SELECT id, deal_id, submission_id, status, amount, source, terms_unknown FROM deal_offers WHERE workspace_id = ?",
    ).all(actor.workspaceId),
    db.prepare<{ id: string; deal_id: string; offer_id: string; advance_id: string; amount_cents: number; funded_at: string; state: string; source: string }>(
      "SELECT id, deal_id, offer_id, advance_id, amount_cents, funded_at, state, source FROM mca_funding_events WHERE workspace_id = ?",
    ).all(actor.workspaceId),
    permission.paymentsVisible
      ? db.prepare<{
        id: string
        advance_id: string
        type: "commission" | "fee"
        origin: string
        status: string
        expected_amount_cents: number
        received_amount_cents: number
        expected_at: string | null
        received_at: string | null
        created_at: string
        deal_id: string
        offer_id: string
      }>(
        `SELECT p.id, p.advance_id, p.type, p.origin, p.status,
                p.expected_amount_cents + COALESCE((SELECT sum(a.amount_cents) FROM mca_accounting_adjustments a
                  WHERE a.workspace_id = p.workspace_id AND a.payment_id = p.id), 0)::int AS expected_amount_cents,
                p.received_amount_cents, p.expected_at, p.received_at, p.created_at, adv.deal_id, adv.offer_id
         FROM mca_accounting_payments p
         JOIN mca_advances adv ON adv.workspace_id = p.workspace_id AND adv.id = p.advance_id
         WHERE p.workspace_id = ? AND p.status <> 'void'`,
      ).all(actor.workspaceId)
      : Promise.resolve([]),
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

  const createdAt = new Map<string, string>()
  for (const row of activityRows) {
    const current = createdAt.get(row.deal_id)
    if (!current || row.created_at < current) createdAt.set(row.deal_id, row.created_at)
  }
  const assignments = new Map<string, string[]>()
  for (const row of assignmentRows) {
    const current = assignments.get(row.deal_id) ?? []
    current.push(row.membership_id)
    assignments.set(row.deal_id, uniqueIds(current))
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

  const deals = new Map<string, DealMeta>()
  for (const row of dealRows) {
    const createdStamp = createdAt.get(row.id) ?? row.created_at
    deals.set(row.id, {
      id: row.id,
      displayId: row.display_id,
      legalName: row.legal_name?.trim() || "Untitled draft",
      createdOn: DATE_ONLY.test(createdStamp) ? createdStamp : calendarDateInTimeZone(createdStamp, timezone),
      membershipIds: assignments.get(row.id) ?? [],
      sourceIds: sources.get(row.id) ?? [],
      batchIds: batches.get(row.id) ?? [],
    })
  }

  const funderName = new Map(funderRows.map((row) => [row.id, row.nickname?.trim() || row.legal_name]))
  const jobsById = new Map(jobRows.map((row) => [row.id, row]))
  const submissionsById = new Map(submissionRows.map((row) => [row.id, row]))
  const submissionsByJob = new Map(submissionRows.filter((row) => row.job_id).map((row) => [row.job_id as string, row]))

  function canonicalKey(raw: string | null | undefined, fallback: string): string {
    if (!raw) return fallback
    if (jobsById.has(raw)) return raw
    const linked = submissionsById.get(raw)
    if (linked?.job_id) return linked.job_id
    if (linked) return linked.id
    return raw
  }

  function scopedDeal(dealId: string): DealMeta | null {
    const deal = deals.get(dealId)
    if (!deal) return null
    if (!dealPassesFilters(deal, filters)) return null
    return deal
  }

  const funderSet = filters.funderIds?.length ? new Set(filters.funderIds) : null
  function includeFunder(funderId: string | null): boolean {
    if (!funderSet) return true
    return funderId != null && funderSet.has(funderId)
  }

  const submissionFacts = new Map<string, FunderSubmissionRow>()
  function putSubmission(row: FunderSubmissionRow) {
    if (!includeFunder(row.funderId)) return
    const deal = scopedDeal(row.dealId)
    if (!deal) return
    if (!inReportPeriod(row.occurredOn, filters, deal.createdOn)) return
    const current = submissionFacts.get(row.id)
    if (!current) {
      submissionFacts.set(row.id, { ...row, displayId: deal.displayId, legalName: deal.legalName })
      return
    }
    const channel = current.channel === "unknown" && row.channel !== "unknown" ? row.channel : current.channel
    const occurredOn = current.occurredOn && (!row.occurredOn || current.occurredOn <= row.occurredOn) ? current.occurredOn : row.occurredOn
    submissionFacts.set(row.id, { ...current, channel, occurredOn, status: row.status || current.status })
  }

  for (const job of jobRows) {
    if (!SUBMITTED_JOB_STATES.has(job.state)) continue
    const cache = submissionsByJob.get(job.id)
    putSubmission({
      id: job.id,
      funderId: job.funder_id,
      dealId: job.deal_id,
      displayId: "",
      legalName: "",
      channel: channelFromRouteKind(job.route_kind),
      sourceKind: "job",
      sourceId: job.id,
      occurredOn: calendarDateInTimeZone(job.created_at, timezone),
      status: cache?.status ?? job.state,
    })
  }
  for (const row of submissionRows) {
    if (!SUBMITTED_SUBMISSION_STATUSES.has(row.status)) continue
    const job = row.job_id ? jobsById.get(row.job_id) : undefined
    const id = row.job_id && SUBMITTED_JOB_STATES.has(job?.state ?? "") ? row.job_id : row.id
    const at = job?.created_at ? calendarDateInTimeZone(job.created_at, timezone) : null
    putSubmission({
      id,
      funderId: row.funder_id ?? job?.funder_id ?? null,
      dealId: row.deal_id,
      displayId: "",
      legalName: "",
      channel: channelFromRouteKind(row.route_kind ?? job?.route_kind),
      sourceKind: row.job_id ? "job" : "legacy",
      sourceId: row.job_id ?? row.id,
      occurredOn: at,
      status: row.status,
    })
  }
  for (const row of manualRows) {
    const at = earliest([row.historical_at, row.created_at])
    putSubmission({
      id: `manual:${row.id}`,
      funderId: row.funder_id,
      dealId: row.deal_id,
      displayId: "",
      legalName: "",
      channel: channelFromRouteKind(row.source),
      sourceKind: "manual",
      sourceId: row.id,
      occurredOn: at ? calendarDateInTimeZone(at, timezone) : null,
      status: row.state,
    })
  }

  const revisionsByOffer = new Map<string, typeof revisionRows>()
  for (const row of revisionRows) {
    const list = revisionsByOffer.get(row.offer_id) ?? []
    list.push(row)
    revisionsByOffer.set(row.offer_id, list)
  }
  const selectedByOffer = new Map(selectionRows.map((row) => [row.offer_id, row.offer_revision_id]))

  type ApprovalAcc = FunderApprovalRow & { occurredAt: string | null }
  const approvalFacts = new Map<string, ApprovalAcc>()
  function putApproval(input: Omit<ApprovalAcc, "displayId" | "legalName">) {
    if (!includeFunder(input.funderId)) return
    const deal = scopedDeal(input.dealId)
    if (!deal) return
    if (!inReportPeriod(input.occurredOn, filters, deal.createdOn)) return
    const current = approvalFacts.get(input.id)
    if (!current) {
      approvalFacts.set(input.id, { ...input, displayId: deal.displayId, legalName: deal.legalName })
      return
    }
    const occurredAt = earliest([current.occurredAt, input.occurredAt])
    approvalFacts.set(input.id, {
      ...current,
      revisionCount: Math.max(current.revisionCount, input.revisionCount),
      amountCents: current.amountCents ?? input.amountCents,
      occurredAt,
      occurredOn: occurredAt ? calendarDateInTimeZone(occurredAt, timezone) : current.occurredOn,
      offerId: current.offerId ?? input.offerId,
      source: current.source === "unknown" ? input.source : current.source,
    })
  }

  for (const offer of offerRows) {
    const revisions = revisionsByOffer.get(offer.id) ?? []
    const selectedId = selectedByOffer.get(offer.id)
    const selected = revisions.find((item) => item.id === selectedId)
    const fundedRevision = revisions.find((item) => item.state === "funded")
    const current = revisions.find((item) => item.id === offer.current_revision_id)
    const chosen = selected ?? fundedRevision ?? current ?? revisions[0]
    const incomplete = chosen ? parseIncomplete(chosen.incomplete_fields_json) : []
    const rawAmount = chosen && !incomplete.includes("amountCents") && chosen.amount_cents != null ? Number(chosen.amount_cents) : null
    const amountCents = rawAmount != null && Number.isSafeInteger(rawAmount) ? rawAmount : null
    const occurredAt = earliest([offer.created_at, chosen?.effective_at, chosen?.created_at, ...revisions.map((item) => item.created_at)])
    const submissionKey = canonicalKey(offer.submission_id, offer.id)
    putApproval({
      id: `${offer.funder_id ?? "none"}:${submissionKey}`,
      funderId: offer.funder_id,
      dealId: offer.deal_id,
      offerId: offer.id,
      submissionKey,
      revisionCount: Math.max(revisions.length, 1),
      occurredOn: occurredAt ? calendarDateInTimeZone(occurredAt, timezone) : null,
      amountCents,
      source: offer.source,
      occurredAt,
    })
  }
  for (const row of submissionRows) {
    if (!APPROVED_SUBMISSION_STATUSES.has(row.status)) continue
    const submissionKey = canonicalKey(row.job_id ?? row.id, row.id)
    putApproval({
      id: `${row.funder_id ?? "none"}:${submissionKey}`,
      funderId: row.funder_id,
      dealId: row.deal_id,
      offerId: null,
      submissionKey,
      revisionCount: 1,
      occurredOn: null,
      amountCents: null,
      source: channelFromRouteKind(row.route_kind),
      occurredAt: null,
    })
  }
  for (const row of manualRows) {
    if (!APPROVED_MANUAL_STATES.has(row.state)) continue
    const submissionKey = canonicalKey(row.offer_id, row.id)
    const at = earliest([row.historical_at, row.created_at])
    putApproval({
      id: `${row.funder_id ?? "none"}:${submissionKey}`,
      funderId: row.funder_id,
      dealId: row.deal_id,
      offerId: row.offer_id,
      submissionKey,
      revisionCount: 1,
      occurredOn: at ? calendarDateInTimeZone(at, timezone) : null,
      amountCents: null,
      source: row.source,
      occurredAt: at,
    })
  }
  for (const row of legacyOfferRows) {
    if (!APPROVED_OFFER_STATUSES.has(row.status)) continue
    const unknown = Number(row.terms_unknown) === 1
    const submissionKey = canonicalKey(row.submission_id, row.id)
    const linked = submissionsById.get(row.submission_id)
    putApproval({
      id: `${linked?.funder_id ?? "none"}:${submissionKey}`,
      funderId: linked?.funder_id ?? null,
      dealId: row.deal_id,
      offerId: row.id,
      submissionKey,
      revisionCount: 1,
      occurredOn: null,
      amountCents: unknown ? null : amountToCents(row.amount),
      source: row.source ?? "unknown",
      occurredAt: null,
    })
  }

  const offerFunder = new Map(offerRows.map((row) => [row.id, row.funder_id ?? null]))
  const advanceRows: FunderAdvanceRow[] = []
  for (const row of fundingRows) {
    if (row.state !== "committed") continue
    const funderId = offerFunder.get(row.offer_id) ?? null
    if (!includeFunder(funderId)) continue
    const deal = scopedDeal(row.deal_id)
    if (!deal) continue
    const fundedOn = calendarDateInTimeZone(row.funded_at, timezone)
    if (!inReportPeriod(fundedOn, filters, deal.createdOn)) continue
    advanceRows.push({
      id: row.advance_id,
      funderId,
      dealId: row.deal_id,
      displayId: deal.displayId,
      legalName: deal.legalName,
      fundingEventId: row.id,
      offerId: row.offer_id,
      source: row.source,
      fundedOn,
      amountCents: Number(row.amount_cents),
    })
  }

  const paymentDrilldown: FunderPaymentRow[] = []
  if (permission.paymentsVisible) {
    for (const row of paymentRows) {
      const funderId = offerFunder.get(row.offer_id) ?? null
      if (!includeFunder(funderId)) continue
      const deal = scopedDeal(row.deal_id)
      if (!deal) continue
      const receivedOn = row.received_at
        ? calendarDateInTimeZone(row.received_at, timezone)
        : row.expected_at
          ? calendarDateInTimeZone(row.expected_at, timezone)
          : calendarDateInTimeZone(row.created_at, timezone)
      const eventOn = row.received_at ? calendarDateInTimeZone(row.received_at, timezone) : receivedOn
      if (!inReportPeriod(eventOn, filters, deal.createdOn)) continue
      paymentDrilldown.push({
        id: row.id,
        funderId,
        dealId: row.deal_id,
        displayId: deal.displayId,
        legalName: deal.legalName,
        advanceId: row.advance_id,
        type: row.type,
        origin: row.origin,
        status: row.status,
        receivedOn,
        expectedCents: Number(row.expected_amount_cents),
        collectedCents: Number(row.received_amount_cents),
      })
    }
  }

  const submissionDrilldown = [...submissionFacts.values()].sort((a, b) => (a.occurredOn ?? "").localeCompare(b.occurredOn ?? "") || a.id.localeCompare(b.id))
  const approvalDrilldown = [...approvalFacts.values()]
    .map(({ occurredAt: _occurredAt, ...row }) => row)
    .sort((a, b) => (a.occurredOn ?? "").localeCompare(b.occurredOn ?? "") || a.id.localeCompare(b.id))
  const advances = advanceRows.sort((a, b) => (a.fundedOn ?? "").localeCompare(b.fundedOn ?? "") || a.id.localeCompare(b.id))
  const payments = paymentDrilldown.sort((a, b) => (a.receivedOn ?? "").localeCompare(b.receivedOn ?? "") || a.id.localeCompare(b.id))

  const totals = buildRow(null, "All funders", submissionDrilldown, approvalDrilldown, advances, payments, permission, true)

  const funderIds = uniqueIds([
    ...submissionDrilldown.map((row) => row.funderId),
    ...approvalDrilldown.map((row) => row.funderId),
    ...advances.map((row) => row.funderId),
    ...payments.map((row) => row.funderId),
    ...(filters.funderIds ?? []),
  ]).sort((a, b) => (funderName.get(a) ?? a).localeCompare(funderName.get(b) ?? b))

  const funderRowsOut: FunderAnalyticsRow[] = []
  for (const funderId of funderIds) {
    const row = buildRow(
      funderId,
      funderName.get(funderId) ?? "Unknown funder",
      submissionDrilldown.filter((item) => item.funderId === funderId),
      approvalDrilldown.filter((item) => item.funderId === funderId),
      advances.filter((item) => item.funderId === funderId),
      payments.filter((item) => item.funderId === funderId),
      permission,
      false,
    )
    const hasActivity = row.submissions.count > 0 || row.approvals.count > 0 || row.fundings.count > 0 || (row.commissions.count ?? 0) > 0
    if (!hasActivity && !filters.funderIds?.includes(funderId)) continue
    funderRowsOut.push(row)
  }

  const unattributedSubmissions = submissionDrilldown.filter((item) => item.funderId == null)
  const unattributedApprovals = approvalDrilldown.filter((item) => item.funderId == null)
  const unattributedAdvances = advances.filter((item) => item.funderId == null)
  const unattributedPayments = payments.filter((item) => item.funderId == null)
  const unattributedHasActivity = unattributedSubmissions.length || unattributedApprovals.length || unattributedAdvances.length || unattributedPayments.length
  const unattributed = unattributedHasActivity
    ? buildRow(null, "Unattributed", unattributedSubmissions, unattributedApprovals, unattributedAdvances, unattributedPayments, permission, false)
    : null

  return {
    filters,
    period: periodFor(filters, timezone, nowIso),
    permission,
    attribution: FUNDER_ANALYTICS_ATTRIBUTION,
    totals,
    funders: funderRowsOut,
    unattributed,
    drilldown: {
      submissions: submissionDrilldown,
      approvals: approvalDrilldown,
      advances,
      payments,
    },
  }
}
