import { assertCents } from "../accounting/money"

const DAY_MS = 86_400_000

function utcDay(value: string): Date {
  const date = /^\d{4}-\d{2}-\d{2}$/.test(value) ? new Date(`${value}T00:00:00.000Z`) : new Date(value)
  if (!Number.isFinite(date.getTime())) throw new TypeError("Date must be a valid ISO date or timestamp.")
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()))
}

function businessDays(start: Date, end: Date): number {
  let count = 0
  for (let cursor = start.getTime() + DAY_MS; cursor <= end.getTime(); cursor += DAY_MS) {
    const day = new Date(cursor).getUTCDay()
    if (day !== 0 && day !== 6) count += 1
  }
  return count
}

function monthlyAnniversaries(start: Date, end: Date, limit: number): number {
  let count = 0
  const originalDay = start.getUTCDate()
  for (let offset = 1; offset <= limit; offset += 1) {
    const year = start.getUTCFullYear() + Math.floor((start.getUTCMonth() + offset) / 12)
    const month = (start.getUTCMonth() + offset) % 12
    const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate()
    const due = new Date(Date.UTC(year, month, Math.min(originalDay, lastDay)))
    if (due > end) break
    count += 1
  }
  return count
}

export interface ScheduledPaidInInput {
  fundedAt: string
  asOf: string
  paybackCents: number | null
  periodicPaymentCents: number | null
  paymentCount: number | null
  paymentFrequency: string | null
  calendarConvention: string | null
}

export interface ScheduledPaidInEstimate {
  paidInCents: number | null
  paidInBasisPoints: number | null
  elapsedPayments: number | null
  label: "scheduled_estimate" | "unknown"
}

export function estimateScheduledPaidIn(input: ScheduledPaidInInput): ScheduledPaidInEstimate {
  if (input.paybackCents === null || input.periodicPaymentCents === null || input.paymentCount === null
    || !input.paymentFrequency || !input.calendarConvention) {
    return { paidInCents: null, paidInBasisPoints: null, elapsedPayments: null, label: "unknown" }
  }
  assertCents(input.paybackCents, "paybackCents")
  assertCents(input.periodicPaymentCents, "periodicPaymentCents")
  if (!Number.isSafeInteger(input.paymentCount) || input.paymentCount <= 0) throw new TypeError("paymentCount must be positive.")
  const funded = utcDay(input.fundedAt)
  const asOf = utcDay(input.asOf)
  if (asOf < funded) return { paidInCents: 0, paidInBasisPoints: 0, elapsedPayments: 0, label: "scheduled_estimate" }
  const days = Math.floor((asOf.getTime() - funded.getTime()) / DAY_MS)
  if (!["calendar_days", "business_days", "fixed_count"].includes(input.calendarConvention)) {
    return { paidInCents: null, paidInBasisPoints: null, elapsedPayments: null, label: "unknown" }
  }
  let elapsed: number
  if (input.calendarConvention === "business_days" && input.paymentFrequency === "daily") elapsed = businessDays(funded, asOf)
  else if (input.paymentFrequency === "daily") elapsed = days
  else if (input.paymentFrequency === "weekly") elapsed = Math.floor(days / 7)
  else if (input.paymentFrequency === "biweekly") elapsed = Math.floor(days / 14)
  else if (input.paymentFrequency === "monthly") elapsed = monthlyAnniversaries(funded, asOf, input.paymentCount)
  else return { paidInCents: null, paidInBasisPoints: null, elapsedPayments: null, label: "unknown" }
  elapsed = Math.max(0, Math.min(input.paymentCount, elapsed))
  const paidInCents = Math.min(input.paybackCents, elapsed * input.periodicPaymentCents)
  const paidInBasisPoints = input.paybackCents === 0 ? 0 : Math.min(10_000, Number((BigInt(paidInCents) * BigInt(10_000)) / BigInt(input.paybackCents)))
  return { paidInCents, paidInBasisPoints, elapsedPayments: elapsed, label: "scheduled_estimate" }
}

export interface ExpectedInstallment {
  sequence: number
  occurrenceDate: string
  amountCents: number
}

function ymd(date: Date): string {
  return date.toISOString().slice(0, 10)
}

function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * DAY_MS)
}

function addBusinessDays(start: Date, count: number): Date {
  let cursor = start
  let remaining = count
  while (remaining > 0) {
    cursor = addDays(cursor, 1)
    const day = cursor.getUTCDay()
    if (day !== 0 && day !== 6) remaining -= 1
  }
  return cursor
}

function monthlyOccurrence(start: Date, offset: number): Date {
  const originalDay = start.getUTCDate()
  const year = start.getUTCFullYear() + Math.floor((start.getUTCMonth() + offset) / 12)
  const month = (start.getUTCMonth() + offset) % 12
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate()
  return new Date(Date.UTC(year, month, Math.min(originalDay, lastDay)))
}

/** First payment is due after one period, matching estimateScheduledPaidIn. */
export function generateExpectedInstallments(input: {
  fundedAt: string
  paymentCount: number | null
  paymentFrequency: string | null
  calendarConvention: string | null
  periodicPaymentCents: number | null
  paybackCents?: number | null
}): ExpectedInstallment[] {
  if (input.paymentCount === null || input.periodicPaymentCents === null || !input.paymentFrequency || !input.calendarConvention) return []
  if (!Number.isSafeInteger(input.paymentCount) || input.paymentCount <= 0) return []
  if (!Number.isSafeInteger(input.periodicPaymentCents) || input.periodicPaymentCents <= 0) return []
  if (!["calendar_days", "business_days", "fixed_count"].includes(input.calendarConvention)) return []
  const funded = utcDay(input.fundedAt)
  const dates: Date[] = []
  for (let sequence = 1; sequence <= input.paymentCount; sequence += 1) {
    if (input.paymentFrequency === "daily" && input.calendarConvention === "business_days") dates.push(addBusinessDays(funded, sequence))
    else if (input.paymentFrequency === "daily") dates.push(addDays(funded, sequence))
    else if (input.paymentFrequency === "weekly") dates.push(addDays(funded, sequence * 7))
    else if (input.paymentFrequency === "biweekly") dates.push(addDays(funded, sequence * 14))
    else if (input.paymentFrequency === "monthly") dates.push(monthlyOccurrence(funded, sequence))
    else return []
  }
  return dates.map((date, index) => {
    const isLast = index === dates.length - 1
    const remaining = isLast && input.paybackCents != null
      ? Math.max(0, input.paybackCents - input.periodicPaymentCents! * (dates.length - 1))
      : input.periodicPaymentCents!
    return { sequence: index + 1, occurrenceDate: ymd(date), amountCents: remaining }
  })
}
