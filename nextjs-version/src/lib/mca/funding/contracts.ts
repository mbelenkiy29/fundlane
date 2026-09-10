import type { DbExecutor } from "../db"

export interface FundingSplitInput {
  recipientMembershipId: string
  percentageBasisPoints: number
}

export interface FundingAccountingInput {
  workspaceId: string
  fundingEventId: string
  advanceId: string
  dealId: string
  offerId: string
  offerRevisionId: string
  fundedAt: string
  amountCents: number
  commissionCents: number
  feeCents: number
  expectedCommissionAt?: string
  expectedFeeAt?: string
  splits: FundingSplitInput[]
  source: "live" | "manual" | "historical"
  idempotencyKey: string
}

export type FundingAccountingWriter = (
  database: DbExecutor,
  input: FundingAccountingInput,
) => Promise<{ recordIds: string[] }>

export interface ConfirmFundingInput {
  dealId: string
  offerId: string
  offerRevisionId: string
  idempotencyKey: string
  fundedAt: string
  amountCents?: number
  commissionCents?: number
  feeCents?: number
  expectedCommissionAt?: string
  expectedFeeAt?: string
  paymentCount?: number
  paymentFrequency?: "daily" | "weekly" | "biweekly" | "monthly"
  calendarConvention?: "calendar_days" | "business_days" | "fixed_count"
  splits?: FundingSplitInput[]
  source?: "live" | "manual" | "historical"
  manualSubmissionId?: string
  correctionOfEventId?: string
}

export interface FundingResult {
  fundingEventId: string
  advanceId: string
  dealId: string
  offerId: string
  offerRevisionId: string
  fundedAt: string
  source: "live" | "manual" | "historical"
  accountingRecordIds: string[]
  state: "committed" | "reversed" | "corrected"
  replayed: boolean
}
