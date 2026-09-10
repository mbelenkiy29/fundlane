export const REPORT_BASES = ["event", "cohort"] as const
export type ReportBasis = (typeof REPORT_BASES)[number]

export interface ReportFilters {
  from?: string
  to?: string
  membershipIds?: string[]
  funderIds?: string[]
  sourceIds?: string[]
  batchIds?: string[]
  basis: ReportBasis
}

export interface ReportPermissionState {
  allowed: boolean
  paymentsVisible: boolean
  companyTotalsVisible: boolean
  reason?: "reports_disabled" | "payment_permission_required" | "company_totals_restricted"
}
