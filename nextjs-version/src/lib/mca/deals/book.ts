import "server-only"

import { AppError } from "../errors"
import { getDatabase } from "../db"
import { decryptSensitive } from "../crypto"
import type { DealActor } from "./schema"
import { canActorAccessDeal } from "./access-policy"
import { canViewCompanyFinancials, isActionAllowed } from "../policy"
import { getWorkspaceSettings } from "../workspaces"
import { estimateScheduledPaidIn } from "../advances/performance"
import { getRenewalPolicy } from "../renewals/service"
import {
  assignAdvanceNumbers,
  calendarDateInZone,
  calendarWindow,
  completedReceipts,
  merchantIdentity,
  missedInstallments,
  nextPaymentDate,
  paidDown,
  servicingStatus,
  type BookWindow,
  type ServicingStatus,
} from "./book-math"
import type { BookDetail, BookFilters, BookListResponse, BookRow } from "./book-contracts"
import { ensureWorkspaceInstallments, listInstallments, listReceipts, unreadAlertCount } from "./remittance"

type AdvanceBookRow = {
  id: string
  deal_id: string
  funded_at: string
  principal_cents: number
  payback_cents: number | null
  periodic_payment_cents: number | null
  payment_count: number | null
  payment_frequency: string | null
  calendar_convention: string | null
  created_at: string
  display_id: string
  legal_name: string | null
  dba_name: string | null
  ein_cipher: string | null
  contact_phone_cipher: string | null
  funder_name: string
  term_months: number | null
  factor_rate_millionths: number | null
  assigned_team: string
  assigned_rep: string | null
}

function decrypt(value: string | null, workspaceId: string): string | undefined {
  if (!value) return undefined
  try { return decryptSensitive(value, workspaceId) } catch { return undefined }
}

function matchesSearch(row: BookRow, search?: string): boolean {
  if (!search) return true
  const haystack = [row.legalName, row.dbaName, row.funderName, row.displayId, row.assignedRep].filter(Boolean).join(" ").toLowerCase()
  return haystack.includes(search.trim().toLowerCase())
}

async function loadAdvances(workspaceId: string): Promise<AdvanceBookRow[]> {
  return getDatabase().prepare<AdvanceBookRow>(`SELECT a.id, a.deal_id, a.funded_at, a.principal_cents, a.payback_cents,
    a.periodic_payment_cents, a.payment_count, a.payment_frequency, a.calendar_convention, a.created_at,
    d.display_id, d.legal_name, d.dba_name, d.ein_cipher, d.contact_phone_cipher,
    o.funder_name, r.term_months, r.factor_rate_millionths,
    COALESCE((SELECT string_agg(u.name || ' (' || da.kind || ')', ', ' ORDER BY da.is_primary DESC, da.assigned_at)
      FROM deal_assignments da JOIN memberships m ON m.id=da.membership_id AND m.workspace_id=da.workspace_id
      JOIN users u ON u.id=m.user_id WHERE da.workspace_id=a.workspace_id AND da.deal_id=a.deal_id), '') assigned_team,
    (SELECT u.name FROM deal_assignments da JOIN memberships m ON m.id=da.membership_id AND m.workspace_id=da.workspace_id
      JOIN users u ON u.id=m.user_id WHERE da.workspace_id=a.workspace_id AND da.deal_id=a.deal_id AND da.kind='originator'
      ORDER BY da.is_primary DESC, da.assigned_at LIMIT 1) assigned_rep
    FROM mca_advances a
    JOIN deals d ON d.workspace_id=a.workspace_id AND d.id=a.deal_id
    JOIN mca_offers o ON o.workspace_id=a.workspace_id AND o.id=a.offer_id
    LEFT JOIN mca_offer_revisions r ON r.workspace_id=a.workspace_id AND r.id=a.offer_revision_id
    WHERE a.workspace_id=? AND a.reversed_at IS NULL
    ORDER BY a.funded_at DESC, a.created_at DESC, a.id DESC`).all(workspaceId)
}

export async function listDealBook(actor: DealActor, filters: BookFilters = {}): Promise<BookListResponse> {
  const settings = await getWorkspaceSettings(actor.workspaceId)
  const timezone = settings.timezone || "America/New_York"
  const asOf = filters.asOf ?? new Date().toISOString()
  const asOfDate = calendarDateInZone(asOf, timezone)
  const missedWindow = calendarWindow(asOf, timezone, filters.missedWindow ?? "today")
  const completedWindow = calendarWindow(asOf, timezone, filters.completedWindow ?? "today")
  await ensureWorkspaceInstallments(actor.workspaceId)

  const [advances, assignmentRows, statuses, installments, receipts, commissions, policy, unreadAlerts] = await Promise.all([
    loadAdvances(actor.workspaceId),
    getDatabase().prepare<{ deal_id: string; membership_id: string; kind: "originator" | "closer" }>("SELECT deal_id, membership_id, kind FROM deal_assignments WHERE workspace_id=?").all(actor.workspaceId),
    getDatabase().prepare<{ advance_id: string; status: BookRow["performanceStatus"] }>(`SELECT DISTINCT ON (advance_id) advance_id, status
      FROM mca_advance_status_history WHERE workspace_id=? ORDER BY advance_id, effective_at DESC, created_at DESC`).all(actor.workspaceId),
    listInstallments(actor.workspaceId),
    listReceipts(actor.workspaceId),
    getDatabase().prepare<{ advance_id: string; received: number }>(`SELECT advance_id, coalesce(sum(received_amount_cents),0)::int AS received
      FROM mca_accounting_payments WHERE workspace_id=? AND type='commission' AND status<>'void' GROUP BY advance_id`).all(actor.workspaceId),
    getRenewalPolicy(actor).catch(() => null),
    unreadAlertCount(actor.workspaceId),
  ])

  const assignmentsByDeal = new Map<string, Array<{ membershipId: string; kind: "originator" | "closer" }>>()
  for (const row of assignmentRows) {
    const list = assignmentsByDeal.get(row.deal_id) ?? []
    list.push({ membershipId: row.membership_id, kind: row.kind })
    assignmentsByDeal.set(row.deal_id, list)
  }
  const visible = advances.filter((row) => canActorAccessDeal(actor, {
    workspaceId: actor.workspaceId,
    assignments: (assignmentsByDeal.get(row.deal_id) ?? []).map((item) => ({
      id: item.membershipId, membershipId: item.membershipId, kind: item.kind, isPrimary: true, assignedAt: "", assignedByUserId: null,
    })),
  }))

  const performance = new Map(statuses.map((row) => [row.advance_id, row.status]))
  const commissionByAdvance = new Map(commissions.map((row) => [row.advance_id, row.received]))
  const installmentsByAdvance = new Map<string, typeof installments>()
  for (const item of installments) {
    const list = installmentsByAdvance.get(item.advance_id) ?? []
    list.push(item)
    installmentsByAdvance.set(item.advance_id, list)
  }
  const receiptsByAdvance = new Map<string, typeof receipts>()
  for (const item of receipts) {
    if (item.status !== "received") continue
    const list = receiptsByAdvance.get(item.advance_id) ?? []
    list.push(item)
    receiptsByAdvance.set(item.advance_id, list)
  }

  const identities = visible.map((row) => ({
    id: row.id,
    identity: merchantIdentity({ ein: decrypt(row.ein_cipher, actor.workspaceId), legalName: row.legal_name, dealId: row.deal_id }),
    fundedAt: row.funded_at,
    createdAt: row.created_at,
  }))
  const numbers = assignAdvanceNumbers(identities)
  const threshold = policy?.paidInThresholdBasisPoints ?? 5000
  const minimumDays = policy?.minimumDaysSinceFunding ?? 0
  const showCommission = Boolean(actor.role && canViewCompanyFinancials(actor.role) && isActionAllowed(actor.role, "viewCompanyFinancials", settings.actionVisibility))

  const rows: BookRow[] = visible.map((row) => {
    const estimate = estimateScheduledPaidIn({
      fundedAt: row.funded_at, asOf, paybackCents: row.payback_cents, periodicPaymentCents: row.periodic_payment_cents,
      paymentCount: row.payment_count, paymentFrequency: row.payment_frequency, calendarConvention: row.calendar_convention,
    })
    const advanceReceipts = receiptsByAdvance.get(row.id) ?? []
    const receivedCents = advanceReceipts.reduce((sum, item) => sum + item.amount_cents, 0)
    const paid = paidDown({
      paybackCents: row.payback_cents, receivedCents,
      scheduledPaidInCents: estimate.paidInCents, scheduledPaidInBasisPoints: estimate.paidInBasisPoints,
    })
    const installmentRows = (installmentsByAdvance.get(row.id) ?? []).map((item) => ({ occurrenceDate: item.occurrence_date }))
    const receiptDates = new Set(advanceReceipts.map((item) => calendarDateInZone(item.received_at, timezone) || item.received_at.slice(0, 10)))
    const missed = missedInstallments(installmentRows, receiptDates, missedWindow, asOfDate)
    const completed = completedReceipts(advanceReceipts.map((item) => ({ receivedDate: calendarDateInZone(item.received_at, timezone) || item.received_at.slice(0, 10) })), completedWindow)
    const ageDays = Math.floor((Date.parse(asOf) - Date.parse(row.funded_at)) / 86_400_000)
    const performanceStatus = performance.get(row.id) ?? "on_track"
    const status = servicingStatus(performanceStatus)
    const renewalEligible = status === "active"
      && paid.paidDownBasisPoints !== null
      && paid.paidDownBasisPoints >= threshold
      && ageDays >= minimumDays
    return {
      id: row.id,
      dealId: row.deal_id,
      displayId: row.display_id,
      legalName: row.legal_name || row.display_id,
      dbaName: row.dba_name || undefined,
      funderName: row.funder_name,
      contactPhone: decrypt(row.contact_phone_cipher, actor.workspaceId),
      assignedRep: row.assigned_rep || undefined,
      assignedTeam: row.assigned_team ? row.assigned_team.split(", ") : [],
      advanceNumber: numbers.get(row.id) ?? 1,
      fundedAt: row.funded_at,
      principalCents: row.principal_cents,
      paybackCents: row.payback_cents,
      factorRate: row.factor_rate_millionths === null ? undefined : row.factor_rate_millionths / 1_000_000,
      termMonths: row.term_months,
      paymentCount: row.payment_count,
      paymentFrequency: row.payment_frequency,
      periodicPaymentCents: row.periodic_payment_cents,
      balanceRemainingCents: paid.balanceRemainingCents,
      paidDownBasisPoints: paid.paidDownBasisPoints,
      paidDownEstimated: paid.paidDownEstimated,
      servicingStatus: status,
      performanceStatus,
      nextPaymentDate: nextPaymentDate(installmentRows, receiptDates, asOfDate),
      ...(showCommission ? { commissionEarnedCents: commissionByAdvance.get(row.id) ?? 0 } : {}),
      renewalEligible,
      missedCount: missed.length,
      completedCount: completed.length,
    }
  })

  const filtered = rows.filter((row) => {
    if (!matchesSearch(row, filters.search)) return false
    if (filters.statuses?.length && !filters.statuses.includes(row.servicingStatus)) return false
    if (filters.funder && !row.funderName.toLowerCase().includes(filters.funder.trim().toLowerCase())) return false
    if (filters.assignee && !(row.assignedRep ?? "").toLowerCase().includes(filters.assignee.trim().toLowerCase()) && !row.assignedTeam.some((name) => name.toLowerCase().includes(filters.assignee!.trim().toLowerCase()))) return false
    if (filters.frequency && row.paymentFrequency !== filters.frequency) return false
    if (filters.renewalEligible && !row.renewalEligible) return false
    if (filters.paidDownMin !== undefined && (row.paidDownBasisPoints ?? -1) < filters.paidDownMin) return false
    if (filters.paidDownMax !== undefined && (row.paidDownBasisPoints ?? 10_001) > filters.paidDownMax) return false
    return true
  })

  const missedAmount = filtered.reduce((sum, row) => sum + (row.missedCount > 0 ? (row.periodicPaymentCents ?? 0) * row.missedCount : 0), 0)
  let completedCents = 0
  let completedCount = 0
  for (const row of filtered) {
    for (const receipt of receiptsByAdvance.get(row.id) ?? []) {
      const date = calendarDateInZone(receipt.received_at, timezone) || receipt.received_at.slice(0, 10)
      if (date >= completedWindow.from && date <= completedWindow.to) {
        completedCents += receipt.amount_cents
        completedCount += 1
      }
    }
  }

  return {
    rows: filtered,
    total: filtered.length,
    dashboard: {
      missed: { window: filters.missedWindow ?? "today", count: filtered.reduce((sum, row) => sum + row.missedCount, 0), amountCents: missedAmount },
      completed: { window: filters.completedWindow ?? "today", count: completedCount, amountCents: completedCents },
      renewals: { count: filtered.filter((row) => row.renewalEligible).length },
      unreadAlerts,
    },
    filters,
    timezone,
  }
}

export async function getDealBookRow(actor: DealActor, advanceId: string, filters: BookFilters = {}): Promise<BookDetail> {
  const list = await listDealBook(actor, filters)
  const row = list.rows.find((item) => item.id === advanceId)
  if (!row) throw new AppError(404, "advance_not_found", "The requested advance was not found.")
  const [installments, receipts] = await Promise.all([listInstallments(actor.workspaceId, advanceId), listReceipts(actor.workspaceId, advanceId)])
  const receivedDates = new Set(receipts.filter((item) => item.status === "received").map((item) => item.received_at.slice(0, 10)))
  return {
    ...row,
    installments: installments.map((item) => ({
      id: item.id, sequence: item.sequence, occurrenceDate: item.occurrence_date, amountCents: item.amount_cents,
      received: receivedDates.has(item.occurrence_date),
    })),
    receipts: receipts.map((item) => ({
      id: item.id, amountCents: item.amount_cents, receivedAt: item.received_at, origin: item.origin, status: item.status,
    })),
  }
}

export function parseBookWindow(value: string | null): BookWindow | undefined {
  if (value === "today" || value === "week" || value === "month") return value
  return undefined
}

export function parseServicingStatuses(value: string | null): ServicingStatus[] | undefined {
  if (!value) return undefined
  const allowed = new Set<ServicingStatus>(["active", "paid_off", "defaulted", "in_collections"])
  const statuses = value.split(",").map((item) => item.trim()).filter((item): item is ServicingStatus => allowed.has(item as ServicingStatus))
  return statuses.length ? statuses : undefined
}
