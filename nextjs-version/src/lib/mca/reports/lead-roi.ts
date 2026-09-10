import "server-only"

import { requireWorkspaceAccess } from "../auth"
import { getDatabase } from "../db"
import { actorForDeals } from "../deals/service"
import type { DealActor } from "../deals/schema"
import { AppError } from "../errors"
import { requestCorrelationId } from "../http"
import { listLatestAcquisitions } from "../leads"
import { effectivePageVisibility, isActionAllowed } from "../policy"
import { getWorkspaceSettings } from "../workspaces"
import type { ReportFilters, ReportPermissionState } from "./contracts"
import {
  calendarDateInTimeZone,
  conversionRate,
  dateInInclusiveRange,
  parseReportFilters,
} from "./rep-funnel"

export { parseReportFilters }

export const LEAD_ROI_ATTRIBUTION = {
  acquisition: "latest_acquisition_event",
  counts: "unique_acquired_deals",
  fundedDeal: "unique_acquired_deals_with_committed_funding",
  fundedMerchant: "unique_merchant_key_among_funded_acquired_deals",
  merchantKey: "ein_cipher_else_deal_id",
  renewals: "excluded_from_acquisition_counts",
  repeatFundings: "do_not_increment_funded_deal_count",
  followOnCommission: "labeled_separately",
  purchaseCost: "current_lead_batches_cost_cents",
  collectedCommission: "accounting_payments_commission_received_not_void",
  expectedCommission: "accounting_payments_commission_expected_not_void",
  roi: "(attributed_collected_commission - purchase_cost) / purchase_cost",
  expectedRoi: "(attributed_expected_commission - purchase_cost) / purchase_cost",
  followOnRoi: "(collected_plus_follow_on - purchase_cost) / purchase_cost",
  zeroCostRoi: "undefined",
  missingCost: "warning_and_undefined",
  zeroDenominator: "N/A",
} as const

const SUBMITTED_SUBMISSION_STATUSES = new Set(["sent", "errored", "declined", "approved"])
const SUBMITTED_JOB_STATES = new Set(["sent", "sending", "pending_portal"])
const APPROVED_SUBMISSION_STATUSES = new Set(["approved"])
const APPROVED_OFFER_STATUSES = new Set(["received", "presented", "accepted"])
const APPROVED_ACTIVITY = new Set(["offer", "contract", "funded"])
const SUBMITTED_ACTIVITY = new Set(["submitted", "resubmitting"])

export type LeadRoiRowKind = "source" | "batch" | "unassigned" | "totals"
export type LeadDealKind = "acquired" | "renewal" | "unassigned"
export type RoiDisplay = "ratio" | "n_a" | "undefined"
export type LeadRoiWarningCode = "missing_cost" | "zero_cost" | "unassigned_deals" | "renewals_excluded"

export interface LeadConversionMetric {
  from: "acquired" | "submitted" | "approved"
  to: "submitted" | "approved" | "funded"
  numerator: number
  denominator: number
  rate: number | null
}

export interface LeadRoiEconomics {
  paymentsVisible: boolean
  reason?: ReportPermissionState["reason"]
  purchaseCostCents: number | null
  costComplete: boolean
  zeroCost: boolean
  costPerFundedMerchantCents: number | null
  costPerFundedDealCents: number | null
  collectedCommissionCents?: number
  expectedCommissionCents?: number
  followOnCollectedCents?: number
  followOnExpectedCents?: number
  collectedRoi: number | null
  expectedRoi: number | null
  followOnCollectedRoi: number | null
  collectedRoiDisplay: RoiDisplay
  expectedRoiDisplay: RoiDisplay
  followOnRoiDisplay: RoiDisplay
  expectedRoiLabel: "expected_value"
  followOnRoiLabel: "including_follow_on"
}

export interface LeadRoiRow {
  key: string
  kind: LeadRoiRowKind
  sourceId: string | null
  batchId: string | null
  name: string
  acquiredCount: number
  submittedCount: number
  approvedCount: number
  fundedDealCount: number
  fundedMerchantCount: number
  conversions: LeadConversionMetric[]
  economics: LeadRoiEconomics
  missingCost: boolean
  missingCostBatchIds: string[]
  zeroCost: boolean
}

export interface LeadRoiDealRow {
  dealId: string
  displayId: string
  legalName: string
  sourceId: string | null
  sourceName: string | null
  batchId: string | null
  batchName: string | null
  merchantKey: string
  kind: LeadDealKind
  submitted: boolean
  approved: boolean
  funded: boolean
  committedFundingCount: number
  acquiredOn: string | null
  submittedOn: string | null
  approvedOn: string | null
  fundedOn: string | null
  collectedCommissionCents: number | null
  expectedCommissionCents: number | null
}

export interface LeadRoiWarning {
  code: LeadRoiWarningCode
  message: string
  batchIds?: string[]
  dealCount?: number
}

export interface LeadRoiPeriod {
  from?: string
  to?: string
  timezone: string
  complete: boolean
  label: string
}

export interface LeadRoiReport {
  filters: ReportFilters
  period: LeadRoiPeriod
  permission: ReportPermissionState
  attribution: typeof LEAD_ROI_ATTRIBUTION
  totals: LeadRoiRow
  sources: LeadRoiRow[]
  batches: LeadRoiRow[]
  unassigned: LeadRoiRow | null
  warnings: LeadRoiWarning[]
  options: {
    sources: Array<{ id: string; name: string }>
    batches: Array<{ id: string; sourceId: string; name: string }>
  }
  drilldown: {
    acquired: LeadRoiDealRow[]
    submitted: LeadRoiDealRow[]
    approved: LeadRoiDealRow[]
    funded: LeadRoiDealRow[]
    followOn: LeadRoiDealRow[]
    unassigned: LeadRoiDealRow[]
  }
}

interface DealFact {
  id: string
  displayId: string
  legalName: string
  merchantKey: string
  sourceId: string | null
  batchId: string | null
  kind: LeadDealKind
  createdOn: string
  acquiredOn: string | null
  submittedOn: string | null
  approvedOn: string | null
  fundedOn: string | null
  submitted: boolean
  approved: boolean
  funded: boolean
  committedFundingCount: number
  membershipIds: string[]
  funderIds: string[]
}

interface CommissionFact {
  dealId: string
  expectedCents: number
  receivedCents: number
  expectedOn: string | null
  receivedOn: string | null
}

function uniqueIds(values: Array<string | null | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value)))]
}

function earliest(values: Array<string | null | undefined>): string | null {
  const usable = values.filter((value): value is string => Boolean(value))
  if (!usable.length) return null
  return usable.reduce((min, value) => (value < min ? value : min))
}

export function merchantKeyFor(deal: { id: string; einCipher?: string | null }): string {
  const ein = deal.einCipher?.trim()
  return ein ? `ein:${ein}` : `deal:${deal.id}`
}

/** CAC helper. Zero or missing denominators are N/A, never infinity. Missing cost is N/A. Zero cost with a denominator is $0. */
export function costPerFunded(costCents: number | null, fundedCount: number): number | null {
  if (costCents == null || fundedCount <= 0) return null
  return costCents / fundedCount
}

/** ROI = (attributed collected commission − purchase cost) / purchase cost. Zero or missing cost is undefined, not infinity. */
export function roiRatio(attributedCollectedCents: number, purchaseCostCents: number | null): number | null {
  if (purchaseCostCents == null || purchaseCostCents <= 0) return null
  return (attributedCollectedCents - purchaseCostCents) / purchaseCostCents
}

export function roiDisplayFor(purchaseCostCents: number | null): RoiDisplay {
  if (purchaseCostCents == null || purchaseCostCents <= 0) return "undefined"
  return "ratio"
}

export function formatRoiPercent(value: number | null, purchaseCostCents: number | null): string {
  if (purchaseCostCents == null || purchaseCostCents <= 0) return "Undefined"
  if (value == null) return "N/A"
  const percent = value * 100
  const digits = Number.isInteger(percent) ? 0 : 1
  const sign = percent > 0 ? "+" : ""
  return `${sign}${percent.toFixed(digits)}%`
}

export function leadConversions(acquired: number, submitted: number, approved: number, funded: number): LeadConversionMetric[] {
  const pairs: Array<[LeadConversionMetric["from"], LeadConversionMetric["to"], number, number]> = [
    ["acquired", "submitted", submitted, acquired],
    ["submitted", "approved", approved, submitted],
    ["approved", "funded", funded, approved],
    ["acquired", "funded", funded, acquired],
  ]
  return pairs.map(([from, to, numerator, denominator]) => ({
    from,
    to,
    numerator,
    denominator,
    rate: conversionRate(numerator, denominator),
  }))
}

function inRangeForStage(on: string | null, filters: ReportFilters, acquiredOn: string | null): boolean {
  if (filters.basis === "cohort") return dateInInclusiveRange(acquiredOn, filters.from, filters.to)
  return dateInInclusiveRange(on, filters.from, filters.to)
}

function periodFor(filters: ReportFilters, timezone: string, nowIso: string): LeadRoiPeriod {
  const today = calendarDateInTimeZone(nowIso, timezone)
  const complete = Boolean(filters.to && filters.to < today)
  const label = !filters.to
    ? "No end date — later events may still arrive. Event basis uses full batch purchase cost; prefer cohort for purchase-window CAC."
    : filters.to >= today
      ? "This period includes today or a future date and is incomplete. Event basis uses full batch purchase cost; prefer cohort for purchase-window CAC."
      : `Inclusive ${filters.from ?? "start"} to ${filters.to} (${timezone}). Event basis uses full batch purchase cost; prefer cohort for purchase-window CAC.`
  return { from: filters.from, to: filters.to, timezone, complete, label }
}

export async function requireLeadRoiActor(request: Request): Promise<DealActor> {
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

function buildEconomics(input: {
  permission: ReportPermissionState
  companyRow: boolean
  purchaseCostCents: number | null
  costComplete: boolean
  zeroCost: boolean
  fundedDeals: number
  fundedMerchants: number
  collected: number
  expected: number
  followOnCollected: number
  followOnExpected: number
}): LeadRoiEconomics {
  const paymentsVisible = input.permission.paymentsVisible && (!input.companyRow || input.permission.companyTotalsVisible)
  const display = roiDisplayFor(input.costComplete ? input.purchaseCostCents : null)
  const costForRatios = input.costComplete ? input.purchaseCostCents : null
  return {
    paymentsVisible,
    reason: paymentsVisible ? undefined : input.permission.reason,
    purchaseCostCents: costForRatios,
    costComplete: input.costComplete,
    zeroCost: input.zeroCost,
    costPerFundedMerchantCents: costPerFunded(costForRatios, input.fundedMerchants),
    costPerFundedDealCents: costPerFunded(costForRatios, input.fundedDeals),
    collectedCommissionCents: paymentsVisible ? input.collected : undefined,
    expectedCommissionCents: paymentsVisible ? input.expected : undefined,
    followOnCollectedCents: paymentsVisible ? input.followOnCollected : undefined,
    followOnExpectedCents: paymentsVisible ? input.followOnExpected : undefined,
    collectedRoi: paymentsVisible ? roiRatio(input.collected, costForRatios) : null,
    expectedRoi: paymentsVisible ? roiRatio(input.expected, costForRatios) : null,
    followOnCollectedRoi: paymentsVisible ? roiRatio(input.collected + input.followOnCollected, costForRatios) : null,
    collectedRoiDisplay: paymentsVisible ? display : "undefined",
    expectedRoiDisplay: paymentsVisible ? display : "undefined",
    followOnRoiDisplay: paymentsVisible ? display : "undefined",
    expectedRoiLabel: "expected_value",
    followOnRoiLabel: "including_follow_on",
  }
}

function summarizeCost(batchIds: string[], batches: Map<string, { costCents: number | null }>): {
  purchaseCostCents: number | null
  costComplete: boolean
  zeroCost: boolean
  missingCost: boolean
  missingCostBatchIds: string[]
} {
  const unique = uniqueIds(batchIds)
  const missingCostBatchIds = unique.filter((id) => (batches.get(id)?.costCents ?? null) == null)
  const known = unique.map((id) => batches.get(id)?.costCents).filter((value): value is number => value != null)
  const missingCost = missingCostBatchIds.length > 0
  const costComplete = !missingCost
  const purchaseCostCents = costComplete ? known.reduce((sum, value) => sum + value, 0) : null
  const zeroCost = costComplete && purchaseCostCents === 0 && unique.length > 0
  return { purchaseCostCents, costComplete, zeroCost, missingCost, missingCostBatchIds }
}

function commissionInRange(item: CommissionFact, filters: ReportFilters, acquiredOn: string | null, field: "received" | "expected"): boolean {
  if (filters.basis === "cohort") return dateInInclusiveRange(acquiredOn, filters.from, filters.to)
  const on = field === "received" ? item.receivedOn : item.expectedOn
  return dateInInclusiveRange(on, filters.from, filters.to)
}

export function drilldownReconcilesLeadRoi(report: Pick<LeadRoiReport, "totals" | "drilldown">): boolean {
  const unique = (rows: LeadRoiDealRow[]) => new Set(rows.map((row) => row.dealId))
  if (unique(report.drilldown.acquired).size !== report.totals.acquiredCount) return false
  if (report.drilldown.acquired.length !== report.totals.acquiredCount) return false
  if (unique(report.drilldown.submitted).size !== report.totals.submittedCount) return false
  if (unique(report.drilldown.approved).size !== report.totals.approvedCount) return false
  if (unique(report.drilldown.funded).size !== report.totals.fundedDealCount) return false
  if (new Set(report.drilldown.funded.map((row) => row.merchantKey)).size !== report.totals.fundedMerchantCount) return false
  if (report.drilldown.acquired.some((row) => row.kind !== "acquired")) return false
  if (report.drilldown.funded.some((row) => row.kind !== "acquired" || !row.funded)) return false
  if (report.drilldown.followOn.some((row) => row.kind !== "renewal")) return false
  return true
}

export async function getLeadRoiReport(actor: DealActor, filters: ReportFilters, nowIso = new Date().toISOString()): Promise<LeadRoiReport> {
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
    legacyOfferRows,
    fundingRows,
    sourceRows,
    batchRows,
    acquisitions,
    renewalRows,
    advanceRows,
    paymentRows,
  ] = await Promise.all([
    db.prepare<{ id: string; display_id: string; legal_name: string | null; ein_cipher: string | null; created_at: string }>(
      "SELECT id, display_id, legal_name, ein_cipher, created_at FROM deals WHERE workspace_id = ?",
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
    db.prepare<{ deal_id: string; funder_id: string | null; created_at: string }>(
      "SELECT deal_id, funder_id, created_at FROM mca_offers WHERE workspace_id = ?",
    ).all(actor.workspaceId),
    db.prepare<{ deal_id: string; status: string }>(
      "SELECT deal_id, status FROM deal_offers WHERE workspace_id = ?",
    ).all(actor.workspaceId),
    db.prepare<{ deal_id: string; funded_at: string; state: string }>(
      "SELECT deal_id, funded_at, state FROM mca_funding_events WHERE workspace_id = ?",
    ).all(actor.workspaceId),
    db.prepare<{ id: string; name: string }>(
      "SELECT id, name FROM import_sources WHERE workspace_id = ? ORDER BY name",
    ).all(actor.workspaceId),
    db.prepare<{ id: string; source_id: string; name: string; cost_cents: number | null; purchased_on: string | null }>(
      "SELECT id, source_id, name, cost_cents, purchased_on FROM lead_batches WHERE workspace_id = ? ORDER BY name",
    ).all(actor.workspaceId),
    listLatestAcquisitions(actor.workspaceId),
    db.prepare<{ renewed_deal_id: string; source_advance_id: string }>(
      "SELECT renewed_deal_id, source_advance_id FROM mca_renewal_actions WHERE workspace_id = ? AND renewed_deal_id IS NOT NULL",
    ).all(actor.workspaceId),
    db.prepare<{ id: string; deal_id: string }>(
      "SELECT id, deal_id FROM mca_advances WHERE workspace_id = ?",
    ).all(actor.workspaceId),
    permission.paymentsVisible
      ? db.prepare<{ deal_id: string; expected_amount_cents: number; received_amount_cents: number; expected_at: string | null; received_at: string | null; created_at: string }>(
        `SELECT a.deal_id, p.expected_amount_cents, p.received_amount_cents, p.expected_at, p.received_at, p.created_at
         FROM mca_accounting_payments p
         JOIN mca_advances a ON a.workspace_id = p.workspace_id AND a.id = p.advance_id
         WHERE p.workspace_id = ? AND p.type = 'commission' AND p.status <> 'void'`,
      ).all(actor.workspaceId)
      : Promise.resolve([]),
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

  const approvedFlag = new Map<string, boolean>()
  const approvedFunders = new Map<string, string[]>()
  function markApproved(dealId: string, at: string | null | undefined, funderId: string | null) {
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
  }
  for (const row of submissionRows) {
    if (APPROVED_SUBMISSION_STATUSES.has(row.status)) markApproved(row.deal_id, null, row.funder_id)
  }
  for (const row of manualRows) {
    if (row.state === "approved" || row.state === "funded") {
      markApproved(row.deal_id, earliest([row.historical_at, row.created_at]), row.funder_id)
    }
  }
  for (const row of legacyOfferRows) {
    if (APPROVED_OFFER_STATUSES.has(row.status)) markApproved(row.deal_id, null, null)
  }
  for (const offer of offerRows) {
    markApproved(offer.deal_id, offer.created_at, offer.funder_id)
  }

  const fundedAt = new Map<string, string>()
  const fundedCount = new Map<string, number>()
  const fundedFunders = new Map<string, string[]>()
  const offerFunder = new Map(offerRows.map((row) => [row.deal_id, row.funder_id]))
  for (const row of fundingRows) {
    if (row.state !== "committed") continue
    fundedCount.set(row.deal_id, (fundedCount.get(row.deal_id) ?? 0) + 1)
    const current = fundedAt.get(row.deal_id)
    if (!current || row.funded_at < current) fundedAt.set(row.deal_id, row.funded_at)
    const funderId = offerFunder.get(row.deal_id) ?? null
    if (funderId) {
      const list = fundedFunders.get(row.deal_id) ?? []
      list.push(funderId)
      fundedFunders.set(row.deal_id, uniqueIds(list))
    }
  }

  const acquisitionByDeal = new Map(acquisitions.map((event) => [event.dealId, event]))
  const advanceDeal = new Map(advanceRows.map((row) => [row.id, row.deal_id]))
  const renewalOriginal = new Map<string, string>()
  const renewalDealIds = new Set<string>()
  for (const row of renewalRows) {
    renewalDealIds.add(row.renewed_deal_id)
    const originalId = advanceDeal.get(row.source_advance_id)
    if (originalId) renewalOriginal.set(row.renewed_deal_id, originalId)
  }

  const sourceName = new Map(sourceRows.map((row) => [row.id, row.name]))
  const batchInfo = new Map(batchRows.map((row) => [row.id, {
    id: row.id,
    sourceId: row.source_id,
    name: row.name,
    costCents: row.cost_cents == null ? null : Number(row.cost_cents),
    purchasedOn: row.purchased_on,
  }]))

  const funderSet = filters.funderIds?.length ? new Set(filters.funderIds) : null
  const sourceSet = filters.sourceIds?.length ? new Set(filters.sourceIds) : null
  const batchSet = filters.batchIds?.length ? new Set(filters.batchIds) : null
  const membershipSet = filters.membershipIds?.length ? new Set(filters.membershipIds) : null

  const deals: DealFact[] = dealRows.map((row) => {
    const createdStamp = createdAt.get(row.id) ?? row.created_at
    const createdOn = calendarDateInTimeZone(createdStamp, timezone)
    const acquisition = acquisitionByDeal.get(row.id)
    const purchasedOn = acquisition?.purchasedOn && /^\d{4}-\d{2}-\d{2}$/.test(acquisition.purchasedOn)
      ? acquisition.purchasedOn
      : null
    const acquiredOn = purchasedOn
      ?? (acquisition ? calendarDateInTimeZone(acquisition.createdAt, timezone) || createdOn : createdOn)
    const submittedStamp = submittedAt.get(row.id) ?? null
    const approvedStamp = approvedAt.get(row.id) ?? null
    const fundedStamp = fundedAt.get(row.id) ?? null
    const submittedFundersForDeal = submittedFunders.get(row.id) ?? []
    const approvedFundersForDeal = approvedFunders.get(row.id) ?? []
    const fundedFundersForDeal = fundedFunders.get(row.id) ?? []
    const submitted = Boolean(submittedFlag.get(row.id) || submittedStamp) && (!funderSet || submittedFundersForDeal.some((id) => funderSet.has(id)))
    const approved = Boolean(approvedFlag.get(row.id) || approvedStamp) && (!funderSet || approvedFundersForDeal.some((id) => funderSet.has(id)))
    const committedFundingCount = fundedCount.get(row.id) ?? 0
    const funded = committedFundingCount > 0 && (!funderSet || fundedFundersForDeal.some((id) => funderSet.has(id)))
    const isRenewal = renewalDealIds.has(row.id)
    const hasAcquisition = Boolean(acquisition?.sourceId || acquisition?.batchId)
    const kind: LeadDealKind = isRenewal ? "renewal" : hasAcquisition ? "acquired" : "unassigned"
    return {
      id: row.id,
      displayId: row.display_id,
      legalName: row.legal_name?.trim() || "Untitled draft",
      merchantKey: merchantKeyFor({ id: row.id, einCipher: row.ein_cipher }),
      sourceId: acquisition?.sourceId ?? null,
      batchId: acquisition?.batchId ?? null,
      kind,
      createdOn,
      acquiredOn,
      submittedOn: submittedStamp ? calendarDateInTimeZone(submittedStamp, timezone) : null,
      approvedOn: approvedStamp ? calendarDateInTimeZone(approvedStamp, timezone) : null,
      fundedOn: fundedStamp ? calendarDateInTimeZone(fundedStamp, timezone) : null,
      submitted,
      approved,
      funded,
      committedFundingCount,
      membershipIds: assignments.get(row.id) ?? [],
      funderIds: uniqueIds([...submittedFundersForDeal, ...approvedFundersForDeal, ...fundedFundersForDeal]),
    }
  })

  function passesStaticFilters(deal: DealFact): boolean {
    if (funderSet && !deal.funderIds.some((id) => funderSet.has(id))) return false
    if (sourceSet && deal.kind !== "renewal" && (deal.sourceId == null || !sourceSet.has(deal.sourceId))) return false
    if (batchSet && deal.kind !== "renewal" && (deal.batchId == null || !batchSet.has(deal.batchId))) return false
    if (membershipSet && !deal.membershipIds.some((id) => membershipSet.has(id))) return false
    return true
  }

  const scoped = deals.filter(passesStaticFilters)
  const dealById = new Map(deals.map((deal) => [deal.id, deal]))

  const commissions: CommissionFact[] = paymentRows.map((row) => ({
    dealId: row.deal_id,
    expectedCents: Number(row.expected_amount_cents),
    receivedCents: Number(row.received_amount_cents),
    expectedOn: row.expected_at ? calendarDateInTimeZone(row.expected_at, timezone) || row.expected_at : calendarDateInTimeZone(row.created_at, timezone),
    receivedOn: row.received_at ? calendarDateInTimeZone(row.received_at, timezone) || row.received_at : null,
  }))

  function sumCommission(dealIds: Set<string>, field: "received" | "expected"): number {
    let total = 0
    for (const item of commissions) {
      if (!dealIds.has(item.dealId)) continue
      const deal = dealById.get(item.dealId)
      if (!commissionInRange(item, filters, deal?.acquiredOn ?? null, field)) continue
      total += field === "received" ? item.receivedCents : item.expectedCents
    }
    return total
  }

  function acquiredInRange(deal: DealFact): boolean {
    return deal.kind === "acquired" && inRangeForStage(deal.acquiredOn, filters, deal.acquiredOn)
  }
  function submittedInRange(deal: DealFact): boolean {
    return deal.kind === "acquired" && deal.submitted && inRangeForStage(deal.submittedOn, filters, deal.acquiredOn)
  }
  function approvedInRange(deal: DealFact): boolean {
    return deal.kind === "acquired" && deal.approved && inRangeForStage(deal.approvedOn, filters, deal.acquiredOn)
  }
  function fundedInRange(deal: DealFact): boolean {
    return deal.kind === "acquired" && deal.funded && inRangeForStage(deal.fundedOn, filters, deal.acquiredOn)
  }

  const acquiredDeals = scoped.filter(acquiredInRange)
  const submittedDeals = scoped.filter(submittedInRange)
  const approvedDeals = scoped.filter(approvedInRange)
  const fundedDeals = scoped.filter(fundedInRange)
  const unassignedDeals = scoped.filter((deal) => deal.kind === "unassigned" && inRangeForStage(deal.acquiredOn, filters, deal.acquiredOn))

  const originalInUniverse = new Set(acquiredDeals.map((deal) => deal.id))
  const followOnDeals = scoped.filter((deal) => {
    if (deal.kind !== "renewal") return false
    const originalId = renewalOriginal.get(deal.id)
    const original = originalId ? dealById.get(originalId) : undefined
    if (!original || original.kind !== "acquired") return inRangeForStage(deal.fundedOn ?? deal.acquiredOn, filters, deal.acquiredOn)
    if (sourceSet && (original.sourceId == null || !sourceSet.has(original.sourceId))) return false
    if (batchSet && (original.batchId == null || !batchSet.has(original.batchId))) return false
    return originalInUniverse.has(original.id) || (filters.basis === "event" && inRangeForStage(deal.fundedOn, filters, original.acquiredOn))
  })

  function toRow(deal: DealFact): LeadRoiDealRow {
    const collected = permission.paymentsVisible ? sumCommission(new Set([deal.id]), "received") : null
    const expected = permission.paymentsVisible ? sumCommission(new Set([deal.id]), "expected") : null
    return {
      dealId: deal.id,
      displayId: deal.displayId,
      legalName: deal.legalName,
      sourceId: deal.sourceId,
      sourceName: deal.sourceId ? sourceName.get(deal.sourceId) ?? null : null,
      batchId: deal.batchId,
      batchName: deal.batchId ? batchInfo.get(deal.batchId)?.name ?? null : null,
      merchantKey: deal.merchantKey,
      kind: deal.kind,
      submitted: deal.submitted,
      approved: deal.approved,
      funded: deal.funded,
      committedFundingCount: deal.committedFundingCount,
      acquiredOn: deal.acquiredOn,
      submittedOn: deal.submittedOn,
      approvedOn: deal.approvedOn,
      fundedOn: deal.fundedOn,
      collectedCommissionCents: collected,
      expectedCommissionCents: expected,
    }
  }

  const followOnByOriginal = new Map<string, string[]>()
  for (const deal of followOnDeals) {
    const originalId = renewalOriginal.get(deal.id)
    if (!originalId) continue
    const list = followOnByOriginal.get(originalId) ?? []
    list.push(deal.id)
    followOnByOriginal.set(originalId, list)
  }

  function followOnIdsFor(acquired: DealFact[]): Set<string> {
    const ids = new Set<string>()
    for (const deal of acquired) {
      for (const followId of followOnByOriginal.get(deal.id) ?? []) ids.add(followId)
    }
    return ids
  }

  function countsFor(group: DealFact[], includeUnassigned = false) {
    const eligible = (deal: DealFact) => {
      if (deal.kind === "renewal") return false
      if (deal.kind === "acquired") return true
      return includeUnassigned && deal.kind === "unassigned"
    }
    const acquired = group.filter((deal) => eligible(deal) && inRangeForStage(deal.acquiredOn, filters, deal.acquiredOn))
    const submitted = group.filter((deal) => eligible(deal) && deal.submitted && inRangeForStage(deal.submittedOn, filters, deal.acquiredOn))
    const approved = group.filter((deal) => eligible(deal) && deal.approved && inRangeForStage(deal.approvedOn, filters, deal.acquiredOn))
    const funded = group.filter((deal) => eligible(deal) && deal.funded && inRangeForStage(deal.fundedOn, filters, deal.acquiredOn))
    return {
      acquired,
      submitted,
      approved,
      funded,
      acquiredCount: acquired.length,
      submittedCount: submitted.length,
      approvedCount: approved.length,
      fundedDealCount: funded.length,
      fundedMerchantCount: new Set(funded.map((deal) => deal.merchantKey)).size,
    }
  }

  function rowFrom(
    kind: LeadRoiRowKind,
    key: string,
    name: string,
    sourceId: string | null,
    batchId: string | null,
    group: DealFact[],
    costBatchIds: string[],
    companyRow: boolean,
    includeUnassigned = false,
  ): LeadRoiRow {
    const counted = countsFor(group, includeUnassigned)
    const cost = summarizeCost(costBatchIds, batchInfo)
    const acquiredIds = new Set(counted.acquired.map((deal) => deal.id))
    const followIds = followOnIdsFor(counted.acquired)
    const economics = buildEconomics({
      permission,
      companyRow,
      purchaseCostCents: cost.purchaseCostCents,
      costComplete: cost.costComplete,
      zeroCost: cost.zeroCost,
      fundedDeals: counted.fundedDealCount,
      fundedMerchants: counted.fundedMerchantCount,
      collected: sumCommission(acquiredIds, "received"),
      expected: sumCommission(acquiredIds, "expected"),
      followOnCollected: sumCommission(followIds, "received"),
      followOnExpected: sumCommission(followIds, "expected"),
    })
    return {
      key,
      kind,
      sourceId,
      batchId,
      name,
      acquiredCount: counted.acquiredCount,
      submittedCount: counted.submittedCount,
      approvedCount: counted.approvedCount,
      fundedDealCount: counted.fundedDealCount,
      fundedMerchantCount: counted.fundedMerchantCount,
      conversions: leadConversions(counted.acquiredCount, counted.submittedCount, counted.approvedCount, counted.fundedDealCount),
      economics,
      missingCost: cost.missingCost,
      missingCostBatchIds: cost.missingCostBatchIds,
      zeroCost: cost.zeroCost,
    }
  }

  function batchHasUniverse(batchId: string): boolean {
    if (acquiredDeals.some((deal) => deal.batchId === batchId)) return true
    if (submittedDeals.some((deal) => deal.batchId === batchId)) return true
    if (approvedDeals.some((deal) => deal.batchId === batchId)) return true
    if (fundedDeals.some((deal) => deal.batchId === batchId)) return true
    const purchasedOn = batchInfo.get(batchId)?.purchasedOn
    if (purchasedOn && dateInInclusiveRange(purchasedOn, filters.from, filters.to)) return true
    if (batchSet?.has(batchId)) return true
    return false
  }

  const includedBatches = batchRows.filter((row) => {
    if (sourceSet && !sourceSet.has(row.source_id)) return false
    if (batchSet && !batchSet.has(row.id)) return false
    return batchHasUniverse(row.id)
  })

  const batchRowsOut = includedBatches.map((row) => {
    const group = scoped.filter((deal) => deal.batchId === row.id)
    return rowFrom("batch", `batch:${row.id}`, row.name, row.source_id, row.id, group, [row.id], false)
  }).sort((a, b) => a.name.localeCompare(b.name))

  const includedSourceIds = uniqueIds([
    ...includedBatches.map((row) => row.source_id),
    ...acquiredDeals.map((deal) => deal.sourceId),
  ]).filter((id) => !sourceSet || sourceSet.has(id))

  const sourceRowsOut = includedSourceIds.map((sourceId) => {
    const name = sourceName.get(sourceId) ?? "Unknown source"
    const group = scoped.filter((deal) => deal.sourceId === sourceId)
    const costBatchIds = includedBatches.filter((row) => row.source_id === sourceId).map((row) => row.id)
    return rowFrom("source", `source:${sourceId}`, name, sourceId, null, group, costBatchIds, false)
  }).sort((a, b) => a.name.localeCompare(b.name))

  const totalsCostBatchIds = includedBatches.map((row) => row.id)
  const totals = rowFrom("totals", "totals", "All sources (unique acquired deals)", null, null, scoped, totalsCostBatchIds, true)

  const unassigned = unassignedDeals.length > 0
    ? rowFrom("unassigned", "unassigned", "Unassigned", null, null, unassignedDeals, [], false, true)
    : null

  const missingCostBatchIds = uniqueIds(batchRowsOut.filter((row) => row.missingCost).map((row) => row.batchId))
  const zeroCostBatchIds = uniqueIds(batchRowsOut.filter((row) => row.zeroCost).map((row) => row.batchId))
  const excludedRenewals = followOnDeals.length
  const repeatFundings = acquiredDeals.filter((deal) => deal.committedFundingCount > 1).length
  const warnings: LeadRoiWarning[] = []
  if (missingCostBatchIds.length) {
    warnings.push({
      code: "missing_cost",
      message: "Blank purchase cost is missing. CAC and ROI are omitted for those batches — missing cost is not treated as $0.",
      batchIds: missingCostBatchIds,
    })
  }
  if (zeroCostBatchIds.length) {
    warnings.push({
      code: "zero_cost",
      message: "A $0.00 batch cost is a real zero. ROI is undefined, not infinity.",
      batchIds: zeroCostBatchIds,
    })
  }
  if (unassignedDeals.length) {
    warnings.push({
      code: "unassigned_deals",
      message: `${unassignedDeals.length} deal${unassignedDeals.length === 1 ? "" : "s"} have no source/batch assignment and are excluded from CAC.`,
      dealCount: unassignedDeals.length,
    })
  }
  if (excludedRenewals || repeatFundings) {
    warnings.push({
      code: "renewals_excluded",
      message: "Renewal deals and repeat fundings do not increment acquisition or funded-deal counts. Follow-on commission is labeled separately from collected ROI.",
      dealCount: excludedRenewals,
    })
  }

  return {
    filters,
    period: periodFor(filters, timezone, nowIso),
    permission,
    attribution: LEAD_ROI_ATTRIBUTION,
    totals,
    sources: sourceRowsOut,
    batches: batchRowsOut,
    unassigned,
    warnings,
    options: {
      sources: sourceRows.map((row) => ({ id: row.id, name: row.name })),
      batches: batchRows.map((row) => ({ id: row.id, sourceId: row.source_id, name: row.name })),
    },
    drilldown: {
      acquired: acquiredDeals.map(toRow),
      submitted: submittedDeals.map(toRow),
      approved: approvedDeals.map(toRow),
      funded: fundedDeals.map(toRow),
      followOn: followOnDeals.map(toRow),
      unassigned: unassignedDeals.map(toRow),
    },
  }
}
