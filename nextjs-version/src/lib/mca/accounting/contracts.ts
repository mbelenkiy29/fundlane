import type { BasisPointAllocation } from "./money"

export type AdvancePerformanceStatus = "on_track" | "missed_payment" | "default" | "renewed" | "closed"
export type AccountingPaymentType = "commission" | "fee"
export type AccountingPaymentStatus = "expected" | "partial" | "received" | "void"

export interface AdvanceSummary {
  id: string
  dealId: string
  offerId: string
  businessName: string
  funderName: string
  assignedTeam: string[]
  fundedAt: string
  principalCents: number
  paybackCents: number | null
  periodicPaymentCents: number | null
  paymentCount: number | null
  paymentFrequency: string | null
  calendarConvention: string | null
  termMonths: number | null
  status: string
  performanceStatus: AdvancePerformanceStatus
  scheduledPaidInBasisPoints: number | null
  scheduledPaidInCents: number | null
  estimateAsOf: string
  estimateLabel: "scheduled_estimate" | "unknown"
  statusHistory: Array<{ id: string; status: AdvancePerformanceStatus; reason: string | null; effectiveAt: string }>
}

export interface AccountingPayment {
  id: string
  advanceId: string
  type: AccountingPaymentType
  origin: "automatic" | "manual" | "historical"
  originatorMembershipId: string | null
  expectedAmountCents: number
  receivedAmountCents: number
  expectedAt: string | null
  receivedAt: string | null
  status: AccountingPaymentStatus
  createdAt: string
  updatedAt: string
}

export interface AccountingTotals {
  expectedCents: number
  collectedCents: number
  outstandingCents: number
}

export interface SplitTemplateVersion {
  templateId: string
  name: string
  version: number
  allocations: BasisPointAllocation[]
  createdAt: string
}

export interface PaymentDistribution {
  id: string
  paymentId: string
  recipientMembershipId: string
  recipientName: string
  templateId: string | null
  templateVersion: number | null
  percentageBasisPoints: number
  amountCents: number
  status: "expected" | "paid" | "void"
  expectedAt: string | null
  paidAt: string | null
  snapshot: unknown
}

export interface RenewalAction {
  id: string
  sourceAdvanceId: string
  renewedDealId: string | null
  policyVersion: number
  eligibleAt: string
  state: "eligible" | "contacted" | "documents_requested" | "converted" | "dismissed"
  messageSubject: string
  messageBody: string
  documentationRequestedAt: string | null
  createdAt: string
  updatedAt: string
}

/** MIC-111 frozen ports. Schedules are expected accounting rows, not bank transfers. */
export type DistributionScheduleStatus = "active" | "paused" | "cancelled"
export type ScheduledInstallmentStatus = "expected" | "paid" | "void"

export interface ReverseConsolidation {
  id: string
  dealId: string
  referencedAdvanceIds: string[]
  scheduleId: string
  createdAt: string
}

export interface DistributionSchedule {
  id: string
  workspaceId: string
  reverseConsolidationId: string
  dealId: string
  status: DistributionScheduleStatus
  version: number
  startDate: string
  installmentCount: number
  installmentCents: number
  splitTemplateId: string
  splitTemplateVersion: number
  createdAt: string
  updatedAt: string
}

export interface ScheduledInstallment {
  id: string
  scheduleId: string
  scheduleVersion: number
  occurrenceDate: string
  recipientMembershipId: string
  recipientName: string
  amountCents: number
  percentageBasisPoints: number
  status: ScheduledInstallmentStatus
  paidAt: string | null
  snapshot: unknown
}

export interface ReverseConsolidationWorkspace {
  consolidations: ReverseConsolidation[]
  schedules: DistributionSchedule[]
  installments: ScheduledInstallment[]
}
