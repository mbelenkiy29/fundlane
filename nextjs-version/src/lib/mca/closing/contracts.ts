export type ClosingChannel = "email" | "sms" | "webhook" | "phone"
export type DeliveryState = "pending" | "sent" | "preview" | "failed" | "blocked"
export type StipulationState = "open" | "received" | "verified" | "waived"

export interface OfferRevisionBinding {
  offerId: string; revisionId: string; revisionNumber: number; state: string; selected: boolean
  funderId?: string; funderName: string; amountCents: number; factorRate?: number; termMonths?: number
  paymentAmountCents?: number; paymentFrequency?: string; commissionCents?: number
}

export interface StipulationTask {
  id: string; dealId: string; offerId?: string; offerRevisionId?: string; funderId?: string
  documentCategory: string; label: string; ownerMembershipId?: string; dueDate?: string
  status: StipulationState; linkedDocumentId?: string; exceptionReason?: string
  createdAt: string; receivedAt?: string; verifiedAt?: string; updatedAt: string
}

export interface MerchantUploadLink {
  id: string; stipulationId?: string; destinationCategory: string; expiresAt: string
  maxUploads: number; usedCount: number; url?: string
}

export interface ClosingDelivery {
  id: string; kind: string; recordId: string; channel: ClosingChannel; state: DeliveryState
  payloadHash: string; correlationId: string; externalId?: string; errorCode?: string; errorMessage?: string
  createdAt: string; updatedAt: string
}

export interface ClosingRequestPreview {
  id: string; dealId: string; kind: "stipulation_request" | "contract_request" | "repricing_request"
  recordId: string; channel: "email" | "sms"; senderId?: string; recipientMasked: string
  subject?: string; body: string; contentHash: string; state: "preview" | "sent" | "failed"
  createdAt: string; updatedAt: string
}

export interface ContractWorkflow {
  id: string; dealId: string; offer: OfferRevisionBinding; state: "accepted" | "contract_requested" | "contract_sent" | "repricing_requested" | "signed" | "final_review"
  recipientMasked?: string; attachedDocumentIds: string[]; outstandingStips: string[]
  acceptedAt?: string; contractRequestedAt?: string; contractSentAt?: string; signedAt?: string; finalReviewAt?: string; repricingRequestedAt?: string
  signature?: { source: "external" | "manual"; externalId?: string; evidenceDocumentId?: string; manualReason?: string }
  updatedAt: string
}

export interface PsfRequestSummary {
  id: string; dealId: string; offer: OfferRevisionBinding; amountCents: number; bankNameMasked: string
  accountLast4: string; state: "pending" | "delivered" | "failed" | "signed"; payloadVersion: number
  payloadHash: string; correlationId: string; externalRequestId?: string; lastErrorCode?: string; lastErrorMessage?: string
  deliveredAt?: string; signedAt?: string; createdAt: string; updatedAt: string
}

export interface OfferMessagePreview {
  id: string; dealId: string; offer: OfferRevisionBinding; selectionMode: "selected" | "all" | "highest"
  channel: "email" | "sms"; senderId?: string; recipientMasked: string; subject?: string; body: string
  contentHash: string; state: "preview" | "sent" | "failed"; createdAt: string; updatedAt: string
}

export interface ClosingSnapshot {
  dealId: string; stipulations: StipulationTask[]; contracts: ContractWorkflow[]
  psfRequests: PsfRequestSummary[]; messagePreviews: OfferMessagePreview[]
  deliveries: ClosingDelivery[]; pitchedRevisionIds: string[]
  capabilities: { psfVisible: boolean; psfAdmin: boolean }
  psfDeliveryReady: boolean
  merchantContact: { email?: string; phone?: string }
  assignableOwners: Array<{ id: string; name: string }>
  merchantSmsAccounts: Array<{ id: string; label: string; senderMasked: string; providerConfigured: boolean; isDefault: boolean }>
  productionGates: { merchantEmail: string; merchantSms: string; contractDelivery: string; psfDelivery: string }
}
