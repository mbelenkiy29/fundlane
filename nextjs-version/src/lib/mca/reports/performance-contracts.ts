import type { ReportFilters, ReportPermissionState } from "./contracts"
import type { FunnelDealRow, FunnelPeriod, FunnelStage, SHARED_REP_ATTRIBUTION } from "./rep-funnel"

export interface PerformanceMoneyRecord {
  recordId: string
  dealId: string
  occurredOn: string | null
  amountCents: number | null
}
export type PerformanceMoney = { visible: false } | {
  visible: true
  knownCents: number
  unknownCount: number
  count: number
  records: PerformanceMoneyRecord[]
}
export interface PerformanceReport {
  filters: ReportFilters
  generatedAt: string
  timezone: string
  period: FunnelPeriod
  permission: ReportPermissionState
  attribution: typeof SHARED_REP_ATTRIBUTION
  definitions: Record<string, string>
  stages: Record<FunnelStage, { dealCount: number; deals: FunnelDealRow[] }>
  conversions: Array<{ from: FunnelStage; to: FunnelStage; numerator: number; denominator: number; rate: number | null }>
  pipeline: { basis: "created_cohort_current_status"; counts: Record<string, number>; deals: Array<{ dealId: string; status: string }> }
  renewals: { eligibleAdvanceCount: number; convertedAdvanceCount: number; records: Array<{ sourceAdvanceId: string; dealId: string; renewedDealId: string | null; state: string; eligibleOn: string }> }
  finance: Record<"fundedVolume" | "reversedFunding" | "estimatedCommission" | "recordedFundingCommission" | "collectedCommission" | "paidBrokerCommission", PerformanceMoney>
}
