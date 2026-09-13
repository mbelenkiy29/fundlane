import type { DealWriteInput } from "../deals/schema"

export type MerchantMatchKind = "ein" | "identity_last4"

export interface MerchantMatch {
  merchantId: string
  legalName: string
  dbaName?: string
  match: MerchantMatchKind
  dealCount: number
  latestDealId?: string
  contactName?: string
  contactEmail?: string
}

export interface MerchantLookupQuery {
  ein?: string
  owners?: Array<{ identityLast4?: string }>
}

export interface MerchantLookupResult {
  normalizedEin?: string
  matches: MerchantMatch[]
}

export interface MerchantAttachPayload {
  merchantId: string
  fields: DealWriteInput
  documentSummaries: Array<{ id: string; category: string; filename: string; dealId: string }>
}

export interface MerchantBackfillResult {
  dealCount: number
  merchantCount: number
}
