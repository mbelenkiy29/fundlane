import type { DealStatus } from "../deals/schema"

export const HOME_KPI_PERIODS = ["mtd", "ytd"] as const
export type KpiPeriod = (typeof HOME_KPI_PERIODS)[number]

export const PIPELINE_EXCLUDED_STATUSES = ["funded", "renewed", "closed", "default", "missed_payments"] as const
export type PipelineExcludedStatus = (typeof PIPELINE_EXCLUDED_STATUSES)[number]

export const ACTIVE_ADVANCE_PERFORMANCE = ["on_track", "missed_payment"] as const

export function isHomeKpiPeriod(value: string): value is KpiPeriod {
  return (HOME_KPI_PERIODS as readonly string[]).includes(value)
}

export function isPipelineOpenStatus(status: DealStatus | string): boolean {
  return !(PIPELINE_EXCLUDED_STATUSES as readonly string[]).includes(status)
}

export interface HomeKpiQuery {
  period: KpiPeriod
  nowIso: string
}

export interface MoneyCount {
  amountCents: number | null
  count: number
  dollarsHidden: boolean
}

export interface HomeKpis {
  timezone: string
  asOf: string
  period: KpiPeriod
  pipeline: { count: number; volumeDollars: number | null; dollarsHidden: boolean }
  newDeals: { count: number }
  renewals: { count: number }
  funded: MoneyCount
  commission: MoneyCount
  activeMerchants: { count: number }
  approvalRate: { numerator: number; denominator: number; rate: number | null }
  collectionsToday: {
    expectedCents: number | null
    receivedCents: number | null
    dollarsHidden: boolean
    source: "accounting_payments"
  }
  empty: boolean
  series: {
    fundedByMonth: Array<{ month: string; fundedCents: number; commissionCents: number }>
    pipelineByMonth: Array<{ month: string; count: number; volumeDollars: number }>
    approvalByMonth: Array<{ month: string; numerator: number; denominator: number; rate: number | null }>
    collectionsByDay: Array<{ day: string; expectedCents: number; receivedCents: number }>
    revenueBreakdown: Array<{ key: "funded" | "commission" | "fees"; amountCents: number }>
    recentActivity: Array<{
      id: string
      kind: "funding" | "commission" | "fee"
      title: string
      subtitle: string
      amountCents: number | null
      status: string
      at: string
    }>
    topFunders: Array<{ name: string; fundedCents: number; dealCount: number }>
    merchantGrowth: Array<{ month: string; new: number; renewals: number; churn: number }>
    industries: Array<{ label: string; count: number; fundedCents: number | null }>
    states: Array<{ label: string; count: number; fundedCents: number | null }>
  }
}
