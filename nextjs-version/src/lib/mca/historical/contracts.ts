import type { FundingSplitInput } from "../funding/contracts"
import type { PaymentFrequency } from "../offers/contracts"

export interface HistoricalFundingRowInput {
  externalId: string
  dealId?: string
  legalName?: string
  funderId?: string
  funderName: string
  fundedAt: string
  amountCents: number
  factorRate?: number
  termMonths?: number
  paymentAmountCents?: number
  paymentCount?: number
  paymentFrequency?: Exclude<PaymentFrequency, "irregular">
  calendarConvention?: "calendar_days" | "business_days" | "fixed_count"
  commissionCents?: number
  paidCommissionCents?: number
  paidCommissionAt?: string
  feeCents?: number
  expectedCommissionAt?: string
  expectedFeeAt?: string
  splits?: FundingSplitInput[]
  paidSplits?: Array<{ recipientMembershipId: string; amountCents: number; paidAt: string }>
}

export interface HistoricalRowPreview extends HistoricalFundingRowInput {
  rowNumber: number
  duplicate: boolean
  errors: string[]
}

export interface HistoricalImportPreview {
  runId: string
  state: "preview" | "committed" | "failed"
  previewRevision: number
  rows: HistoricalRowPreview[]
  totals: { rows: number; valid: number; invalid: number; duplicates: number; principalCents: number; expectedCommissionCents: number; paidCommissionCents: number; feeCents: number }
}

export interface HistoricalImportResult {
  runId: string
  state: "committed" | "failed"
  created: number
  duplicates: number
  invalid: number
  failed: number
  principalCents: number
  expectedCommissionCents: number
  paidCommissionCents: number
  fundingEventIds: string[]
}
