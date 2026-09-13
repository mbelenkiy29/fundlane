import type { AdvancePerformanceStatus } from "../accounting/contracts"
import type { BookWindow, ServicingStatus } from "./book-math"

export type { BookWindow, ServicingStatus }

export interface BookFilters {
  search?: string
  statuses?: ServicingStatus[]
  funder?: string
  assignee?: string
  frequency?: string
  renewalEligible?: boolean
  paidDownMin?: number
  paidDownMax?: number
  missedWindow?: BookWindow
  completedWindow?: BookWindow
  asOf?: string
}

export interface BookInstallment {
  id: string
  sequence: number
  occurrenceDate: string
  amountCents: number
  received: boolean
}

export interface BookReceipt {
  id: string
  amountCents: number
  receivedAt: string
  origin: "manual" | "csv" | "system"
  status: "received" | "void"
}

export interface BookRow {
  id: string
  dealId: string
  displayId: string
  legalName: string
  dbaName?: string
  funderName: string
  contactPhone?: string
  assignedRep?: string
  assignedTeam: string[]
  advanceNumber: number
  fundedAt: string
  principalCents: number
  paybackCents: number | null
  factorRate?: number
  termMonths: number | null
  paymentCount: number | null
  paymentFrequency: string | null
  periodicPaymentCents: number | null
  balanceRemainingCents: number | null
  paidDownBasisPoints: number | null
  paidDownEstimated: boolean
  servicingStatus: ServicingStatus
  performanceStatus: AdvancePerformanceStatus
  nextPaymentDate: string | null
  commissionEarnedCents?: number
  renewalEligible: boolean
  missedCount: number
  completedCount: number
}

export interface BookDashboard {
  missed: { window: BookWindow; count: number; amountCents: number }
  completed: { window: BookWindow; count: number; amountCents: number }
  renewals: { count: number }
  unreadAlerts: number
}

export interface BookListResponse {
  rows: BookRow[]
  total: number
  dashboard: BookDashboard
  filters: BookFilters
  timezone: string
}

export interface BookDetail extends BookRow {
  installments: BookInstallment[]
  receipts: BookReceipt[]
}
