import type { HomeKpis, KpiPeriod } from "../home/kpi-contracts"

export const NO_ACTIVITY_YET = "No activity yet"
export const RESTRICTED_LABEL = "Restricted"
export const NA_LABEL = "N/A"

export type Dashboard2DateRange = "7d" | "30d" | "90d" | "1y"
export type Dashboard2SalesRange = "3m" | "6m" | "12m"

export interface Dashboard2MetricCard {
  title: string
  value: string
  description: string
  change: string
  trend: "up" | "down"
  footer: string
  subfooter: string
}

export interface Dashboard2SalesPoint {
  month: string
  sales: number
  target: number
}

export interface Dashboard2RevenueSlice {
  category: "funded" | "commission" | "fees"
  label: string
  amount: number
  value: number
  display: string
  fill: string
  restricted: boolean
}

export interface Dashboard2ActivityRow {
  id: string
  customer: { name: string; email: string }
  amount: string
  status: "completed" | "pending" | "failed"
  date: string
}

export interface Dashboard2FunderRow {
  id: string
  name: string
  sales: number
  revenue: string
  growth: string
  rating: string
  stock: number
  stockPercent: number
  category: string
}

export interface Dashboard2GrowthPoint {
  month: string
  new: number
  renewals: number
  churn: number
}

export interface Dashboard2ShareRow {
  label: string
  customers: number
  percentage: string
  revenue: string
  growth: string
  growthColor: string
}

export interface Dashboard2GrowthMetrics {
  totalCustomers: string
  totalCustomersHint: string
  retention: string
  retentionHint: string
  collections: string
  collectionsHint: string
}

export interface Dashboard2View {
  empty: boolean
  asOf: string
  period: KpiPeriod
  periodLabel: string
  companyHidden: boolean
  paymentsHidden: boolean
  metrics: Dashboard2MetricCard[]
  sales: {
    points: Dashboard2SalesPoint[]
    restricted: boolean
    empty: boolean
    plotSales: boolean
    plotTarget: boolean
  }
  revenue: {
    slices: Dashboard2RevenueSlice[]
    restricted: boolean
    empty: boolean
    totalDisplay: string
  }
  activity: Dashboard2ActivityRow[]
  funders: Dashboard2FunderRow[]
  growth: Dashboard2GrowthPoint[]
  growthMetrics: Dashboard2GrowthMetrics
  industries: Dashboard2ShareRow[]
  states: Dashboard2ShareRow[]
}

const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 })
const REVENUE_LABELS: Record<Dashboard2RevenueSlice["category"], string> = {
  funded: "Funded",
  commission: "Commission",
  fees: "Fees",
}

export function periodForDateRange(range: Dashboard2DateRange): KpiPeriod {
  return range === "1y" ? "ytd" : "mtd"
}

export function monthWindowForDateRange(range: Dashboard2DateRange): number {
  if (range === "90d") return 3
  if (range === "1y") return 12
  return 1
}

export function monthWindowForSalesRange(range: Dashboard2SalesRange): number {
  if (range === "3m") return 3
  if (range === "6m") return 6
  return 12
}

export function periodLabel(period: KpiPeriod): string {
  return period === "ytd" ? "Year to date" : "Month to date"
}

export function formatUsd(amount: number): string {
  return usd.format(amount)
}

export function formatCentsUsd(cents: number): string {
  return formatUsd(cents / 100)
}

export function formatMonthLabel(month: string): string {
  const year = Number(month.slice(0, 4))
  const monthIndex = Number(month.slice(5, 7)) - 1
  if (!Number.isFinite(year) || monthIndex < 0 || monthIndex > 11) return month
  return new Date(Date.UTC(year, monthIndex, 1)).toLocaleString("en-US", { month: "short", timeZone: "UTC" })
}

export function formatPercent(rate: number | null): string {
  if (rate == null || !Number.isFinite(rate)) return NA_LABEL
  const percent = rate * 100
  const digits = Number.isInteger(percent) ? 0 : 1
  return `${percent.toFixed(digits)}%`
}

export function formatRelativeTimestamp(at: string, nowIso: string): string {
  const elapsed = Date.parse(nowIso) - Date.parse(at)
  if (!Number.isFinite(elapsed)) return ""
  if (elapsed < 60_000) return "just now"
  const minutes = Math.floor(elapsed / 60_000)
  if (minutes < 60) return minutes === 1 ? "1 minute ago" : `${minutes} minutes ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return hours === 1 ? "1 hour ago" : `${hours} hours ago`
  const days = Math.floor(hours / 24)
  return days === 1 ? "1 day ago" : `${days} days ago`
}

export function toCsv(headers: string[], rows: Array<Array<string | number>>): string {
  const escape = (value: string | number) => {
    const text = String(value)
    return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text
  }
  return [headers.map(escape).join(","), ...rows.map((row) => row.map(escape).join(","))].join("\n")
}

export function salesChartCsv(points: Dashboard2SalesPoint[], restricted: boolean): string {
  if (restricted) return toCsv(["month", "funded", "commission"], [])
  return toCsv(["month", "funded", "commission"], points.map((point) => [point.month, point.sales, point.target]))
}

export function revenueBreakdownCsv(slices: Dashboard2RevenueSlice[], restricted: boolean): string {
  if (restricted) return toCsv(["category", "amount", "percent"], [])
  return toCsv(
    ["category", "amount", "percent"],
    slices.map((slice) => [slice.label, slice.restricted ? RESTRICTED_LABEL : slice.amount, slice.value]),
  )
}

export function emptyHomeKpis(period: KpiPeriod = "mtd"): HomeKpis {
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
      revenueBreakdown: [
        { key: "funded", amountCents: 0 },
        { key: "commission", amountCents: 0 },
        { key: "fees", amountCents: 0 },
      ],
      recentActivity: [],
      topFunders: [],
      merchantGrowth: [],
      industries: [],
      states: [],
    },
  }
}

function sliceLast<T>(rows: T[], count: number): T[] {
  if (count <= 0) return []
  return rows.slice(Math.max(0, rows.length - count))
}

function moneyDisplay(amount: number | null | undefined, hidden: boolean, empty: boolean, asCents: boolean): string {
  if (empty) return formatUsd(0)
  if (hidden || amount == null) return RESTRICTED_LABEL
  return asCents ? formatCentsUsd(amount) : formatUsd(amount)
}

function activityStatus(status: string): Dashboard2ActivityRow["status"] {
  if (status === "committed" || status === "received" || status === "posted" || status === "completed") return "completed"
  if (status === "pending" || status === "expected") return "pending"
  return "failed"
}

function shareRows(
  rows: Array<{ label: string; count: number; fundedCents: number | null }>,
  companyHidden: boolean,
  empty: boolean,
): Dashboard2ShareRow[] {
  const total = rows.reduce((sum, row) => sum + row.count, 0)
  return rows.map((row) => ({
    label: row.label,
    customers: row.count,
    percentage: total === 0 ? "0.0%" : `${((row.count / total) * 100).toFixed(1)}%`,
    revenue: empty ? formatUsd(0) : companyHidden || row.fundedCents == null ? RESTRICTED_LABEL : formatCentsUsd(row.fundedCents),
    growth: "—",
    growthColor: "text-muted-foreground",
  }))
}

export function mapSalesChart(
  kpis: HomeKpis | null,
  salesRange: Dashboard2SalesRange = "12m",
): Dashboard2View["sales"] {
  const source = kpis ?? emptyHomeKpis()
  const companyHidden = source.funded.dollarsHidden || source.pipeline.dollarsHidden
  const paymentsHidden = source.commission.dollarsHidden || source.collectionsToday.dollarsHidden
  const points = sliceLast(source.series.fundedByMonth, monthWindowForSalesRange(salesRange)).map((row) => ({
    month: formatMonthLabel(row.month),
    sales: companyHidden ? 0 : row.fundedCents / 100,
    target: paymentsHidden ? 0 : row.commissionCents / 100,
  }))
  const allZero = points.every((row) => row.sales === 0 && row.target === 0)
  const restricted = !source.empty && companyHidden && paymentsHidden
  return {
    points,
    restricted,
    empty: source.empty || (allZero && !restricted),
    plotSales: !companyHidden,
    plotTarget: !paymentsHidden,
  }
}

export function mapDashboard2(
  kpis: HomeKpis | null,
  options: { dateRange?: Dashboard2DateRange; salesRange?: Dashboard2SalesRange } = {},
): Dashboard2View {
  const source = kpis ?? emptyHomeKpis()
  const dateRange = options.dateRange ?? "30d"
  const empty = source.empty
  const companyHidden = source.funded.dollarsHidden || source.pipeline.dollarsHidden
  const paymentsHidden = source.commission.dollarsHidden || source.collectionsToday.dollarsHidden
  const label = periodLabel(source.period)
  const pipelineValue = empty
    ? "0"
    : String(source.pipeline.count)
  const pipelineFooter = empty
    ? NO_ACTIVITY_YET
    : moneyDisplay(source.pipeline.volumeDollars, companyHidden, false, false)
  const fundedValue = moneyDisplay(source.funded.amountCents, companyHidden, empty, true)
  const commissionValue = moneyDisplay(source.commission.amountCents, paymentsHidden, empty, true)

  const metrics: Dashboard2MetricCard[] = [
    {
      title: "Pipeline",
      value: pipelineValue,
      description: "Open deals",
      change: "—",
      trend: "up",
      footer: pipelineFooter,
      subfooter: `${source.activeMerchants.count} active merchants`,
    },
    {
      title: "Funded",
      value: fundedValue,
      description: label,
      change: "—",
      trend: "up",
      footer: empty ? NO_ACTIVITY_YET : `${source.funded.count} fundings`,
      subfooter: label,
    },
    {
      title: "Commission",
      value: commissionValue,
      description: label,
      change: "—",
      trend: "up",
      footer: empty ? NO_ACTIVITY_YET : `${source.commission.count} payments`,
      subfooter: label,
    },
    {
      title: "Approval rate",
      value: empty ? NA_LABEL : formatPercent(source.approvalRate.rate),
      description: "Approvals / submissions",
      change: "—",
      trend: "up",
      footer: empty ? NO_ACTIVITY_YET : `${source.approvalRate.numerator} / ${source.approvalRate.denominator}`,
      subfooter: label,
    },
  ]

  const sales = mapSalesChart(source, options.salesRange ?? "12m")
  const breakdown = source.series.revenueBreakdown
  const fundedSlice = breakdown.find((row) => row.key === "funded")?.amountCents ?? 0
  const commissionSlice = breakdown.find((row) => row.key === "commission")?.amountCents ?? 0
  const feeSlice = breakdown.find((row) => row.key === "fees")?.amountCents ?? 0
  const visibleTotal =
    (companyHidden ? 0 : fundedSlice) + (paymentsHidden ? 0 : commissionSlice) + (paymentsHidden ? 0 : feeSlice)
  const slices: Dashboard2RevenueSlice[] = (
    [
      { key: "funded" as const, cents: fundedSlice, hidden: companyHidden },
      { key: "commission" as const, cents: commissionSlice, hidden: paymentsHidden },
      { key: "fees" as const, cents: feeSlice, hidden: paymentsHidden },
    ] as const
  ).map((row) => {
    const restricted = !empty && row.hidden
    const amount = restricted ? 0 : row.cents / 100
    const value = visibleTotal === 0 || restricted ? 0 : Math.round((row.cents / visibleTotal) * 100)
    return {
      category: row.key,
      label: REVENUE_LABELS[row.key],
      amount,
      value,
      display: empty ? formatUsd(0) : restricted ? RESTRICTED_LABEL : formatUsd(amount),
      fill: `var(--color-${row.key})`,
      restricted,
    }
  })
  const revenueRestricted = !empty && companyHidden && paymentsHidden
  const revenueEmpty = empty || (visibleTotal === 0 && !revenueRestricted)

  const growthWindow = monthWindowForDateRange(dateRange)
  const growth = sliceLast(source.series.merchantGrowth, growthWindow).map((row) => ({
    month: formatMonthLabel(row.month),
    new: row.new,
    renewals: row.renewals,
    churn: row.churn,
  }))
  const growthTotals = growth.reduce(
    (sum, row) => ({ new: sum.new + row.new, renewals: sum.renewals + row.renewals, churn: sum.churn + row.churn }),
    { new: 0, renewals: 0, churn: 0 },
  )
  const retentionBase = growthTotals.renewals + growthTotals.churn
  const retention = retentionBase === 0 ? null : growthTotals.renewals / retentionBase
  const collectionsDisplay = empty
    ? formatUsd(0)
    : paymentsHidden || source.collectionsToday.receivedCents == null || source.collectionsToday.expectedCents == null
      ? RESTRICTED_LABEL
      : `${formatCentsUsd(source.collectionsToday.receivedCents)} / ${formatCentsUsd(source.collectionsToday.expectedCents)}`

  const funderMax = source.series.topFunders.reduce((max, row) => Math.max(max, row.dealCount), 0)
  const funderTotal = source.series.topFunders.reduce((sum, row) => sum + row.fundedCents, 0)

  return {
    empty,
    asOf: source.asOf,
    period: source.period,
    periodLabel: label,
    companyHidden,
    paymentsHidden,
    metrics,
    sales,
    revenue: {
      slices,
      restricted: revenueRestricted,
      empty: revenueEmpty,
      totalDisplay: revenueEmpty ? formatUsd(0) : revenueRestricted ? RESTRICTED_LABEL : formatCentsUsd(visibleTotal),
    },
    activity: source.series.recentActivity.map((row) => ({
      id: row.id,
      customer: { name: row.title, email: row.subtitle },
      amount: empty ? formatUsd(0) : row.amountCents == null ? RESTRICTED_LABEL : formatCentsUsd(row.amountCents),
      status: activityStatus(row.status),
      date: source.asOf ? formatRelativeTimestamp(row.at, source.asOf) : "",
    })),
    funders: source.series.topFunders.map((row, index) => ({
      id: `${row.name}-${index}`,
      name: row.name,
      sales: row.dealCount,
      revenue: empty ? formatUsd(0) : companyHidden ? RESTRICTED_LABEL : formatCentsUsd(row.fundedCents),
      growth: empty || companyHidden || funderTotal === 0 ? "—" : `${Math.round((row.fundedCents / funderTotal) * 100)}%`,
      rating: "—",
      stock: row.dealCount,
      stockPercent: funderMax === 0 ? 0 : Math.round((row.dealCount / funderMax) * 100),
      category: "Funder",
    })),
    growth,
    growthMetrics: {
      totalCustomers: String(source.activeMerchants.count),
      totalCustomersHint: empty ? NO_ACTIVITY_YET : "Active advances on track or missed payment",
      retention: empty ? NA_LABEL : formatPercent(retention),
      retentionHint: empty ? NO_ACTIVITY_YET : "Renewals vs churned in range",
      collections: collectionsDisplay,
      collectionsHint: empty ? NO_ACTIVITY_YET : "Received / expected today",
    },
    industries: shareRows(source.series.industries, companyHidden, empty),
    states: shareRows(source.series.states, companyHidden, empty),
  }
}

export const EMPTY_DASHBOARD2 = mapDashboard2(null)
