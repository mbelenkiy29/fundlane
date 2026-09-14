import { calendarDateInZone, calendarWindow, type BookWindow } from "../deals/book-math"
import { isCountedSubmission, type SubmissionRow } from "./dashboard-view"

export const INSIGHT_WINDOWS = ["today", "week", "month"] as const
export type InsightWindow = BookWindow

export function isInsightWindow(value: string): value is InsightWindow {
  return (INSIGHT_WINDOWS as readonly string[]).includes(value)
}

export interface SubmissionInsights {
  timezone: string
  window: InsightWindow
  submissions: { count: number; dealCount: number }
  brokers: Array<{ membershipId: string; name: string; count: number }>
  lenders: Array<{ funderId: string | null; name: string; count: number }>
}

const OTHER_LENDER = "Other"
const LENDER_LIMIT = 8

export function buildSubmissionInsights(input: {
  timezone: string
  window: InsightWindow
  nowIso: string
  rows: SubmissionRow[]
}): SubmissionInsights {
  const range = calendarWindow(input.nowIso, input.timezone, input.window)
  const counted = input.rows.filter((row) => {
    if (!isCountedSubmission(row) || !row.submittedAt) return false
    const day = calendarDateInZone(row.submittedAt, input.timezone) || row.submittedAt.slice(0, 10)
    return day >= range.from && day <= range.to
  })
  const deals = new Set(counted.map((row) => row.dealId))
  const brokers = new Map<string, { membershipId: string; name: string; count: number }>()
  const lenders = new Map<string, { funderId: string | null; name: string; count: number }>()
  for (const row of counted) {
    const membershipId = row.originatorId ?? "unassigned"
    const name = row.originatorName?.trim() || "Unassigned"
    const broker = brokers.get(membershipId) ?? { membershipId, name, count: 0 }
    broker.count += 1
    brokers.set(membershipId, broker)
    const lenderKey = row.funderId ?? `name:${row.funder}`
    const lender = lenders.get(lenderKey) ?? { funderId: row.funderId, name: row.funder, count: 0 }
    lender.count += 1
    lenders.set(lenderKey, lender)
  }
  const rankedLenders = [...lenders.values()].sort(
    (a, b) => b.count - a.count || a.name.localeCompare(b.name)
  )
  const visible = rankedLenders.slice(0, LENDER_LIMIT)
  const rest = rankedLenders.slice(LENDER_LIMIT)
  if (rest.length) {
    visible.push({
      funderId: null,
      name: OTHER_LENDER,
      count: rest.reduce((sum, row) => sum + row.count, 0),
    })
  }
  return {
    timezone: input.timezone,
    window: input.window,
    submissions: { count: counted.length, dealCount: deals.size },
    brokers: [...brokers.values()].sort(
      (a, b) => b.count - a.count || a.name.localeCompare(b.name) || a.membershipId.localeCompare(b.membershipId)
    ),
    lenders: visible,
  }
}
