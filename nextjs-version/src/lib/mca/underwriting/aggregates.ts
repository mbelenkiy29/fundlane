import "server-only"

import { getWorkspaceSettings } from "../workspaces"
import { readRequiredStatementMonths } from "./completeness-repository"
import type { ExistingPositionCandidate, MetricEvidence, StatementMonthRecord, UnderwritingAggregate } from "./contracts"
import { closedLookbackMonths } from "./lookback"
import { normalizeIsoDates } from "./statement-extraction"

const PERIOD = /^\d{4}-(0[1-9]|1[0-2])$/
const UNKNOWN_METRIC: MetricEvidence = { value: null, unknown: true, confidence: 0 }

export interface ComputeUnderwritingAggregateInput {
  dealId: string
  months: StatementMonthRecord[]
  positions: ExistingPositionCandidate[]
  window: string[]
  version: number
  computedAt: string
}

export async function resolveUnderwritingWindow(workspaceId: string): Promise<string[]> {
  const [settings, required] = await Promise.all([
    getWorkspaceSettings(workspaceId),
    readRequiredStatementMonths(workspaceId),
  ])
  return closedLookbackMonths(required, settings.timezone || "America/New_York")
}

function includedMonths(months: StatementMonthRecord[], window: string[]): StatementMonthRecord[] {
  const lookback = new Set(window.filter((period) => PERIOD.test(period)))
  return months.filter((month) => (
    month.accountKind === "checking"
    && !month.duplicateOfId
    && PERIOD.test(month.period)
    && lookback.has(month.period)
  ))
}

function averagePeriodTotals(months: StatementMonthRecord[], pick: (month: StatementMonthRecord) => MetricEvidence, text: string): MetricEvidence {
  if (months.length === 0) return { ...UNKNOWN_METRIC, text }
  const byPeriod = new Map<string, StatementMonthRecord[]>()
  for (const month of months) {
    const group = byPeriod.get(month.period) ?? []
    group.push(month)
    byPeriod.set(month.period, group)
  }
  const totals: Array<{ value: number; confidence: number }> = []
  for (const group of byPeriod.values()) {
    let sum = 0
    let confidence = 1
    for (const month of group) {
      const metric = pick(month)
      if (metric.unknown || metric.value == null || !Number.isFinite(metric.value)) return { ...UNKNOWN_METRIC, text }
      sum += metric.value
      confidence = Math.min(confidence, metric.confidence)
    }
    totals.push({ value: sum, confidence })
  }
  return {
    value: totals.reduce((sum, item) => sum + item.value, 0) / totals.length,
    unknown: false,
    confidence: totals.reduce((sum, item) => sum + item.confidence, 0) / totals.length,
    text,
  }
}

function uniqueDayMetric(
  months: StatementMonthRecord[],
  datesOf: (month: StatementMonthRecord) => string[],
  countOf: (month: StatementMonthRecord) => MetricEvidence,
  text: string,
): MetricEvidence {
  if (months.length === 0) return { ...UNKNOWN_METRIC, text }
  const dated: string[][] = []
  const countOnly: MetricEvidence[] = []
  let confidence = 1
  for (const month of months) {
    const dates = normalizeIsoDates(datesOf(month))
    const count = countOf(month)
    if (dates.length > 0) {
      dated.push(dates)
      confidence = Math.min(confidence, count.confidence)
      continue
    }
    if (count.unknown || count.value == null || !Number.isFinite(count.value)) return { ...UNKNOWN_METRIC, text }
    confidence = Math.min(confidence, count.confidence)
    if (count.value === 0) continue
    countOnly.push(count)
  }
  if (countOnly.length >= 2) return { ...UNKNOWN_METRIC, text }
  if (countOnly.length === 1) {
    if (dated.length > 0) return { ...UNKNOWN_METRIC, text }
    return { value: countOnly[0]!.value, unknown: false, confidence, text }
  }
  const union = new Set<string>()
  for (const dates of dated) {
    for (const day of dates) union.add(day)
  }
  return { value: union.size, unknown: false, confidence, text }
}

function worstMonthUniqueDays(
  months: StatementMonthRecord[],
  datesOf: (month: StatementMonthRecord) => string[],
  countOf: (month: StatementMonthRecord) => MetricEvidence,
  text: string,
): MetricEvidence {
  if (months.length === 0) return { ...UNKNOWN_METRIC, text }
  const byPeriod = new Map<string, StatementMonthRecord[]>()
  for (const month of months) {
    const group = byPeriod.get(month.period) ?? []
    group.push(month)
    byPeriod.set(month.period, group)
  }
  let worst: number | null = null
  let confidence = 1
  for (const group of byPeriod.values()) {
    const metric = uniqueDayMetric(group, datesOf, countOf, text)
    if (metric.unknown || metric.value == null || !Number.isFinite(metric.value)) return { ...UNKNOWN_METRIC, text }
    worst = worst == null ? metric.value : Math.max(worst, metric.value)
    confidence = Math.min(confidence, metric.confidence)
  }
  return worst == null ? { ...UNKNOWN_METRIC, text } : { value: worst, unknown: false, confidence, text }
}

function collectWarnings(months: StatementMonthRecord[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const month of months) {
    for (const warning of month.warnings) {
      if (seen.has(warning)) continue
      seen.add(warning)
      out.push(warning)
    }
  }
  return out
}

export function computeUnderwritingAggregate({
  dealId,
  months,
  positions,
  window,
  version,
  computedAt,
}: ComputeUnderwritingAggregateInput): UnderwritingAggregate {
  const included = includedMonths(months, window)
  return {
    dealId,
    version,
    monthlyRevenue: averagePeriodTotals(included, (month) => month.deposits, "Average of unique checking months' deposits; accounts in the same period are summed first."),
    averageDailyBalance: averagePeriodTotals(included, (month) => month.averageDailyBalance, "Average of unique checking months' ADB; accounts in the same period are summed first."),
    nsfCount: uniqueDayMetric(included, (month) => month.nsfDates, (month) => month.nsfCount, "Unique NSF calendar days across checking statements in the lookback window."),
    negativeDays: uniqueDayMetric(included, (month) => month.negativeDates, (month) => month.negativeDays, "Unique negative-balance calendar days across checking statements in the lookback window."),
    depositCount: averagePeriodTotals(included, (month) => month.depositCount, "Average of unique checking months' deposit counts; accounts in the same period are summed first."),
    worstMonthNsf: worstMonthUniqueDays(included, (month) => month.nsfDates, (month) => month.nsfCount, "Highest unique-day NSF count in any lookback month."),
    warnings: collectWarnings(included),
    positionCount: positions.filter((position) => position.status === "confirmed").length,
    stale: false,
    computedAt,
  }
}
