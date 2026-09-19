export const OFFER_SOURCES = ["api", "email", "link", "manual", "historical"] as const
export type OfferSource = (typeof OFFER_SOURCES)[number]
export const OFFER_REVISION_STATES = ["active", "withdrawn", "superseded", "funded"] as const
export type OfferRevisionState = (typeof OFFER_REVISION_STATES)[number]
export const PAYMENT_FREQUENCIES = ["daily", "weekly", "biweekly", "monthly", "irregular"] as const
export type PaymentFrequency = (typeof PAYMENT_FREQUENCIES)[number]

export const OFFER_REVISION_TTL_DAYS = 14
export type OfferRevisionValidity = "not_yet_effective" | "active" | "expired"

export interface OfferTermsInput {
  product?: string
  amountCents?: number
  factorRate?: number
  buyRate?: number
  termMonths?: number
  paymentAmountCents?: number
  paymentFrequency?: PaymentFrequency
  feeCents?: number
  commissionCents?: number
  stipulations?: string[]
  effectiveAt?: string
}

export interface OfferRevision extends OfferTermsInput {
  id: string
  revisionNumber: number
  state: OfferRevisionState
  incompleteFields: string[]
  createdAt: string
  createdByUserId: string | null
  expiresAt: string
}

export function defaultOfferRevisionExpiresAt(createdAt: string): string {
  return new Date(Date.parse(createdAt) + OFFER_REVISION_TTL_DAYS * 24 * 60 * 60 * 1000).toISOString()
}

export function offerRevisionValidity(
  revision: { effectiveAt?: string; expiresAt: string },
  nowIso: string,
): OfferRevisionValidity {
  if (revision.expiresAt <= nowIso) return "expired"
  if (revision.effectiveAt && revision.effectiveAt > nowIso) return "not_yet_effective"
  return "active"
}

export function isSplitFundProduct(product?: string | null): boolean {
  return typeof product === "string" && /^split[\s_-]*fund$/i.test(product.trim())
}

export interface OfferRecord {
  id: string
  workspaceId: string
  dealId: string
  submissionId?: string
  funderId?: string
  funderName: string
  source: OfferSource
  externalId?: string
  currentRevisionId: string
  revisions: OfferRevision[]
  selectedRevisionIds: string[]
  createdAt: string
  updatedAt: string
}

export interface OfferRevisionForClosing {
  offerId: string
  revisionId: string
  revisionNumber: number
  state: OfferRevisionState
  selected: boolean
  funderId?: string
  funderName: string
  amountCents: number
  factorRate?: number
  termMonths?: number
  paymentAmountCents?: number
  paymentFrequency?: PaymentFrequency
  commissionCents?: number
  effectiveAt: string
  expiresAt: string
}

