import "server-only"

import { AppError } from "../errors"
import { recordAuditEvent } from "../db"
import type { DealActor, DealRecord } from "../deals/schema"
import { getFunder } from "../funders/directory"
import { normalizeSmsRecipient } from "../sms/service"

const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const OVERRIDE_REASON_MIN = 8
const OVERRIDE_REASON_MAX = 500

export type BoundRecipientSource = "deal_contact" | "funder_route" | "admin_override"

export type BoundRecipient = {
  address: string
  masked: string
  overridden: boolean
  channel: "email" | "sms"
  source: BoundRecipientSource
  overrideReason?: string
}

export type RecipientBindInput = {
  recipient?: string | null
  overrideReason?: string | null
  dealId?: string
  resourceId?: string
  kind?: string
}

function normalizeEmail(value: string): string {
  return value.trim().toLowerCase()
}

export function maskClosingEmail(value: string): string {
  const [local, domain] = value.split("@")
  return domain ? `${local.slice(0, 1)}•••@${domain}` : "••••"
}

export function maskClosingSms(value: string): string {
  return `•••${value.replace(/\D/g, "").slice(-4)}`
}

function canOverrideRecipient(actor: DealActor): boolean {
  return actor.source === "user" && (actor.role === "admin" || actor.role === "super_admin")
}

function assertOverrideAllowed(actor: DealActor, overrideReason: string | null | undefined): string {
  if (!canOverrideRecipient(actor)) {
    throw new AppError(403, "recipient_override_denied", "Only a workspace administrator session can send to a different recipient.")
  }
  const reason = overrideReason?.trim() ?? ""
  if (reason.length < OVERRIDE_REASON_MIN || reason.length > OVERRIDE_REASON_MAX) {
    throw new AppError(422, "recipient_override_required", `Provide an override reason between ${OVERRIDE_REASON_MIN} and ${OVERRIDE_REASON_MAX} characters to use a different recipient.`)
  }
  return reason
}

function resolveMerchantDefault(deal: Pick<DealRecord, "contactEmail" | "contactPhone">, channel: "email" | "sms"): string {
  if (channel === "email") {
    const value = deal.contactEmail?.trim()
    if (!value) throw new AppError(422, "merchant_contact_missing", "This deal does not have a merchant contact email.")
    return normalizeEmail(value)
  }
  const value = deal.contactPhone?.trim()
  if (!value) throw new AppError(422, "merchant_contact_missing", "This deal does not have a merchant contact phone.")
  return normalizeSmsRecipient(value)
}

function bindAgainstDefault(
  actor: DealActor,
  input: RecipientBindInput,
  channel: "email" | "sms",
  defaultAddress: string,
  sourceWhenDefault: BoundRecipientSource,
): BoundRecipient {
  const provided = input.recipient?.trim()
  if (!provided) {
    return {
      address: defaultAddress,
      masked: channel === "email" ? maskClosingEmail(defaultAddress) : maskClosingSms(defaultAddress),
      overridden: false,
      channel,
      source: sourceWhenDefault,
    }
  }

  let candidate = provided
  if (channel === "email") {
    candidate = normalizeEmail(provided)
    if (!emailPattern.test(candidate)) throw new AppError(422, "recipient_invalid", "Enter a valid recipient email address.")
  } else {
    candidate = normalizeSmsRecipient(provided)
  }

  if (candidate === defaultAddress) {
    return {
      address: defaultAddress,
      masked: channel === "email" ? maskClosingEmail(defaultAddress) : maskClosingSms(defaultAddress),
      overridden: false,
      channel,
      source: sourceWhenDefault,
    }
  }

  const reason = assertOverrideAllowed(actor, input.overrideReason)
  return {
    address: candidate,
    masked: channel === "email" ? maskClosingEmail(candidate) : maskClosingSms(candidate),
    overridden: true,
    channel,
    source: "admin_override",
    overrideReason: reason,
  }
}

export function bindMerchantEmail(
  deal: Pick<DealRecord, "id" | "contactEmail" | "contactPhone">,
  input: RecipientBindInput,
  actor: DealActor,
): BoundRecipient {
  const defaultAddress = resolveMerchantDefault(deal, "email")
  return bindAgainstDefault(actor, { ...input, dealId: input.dealId ?? deal.id }, "email", defaultAddress, "deal_contact")
}

export function bindMerchantSms(
  deal: Pick<DealRecord, "id" | "contactEmail" | "contactPhone">,
  input: RecipientBindInput,
  actor: DealActor,
): BoundRecipient {
  const defaultAddress = resolveMerchantDefault(deal, "sms")
  return bindAgainstDefault(actor, { ...input, dealId: input.dealId ?? deal.id }, "sms", defaultAddress, "deal_contact")
}

function activeEmailRouteDestination(routes: Array<{ kind: string; active: boolean; destination: string }>): string | undefined {
  const route = routes.find((item) => item.active && item.kind === "email")
  if (!route) return undefined
  const first = route.destination.split(/[;,]/).map((part) => normalizeEmail(part)).find((part) => emailPattern.test(part))
  return first
}

export async function bindFunderEmail(
  input: RecipientBindInput & { funderId?: string | null },
  actor: DealActor,
): Promise<BoundRecipient> {
  if (!input.funderId?.trim()) {
    throw new AppError(422, "funder_email_route_missing", "Link a funder with an active email route before preparing this contract request.")
  }
  const funder = await getFunder(actor, input.funderId.trim())
  const defaultAddress = activeEmailRouteDestination(funder.routes)
  if (!defaultAddress) {
    throw new AppError(422, "funder_email_route_missing", "This funder does not have an active email submission route.")
  }
  return bindAgainstDefault(actor, input, "email", defaultAddress, "funder_route")
}

export async function recordRecipientOverrideAudit(
  actor: DealActor,
  bound: BoundRecipient,
  meta: { dealId: string; resourceId?: string; kind: string },
): Promise<void> {
  if (!bound.overridden || !bound.overrideReason) return
  await recordAuditEvent({
    context: actor,
    action: "closing.recipient_overridden",
    resourceType: "deal",
    resourceId: meta.dealId,
    metadata: {
      kind: meta.kind,
      channel: bound.channel,
      source: bound.source,
      recipientMasked: bound.masked,
      reason: bound.overrideReason,
      ...(meta.resourceId ? { resourceId: meta.resourceId } : {}),
    },
    correlationId: actor.correlationId,
  })
}
