import "server-only"
import { membershipProfileNameSql } from "../membership-profile"

import { getDatabase } from "../db"
import type { DealActor } from "../deals/schema"
import { AppError } from "../errors"
import type { ReportFilters, ReportPermissionState } from "./contracts"
import {
  SHARED_REP_ATTRIBUTION,
  calendarDateInTimeZone,
  dateInInclusiveRange,
  FUNNEL_STAGES,
  getRepFunnelReport,
  parseReportFilters,
  requireRepFunnelActor,
  stageMetric,
  type DistributionMetric,
  type FunnelDealRow,
  type FunnelPeriod,
  type FunnelStage,
  type RepFunnelReport,
  type StageMetric,
} from "./rep-funnel"

export { SHARED_REP_ATTRIBUTION, parseReportFilters, requireRepFunnelActor }

export const REVENUE_RECOGNITIONS = ["collected", "expected"] as const
export type RevenueRecognition = (typeof REVENUE_RECOGNITIONS)[number]

export const TEAM_PROFIT_DEFINITIONS = {
  uniqueDeals: "Company and manager totals count each deal once. Shared originator/closer assignments still give each user full row credit.",
  collectedRevenue: "Received commission and fee amounts on non-void ledger payments. Void and reversed rows are omitted.",
  expectedRevenue: "Expected commission and fee amounts on non-void ledger payments, including unpaid expected rows.",
  paidDistributions: "Paid recipient distribution rows on non-void payments. Splits sum to the unique company total.",
  expectedDistributions: "Unpaid expected recipient distribution rows on non-void payments.",
  grossContribution: "Collected commission and fees minus paid distributions. Other operating costs are not subtracted.",
  otherOperatingCosts: "Lead-batch purchase costs in the period. Displayed separately from gross contribution.",
  userCredit: "Each assigned originator and closer receives full deal credit and full attributed revenue. Company totals stay unique.",
  managerGrouping: "A manager row unions the team's deals and payments once. Shared deals inside the team are not double-counted.",
  reversalEvidence: "Voided payments, reversed funding events, and accounting adjustments stay listed with record ids, timestamps, amounts, and correlation ids.",
} as const

export interface MoneyMetric {
  visible: boolean
  collectedCents?: number
  expectedCents?: number
  reason?: ReportPermissionState["reason"]
}

export interface OperatingCostMetric {
  visible: boolean
  knownCents?: number
  unknownCount?: number
  complete?: boolean
  excludedFromGrossContribution: true
  reason?: ReportPermissionState["reason"]
}

export interface GrossContributionMetric {
  visible: boolean
  collectedCents?: number
  expectedCents?: number
  formula: "collected_commission_and_fees_minus_paid_distributions"
  excludesOperatingCosts: true
  reason?: ReportPermissionState["reason"]
}

export interface TeamProfitRow {
  membershipId: string | null
  name: string
  kind: "company" | "user" | "manager" | "unassigned"
  memberIds: string[]
  stages: Record<FunnelStage, StageMetric>
  revenue: MoneyMetric
  distributions: DistributionMetric
  grossContribution: GrossContributionMetric
}

export interface LedgerEvidenceRow {
  kind: "payment_void" | "funding_reversal" | "adjustment"
  recordId: string
  paymentId?: string
  fundingEventId?: string
  dealId?: string | null
  amountCents: number
  occurredAt: string
  occurredOn: string | null
  reason?: string
  correlationId?: string
  status: string
}

export interface TeamProfitReport {
  filters: ReportFilters
  recognition: RevenueRecognition
  period: FunnelPeriod
  permission: ReportPermissionState
  attribution: typeof SHARED_REP_ATTRIBUTION
  definitions: typeof TEAM_PROFIT_DEFINITIONS
  company: TeamProfitRow
  users: TeamProfitRow[]
  managers: TeamProfitRow[]
  unassigned: TeamProfitRow | null
  evidence: LedgerEvidenceRow[]
  otherOperatingCosts: OperatingCostMetric
}

interface DealScope {
  id: string
  createdOn: string
  membershipIds: string[]
  funderIds: string[]
  sourceIds: string[]
  batchIds: string[]
}

const GROSS_FORMULA = "collected_commission_and_fees_minus_paid_distributions" as const

export function parseTeamProfitFilters(search: URLSearchParams): { filters: ReportFilters; recognition: RevenueRecognition } {
  const filters = parseReportFilters(search)
  const raw = search.get("recognition")
  if (raw && raw !== "collected" && raw !== "expected") {
    throw new AppError(422, "invalid_filter", "recognition must be collected or expected.", { recognition: ["Choose collected or expected."] })
  }
  return { filters, recognition: raw === "expected" ? "expected" : "collected" }
}

export async function requireTeamProfitActor(request: Request): Promise<DealActor> {
  return requireRepFunnelActor(request)
}

export function grossContributionCents(collectedRevenueCents: number, paidDistributionCents: number): number {
  return collectedRevenueCents - paidDistributionCents
}

export function expectedGrossContributionCents(
  expectedRevenueCents: number,
  paidDistributionCents: number,
  expectedDistributionCents: number,
): number {
  return expectedRevenueCents - paidDistributionCents - expectedDistributionCents
}

export function companyDealCountsMatchFunnel(report: Pick<TeamProfitReport, "company">, funnel: Pick<RepFunnelReport, "totals">): boolean {
  return FUNNEL_STAGES.every((stage) => report.company.stages[stage].dealCount === funnel.totals.stages[stage].dealCount)
}

export function summedUserDealCount(report: Pick<TeamProfitReport, "users" | "unassigned">, stage: FunnelStage): number {
  return report.users.reduce((sum, row) => sum + row.stages[stage].dealCount, 0) + (report.unassigned?.stages[stage].dealCount ?? 0)
}

function uniqueIds(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))]
}

function inRangeForEvent(on: string | null, filters: ReportFilters, createdOn: string): boolean {
  if (filters.basis === "cohort") return dateInInclusiveRange(createdOn, filters.from, filters.to)
  return dateInInclusiveRange(on, filters.from, filters.to)
}

function moneyVisible(permission: ReportPermissionState, companyRow: boolean): boolean {
  return permission.paymentsVisible && (!companyRow || permission.companyTotalsVisible)
}

function restrictedReason(permission: ReportPermissionState): ReportPermissionState["reason"] {
  if (!permission.paymentsVisible) return "payment_permission_required"
  if (!permission.companyTotalsVisible) return "company_totals_restricted"
  return permission.reason
}

function emptyMoney(permission: ReportPermissionState, companyRow: boolean): MoneyMetric {
  if (!moneyVisible(permission, companyRow)) {
    return { visible: false, reason: restrictedReason(permission) }
  }
  return { visible: true, collectedCents: 0, expectedCents: 0 }
}

function moneyFrom(collectedCents: number, expectedCents: number, permission: ReportPermissionState, companyRow: boolean): MoneyMetric {
  if (!moneyVisible(permission, companyRow)) {
    return { visible: false, reason: restrictedReason(permission) }
  }
  return { visible: true, collectedCents, expectedCents }
}

function emptyDistributions(permission: ReportPermissionState): DistributionMetric {
  if (!permission.paymentsVisible) return { visible: false, reason: "payment_permission_required" }
  return { visible: true, expectedCents: 0, paidCents: 0, count: 0 }
}

function sumDistributions(items: DistributionMetric[], permission: ReportPermissionState): DistributionMetric {
  if (!permission.paymentsVisible) return emptyDistributions(permission)
  return items.reduce<DistributionMetric>((metric, item) => {
    if (!item.visible) return metric
    return {
      visible: true,
      expectedCents: (metric.expectedCents ?? 0) + (item.expectedCents ?? 0),
      paidCents: (metric.paidCents ?? 0) + (item.paidCents ?? 0),
      count: (metric.count ?? 0) + (item.count ?? 0),
    }
  }, emptyDistributions(permission))
}

export function buildGrossContribution(
  revenue: MoneyMetric,
  distributions: DistributionMetric,
  permission: ReportPermissionState,
  companyRow: boolean,
): GrossContributionMetric {
  if (!moneyVisible(permission, companyRow) || !revenue.visible) {
    return {
      visible: false,
      formula: GROSS_FORMULA,
      excludesOperatingCosts: true,
      reason: restrictedReason(permission),
    }
  }
  const paid = distributions.visible ? (distributions.paidCents ?? 0) : 0
  const expectedDist = distributions.visible ? (distributions.expectedCents ?? 0) : 0
  return {
    visible: true,
    collectedCents: grossContributionCents(revenue.collectedCents ?? 0, paid),
    expectedCents: expectedGrossContributionCents(revenue.expectedCents ?? 0, paid, expectedDist),
    formula: GROSS_FORMULA,
    excludesOperatingCosts: true,
  }
}

function uniqueStageMetric(rows: FunnelDealRow[], restricted: boolean): StageMetric {
  const unique = [...new Map(rows.map((row) => [row.dealId, row])).values()]
  return stageMetric(unique, restricted)
}

function dealPassesFilters(deal: DealScope, filters: ReportFilters): boolean {
  const membershipSet = filters.membershipIds?.length ? new Set(filters.membershipIds) : null
  const funderSet = filters.funderIds?.length ? new Set(filters.funderIds) : null
  const sourceSet = filters.sourceIds?.length ? new Set(filters.sourceIds) : null
  const batchSet = filters.batchIds?.length ? new Set(filters.batchIds) : null
  if (membershipSet && !deal.membershipIds.some((id) => membershipSet.has(id))) return false
  if (funderSet && !deal.funderIds.some((id) => funderSet.has(id))) return false
  if (sourceSet && !deal.sourceIds.some((id) => sourceSet.has(id))) return false
  if (batchSet && !deal.batchIds.some((id) => batchSet.has(id))) return false
  return true
}

function parseMetadata(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>
  if (typeof value !== "string" || !value) return {}
  try {
    const parsed = JSON.parse(value) as unknown
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {}
  } catch {
    return {}
  }
}

export async function getTeamProfitReport(
  actor: DealActor,
  filters: ReportFilters,
  nowIso = new Date().toISOString(),
  recognition: RevenueRecognition = "collected",
): Promise<TeamProfitReport> {
  const funnel = await getRepFunnelReport(actor, filters, nowIso)
  const permission = funnel.permission
  const timezone = funnel.period.timezone
  const db = getDatabase()
  const companyRestricted = !permission.companyTotalsVisible

  const [
    dealRows,
    assignmentRows,
    createdActivityRows,
    submissionRows,
    offerRows,
    acquisitionRows,
    importLinkRows,
    memberRows,
    paymentRows,
    voidedPaymentRows,
    adjustmentRows,
    reversalRows,
    auditRows,
    batchRows,
  ] = await Promise.all([
    db.prepare<{ id: string; created_at: string }>("SELECT id, created_at FROM deals WHERE workspace_id = ?").all(actor.workspaceId),
    db.prepare<{ deal_id: string; membership_id: string }>("SELECT deal_id, membership_id FROM deal_assignments WHERE workspace_id = ?").all(actor.workspaceId),
    db.prepare<{ deal_id: string; created_at: string }>(
      "SELECT deal_id, created_at FROM deal_activity WHERE workspace_id = ? AND action = 'created'",
    ).all(actor.workspaceId),
    db.prepare<{ deal_id: string; funder_id: string | null }>("SELECT deal_id, funder_id FROM deal_submissions WHERE workspace_id = ?").all(actor.workspaceId),
    db.prepare<{ deal_id: string; funder_id: string | null }>("SELECT deal_id, funder_id FROM mca_offers WHERE workspace_id = ?").all(actor.workspaceId),
    db.prepare<{ deal_id: string; source_id: string | null; batch_id: string | null }>(
      "SELECT deal_id, source_id, batch_id FROM mca_deal_acquisition_events WHERE workspace_id = ?",
    ).all(actor.workspaceId),
    db.prepare<{ deal_id: string; source_id: string; batch_id: string }>(
      `SELECT ir.deal_id, r.source_id, r.batch_id
       FROM import_rows ir
       JOIN import_runs r ON r.id = ir.run_id AND r.workspace_id = ir.workspace_id
       WHERE ir.workspace_id = ? AND ir.deal_id IS NOT NULL`,
    ).all(actor.workspaceId),
    db.prepare<{ id: string; role: string; manager_membership_id: string | null; name: string }>(
      `SELECT m.id, m.role, m.manager_membership_id, ${membershipProfileNameSql} AS name FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.workspace_id = ?`,
    ).all(actor.workspaceId),
    permission.paymentsVisible
      ? db.prepare<{
        id: string
        expected_amount_cents: number
        received_amount_cents: number
        expected_at: string | null
        received_at: string | null
        status: string
        created_at: string
        updated_at: string
        deal_id: string
      }>(
        `SELECT p.id,
            p.expected_amount_cents + COALESCE((SELECT sum(a.amount_cents) FROM mca_accounting_adjustments a
              WHERE a.workspace_id=p.workspace_id AND a.payment_id=p.id),0)::int AS expected_amount_cents,
            p.received_amount_cents, p.expected_at, p.received_at, p.status, p.created_at, p.updated_at, adv.deal_id
         FROM mca_accounting_payments p
         JOIN mca_advances adv ON adv.workspace_id = p.workspace_id AND adv.id = p.advance_id
         WHERE p.workspace_id = ? AND p.type IN ('commission','fee')`,
      ).all(actor.workspaceId)
      : Promise.resolve([]),
    permission.paymentsVisible
      ? db.prepare<{
        id: string
        expected_amount_cents: number
        received_amount_cents: number
        expected_at: string | null
        received_at: string | null
        status: string
        created_at: string
        updated_at: string
        deal_id: string
      }>(
        `SELECT p.id, p.expected_amount_cents, p.received_amount_cents, p.expected_at, p.received_at, p.status, p.created_at, p.updated_at, adv.deal_id
         FROM mca_accounting_payments p
         JOIN mca_advances adv ON adv.workspace_id = p.workspace_id AND adv.id = p.advance_id
         WHERE p.workspace_id = ? AND p.status = 'void'`,
      ).all(actor.workspaceId)
      : Promise.resolve([]),
    permission.paymentsVisible
      ? db.prepare<{ id: string; payment_id: string; amount_cents: number; reason: string; correlation_id: string; created_at: string; deal_id: string }>(
        `SELECT a.id, a.payment_id, a.amount_cents, a.reason, a.correlation_id, a.created_at, adv.deal_id
         FROM mca_accounting_adjustments a
         JOIN mca_accounting_payments p ON p.workspace_id = a.workspace_id AND p.id = a.payment_id
         JOIN mca_advances adv ON adv.workspace_id = p.workspace_id AND adv.id = p.advance_id
         WHERE a.workspace_id = ?`,
      ).all(actor.workspaceId)
      : Promise.resolve([]),
    db.prepare<{ id: string; deal_id: string; amount_cents: number; reversed_at: string | null; state: string }>(
      "SELECT id, deal_id, amount_cents, reversed_at, state FROM mca_funding_events WHERE workspace_id = ? AND state = 'reversed'",
    ).all(actor.workspaceId),
    db.prepare<{ resource_id: string; action: string; correlation_id: string; metadata: string; created_at: string }>(
      `SELECT resource_id, action, correlation_id, metadata, created_at FROM audit_events
       WHERE workspace_id = ? AND action IN ('funding.reversed','accounting.payment.voided','accounting.payment.adjusted')`,
    ).all(actor.workspaceId),
    db.prepare<{ id: string; source_id: string; cost_cents: number | null; purchased_on: string | null }>(
      "SELECT id, source_id, cost_cents, purchased_on FROM lead_batches WHERE workspace_id = ?",
    ).all(actor.workspaceId),
  ])

  const createdAt = new Map<string, string>()
  for (const row of createdActivityRows) {
    const current = createdAt.get(row.deal_id)
    if (!current || row.created_at < current) createdAt.set(row.deal_id, row.created_at)
  }
  const assignments = new Map<string, string[]>()
  for (const row of assignmentRows) {
    const current = assignments.get(row.deal_id) ?? []
    current.push(row.membership_id)
    assignments.set(row.deal_id, uniqueIds(current))
  }
  const funders = new Map<string, string[]>()
  for (const row of [...submissionRows, ...offerRows]) {
    if (!row.funder_id) continue
    const current = funders.get(row.deal_id) ?? []
    current.push(row.funder_id)
    funders.set(row.deal_id, uniqueIds(current))
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

  const deals = new Map<string, DealScope>()
  for (const row of dealRows) {
    const createdStamp = createdAt.get(row.id) ?? row.created_at
    deals.set(row.id, {
      id: row.id,
      createdOn: calendarDateInTimeZone(createdStamp, timezone),
      membershipIds: assignments.get(row.id) ?? [],
      funderIds: funders.get(row.id) ?? [],
      sourceIds: sources.get(row.id) ?? [],
      batchIds: batches.get(row.id) ?? [],
    })
  }

  const memberName = new Map(memberRows.map((row) => [row.id, row.name]))
  const reportsByManager = new Map<string, string[]>()
  for (const row of memberRows) {
    if (!row.manager_membership_id) continue
    const current = reportsByManager.get(row.manager_membership_id) ?? []
    current.push(row.id)
    reportsByManager.set(row.manager_membership_id, uniqueIds(current))
  }
  for (const row of memberRows) {
    if (row.role === "manager" && !reportsByManager.has(row.id)) reportsByManager.set(row.id, [])
  }

  const companyMoney = { collected: 0, expected: 0 }
  const userMoney = new Map<string, { collected: number; expected: number }>()
  const managerMoney = new Map<string, { collected: number; expected: number }>()
  function addPair(target: Map<string, { collected: number; expected: number }>, id: string, collected: number, expected: number) {
    const current = target.get(id) ?? { collected: 0, expected: 0 }
    current.collected += collected
    current.expected += expected
    target.set(id, current)
  }

  for (const row of paymentRows) {
    if (row.status === "void") continue
    const deal = deals.get(row.deal_id)
    if (!deal || !dealPassesFilters(deal, filters)) continue
    const expectedOn = row.expected_at ? calendarDateInTimeZone(row.expected_at, timezone) : calendarDateInTimeZone(row.created_at, timezone)
    const receivedOn = row.received_at ? calendarDateInTimeZone(row.received_at, timezone) : null
    const collectedAdd = inRangeForEvent(receivedOn, filters, deal.createdOn) ? Number(row.received_amount_cents) : 0
    const expectedAdd = inRangeForEvent(expectedOn, filters, deal.createdOn) ? Number(row.expected_amount_cents) : 0
    if (collectedAdd === 0 && expectedAdd === 0) continue
    companyMoney.collected += collectedAdd
    companyMoney.expected += expectedAdd
    for (const membershipId of deal.membershipIds) addPair(userMoney, membershipId, collectedAdd, expectedAdd)
    for (const [managerId, reportIds] of reportsByManager) {
      const team = new Set([managerId, ...reportIds])
      if (deal.membershipIds.some((id) => team.has(id))) addPair(managerMoney, managerId, collectedAdd, expectedAdd)
    }
  }

  const auditsByResource = new Map<string, { correlationId: string; metadata: Record<string, unknown>; createdAt: string; action: string }>()
  for (const row of auditRows) {
    const current = auditsByResource.get(row.resource_id)
    if (current && current.createdAt >= row.created_at) continue
    auditsByResource.set(row.resource_id, {
      correlationId: row.correlation_id,
      metadata: parseMetadata(row.metadata),
      createdAt: row.created_at,
      action: row.action,
    })
  }

  const evidence: LedgerEvidenceRow[] = []
  function evidenceInRange(occurredOn: string | null, dealId: string | null, createdOnFallback?: string): boolean {
    const deal = dealId ? deals.get(dealId) : undefined
    if (deal && !dealPassesFilters(deal, filters)) return false
    const createdOn = deal?.createdOn ?? createdOnFallback ?? occurredOn ?? ""
    return inRangeForEvent(occurredOn, filters, createdOn)
  }

  for (const row of voidedPaymentRows) {
    const deal = deals.get(row.deal_id)
    const occurredAt = row.updated_at || row.received_at || row.expected_at || row.created_at
    const occurredOn = calendarDateInTimeZone(occurredAt, timezone)
    const receivedOn = row.received_at ? calendarDateInTimeZone(row.received_at, timezone) : null
    const expectedOn = row.expected_at ? calendarDateInTimeZone(row.expected_at, timezone) : calendarDateInTimeZone(row.created_at, timezone)
    if (!evidenceInRange(occurredOn, row.deal_id, deal?.createdOn) && !evidenceInRange(receivedOn, row.deal_id, deal?.createdOn) && !evidenceInRange(expectedOn, row.deal_id, deal?.createdOn)) continue
    const audit = auditsByResource.get(row.id)
    evidence.push({
      kind: "payment_void",
      recordId: row.id,
      paymentId: row.id,
      dealId: row.deal_id,
      amountCents: Number(row.received_amount_cents || row.expected_amount_cents),
      occurredAt,
      occurredOn,
      reason: typeof audit?.metadata.reason === "string" ? audit.metadata.reason : "Ledger payment voided",
      correlationId: audit?.correlationId,
      status: "void",
    })
  }

  for (const row of reversalRows) {
    const occurredAt = row.reversed_at ?? ""
    if (!occurredAt) continue
    const occurredOn = calendarDateInTimeZone(occurredAt, timezone)
    if (!evidenceInRange(occurredOn, row.deal_id)) continue
    const audit = auditsByResource.get(row.id)
    evidence.push({
      kind: "funding_reversal",
      recordId: row.id,
      fundingEventId: row.id,
      dealId: row.deal_id,
      amountCents: Number(row.amount_cents),
      occurredAt,
      occurredOn,
      reason: typeof audit?.metadata.reason === "string" ? audit.metadata.reason : "Funding event reversed",
      correlationId: audit?.correlationId,
      status: "reversed",
    })
  }

  for (const row of adjustmentRows) {
    const occurredOn = calendarDateInTimeZone(row.created_at, timezone)
    if (!evidenceInRange(occurredOn, row.deal_id)) continue
    evidence.push({
      kind: "adjustment",
      recordId: row.id,
      paymentId: row.payment_id,
      dealId: row.deal_id,
      amountCents: Number(row.amount_cents),
      occurredAt: row.created_at,
      occurredOn,
      reason: row.reason,
      correlationId: row.correlation_id,
      status: "adjusted",
    })
  }
  evidence.sort((a, b) => a.occurredAt.localeCompare(b.occurredAt) || a.recordId.localeCompare(b.recordId))

  const sourceSet = filters.sourceIds?.length ? new Set(filters.sourceIds) : null
  const batchSet = filters.batchIds?.length ? new Set(filters.batchIds) : null
  let operatingKnown = 0
  let operatingUnknown = 0
  for (const row of batchRows) {
    if (!row.purchased_on) continue
    if (!dateInInclusiveRange(row.purchased_on, filters.from, filters.to)) continue
    if (sourceSet && !sourceSet.has(row.source_id)) continue
    if (batchSet && !batchSet.has(row.id)) continue
    if (row.cost_cents == null) operatingUnknown += 1
    else operatingKnown += Number(row.cost_cents)
  }
  const otherOperatingCosts: OperatingCostMetric = !moneyVisible(permission, true)
    ? { visible: false, excludedFromGrossContribution: true, reason: restrictedReason(permission) }
    : {
      visible: true,
      knownCents: operatingKnown,
      unknownCount: operatingUnknown,
      complete: operatingUnknown === 0,
      excludedFromGrossContribution: true,
    }

  const companyDistributions = funnel.totals.distributions
  const companyRevenue = moneyFrom(companyMoney.collected, companyMoney.expected, permission, true)
  const company: TeamProfitRow = {
    membershipId: "totals",
    name: "Company (unique deals)",
    kind: "company",
    memberIds: [],
    stages: funnel.totals.stages,
    revenue: companyRevenue,
    distributions: companyDistributions,
    grossContribution: buildGrossContribution(companyRevenue, companyDistributions, permission, true),
  }

  const users: TeamProfitRow[] = funnel.reps.map((row) => {
    const money = userMoney.get(row.membershipId ?? "") ?? { collected: 0, expected: 0 }
    const revenue = moneyFrom(money.collected, money.expected, permission, false)
    return {
      membershipId: row.membershipId,
      name: row.name,
      kind: "user",
      memberIds: row.membershipId ? [row.membershipId] : [],
      stages: row.stages,
      revenue,
      distributions: row.distributions,
      grossContribution: buildGrossContribution(revenue, row.distributions, permission, false),
    }
  })

  const unassigned = funnel.unassigned
    ? {
      membershipId: null,
      name: funnel.unassigned.name,
      kind: "unassigned" as const,
      memberIds: [],
      stages: funnel.unassigned.stages,
      revenue: emptyMoney(permission, false),
      distributions: funnel.unassigned.distributions,
      grossContribution: buildGrossContribution(emptyMoney(permission, false), funnel.unassigned.distributions, permission, false),
    }
    : null

  const managers: TeamProfitRow[] = []
  for (const [managerId, reportIds] of [...reportsByManager.entries()].sort((a, b) => (memberName.get(a[0]) ?? a[0]).localeCompare(memberName.get(b[0]) ?? b[0]))) {
    const team = new Set([managerId, ...reportIds])
    if (filters.membershipIds?.length && !filters.membershipIds.some((id) => team.has(id) || id === managerId)) continue
    const teamStages = {
      created: uniqueStageMetric(funnel.drilldown.created.filter((row) => row.attributedMembershipIds.some((id) => team.has(id))), companyRestricted),
      submitted: uniqueStageMetric(funnel.drilldown.submitted.filter((row) => row.attributedMembershipIds.some((id) => team.has(id))), companyRestricted),
      approved: uniqueStageMetric(funnel.drilldown.approved.filter((row) => row.attributedMembershipIds.some((id) => team.has(id))), companyRestricted),
      funded: uniqueStageMetric(funnel.drilldown.funded.filter((row) => row.attributedMembershipIds.some((id) => team.has(id))), companyRestricted),
    }
    const teamUsers = users.filter((row) => row.membershipId && team.has(row.membershipId))
    const distributions = sumDistributions(teamUsers.map((row) => row.distributions), permission)
    const money = managerMoney.get(managerId) ?? { collected: 0, expected: 0 }
    const revenue = moneyFrom(money.collected, money.expected, permission, true)
    const hasActivity = FUNNEL_STAGES.some((stage) => teamStages[stage].dealCount > 0) || (distributions.count ?? 0) > 0 || money.collected > 0 || money.expected > 0
    if (!hasActivity) continue
    managers.push({
      membershipId: managerId,
      name: memberName.get(managerId) ?? "Unknown manager",
      kind: "manager",
      memberIds: [managerId, ...reportIds],
      stages: teamStages,
      revenue,
      distributions,
      grossContribution: buildGrossContribution(revenue, distributions, permission, true),
    })
  }

  return {
    filters,
    recognition,
    period: funnel.period,
    permission,
    attribution: SHARED_REP_ATTRIBUTION,
    definitions: TEAM_PROFIT_DEFINITIONS,
    company,
    users,
    managers,
    unassigned,
    evidence: permission.paymentsVisible ? evidence : [],
    otherOperatingCosts,
  }
}
