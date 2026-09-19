import type { AdvancePerformanceStatus } from "../accounting/contracts"

export type BookWindow = "today" | "week" | "month"
export type ServicingStatus = "active" | "paid_off" | "defaulted" | "in_collections"

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/
const DAY_MS = 86_400_000

export function calendarDateInZone(value: string, timeZone: string): string {
  if (DATE_ONLY.test(value)) return value
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ""
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(date)
  const year = parts.find((part) => part.type === "year")?.value
  const month = parts.find((part) => part.type === "month")?.value
  const day = parts.find((part) => part.type === "day")?.value
  return year && month && day ? `${year}-${month}-${day}` : ""
}

export function calendarWindow(asOfIso: string, timeZone: string, window: BookWindow): { from: string; to: string } {
  const today = calendarDateInZone(asOfIso, timeZone)
  if (!DATE_ONLY.test(today)) throw new TypeError("asOf must resolve to a calendar date.")
  if (window === "today") return { from: today, to: today }
  const [year, month, day] = today.split("-").map(Number)
  if (window === "month") {
    const last = new Date(Date.UTC(year, month, 0)).getUTCDate()
    return { from: `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-01`, to: `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(last).padStart(2, "0")}` }
  }
  const utc = new Date(Date.UTC(year, month - 1, day))
  const weekday = utc.getUTCDay()
  const offsetFromMonday = weekday === 0 ? 6 : weekday - 1
  const monday = new Date(utc.getTime() - offsetFromMonday * DAY_MS)
  const sunday = new Date(monday.getTime() + 6 * DAY_MS)
  return { from: monday.toISOString().slice(0, 10), to: sunday.toISOString().slice(0, 10) }
}

export function inInclusiveDateRange(date: string, from: string, to: string): boolean {
  return date >= from && date <= to
}

export function servicingStatus(performance: AdvancePerformanceStatus): ServicingStatus {
  if (performance === "closed") return "paid_off"
  if (performance === "default") return "defaulted"
  if (performance === "in_collections") return "in_collections"
  return "active"
}

export function merchantIdentity(input: { ein?: string | null; legalName?: string | null; dealId: string }): string {
  const ein = input.ein?.replace(/\D/g, "")
  if (ein && ein.length >= 9) return `ein:${ein}`
  const legal = input.legalName?.trim().toLowerCase()
  if (legal) return `name:${legal}`
  return `deal:${input.dealId}`
}

export function assignAdvanceNumbers<T extends { identity: string; fundedAt: string; createdAt: string; id: string }>(rows: T[]): Map<string, number> {
  const grouped = new Map<string, T[]>()
  for (const row of rows) {
    const list = grouped.get(row.identity) ?? []
    list.push(row)
    grouped.set(row.identity, list)
  }
  const numbers = new Map<string, number>()
  for (const list of grouped.values()) {
    list.sort((left, right) => left.fundedAt.localeCompare(right.fundedAt) || left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id))
    list.forEach((row, index) => numbers.set(row.id, index + 1))
  }
  return numbers
}

export function paidDown(input: {
  paybackCents: number | null
  receivedCents: number
  scheduledPaidInCents: number | null
  scheduledPaidInBasisPoints: number | null
}): { balanceRemainingCents: number | null; paidDownBasisPoints: number | null; paidDownEstimated: boolean } {
  if (input.paybackCents === null) return { balanceRemainingCents: null, paidDownBasisPoints: null, paidDownEstimated: false }
  if (input.receivedCents > 0) {
    const received = Math.min(input.paybackCents, input.receivedCents)
    const paidDownBasisPoints = input.paybackCents === 0 ? 0 : Math.min(10_000, Number((BigInt(received) * BigInt(10_000)) / BigInt(input.paybackCents)))
    return { balanceRemainingCents: Math.max(0, input.paybackCents - received), paidDownBasisPoints, paidDownEstimated: false }
  }
  if (input.scheduledPaidInCents === null || input.scheduledPaidInBasisPoints === null) {
    return { balanceRemainingCents: input.paybackCents, paidDownBasisPoints: 0, paidDownEstimated: true }
  }
  return {
    balanceRemainingCents: Math.max(0, input.paybackCents - input.scheduledPaidInCents),
    paidDownBasisPoints: input.scheduledPaidInBasisPoints,
    paidDownEstimated: true,
  }
}

export function collectedTowardInstallment(
  installment: { id?: string | null; occurrenceDate: string },
  receipts: Array<{ amountCents: number; receivedOn?: string | null; installmentId?: string | null; status?: string | null }>,
): number {
  let collected = 0
  for (const receipt of receipts) {
    if (receipt.status && receipt.status !== "received") continue
    const byId = Boolean(installment.id) && receipt.installmentId === installment.id
    const byDate = receipt.receivedOn === installment.occurrenceDate
    if (byId || byDate) collected += receipt.amountCents
  }
  return collected
}

export function installmentSatisfied(amountCents: number, collectedCents: number): boolean {
  return amountCents <= 0 || collectedCents >= amountCents
}

export function nextPaymentDate(installments: Array<{ occurrenceDate: string; amountCents?: number }>, receiptsByDate: Set<string>, asOfDate: string): string | null {
  const upcoming = installments
    .filter((item) => item.occurrenceDate >= asOfDate && item.amountCents !== 0 && !receiptsByDate.has(item.occurrenceDate))
    .map((item) => item.occurrenceDate)
    .sort()
  return upcoming[0] ?? null
}

export function missedInstallments(
  installments: Array<{ occurrenceDate: string; amountCents?: number }>,
  receiptsByDate: Set<string>,
  window: { from: string; to: string },
  asOfDate: string,
): Array<{ occurrenceDate: string }> {
  return installments.filter((item) => {
    if (item.amountCents === 0) return false
    if (!inInclusiveDateRange(item.occurrenceDate, window.from, window.to)) return false
    if (item.occurrenceDate > asOfDate) return false
    return !receiptsByDate.has(item.occurrenceDate)
  })
}

export function completedReceipts(receipts: Array<{ receivedDate: string }>, window: { from: string; to: string }): Array<{ receivedDate: string }> {
  return receipts.filter((item) => inInclusiveDateRange(item.receivedDate, window.from, window.to))
}

export function ordinal(value: number): string {
  const remainder = value % 100
  if (remainder >= 11 && remainder <= 13) return `${value}th`
  switch (value % 10) {
    case 1: return `${value}st`
    case 2: return `${value}nd`
    case 3: return `${value}rd`
    default: return `${value}th`
  }
}
