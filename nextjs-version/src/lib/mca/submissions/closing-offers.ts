import "server-only"

import type { DealActor } from "../deals/schema"
import { createOffer, reviseOffer } from "../offers/service"
import { PAYMENT_FREQUENCIES, type OfferRecord, type OfferTermsInput, type PaymentFrequency } from "../offers/contracts"
import type { SubmissionJob } from "./contracts"

export function emailExtractExternalId(replyId: string): string {
  return `email-extract:${replyId}`
}

export function dollarsToCents(amount: number): number | undefined {
  if (!Number.isFinite(amount) || amount <= 0) return undefined
  const cents = Math.round(amount * 100)
  return Number.isSafeInteger(cents) && cents > 0 ? cents : undefined
}

function asPaymentFrequency(value: string | null | undefined): PaymentFrequency | undefined {
  if (!value) return undefined
  const normalized = value.trim().toLowerCase()
  return PAYMENT_FREQUENCIES.includes(normalized as PaymentFrequency) ? normalized as PaymentFrequency : undefined
}

function termsFromExtract(input: {
  amountDollars: number
  factorRate?: number | null
  termMonths?: number | null
  paymentFrequency?: string | null
}): OfferTermsInput | undefined {
  const amountCents = dollarsToCents(input.amountDollars)
  if (amountCents == null) return undefined
  const terms: OfferTermsInput = { amountCents }
  if (typeof input.factorRate === "number" && Number.isFinite(input.factorRate) && input.factorRate > 0) {
    terms.factorRate = input.factorRate
  }
  if (typeof input.termMonths === "number" && Number.isInteger(input.termMonths) && input.termMonths > 0) {
    terms.termMonths = input.termMonths
  }
  const frequency = asPaymentFrequency(input.paymentFrequency)
  if (frequency) terms.paymentFrequency = frequency
  return terms
}

function currentTerms(offer: OfferRecord): OfferTermsInput {
  const revision = offer.revisions.find((item) => item.id === offer.currentRevisionId) ?? offer.revisions[offer.revisions.length - 1]
  return {
    amountCents: revision?.amountCents,
    factorRate: revision?.factorRate,
    termMonths: revision?.termMonths,
    paymentFrequency: revision?.paymentFrequency,
  }
}

function sameTerms(left: OfferTermsInput, right: OfferTermsInput): boolean {
  return left.amountCents === right.amountCents
    && left.factorRate === right.factorRate
    && left.termMonths === right.termMonths
    && left.paymentFrequency === right.paymentFrequency
}

export async function upsertClosingOfferFromExtract(input: {
  actor: DealActor
  replyId: string
  job: SubmissionJob
  amountDollars: number
  factorRate?: number | null
  termMonths?: number | null
  paymentFrequency?: string | null
}): Promise<OfferRecord | undefined> {
  const terms = termsFromExtract(input)
  if (!terms) return undefined
  const externalId = emailExtractExternalId(input.replyId)
  const created = await createOffer(input.actor, {
    dealId: input.job.dealId,
    submissionId: input.job.id,
    funderId: input.job.funderId,
    funderName: input.job.displayFunderName,
    source: "email",
    externalId,
    terms,
  })
  if (sameTerms(currentTerms(created), terms)) return created
  const current = created.revisions.find((item) => item.id === created.currentRevisionId) ?? created.revisions[created.revisions.length - 1]
  if (!current) return created
  return reviseOffer(input.actor, created.id, { expectedRevisionNumber: current.revisionNumber, terms })
}
