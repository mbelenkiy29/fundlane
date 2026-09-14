import "server-only"

import { getDatabase, parseJson } from "../db"
import { canActorAccessDeal } from "../deals/access-policy"
import type { DealActor, DealAssignment, DealStatus } from "../deals/schema"
import { isActionAllowed } from "../policy"
import {
  APPROVED_MANUAL_STATES,
  APPROVED_OFFER_STATUSES,
  APPROVED_SUBMISSION_STATUSES,
  calendarDateInTimeZone,
  conversionRate,
  dateInInclusiveRange,
  SUBMITTED_JOB_STATES,
  SUBMITTED_SUBMISSION_STATUSES,
} from "../reports/funder-analytics"
import { getWorkspaceSettings } from "../workspaces"
import {
  ACTIVE_ADVANCE_PERFORMANCE,
  isPipelineOpenStatus,
  type HomeKpiQuery,
  type HomeKpis,
  type MoneyCount,
} from "./kpi-contracts"

const ACTIVE_PERFORMANCE = new Set<string>(ACTIVE_ADVANCE_PERFORMANCE)
const COLLECTION_TYPES = new Set(["commission", "fee"])

interface DealRow {
  id: string
  merchant_id: string | null
  status: string
  requested_amount: number | string | null
  industry: string | null
  address_json: string | null
  legal_name: string | null
  display_id: string
  created_at: string
  updated_at: string
}

interface VisibleDeal {
  id: string
  merchantKey: string
  status: DealStatus
  requestedAmount: number | null
  industry: string
  state: string
  legalName: string
  updatedAt: string
  createdOn: string
}

function asNumber(value: unknown): number | null {
  if (value == null || value === "") return null
  const numeric = typeof value === "number" ? value : Number(value)
  return Number.isFinite(numeric) ? numeric : null
}

function money(amountCents: number, count: number, visible: boolean): MoneyCount {
  return { amountCents: visible ? amountCents : null, count, dollarsHidden: !visible }
}

function periodRange(period: HomeKpiQuery["period"], today: string): { from: string; to: string } {
  if (period === "mtd") return { from: `${today.slice(0, 7)}-01`, to: today }
  return { from: `${today.slice(0, 4)}-01-01`, to: today }
}

function monthKeysEnding(today: string, count: number): string[] {
  const year = Number(today.slice(0, 4))
  const month = Number(today.slice(5, 7))
  const keys: string[] = []
  for (let offset = count - 1; offset >= 0; offset -= 1) {
    const index = year * 12 + (month - 1) - offset
    const nextYear = Math.floor(index / 12)
    const nextMonth = (index % 12) + 1
    keys.push(`${nextYear}-${String(nextMonth).padStart(2, "0")}`)
  }
  return keys
}

function dayKeysEnding(today: string, count: number): string[] {
  const [year, month, day] = today.split("-").map(Number)
  const utc = Date.UTC(year, month - 1, day)
  const keys: string[] = []
  for (let offset = count - 1; offset >= 0; offset -= 1) {
    keys.push(new Date(utc - offset * 86_400_000).toISOString().slice(0, 10))
  }
  return keys
}

function addressState(raw: string | null): string {
  const parsed = parseJson<{ state?: string }>(raw ?? "", {})
  return parsed.state?.trim() || "Unknown"
}

function toAssignment(membershipId: string, kind: string): DealAssignment {
  return {
    id: membershipId,
    membershipId,
    kind: kind === "closer" ? "closer" : "originator",
    isPrimary: true,
    assignedAt: "",
    assignedByUserId: null,
  }
}

function canonicalKey(
  jobsById: Map<string, { id: string }>,
  submissionsById: Map<string, { id: string; job_id: string | null }>,
  raw: string | null | undefined,
  fallback: string,
): string {
  if (!raw) return fallback
  if (jobsById.has(raw)) return raw
  const linked = submissionsById.get(raw)
  if (linked?.job_id) return linked.job_id
  if (linked) return linked.id
  return raw
}

export async function getHomeKpis(actor: DealActor, query: HomeKpiQuery): Promise<HomeKpis> {
  const settings = await getWorkspaceSettings(actor.workspaceId)
  const timezone = settings.timezone
  const today = calendarDateInTimeZone(query.nowIso, timezone) || query.nowIso.slice(0, 10)
  const range = periodRange(query.period, today)
  const months = monthKeysEnding(today, 12)
  const days = dayKeysEnding(today, 14)
  const monthSet = new Set(months)
  const companyVisible = Boolean(actor.role && isActionAllowed(actor.role, "viewCompanyFinancials", settings.actionVisibility))
  const paymentsVisible = Boolean(actor.role && isActionAllowed(actor.role, "viewPaymentTable", settings.actionVisibility))

  const db = getDatabase()
  const [
    dealRows,
    assignmentRows,
    fundingRows,
    paymentRows,
    advanceRows,
    performanceRows,
    jobRows,
    submissionRows,
    legacyOfferRows,
    manualRows,
    offerRows,
  ] = await Promise.all([
    db.prepare<DealRow>(
      `SELECT id, merchant_id, status, requested_amount, industry, address_json, legal_name, display_id, created_at, updated_at
       FROM deals WHERE workspace_id = ?`,
    ).all(actor.workspaceId),
    db.prepare<{ deal_id: string; membership_id: string; kind: string }>(
      "SELECT deal_id, membership_id, kind FROM deal_assignments WHERE workspace_id = ?",
    ).all(actor.workspaceId),
    db.prepare<{ id: string; deal_id: string; offer_id: string; advance_id: string; amount_cents: number; funded_at: string; state: string }>(
      "SELECT id, deal_id, offer_id, advance_id, amount_cents, funded_at, state FROM mca_funding_events WHERE workspace_id = ?",
    ).all(actor.workspaceId),
    db.prepare<{
      id: string
      advance_id: string
      type: "commission" | "fee"
      status: string
      expected_amount_cents: number
      received_amount_cents: number
      expected_at: string | null
      received_at: string | null
      created_at: string
      deal_id: string
    }>(
      `SELECT p.id, p.advance_id, p.type, p.status,
              p.expected_amount_cents + COALESCE((SELECT sum(a.amount_cents) FROM mca_accounting_adjustments a
                WHERE a.workspace_id = p.workspace_id AND a.payment_id = p.id), 0)::int AS expected_amount_cents,
              p.received_amount_cents, p.expected_at, p.received_at, p.created_at, adv.deal_id
       FROM mca_accounting_payments p
       JOIN mca_advances adv ON adv.workspace_id = p.workspace_id AND adv.id = p.advance_id
       WHERE p.workspace_id = ? AND p.status <> 'void'`,
    ).all(actor.workspaceId),
    db.prepare<{ id: string; deal_id: string; merchant_id: string | null; status: string; reversed_at: string | null }>(
      `SELECT a.id, a.deal_id, d.merchant_id, a.status, a.reversed_at
       FROM mca_advances a
       JOIN deals d ON d.workspace_id = a.workspace_id AND d.id = a.deal_id
       WHERE a.workspace_id = ?`,
    ).all(actor.workspaceId),
    db.prepare<{ advance_id: string; status: string }>(
      `SELECT DISTINCT ON (advance_id) advance_id, status
       FROM mca_advance_status_history WHERE workspace_id = ?
       ORDER BY advance_id, effective_at DESC, created_at DESC`,
    ).all(actor.workspaceId),
    db.prepare<{ id: string; deal_id: string; funder_id: string; state: string; created_at: string }>(
      "SELECT id, deal_id, funder_id, state, created_at FROM mca_submission_jobs WHERE workspace_id = ?",
    ).all(actor.workspaceId),
    db.prepare<{ id: string; deal_id: string; funder_id: string | null; status: string; job_id: string | null }>(
      "SELECT id, deal_id, funder_id, status, job_id FROM deal_submissions WHERE workspace_id = ?",
    ).all(actor.workspaceId),
    db.prepare<{ id: string; deal_id: string; submission_id: string; status: string }>(
      "SELECT id, deal_id, submission_id, status FROM deal_offers WHERE workspace_id = ?",
    ).all(actor.workspaceId),
    db.prepare<{ id: string; deal_id: string; funder_id: string | null; state: string; historical_at: string | null; created_at: string; offer_id: string | null }>(
      "SELECT id, deal_id, funder_id, state, historical_at, created_at, offer_id FROM mca_manual_submissions WHERE workspace_id = ?",
    ).all(actor.workspaceId),
    db.prepare<{ id: string; deal_id: string; funder_id: string | null; funder_name: string }>(
      "SELECT id, deal_id, funder_id, funder_name FROM mca_offers WHERE workspace_id = ?",
    ).all(actor.workspaceId),
  ])

  const assignmentsByDeal = new Map<string, DealAssignment[]>()
  for (const row of assignmentRows) {
    const current = assignmentsByDeal.get(row.deal_id) ?? []
    current.push(toAssignment(row.membership_id, row.kind))
    assignmentsByDeal.set(row.deal_id, current)
  }

  const visible = new Map<string, VisibleDeal>()
  for (const row of dealRows) {
    const assignments = assignmentsByDeal.get(row.id) ?? []
    if (!canActorAccessDeal(actor, { workspaceId: actor.workspaceId, assignments })) continue
    const createdOn = calendarDateInTimeZone(row.created_at, timezone) || row.created_at.slice(0, 10)
    visible.set(row.id, {
      id: row.id,
      merchantKey: row.merchant_id || row.id,
      status: row.status as DealStatus,
      requestedAmount: asNumber(row.requested_amount),
      industry: row.industry?.trim() || "Unknown",
      state: addressState(row.address_json),
      legalName: row.legal_name?.trim() || row.display_id,
      updatedAt: row.updated_at,
      createdOn,
    })
  }

  const empty = visible.size === 0
  let pipelineCount = 0
  let pipelineVolume = 0
  const pipelineByMonth = new Map(months.map((month) => [month, { count: 0, volumeDollars: 0 }]))
  for (const deal of visible.values()) {
    if (!isPipelineOpenStatus(deal.status)) continue
    pipelineCount += 1
    pipelineVolume += deal.requestedAmount ?? 0
    const bucket = pipelineByMonth.get(deal.createdOn.slice(0, 7))
    if (bucket) {
      bucket.count += 1
      bucket.volumeDollars += deal.requestedAmount ?? 0
    }
  }

  const offerName = new Map(offerRows.map((row) => [row.id, row.funder_name]))
  const committedFundings = []
  for (const row of fundingRows) {
    if (row.state !== "committed") continue
    const deal = visible.get(row.deal_id)
    if (!deal) continue
    const fundedOn = calendarDateInTimeZone(row.funded_at, timezone)
    committedFundings.push({
      id: row.id,
      dealId: row.deal_id,
      offerId: row.offer_id,
      amountCents: Number(row.amount_cents) || 0,
      fundedAt: row.funded_at,
      fundedOn,
      month: fundedOn.slice(0, 7),
      legalName: deal.legalName,
      funderName: offerName.get(row.offer_id) || "Unknown funder",
    })
  }

  let fundedCount = 0
  let fundedCents = 0
  const fundedByMonth = new Map<string, number>()
  const topFunders = new Map<string, { fundedCents: number; deals: Set<string> }>()
  const fundedCentsByDeal = new Map<string, number>()
  for (const row of committedFundings) {
    fundedByMonth.set(row.month, (fundedByMonth.get(row.month) ?? 0) + row.amountCents)
    if (dateInInclusiveRange(row.fundedOn, range.from, range.to)) {
      fundedCount += 1
      fundedCents += row.amountCents
      const funder = topFunders.get(row.funderName) ?? { fundedCents: 0, deals: new Set<string>() }
      funder.fundedCents += row.amountCents
      funder.deals.add(row.dealId)
      topFunders.set(row.funderName, funder)
      fundedCentsByDeal.set(row.dealId, (fundedCentsByDeal.get(row.dealId) ?? 0) + row.amountCents)
    }
  }

  const visiblePayments = paymentRows.filter((row) => visible.has(row.deal_id) && COLLECTION_TYPES.has(row.type))
  let commissionCount = 0
  let commissionCents = 0
  let feeCents = 0
  let expectedToday = 0
  let receivedToday = 0
  const commissionByMonth = new Map<string, number>()
  const collectionsByDay = new Map(days.map((day) => [day, { expectedCents: 0, receivedCents: 0 }]))
  for (const row of visiblePayments) {
    const expectedOn = row.expected_at ? calendarDateInTimeZone(row.expected_at, timezone) : ""
    const receivedOn = row.received_at ? calendarDateInTimeZone(row.received_at, timezone) : ""
    const receivedCents = Number(row.received_amount_cents) || 0
    const expectedCents = Number(row.expected_amount_cents) || 0
    if (expectedOn === today) expectedToday += expectedCents
    if (receivedOn === today) receivedToday += receivedCents
    const expectedBucket = expectedOn ? collectionsByDay.get(expectedOn) : undefined
    if (expectedBucket) expectedBucket.expectedCents += expectedCents
    const receivedBucket = receivedOn ? collectionsByDay.get(receivedOn) : undefined
    if (receivedBucket) receivedBucket.receivedCents += receivedCents
    if (receivedOn) {
      const month = receivedOn.slice(0, 7)
      if (row.type === "commission") commissionByMonth.set(month, (commissionByMonth.get(month) ?? 0) + receivedCents)
    }
    if (row.type === "commission" && dateInInclusiveRange(receivedOn, range.from, range.to)) {
      commissionCount += 1
      commissionCents += receivedCents
    }
    if (row.type === "fee" && dateInInclusiveRange(receivedOn, range.from, range.to)) {
      feeCents += receivedCents
    }
  }

  const performance = new Map(performanceRows.map((row) => [row.advance_id, row.status]))
  const activeMerchants = new Set<string>()
  for (const row of advanceRows) {
    if (row.reversed_at || row.status === "reversed") continue
    const deal = visible.get(row.deal_id)
    if (!deal) continue
    const status = performance.get(row.id) ?? "on_track"
    if (!ACTIVE_PERFORMANCE.has(status)) continue
    activeMerchants.add(deal.merchantKey)
  }

  const jobsById = new Map(jobRows.map((row) => [row.id, row]))
  const submissionsById = new Map(submissionRows.map((row) => [row.id, row]))
  const submittedIds = new Set<string>()
  const approvedIds = new Set<string>()
  const submittedByMonth = new Map(months.map((month) => [month, new Set<string>()]))
  const approvedByMonth = new Map(months.map((month) => [month, new Set<string>()]))

  function addSubmitted(id: string, occurredOn: string | null) {
    if (dateInInclusiveRange(occurredOn, range.from, range.to)) submittedIds.add(id)
    const month = occurredOn?.slice(0, 7)
    if (month && monthSet.has(month)) submittedByMonth.get(month)?.add(id)
  }
  function addApproved(id: string, occurredOn: string | null) {
    if (dateInInclusiveRange(occurredOn, range.from, range.to)) approvedIds.add(id)
    const month = occurredOn?.slice(0, 7)
    if (month && monthSet.has(month)) approvedByMonth.get(month)?.add(id)
  }

  for (const job of jobRows) {
    if (!visible.has(job.deal_id) || !SUBMITTED_JOB_STATES.has(job.state)) continue
    addSubmitted(job.id, calendarDateInTimeZone(job.created_at, timezone))
  }
  for (const row of submissionRows) {
    if (!visible.has(row.deal_id) || !SUBMITTED_SUBMISSION_STATUSES.has(row.status)) continue
    const job = row.job_id ? jobsById.get(row.job_id) : undefined
    const id = row.job_id && SUBMITTED_JOB_STATES.has(job?.state ?? "") ? row.job_id : row.id
    addSubmitted(id, job?.created_at ? calendarDateInTimeZone(job.created_at, timezone) : null)
  }
  for (const row of manualRows) {
    if (!visible.has(row.deal_id)) continue
    const at = row.historical_at || row.created_at
    addSubmitted(`manual:${row.id}`, at ? calendarDateInTimeZone(at, timezone) : null)
    if (APPROVED_MANUAL_STATES.has(row.state)) {
      addApproved(`${row.funder_id ?? "none"}:${canonicalKey(jobsById, submissionsById, row.offer_id, row.id)}`, at ? calendarDateInTimeZone(at, timezone) : null)
    }
  }
  for (const row of submissionRows) {
    if (!visible.has(row.deal_id) || !APPROVED_SUBMISSION_STATUSES.has(row.status)) continue
    const job = row.job_id ? jobsById.get(row.job_id) : undefined
    addApproved(
      `${row.funder_id ?? "none"}:${canonicalKey(jobsById, submissionsById, row.job_id ?? row.id, row.id)}`,
      job?.created_at ? calendarDateInTimeZone(job.created_at, timezone) : null,
    )
  }
  for (const row of legacyOfferRows) {
    if (!visible.has(row.deal_id) || !APPROVED_OFFER_STATUSES.has(row.status)) continue
    const linked = submissionsById.get(row.submission_id)
    const job = linked?.job_id ? jobsById.get(linked.job_id) : undefined
    addApproved(
      `${linked?.funder_id ?? "none"}:${canonicalKey(jobsById, submissionsById, row.submission_id, row.id)}`,
      job?.created_at ? calendarDateInTimeZone(job.created_at, timezone) : null,
    )
  }

  const firstSeen = new Map<string, string>()
  for (const deal of visible.values()) {
    const current = firstSeen.get(deal.merchantKey)
    if (!current || deal.createdOn < current) firstSeen.set(deal.merchantKey, deal.createdOn)
  }
  const growth = new Map(months.map((month) => [month, { new: 0, returning: 0, churn: 0 }]))
  const countedNew = new Set<string>()
  for (const [merchantKey, createdOn] of firstSeen) {
    const month = createdOn.slice(0, 7)
    const bucket = growth.get(month)
    if (!bucket) continue
    bucket.new += 1
    countedNew.add(`${merchantKey}:${month}`)
  }
  for (const deal of visible.values()) {
    if (deal.status === "renewed") {
      const month = deal.createdOn.slice(0, 7)
      const bucket = growth.get(month)
      if (bucket && !countedNew.has(`${deal.merchantKey}:${month}`)) bucket.returning += 1
    }
    if (deal.status === "closed" || deal.status === "default") {
      const month = (calendarDateInTimeZone(deal.updatedAt, timezone) || deal.createdOn).slice(0, 7)
      const bucket = growth.get(month)
      if (bucket) bucket.churn += 1
    }
  }

  const groupMetric = (key: (deal: VisibleDeal) => string) => {
    const groups = new Map<string, { count: number; fundedCents: number }>()
    for (const deal of visible.values()) {
      const label = key(deal)
      const current = groups.get(label) ?? { count: 0, fundedCents: 0 }
      current.count += 1
      current.fundedCents += fundedCentsByDeal.get(deal.id) ?? 0
      groups.set(label, current)
    }
    return [...groups.entries()]
      .map(([label, value]) => ({ label, count: value.count, fundedCents: companyVisible ? value.fundedCents : null }))
      .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label))
  }

  const recentActivity = [
    ...committedFundings.map((row) => ({
      id: row.id,
      kind: "funding" as const,
      title: row.legalName,
      subtitle: row.funderName,
      amountCents: companyVisible ? row.amountCents : null,
      status: "committed",
      at: row.fundedAt,
    })),
    ...visiblePayments.map((row) => {
      const deal = visible.get(row.deal_id)
      return {
        id: row.id,
        kind: row.type,
        title: deal?.legalName ?? row.deal_id,
        subtitle: row.type === "commission" ? "Commission" : "Fee",
        amountCents: paymentsVisible ? Number(row.received_amount_cents) || Number(row.expected_amount_cents) || 0 : null,
        status: row.status,
        at: row.received_at || row.expected_at || row.created_at,
      }
    }),
  ].sort((a, b) => b.at.localeCompare(a.at) || a.id.localeCompare(b.id)).slice(0, 12)

  return {
    timezone,
    asOf: query.nowIso,
    period: query.period,
    pipeline: {
      count: pipelineCount,
      volumeDollars: companyVisible ? pipelineVolume : null,
      dollarsHidden: !companyVisible,
    },
    funded: money(fundedCents, fundedCount, companyVisible),
    commission: money(commissionCents, commissionCount, paymentsVisible),
    activeMerchants: { count: activeMerchants.size },
    approvalRate: {
      numerator: approvedIds.size,
      denominator: submittedIds.size,
      rate: conversionRate(approvedIds.size, submittedIds.size),
    },
    collectionsToday: {
      expectedCents: paymentsVisible ? expectedToday : null,
      receivedCents: paymentsVisible ? receivedToday : null,
      dollarsHidden: !paymentsVisible,
      source: "accounting_payments",
    },
    empty,
    series: {
      fundedByMonth: months.map((month) => ({
        month,
        fundedCents: companyVisible ? fundedByMonth.get(month) ?? 0 : 0,
        commissionCents: paymentsVisible ? commissionByMonth.get(month) ?? 0 : 0,
      })),
      pipelineByMonth: months.map((month) => {
        const bucket = pipelineByMonth.get(month) ?? { count: 0, volumeDollars: 0 }
        return {
          month,
          count: bucket.count,
          volumeDollars: companyVisible ? bucket.volumeDollars : 0,
        }
      }),
      approvalByMonth: months.map((month) => {
        const numerator = approvedByMonth.get(month)?.size ?? 0
        const denominator = submittedByMonth.get(month)?.size ?? 0
        return { month, numerator, denominator, rate: conversionRate(numerator, denominator) }
      }),
      collectionsByDay: days.map((day) => {
        const bucket = collectionsByDay.get(day) ?? { expectedCents: 0, receivedCents: 0 }
        return {
          day,
          expectedCents: paymentsVisible ? bucket.expectedCents : 0,
          receivedCents: paymentsVisible ? bucket.receivedCents : 0,
        }
      }),
      revenueBreakdown: [
        { key: "funded", amountCents: companyVisible ? fundedCents : 0 },
        { key: "commission", amountCents: paymentsVisible ? commissionCents : 0 },
        { key: "fees", amountCents: paymentsVisible ? feeCents : 0 },
      ],
      recentActivity,
      topFunders: [...topFunders.entries()]
        .map(([name, value]) => ({ name, fundedCents: companyVisible ? value.fundedCents : 0, dealCount: value.deals.size }))
        .sort((a, b) => b.fundedCents - a.fundedCents || b.dealCount - a.dealCount || a.name.localeCompare(b.name))
        .slice(0, 8),
      merchantGrowth: months.map((month) => ({ month, ...(growth.get(month) ?? { new: 0, returning: 0, churn: 0 }) })),
      industries: groupMetric((deal) => deal.industry),
      states: groupMetric((deal) => deal.state),
    },
  }
}
