import type { HomeKpis, KpiPeriod } from "./kpi-contracts"

export const HOME_KPI_RESTRICTED = "Restricted"
export const HOME_KPI_NA = "N/A"

export const HOME_KPI_COPY = {
  pipeline: "Deals in Pipeline",
  newDeals: "New Deals",
  renewals: "Renewals",
  funded: "Funded",
  commission: "Commission",
  activeMerchants: "Active merchants",
  approvalRate: "Approval rate",
  collectionsToday: "Collections today",
  emptyTitle: "Start your first deal",
  emptyDescription: "Upload an application or enter merchant details to open your pipeline.",
  emptyAction: "Start your first deal",
  mtd: "MTD",
  ytd: "YTD",
} as const

export type HomeKpiCardKey =
  | "pipeline"
  | "newDeals"
  | "renewals"
  | "funded"
  | "commission"
  | "activeMerchants"
  | "approvalRate"
  | "collectionsToday"

export interface HomeKpiSparkPoint {
  t: string
  v: number
}

export interface HomeKpiCard {
  key: HomeKpiCardKey
  title: string
  value: string
  detail: string
  periodSensitive: boolean
  sparkline: HomeKpiSparkPoint[]
  sparklineHidden: boolean
}

const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 })

function formatUsd(amount: number): string {
  return usd.format(amount)
}

function formatCents(cents: number): string {
  return formatUsd(cents / 100)
}

function money(amount: number | null | undefined, hidden: boolean, asCents: boolean): string {
  if (hidden || amount == null) return HOME_KPI_RESTRICTED
  return asCents ? formatCents(amount) : formatUsd(amount)
}

function countLabel(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`
}

function periodLabel(period: KpiPeriod): string {
  return period === "ytd" ? HOME_KPI_COPY.ytd : HOME_KPI_COPY.mtd
}

function formatPercent(rate: number | null): string {
  if (rate == null || !Number.isFinite(rate)) return HOME_KPI_NA
  const percent = rate * 100
  const digits = Number.isInteger(percent) ? 0 : 1
  return `${percent.toFixed(digits)}%`
}

function emptyKpis(period: KpiPeriod = "mtd"): HomeKpis {
  return {
    timezone: "UTC",
    asOf: "",
    period,
    pipeline: { count: 0, volumeDollars: 0, dollarsHidden: false },
    newDeals: { count: 0 },
    renewals: { count: 0 },
    funded: { amountCents: 0, count: 0, dollarsHidden: false },
    commission: { amountCents: 0, count: 0, dollarsHidden: false },
    activeMerchants: { count: 0 },
    approvalRate: { numerator: 0, denominator: 0, rate: null },
    collectionsToday: { expectedCents: 0, receivedCents: 0, dollarsHidden: false, source: "accounting_payments" },
    empty: true,
    series: {
      fundedByMonth: [],
      pipelineByMonth: [],
      approvalByMonth: [],
      collectionsByDay: [],
      revenueBreakdown: [],
      recentActivity: [],
      topFunders: [],
      merchantGrowth: [],
      industries: [],
      states: [],
    },
  }
}

function sparkline(points: HomeKpiSparkPoint[], hidden: boolean): { sparkline: HomeKpiSparkPoint[]; sparklineHidden: boolean } {
  if (hidden) return { sparkline: [], sparklineHidden: true }
  return { sparkline: points, sparklineHidden: false }
}

export function mapHomeKpiStrip(kpis: HomeKpis | null, period: KpiPeriod = kpis?.period ?? "mtd"): HomeKpiCard[] {
  const source = kpis ?? emptyKpis(period)
  const label = periodLabel(period)
  const approval = source.empty || source.approvalRate.rate == null ? HOME_KPI_NA : formatPercent(source.approvalRate.rate)
  return [
    {
      key: "pipeline",
      title: HOME_KPI_COPY.pipeline,
      value: money(source.pipeline.volumeDollars, source.pipeline.dollarsHidden, false),
      detail: countLabel(source.pipeline.count, "deal"),
      periodSensitive: false,
      ...sparkline(
        source.series.pipelineByMonth.map((row) => ({
          t: row.month,
          v: source.pipeline.dollarsHidden ? row.count : row.volumeDollars,
        })),
        false,
      ),
    },
    {
      key: "newDeals",
      title: HOME_KPI_COPY.newDeals,
      value: String(source.newDeals.count),
      detail: `${countLabel(source.newDeals.count, "deal")} · ${label}`,
      periodSensitive: true,
      ...sparkline([], false),
    },
    {
      key: "renewals",
      title: HOME_KPI_COPY.renewals,
      value: String(source.renewals.count),
      detail: `${countLabel(source.renewals.count, "renewal")} · ${label}`,
      periodSensitive: true,
      ...sparkline([], false),
    },
    {
      key: "funded",
      title: HOME_KPI_COPY.funded,
      value: money(source.funded.amountCents, source.funded.dollarsHidden, true),
      detail: `${countLabel(source.funded.count, "funding")} · ${label}`,
      periodSensitive: true,
      ...sparkline(
        source.series.fundedByMonth.map((row) => ({ t: row.month, v: row.fundedCents })),
        source.funded.dollarsHidden,
      ),
    },
    {
      key: "commission",
      title: HOME_KPI_COPY.commission,
      value: money(source.commission.amountCents, source.commission.dollarsHidden, true),
      detail: `${countLabel(source.commission.count, "payment")} · ${label}`,
      periodSensitive: true,
      ...sparkline(
        source.series.fundedByMonth.map((row) => ({ t: row.month, v: row.commissionCents })),
        source.commission.dollarsHidden,
      ),
    },
    {
      key: "activeMerchants",
      title: HOME_KPI_COPY.activeMerchants,
      value: String(source.activeMerchants.count),
      detail: countLabel(source.activeMerchants.count, "merchant"),
      periodSensitive: false,
      ...sparkline(
        source.series.merchantGrowth.map((row) => ({ t: row.month, v: row.new + row.returning })),
        false,
      ),
    },
    {
      key: "approvalRate",
      title: HOME_KPI_COPY.approvalRate,
      value: approval,
      detail: source.empty || source.approvalRate.rate == null ? label : `${source.approvalRate.numerator} / ${source.approvalRate.denominator} · ${label}`,
      periodSensitive: true,
      ...sparkline(
        source.series.approvalByMonth
          .filter((row) => row.rate != null)
          .map((row) => ({ t: row.month, v: (row.rate ?? 0) * 100 })),
        false,
      ),
    },
    {
      key: "collectionsToday",
      title: HOME_KPI_COPY.collectionsToday,
      value: money(source.collectionsToday.expectedCents, source.collectionsToday.dollarsHidden, true),
      detail: `Received ${money(source.collectionsToday.receivedCents, source.collectionsToday.dollarsHidden, true)}`,
      periodSensitive: false,
      ...sparkline(
        source.series.collectionsByDay.map((row) => ({ t: row.day, v: row.receivedCents })),
        source.collectionsToday.dollarsHidden,
      ),
    },
  ]
}
