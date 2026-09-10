import "server-only"

import { createHash, createHmac } from "node:crypto"
import { assertTrustedMutation, requireWorkspaceAccess } from "../auth"
import { getDatabase, newId, nowIso, recordAuditEvent, withImmediateTransaction } from "../db"
import type { DealActor, DealOwner, DealRecord } from "../deals/schema"
import { actorForDeals, getDealForDocument } from "../deals/service"
import { listDocuments } from "../documents/service"
import type { DocumentCategory, DocumentSummary } from "../documents/contracts"
import { AppError } from "../errors"
import { requestCorrelationId } from "../http"
import { listMemberships } from "../memberships"
import type { MembershipSummary } from "../types"
import { listOfferRevisionsForClosing } from "../offers/service"
import type { OfferRevisionForClosing } from "../offers/contracts"
import { canManageWorkspace } from "../policy"
import { MESSAGE_CHANNELS, type MessageChannel } from "./contracts"

export const MESSAGE_TEMPLATE_SCOPES = ["merchant", "followup", "digest", "request_info"] as const
export type MessageTemplateScope = (typeof MESSAGE_TEMPLATE_SCOPES)[number]

export const MESSAGE_TEMPLATE_CHANNELS = MESSAGE_CHANNELS
export type MessageTemplateChannel = MessageChannel

export const TEMPLATE_UPLOAD_TARGETS = ["auto", "statements", "dlvc", "closingDocs", "moreStips"] as const
export type TemplateUploadTarget = (typeof TEMPLATE_UPLOAD_TARGETS)[number]

const NAME_MAX = 120
const SUBJECT_MAX = 500
const BODY_MAX = 20_000
const ID_MAX = 80

const MERCHANT_SCOPES = new Set<MessageTemplateScope>(["merchant", "followup", "request_info"])

const DOUBLE_TOKEN = /\{\{\s*([^}]+?)\s*\}\}/g
const SINGLE_TOKEN = /\{([a-zA-Z][a-zA-Z0-9_]*)\}/g
const IDENTIFIER = /^[a-zA-Z][a-zA-Z0-9_]*$/

const DOCUMENT_BUCKETS: Array<{ categories: DocumentCategory[]; label: string }> = [
  { categories: ["application", "api_application"], label: "Funding Application" },
  { categories: ["statement"], label: "Bank Statement" },
  { categories: ["driver_license"], label: "Driver's License" },
  { categories: ["voided_check"], label: "Voided Check" },
]

export const FORBIDDEN_TEMPLATE_VARIABLES = [
  "commission",
  "commissions",
  "commission_cents",
  "commissioncents",
  "buy_rate",
  "buyrate",
  "buy_rate_cents",
  "fee",
  "fees",
  "fee_cents",
  "feecents",
  "profit",
  "company_profit",
  "distribution",
  "distributions",
  "payout",
  "payouts",
  "collected_commission",
] as const

const FORBIDDEN_LOOKUP = new Set<string>(FORBIDDEN_TEMPLATE_VARIABLES)

export const DEFAULT_EMAIL_SUBJECT = "{{business_name}} funding update"
export const DEFAULT_EMAIL_BODY = `Hi {{owner_first_name}},

Here are the current funding options for {{business_name}}:

{{selected_offers_all_details}}

If any documents are still missing ({{docs_check_summary}}), upload them here:
{{auto_upload_url}}

Thank you,
{{originator_first_name}}`
export const DEFAULT_SMS_BODY = `Hi {{owner_first_name}}, {{business_name}} highest offer: {{highest_offer_funding_amount}}. {{highest_offer_all_details}} Docs: {{auto_upload_url}}`

export type TemplateVariableGroup = "deal" | "business" | "owner" | "rep" | "offers" | "documents" | "uploads"

export interface TemplateVariableDefinition {
  name: string
  group: TemplateVariableGroup
  label: string
  description: string
  example: string
  aliasOf?: string
}

export interface TemplateVariableValidation {
  names: string[]
  unknown: string[]
  forbidden: string[]
  schemaHash: string
  publishable: boolean
}

export interface RenderedMessageTemplate {
  channel: MessageTemplateChannel
  scope: MessageTemplateScope
  dealId?: string
  synthetic: boolean
  subject?: string
  html?: string
  text: string
  variables: Array<{ name: string; value: string; missing: boolean }>
  unknownVariables: string[]
  forbiddenVariables: string[]
  publishBlocked: boolean
  origin: string
}

export interface MessageTemplateVersionView {
  id: string
  templateId: string
  version: number
  subject: string | null
  body: string
  variableSchemaHash: string
  published: boolean
  createdByUserId: string | null
  createdAt: string
}

export interface MessageTemplateView {
  id: string
  workspaceId: string
  name: string
  channel: MessageTemplateChannel
  scope: MessageTemplateScope
  publishedVersionId: string | null
  createdByUserId: string | null
  createdAt: string
  updatedAt: string
  draft: MessageTemplateVersionView | null
  published: MessageTemplateVersionView | null
  canManage: boolean
  canPublish: boolean
}

export interface MessageTemplateListItem {
  id: string
  name: string
  channel: MessageTemplateChannel
  scope: MessageTemplateScope
  published: boolean
  publishedVersionId: string | null
  updatedAt: string
}

export interface MessageTemplateListResult {
  templates: MessageTemplateListItem[]
  variables: TemplateVariableDefinition[]
  canManage: boolean
  canPublish: boolean
}

type TemplateRow = {
  id: string
  workspace_id: string
  name: string
  channel: string
  scope: string
  published_version_id: string | null
  created_by_user_id: string | null
  created_at: string
  updated_at: string
}

type VersionRow = {
  id: string
  workspace_id: string
  template_id: string
  version: number
  subject: string | null
  body: string
  variable_schema_hash: string
  published: number | string
  created_by_user_id: string | null
  created_at: string
}

export const TEMPLATE_VARIABLE_REGISTRY: readonly TemplateVariableDefinition[] = [
  { name: "deal_id", group: "deal", label: "Deal ID", description: "Workspace display identifier for this deal.", example: "12847" },
  { name: "deal_uuid", group: "deal", label: "Deal UUID", description: "Stable record id for this deal.", example: "rec19g6wlw9hzlxw" },
  { name: "deal_url", group: "deal", label: "Deal URL", description: "In-app URL for this deal.", example: "https://app.example.test/deals/rec19g6wlw9hzlxw" },
  { name: "business_name", group: "business", label: "Business name", description: "Legal or DBA name of the merchant.", example: "Atlas Corporation" },
  { name: "business_email", group: "business", label: "Business email", description: "Primary merchant email.", example: "ops@atlas.example.test" },
  { name: "business_phone", group: "business", label: "Business phone", description: "Primary merchant phone.", example: "(555) 123-4567" },
  { name: "owner_first_name", group: "owner", label: "Owner first name", description: "First name of the primary owner.", example: "John" },
  { name: "owner_last_name", group: "owner", label: "Owner last name", description: "Last name of the primary owner.", example: "Galt" },
  { name: "owner_email", group: "owner", label: "Owner email", description: "Email of the primary owner.", example: "john@atlas.example.test" },
  { name: "owner_phone", group: "owner", label: "Owner phone", description: "Phone of the primary owner.", example: "(555) 987-6543" },
  { name: "originator_first_name", group: "rep", label: "Originator first name", description: "First name of the primary originator.", example: "Hank" },
  { name: "originator_last_name", group: "rep", label: "Originator last name", description: "Last name of the primary originator.", example: "Rearden" },
  { name: "originator_email", group: "rep", label: "Originator email", description: "Email of the primary originator.", example: "hank@broker.example.test" },
  { name: "originator_phone", group: "rep", label: "Originator phone", description: "Phone of the primary originator.", example: "(917) 283-2821" },
  { name: "rep_first_name", group: "rep", label: "Rep first name", description: "Alias of originator first name.", example: "Hank", aliasOf: "originator_first_name" },
  { name: "rep_last_name", group: "rep", label: "Rep last name", description: "Alias of originator last name.", example: "Rearden", aliasOf: "originator_last_name" },
  { name: "rep_email", group: "rep", label: "Rep email", description: "Alias of originator email.", example: "hank@broker.example.test", aliasOf: "originator_email" },
  { name: "rep_phone", group: "rep", label: "Rep phone", description: "Alias of originator phone.", example: "(917) 283-2821", aliasOf: "originator_phone" },
  { name: "closer_first_name", group: "rep", label: "Closer first name", description: "First name of the primary closer.", example: "Hank" },
  { name: "closer_last_name", group: "rep", label: "Closer last name", description: "Last name of the primary closer.", example: "Rearden" },
  { name: "closer_email", group: "rep", label: "Closer email", description: "Email of the primary closer.", example: "hank@broker.example.test" },
  { name: "closer_phone", group: "rep", label: "Closer phone", description: "Phone of the primary closer.", example: "(917) 283-2821" },
  { name: "all_offers_all_details", group: "offers", label: "All offers", description: "Formatted list of every current offer. Omits commissions.", example: "Offer 1:\n- Funding Amount: $50,000" },
  { name: "selected_offers_all_details", group: "offers", label: "Selected offers", description: "Formatted list of selected offers. Omits commissions.", example: "Offer 1:\n- Funding Amount: $75,000" },
  { name: "highest_offer_all_details", group: "offers", label: "Highest offer", description: "Formatted details of the highest funding amount. Omits commissions.", example: "Offer 1:\n- Funding Amount: $100,000" },
  { name: "highest_offer_funding_amount", group: "offers", label: "Highest offer amount", description: "Dollar amount of the highest offer, no decimals.", example: "$100,000" },
  { name: "docs_check_summary", group: "documents", label: "Document check", description: "Summary of missing required documents.", example: "Missing 2 of 4 required documents" },
  { name: "missing_docs", group: "documents", label: "Missing documents", description: "List of missing document items.", example: "- Funding Application\n- Bank Statement" },
  { name: "auto_upload_url", group: "uploads", label: "Auto upload URL", description: "Scoped merchant upload link that auto-categorizes files.", example: "https://app.example.test/merchant-upload/…" },
  { name: "statements_upload_url", group: "uploads", label: "Statements upload URL", description: "Scoped upload link for bank statements.", example: "https://app.example.test/merchant-upload/…" },
  { name: "dlvc_upload_url", group: "uploads", label: "DL/VC upload URL", description: "Scoped upload link for driver's license and voided check.", example: "https://app.example.test/merchant-upload/…" },
  { name: "closing_docs_upload_url", group: "uploads", label: "Closing docs upload URL", description: "Scoped upload link for closing documents.", example: "https://app.example.test/merchant-upload/…" },
  { name: "other_docs_upload_url", group: "uploads", label: "Other docs upload URL", description: "Scoped upload link for other documents.", example: "https://app.example.test/merchant-upload/…" },
  { name: "missing_docs_upload_url", group: "uploads", label: "Missing docs upload URL", description: "Legacy alias of other_docs_upload_url.", example: "https://app.example.test/merchant-upload/…", aliasOf: "other_docs_upload_url" },
]

const REGISTRY_BY_NAME = new Map(TEMPLATE_VARIABLE_REGISTRY.map((item) => [item.name, item]))

export const SYNTHETIC_TEMPLATE_DEAL_ID = "rec19g6wlw9hzlxw"

type TemplateValueBag = Record<string, string>

function db() {
  return getDatabase()
}

function denied(message = "You do not have permission to perform this action."): never {
  throw new AppError(403, "permission_denied", message)
}

function invalid(field: string, message: string, extra?: Record<string, string[]>): never {
  throw new AppError(422, "validation_failed", "Review the highlighted fields.", { [field]: [message], ...extra })
}

function isAdmin(actor: DealActor): boolean {
  return Boolean(actor.role && canManageWorkspace(actor.role))
}

function asId(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) invalid(field, `Choose a ${field}.`)
  const next = value.trim()
  if (next.length > ID_MAX) invalid(field, `Use at most ${ID_MAX} characters.`)
  return next
}

function asName(value: unknown): string {
  if (typeof value !== "string") invalid("name", "Enter a template name.")
  const name = value.replace(/\s+/g, " ").trim()
  if (!name) invalid("name", "Enter a template name.")
  if (name.length > NAME_MAX) invalid("name", `Use at most ${NAME_MAX} characters.`)
  return name
}

function asChannel(value: unknown): MessageTemplateChannel {
  if (typeof value !== "string" || !MESSAGE_TEMPLATE_CHANNELS.includes(value as MessageTemplateChannel)) {
    invalid("channel", "Choose email or SMS.")
  }
  return value as MessageTemplateChannel
}

function asScope(value: unknown): MessageTemplateScope {
  if (typeof value !== "string" || !MESSAGE_TEMPLATE_SCOPES.includes(value as MessageTemplateScope)) {
    invalid("scope", "Choose merchant, followup, digest, or request_info.")
  }
  return value as MessageTemplateScope
}

function asSubject(value: unknown, channel: MessageTemplateChannel, required: boolean): string | null {
  if (channel === "sms") return null
  if (value == null || value === "") {
    if (required) invalid("subject", "Enter an email subject.")
    return DEFAULT_EMAIL_SUBJECT
  }
  if (typeof value !== "string") invalid("subject", "Enter an email subject.")
  const subject = value.replace(/\r\n/g, "\n").trim()
  if (!subject) {
    if (required) invalid("subject", "Enter an email subject.")
    return DEFAULT_EMAIL_SUBJECT
  }
  if (subject.length > SUBJECT_MAX) invalid("subject", `Use at most ${SUBJECT_MAX} characters.`)
  if (subject.includes("\n")) invalid("subject", "Subjects cannot contain line breaks.")
  return subject
}

function asBody(value: unknown, channel: MessageTemplateChannel, required: boolean): string {
  if (value == null || value === "") {
    if (required) invalid("body", "Enter template text.")
    return channel === "sms" ? DEFAULT_SMS_BODY : DEFAULT_EMAIL_BODY
  }
  if (typeof value !== "string") invalid("body", "Enter template text.")
  const body = value.replace(/\r\n/g, "\n")
  if (!body.trim()) {
    if (required) invalid("body", "Enter template text.")
    return channel === "sms" ? DEFAULT_SMS_BODY : DEFAULT_EMAIL_BODY
  }
  if (body.length > BODY_MAX) invalid("body", `Use at most ${BODY_MAX} characters.`)
  return body
}

function canonicalName(raw: string): string {
  return raw.trim().toLowerCase()
}

function isForbiddenName(name: string): boolean {
  const compact = name.replace(/[\s.-]/g, "_")
  if (FORBIDDEN_LOOKUP.has(compact)) return true
  return compact.split(/_+/).includes("commission") || compact.includes("buy_rate")
}

export function listTemplateVariables(scope?: MessageTemplateScope): TemplateVariableDefinition[] {
  void scope
  return TEMPLATE_VARIABLE_REGISTRY.map((item) => ({ ...item }))
}

export function extractTemplateVariables(subject: string | null | undefined, body: string): string[] {
  const names = new Set<string>()
  const consume = (source: string | null | undefined) => {
    if (!source) return
    for (const match of source.matchAll(DOUBLE_TOKEN)) {
      const inner = canonicalName(match[1] ?? "")
      if (inner) names.add(inner)
    }
    for (const match of source.matchAll(SINGLE_TOKEN)) {
      const inner = canonicalName(match[1] ?? "")
      if (inner) names.add(inner)
    }
  }
  consume(subject)
  consume(body)
  return [...names]
}

export function variableSchemaHash(input: { channel: MessageTemplateChannel; scope: MessageTemplateScope; names: readonly string[] }): string {
  return createHash("sha256").update(JSON.stringify({
    channel: input.channel,
    scope: input.scope,
    names: [...input.names].sort(),
  })).digest("hex")
}

export function validateTemplateVariables(input: {
  subject?: string | null
  body: string
  channel: MessageTemplateChannel
  scope: MessageTemplateScope
}): TemplateVariableValidation {
  const names = extractTemplateVariables(input.subject, input.body)
  const unknown: string[] = []
  const forbidden: string[] = []
  for (const name of names) {
    if (isForbiddenName(name) && MERCHANT_SCOPES.has(input.scope)) {
      forbidden.push(name)
      continue
    }
    if (!IDENTIFIER.test(name) || !REGISTRY_BY_NAME.has(name) || isForbiddenName(name)) unknown.push(name)
  }
  return {
    names,
    unknown,
    forbidden,
    schemaHash: variableSchemaHash({ channel: input.channel, scope: input.scope, names }),
    publishable: unknown.length === 0 && forbidden.length === 0,
  }
}

function publishBlockedError(validation: TemplateVariableValidation, scope: MessageTemplateScope): never {
  if (validation.forbidden.length) {
    const listed = validation.forbidden.map((name) => `{{${name}}}`).join(", ")
    throw new AppError(
      422,
      "forbidden_variable",
      "Merchant templates cannot access commission or another deal's data.",
      { body: [`${listed} is not available on ${scope} templates.`] },
    )
  }
  const listed = validation.unknown.map((name) => `{{${name}}}`).join(", ")
  throw new AppError(
    422,
    "unknown_variable",
    "Unknown variables cannot be published.",
    { body: [`Unknown variable ${listed} cannot be published.`] },
  )
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
    if (character === "&") return "&amp;"
    if (character === "<") return "&lt;"
    if (character === ">") return "&gt;"
    if (character === '"') return "&quot;"
    return "&#39;"
  })
}

function formatUsdWhole(cents: number): string {
  return `$${Math.round(cents / 100).toLocaleString("en-US")}`
}

function formatUsdPayment(cents: number): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(cents / 100)
}

function formatFrequency(value?: string): string {
  if (value === "biweekly") return "bi-weekly"
  if (value === "daily" || value === "weekly" || value === "monthly") return value
  return ""
}

function formatOfferBlock(offers: OfferRevisionForClosing[], channel: MessageTemplateChannel): string {
  if (!offers.length) return ""
  return offers.map((offer, index) => {
    const amount = formatUsdWhole(offer.amountCents)
    const term = offer.termMonths ? `${offer.termMonths} months` : ""
    const frequency = formatFrequency(offer.paymentFrequency)
    const payment = offer.paymentAmountCents != null ? `${formatUsdPayment(offer.paymentAmountCents)}${frequency ? ` ${frequency}` : ""}` : ""
    if (channel === "sms") {
      return [`Offer ${index + 1}: ${amount}`, term, payment].filter(Boolean).join(", ")
    }
    const lines = [`Offer ${index + 1}:`, `- Funding Amount: ${amount}`]
    if (term) lines.push(`- Term Length: ${term}`)
    if (payment) lines.push(`- Payment: ${payment}`)
    return lines.join("\n")
  }).join(channel === "sms" ? "\n" : "\n\n")
}

function splitName(name?: string | null): { first: string; last: string } {
  const parts = name?.trim().split(/\s+/).filter(Boolean) ?? []
  return { first: parts[0] ?? "", last: parts.slice(1).join(" ") }
}

function primaryOwner(owners: DealOwner[]): DealOwner | undefined {
  return owners.find((owner) => owner.isPrimary) ?? owners[0]
}

function memberFor(assignments: DealRecord["assignments"], members: MembershipSummary[], kind: "originator" | "closer"): MembershipSummary | undefined {
  const group = assignments.filter((item) => item.kind === kind)
  const primary = group.find((item) => item.isPrimary) ?? group[0]
  if (!primary) return undefined
  return members.find((item) => item.id === primary.membershipId)
}

function uploadTokenSecret(): Buffer | undefined {
  const configured = process.env.MCA_UPLOAD_TOKEN_SECRET
  if (configured && configured.length >= 32) return Buffer.from(configured)
  if (process.env.NODE_ENV === "production") return undefined
  return Buffer.from("local-only-upload-token-secret-32-bytes-minimum")
}

export function scopedMerchantUploadUrl(input: {
  origin: string
  workspaceId: string
  dealId: string
  target: TemplateUploadTarget
}): string {
  const origin = input.origin.replace(/\/$/, "")
  if (!origin || !input.workspaceId || !input.dealId) return ""
  const secret = uploadTokenSecret()
  if (!secret) return ""
  const token = createHmac("sha256", secret).update(`template-upload:${input.workspaceId}:${input.dealId}:${input.target}`).digest("base64url")
  const params = new URLSearchParams({
    wid: input.workspaceId,
    did: input.dealId,
    target: input.target,
  })
  return `${origin}/merchant-upload/${token}?${params.toString()}`
}

function documentChecklist(documents: DocumentSummary[], openStipulations: Array<{ label: string }>): { summary: string; missing: string } {
  const clean = documents.filter((item) => item.processingState === "clean")
  const missing: string[] = []
  for (const bucket of DOCUMENT_BUCKETS) {
    if (!clean.some((item) => bucket.categories.includes(item.category))) missing.push(bucket.label)
  }
  for (const stipulation of openStipulations) {
    const label = stipulation.label.trim()
    if (label && !missing.includes(label)) missing.push(label)
  }
  const requiredCount = DOCUMENT_BUCKETS.length + openStipulations.length
  const missingCount = missing.length
  const summary = missingCount === 0 ? "All required documents received" : `Missing ${missingCount} of ${requiredCount} required documents`
  return { summary, missing: missing.map((item) => `- ${item}`).join("\n") }
}

function dealUrl(origin: string, dealId: string): string {
  const base = origin.replace(/\/$/, "")
  if (!base || !dealId) return ""
  return `${base}/deals/${dealId}`
}

function eligibleOffers(offers: OfferRevisionForClosing[]): OfferRevisionForClosing[] {
  return offers.filter((offer) => offer.state === "active" || (offer.state === "superseded" && offer.selected))
}

function sortOffers(offers: OfferRevisionForClosing[]): OfferRevisionForClosing[] {
  return [...offers].sort((left, right) => right.amountCents - left.amountCents || left.funderName.localeCompare(right.funderName) || left.offerId.localeCompare(right.offerId))
}

function highestOffer(offers: OfferRevisionForClosing[]): OfferRevisionForClosing | undefined {
  return sortOffers(offers)[0]
}

function resolveAlias(name: string): string {
  return REGISTRY_BY_NAME.get(name)?.aliasOf ?? name
}

export function buildSyntheticTemplateValues(input: { origin: string; workspaceId: string; channel: MessageTemplateChannel }): TemplateValueBag {
  const origin = input.origin.replace(/\/$/, "") || "https://app.example.test"
  const dealId = SYNTHETIC_TEMPLATE_DEAL_ID
  const offers: OfferRevisionForClosing[] = [
    { offerId: "syn-1", revisionId: "syn-1r", revisionNumber: 1, state: "active", selected: true, funderName: "Northstar Capital", amountCents: 5_000_000, termMonths: 24, paymentAmountCents: 220_000, paymentFrequency: "monthly", commissionCents: 999_999 },
    { offerId: "syn-2", revisionId: "syn-2r", revisionNumber: 1, state: "active", selected: true, funderName: "Harbor Funding", amountCents: 7_500_000, termMonths: 36, paymentAmountCents: 208_333, paymentFrequency: "monthly", commissionCents: 888_888 },
    { offerId: "syn-3", revisionId: "syn-3r", revisionNumber: 1, state: "active", selected: false, funderName: "Summit Advance", amountCents: 10_000_000, termMonths: 12, paymentAmountCents: 520_000, paymentFrequency: "weekly", commissionCents: 777_777 },
  ]
  const all = sortOffers(eligibleOffers(offers))
  const selected = sortOffers(all.filter((item) => item.selected))
  const highest = highestOffer(all)
  const uploads = {
    auto: scopedMerchantUploadUrl({ origin, workspaceId: input.workspaceId, dealId, target: "auto" }),
    statements: scopedMerchantUploadUrl({ origin, workspaceId: input.workspaceId, dealId, target: "statements" }),
    dlvc: scopedMerchantUploadUrl({ origin, workspaceId: input.workspaceId, dealId, target: "dlvc" }),
    closingDocs: scopedMerchantUploadUrl({ origin, workspaceId: input.workspaceId, dealId, target: "closingDocs" }),
    moreStips: scopedMerchantUploadUrl({ origin, workspaceId: input.workspaceId, dealId, target: "moreStips" }),
  }
  return {
    deal_id: "12847",
    deal_uuid: dealId,
    deal_url: dealUrl(origin, dealId),
    business_name: "Atlas Corporation",
    business_email: "ops@atlas.example.test",
    business_phone: "(555) 123-4567",
    owner_first_name: "John",
    owner_last_name: "Galt",
    owner_email: "john@atlas.example.test",
    owner_phone: "(555) 987-6543",
    originator_first_name: "Hank",
    originator_last_name: "Rearden",
    originator_email: "hank@broker.example.test",
    originator_phone: "(917) 283-2821",
    closer_first_name: "Hank",
    closer_last_name: "Rearden",
    closer_email: "hank@broker.example.test",
    closer_phone: "(917) 283-2821",
    all_offers_all_details: formatOfferBlock(all, input.channel),
    selected_offers_all_details: formatOfferBlock(selected, input.channel),
    highest_offer_all_details: highest ? formatOfferBlock([highest], input.channel) : "",
    highest_offer_funding_amount: highest ? formatUsdWhole(highest.amountCents) : "",
    docs_check_summary: "Missing 2 of 4 required documents",
    missing_docs: "- Funding Application\n- Bank Statement",
    auto_upload_url: uploads.auto,
    statements_upload_url: uploads.statements,
    dlvc_upload_url: uploads.dlvc,
    closing_docs_upload_url: uploads.closingDocs,
    other_docs_upload_url: uploads.moreStips,
    missing_docs_upload_url: uploads.moreStips,
    rep_first_name: "Hank",
    rep_last_name: "Rearden",
    rep_email: "hank@broker.example.test",
    rep_phone: "(917) 283-2821",
  }
}

async function openStipulationLabels(workspaceId: string, dealId: string): Promise<Array<{ label: string }>> {
  const rows = await db().prepare<{ label: string }>(
    "SELECT label FROM mca_closing_stipulations WHERE workspace_id=? AND deal_id=? AND status='open' ORDER BY created_at, id",
  ).all(workspaceId, dealId)
  return rows.map((row) => ({ label: String(row.label) }))
}

export async function buildDealTemplateValues(actor: DealActor, input: {
  dealId: string
  origin: string
  channel: MessageTemplateChannel
}): Promise<{ values: TemplateValueBag; dealId: string }> {
  const deal = await getDealForDocument(actor, input.dealId)
  const [offers, documents, members, stipulations] = await Promise.all([
    listOfferRevisionsForClosing(actor, { dealId: deal.id }),
    listDocuments(actor, deal.id),
    listMemberships(actor.workspaceId),
    openStipulationLabels(actor.workspaceId, deal.id),
  ])
  const all = sortOffers(eligibleOffers(offers))
  const selected = sortOffers(all.filter((item) => item.selected))
  const highest = highestOffer(all)
  const owner = primaryOwner(deal.owners)
  const originator = memberFor(deal.assignments, members, "originator")
  const closer = memberFor(deal.assignments, members, "closer")
  const originatorName = splitName(originator?.name)
  const closerName = splitName(closer?.name)
  const docs = documentChecklist(documents, stipulations)
  const origin = input.origin.replace(/\/$/, "")
  const uploads = {
    auto: scopedMerchantUploadUrl({ origin, workspaceId: deal.workspaceId, dealId: deal.id, target: "auto" }),
    statements: scopedMerchantUploadUrl({ origin, workspaceId: deal.workspaceId, dealId: deal.id, target: "statements" }),
    dlvc: scopedMerchantUploadUrl({ origin, workspaceId: deal.workspaceId, dealId: deal.id, target: "dlvc" }),
    closingDocs: scopedMerchantUploadUrl({ origin, workspaceId: deal.workspaceId, dealId: deal.id, target: "closingDocs" }),
    moreStips: scopedMerchantUploadUrl({ origin, workspaceId: deal.workspaceId, dealId: deal.id, target: "moreStips" }),
  }
  const values: TemplateValueBag = {
    deal_id: deal.displayId,
    deal_uuid: deal.id,
    deal_url: dealUrl(origin, deal.id),
    business_name: deal.legalName?.trim() || deal.dbaName?.trim() || "",
    business_email: deal.contactEmail?.trim() || "",
    business_phone: deal.contactPhone?.trim() || "",
    owner_first_name: owner?.firstName?.trim() || "",
    owner_last_name: owner?.lastName?.trim() || "",
    owner_email: owner?.email?.trim() || "",
    owner_phone: owner?.phone?.trim() || "",
    originator_first_name: originatorName.first,
    originator_last_name: originatorName.last,
    originator_email: originator?.email?.trim() || "",
    originator_phone: originator?.phone?.trim() || "",
    closer_first_name: closerName.first,
    closer_last_name: closerName.last,
    closer_email: closer?.email?.trim() || "",
    closer_phone: closer?.phone?.trim() || "",
    all_offers_all_details: formatOfferBlock(all, input.channel),
    selected_offers_all_details: formatOfferBlock(selected, input.channel),
    highest_offer_all_details: highest ? formatOfferBlock([highest], input.channel) : "",
    highest_offer_funding_amount: highest ? formatUsdWhole(highest.amountCents) : "",
    docs_check_summary: docs.summary,
    missing_docs: docs.missing,
    auto_upload_url: uploads.auto,
    statements_upload_url: uploads.statements,
    dlvc_upload_url: uploads.dlvc,
    closing_docs_upload_url: uploads.closingDocs,
    other_docs_upload_url: uploads.moreStips,
    missing_docs_upload_url: uploads.moreStips,
    rep_first_name: originatorName.first,
    rep_last_name: originatorName.last,
    rep_email: originator?.email?.trim() || "",
    rep_phone: originator?.phone?.trim() || "",
  }
  return { values, dealId: deal.id }
}

function lookupValue(values: TemplateValueBag, rawName: string): string {
  const name = resolveAlias(canonicalName(rawName))
  if (!REGISTRY_BY_NAME.has(name) && !REGISTRY_BY_NAME.has(canonicalName(rawName))) return ""
  return values[name] ?? values[canonicalName(rawName)] ?? ""
}

function substitute(source: string, values: TemplateValueBag, mode: "html" | "text" | "subject"): string {
  const replaceValue = (raw: string) => {
    const value = lookupValue(values, raw)
    if (mode === "html") return escapeHtml(value).replace(/\n/g, "<br>")
    if (mode === "subject") return value.replace(/[\r\n]+/g, " ").trim()
    return value
  }
  const once = source.replace(DOUBLE_TOKEN, (_full, raw: string) => replaceValue(String(raw)))
  const twice = once.replace(SINGLE_TOKEN, (_full, raw: string) => replaceValue(String(raw)))
  if (mode === "html") return twice.replace(/\n/g, "<br>")
  return twice
}

function looksLikeHtml(value: string): boolean {
  return /<\/?[a-z][\s\S]*>/i.test(value)
}

function stripHtml(value: string): string {
  return value.replace(/<br\s*\/?>/gi, "\n").replace(/<\/p>/gi, "\n").replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'")
}

export function renderTemplateSource(input: {
  subject?: string | null
  body: string
  channel: MessageTemplateChannel
  scope: MessageTemplateScope
  values: TemplateValueBag
  origin: string
  dealId?: string
  synthetic: boolean
}): RenderedMessageTemplate {
  const validation = validateTemplateVariables({ subject: input.subject, body: input.body, channel: input.channel, scope: input.scope })
  const used = validation.names
  const variables = used.map((name) => {
    const canonical = resolveAlias(name)
    const value = REGISTRY_BY_NAME.has(name) || REGISTRY_BY_NAME.has(canonical) ? (input.values[canonical] ?? input.values[name] ?? "") : ""
    return { name, value, missing: value === "" }
  })
  const textSource = looksLikeHtml(input.body) ? stripHtml(input.body) : input.body
  const text = substitute(textSource, input.values, "text")
  const subject = input.channel === "email" && input.subject ? substitute(input.subject, input.values, "subject") : undefined
  const html = input.channel === "email" ? substitute(input.body, input.values, "html") : undefined
  return {
    channel: input.channel,
    scope: input.scope,
    dealId: input.dealId,
    synthetic: input.synthetic,
    subject,
    html,
    text,
    variables,
    unknownVariables: validation.unknown,
    forbiddenVariables: validation.forbidden,
    publishBlocked: !validation.publishable,
    origin: input.origin,
  }
}

async function actorFromRequest(request: Request, options: { write?: boolean; sessionOnly?: boolean; admin?: boolean; scopes?: readonly ("deals:read")[] }): Promise<DealActor> {
  if (options.write) assertTrustedMutation(request)
  const auth = await requireWorkspaceAccess(request, {
    sessionOnly: options.sessionOnly,
    roles: options.admin ? ["admin", "super_admin"] : undefined,
    scopes: options.scopes,
  })
  return { ...await actorForDeals(auth), correlationId: requestCorrelationId(request) }
}

export async function requireTemplateAdmin(request: Request): Promise<DealActor> {
  return actorFromRequest(request, { write: true, sessionOnly: true, admin: true })
}

export async function requireTemplateAdminRead(request: Request): Promise<DealActor> {
  return actorFromRequest(request, { sessionOnly: true, admin: true })
}

export async function requireTemplateRead(request: Request): Promise<DealActor> {
  return actorFromRequest(request, { scopes: ["deals:read"] })
}

export async function requireTemplatePreview(request: Request): Promise<DealActor> {
  return requireTemplateRead(request)
}

function mapVersion(row: VersionRow): MessageTemplateVersionView {
  return {
    id: String(row.id),
    templateId: String(row.template_id),
    version: Number(row.version),
    subject: row.subject == null ? null : String(row.subject),
    body: String(row.body),
    variableSchemaHash: String(row.variable_schema_hash),
    published: Number(row.published) === 1,
    createdByUserId: row.created_by_user_id ? String(row.created_by_user_id) : null,
    createdAt: String(row.created_at),
  }
}

function mapTemplate(row: TemplateRow, draft: MessageTemplateVersionView | null, published: MessageTemplateVersionView | null, actor: DealActor): MessageTemplateView {
  const manage = isAdmin(actor) && actor.source === "user"
  return {
    id: String(row.id),
    workspaceId: String(row.workspace_id),
    name: String(row.name),
    channel: row.channel as MessageTemplateChannel,
    scope: row.scope as MessageTemplateScope,
    publishedVersionId: row.published_version_id ? String(row.published_version_id) : null,
    createdByUserId: row.created_by_user_id ? String(row.created_by_user_id) : null,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    draft,
    published,
    canManage: manage,
    canPublish: manage,
  }
}

async function loadVersions(workspaceId: string, templateId: string): Promise<MessageTemplateVersionView[]> {
  const rows = await db().prepare<VersionRow>(
    "SELECT * FROM mca_message_template_versions WHERE workspace_id=? AND template_id=? ORDER BY version DESC, created_at DESC",
  ).all(workspaceId, templateId)
  return rows.map(mapVersion)
}

async function loadTemplateRow(actor: DealActor, templateId: string): Promise<TemplateRow> {
  const row = await db().prepare<TemplateRow>("SELECT * FROM mca_message_templates WHERE workspace_id=? AND id=?").get(actor.workspaceId, templateId)
  if (!row) throw new AppError(404, "template_not_found", "The requested message template was not found.")
  return row
}

function currentDraft(versions: MessageTemplateVersionView[], publishedVersionId: string | null): MessageTemplateVersionView | null {
  const published = versions.find((item) => item.id === publishedVersionId) ?? versions.find((item) => item.published) ?? null
  const latestUnpublished = versions.find((item) => !item.published && item.id !== published?.id) ?? null
  if (!latestUnpublished) return null
  if (published && latestUnpublished.version <= published.version) return null
  return latestUnpublished
}

async function hydrateTemplate(actor: DealActor, row: TemplateRow): Promise<MessageTemplateView> {
  const versions = await loadVersions(actor.workspaceId, String(row.id))
  const published = versions.find((item) => item.id === row.published_version_id) ?? versions.find((item) => item.published) ?? null
  const draft = currentDraft(versions, row.published_version_id ? String(row.published_version_id) : null)
  return mapTemplate(row, draft, published, actor)
}

export async function listMessageTemplates(actor: DealActor): Promise<MessageTemplateListResult> {
  if (!isAdmin(actor)) denied()
  const rows = await db().prepare<TemplateRow>(
    "SELECT * FROM mca_message_templates WHERE workspace_id=? ORDER BY updated_at DESC, name ASC",
  ).all(actor.workspaceId)
  return {
    templates: rows.map((row) => ({
      id: String(row.id),
      name: String(row.name),
      channel: row.channel as MessageTemplateChannel,
      scope: row.scope as MessageTemplateScope,
      published: Boolean(row.published_version_id),
      publishedVersionId: row.published_version_id ? String(row.published_version_id) : null,
      updatedAt: String(row.updated_at),
    })),
    variables: listTemplateVariables(),
    canManage: true,
    canPublish: actor.source === "user",
  }
}

export async function getMessageTemplate(actor: DealActor, templateId: string): Promise<MessageTemplateView> {
  if (!isAdmin(actor)) denied()
  return hydrateTemplate(actor, await loadTemplateRow(actor, asId(templateId, "templateId")))
}

export async function getPublishedMessageTemplate(actor: DealActor, templateId: string): Promise<MessageTemplateView> {
  const row = await loadTemplateRow(actor, asId(templateId, "templateId"))
  const hydrated = await hydrateTemplate(actor, row)
  if (!hydrated.published) throw new AppError(404, "template_not_published", "This message template has no published version.")
  return hydrated
}

export async function listMessageTemplateVersions(actor: DealActor, templateId: string): Promise<{ templateId: string; versions: MessageTemplateVersionView[] }> {
  if (!isAdmin(actor)) denied()
  const row = await loadTemplateRow(actor, asId(templateId, "templateId"))
  return { templateId: String(row.id), versions: await loadVersions(actor.workspaceId, String(row.id)) }
}

export async function createMessageTemplate(actor: DealActor, input: {
  name: string
  channel: MessageTemplateChannel
  scope: MessageTemplateScope
  subject?: string | null
  body?: string
}): Promise<MessageTemplateView> {
  if (!isAdmin(actor) || actor.source !== "user") denied()
  const name = asName(input.name)
  const channel = asChannel(input.channel)
  const scope = asScope(input.scope)
  const subject = asSubject(input.subject, channel, false)
  const body = asBody(input.body, channel, false)
  const validation = validateTemplateVariables({ subject, body, channel, scope })
  const now = nowIso()
  const templateId = newId()
  const versionId = newId()
  return withImmediateTransaction(async (database) => {
    const clash = await database.prepare<{ id: string }>(
      "SELECT id FROM mca_message_templates WHERE workspace_id=? AND name=? AND channel=?",
    ).get(actor.workspaceId, name, channel)
    if (clash) throw new AppError(409, "template_name_conflict", "A template with this name already exists for that channel.", { name: ["Choose a different name."] })
    await database.prepare(`INSERT INTO mca_message_templates
      (id, workspace_id, name, channel, scope, published_version_id, created_by_user_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?)`).run(templateId, actor.workspaceId, name, channel, scope, actor.userId, now, now)
    await database.prepare(`INSERT INTO mca_message_template_versions
      (id, workspace_id, template_id, version, subject, body, variable_schema_hash, published, created_by_user_id, created_at)
      VALUES (?, ?, ?, 1, ?, ?, ?, 0, ?, ?)`).run(versionId, actor.workspaceId, templateId, subject, body, validation.schemaHash, actor.userId, now)
    await recordAuditEvent({
      context: actor,
      action: "comms.template_created",
      resourceType: "message_template",
      resourceId: templateId,
      metadata: { channel, scope, version: 1, variableNames: validation.names },
      correlationId: actor.correlationId,
      executor: database,
    })
    const row = await database.prepare<TemplateRow>("SELECT * FROM mca_message_templates WHERE workspace_id=? AND id=?").get(actor.workspaceId, templateId)
    const version = await database.prepare<VersionRow>("SELECT * FROM mca_message_template_versions WHERE id=?").get(versionId)
    return mapTemplate(row!, mapVersion(version!), null, actor)
  })
}

export async function saveMessageTemplateDraft(actor: DealActor, templateId: string, input: {
  name?: string
  subject?: string | null
  body?: string
}): Promise<MessageTemplateView> {
  if (!isAdmin(actor) || actor.source !== "user") denied()
  const id = asId(templateId, "templateId")
  return withImmediateTransaction(async (database) => {
    const row = await database.prepare<TemplateRow>("SELECT * FROM mca_message_templates WHERE workspace_id=? AND id=?").get(actor.workspaceId, id)
    if (!row) throw new AppError(404, "template_not_found", "The requested message template was not found.")
    const channel = row.channel as MessageTemplateChannel
    const scope = row.scope as MessageTemplateScope
    const name = input.name === undefined ? String(row.name) : asName(input.name)
    const latest = await database.prepare<VersionRow>(
      "SELECT * FROM mca_message_template_versions WHERE workspace_id=? AND template_id=? ORDER BY version DESC LIMIT 1",
    ).get(actor.workspaceId, id)
    const subject = input.subject === undefined ? latest?.subject ?? (channel === "email" ? DEFAULT_EMAIL_SUBJECT : null) : asSubject(input.subject, channel, false)
    const body = input.body === undefined ? latest?.body ?? (channel === "sms" ? DEFAULT_SMS_BODY : DEFAULT_EMAIL_BODY) : asBody(input.body, channel, true)
    const validation = validateTemplateVariables({ subject, body, channel, scope })
    if (name !== String(row.name)) {
      const clash = await database.prepare<{ id: string }>(
        "SELECT id FROM mca_message_templates WHERE workspace_id=? AND name=? AND channel=? AND id<>?",
      ).get(actor.workspaceId, name, channel, id)
      if (clash) throw new AppError(409, "template_name_conflict", "A template with this name already exists for that channel.", { name: ["Choose a different name."] })
    }
    const now = nowIso()
    const reuseDraft = latest && Number(latest.published) === 0
    let versionId = latest ? String(latest.id) : newId()
    if (reuseDraft) {
      await database.prepare(
        "UPDATE mca_message_template_versions SET subject=?, body=?, variable_schema_hash=? WHERE workspace_id=? AND id=?",
      ).run(subject, body, validation.schemaHash, actor.workspaceId, versionId)
    } else {
      const nextVersion = (latest ? Number(latest.version) : 0) + 1
      versionId = newId()
      await database.prepare(`INSERT INTO mca_message_template_versions
        (id, workspace_id, template_id, version, subject, body, variable_schema_hash, published, created_by_user_id, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`).run(versionId, actor.workspaceId, id, nextVersion, subject, body, validation.schemaHash, actor.userId, now)
    }
    await database.prepare("UPDATE mca_message_templates SET name=?, updated_at=? WHERE workspace_id=? AND id=?").run(name, now, actor.workspaceId, id)
    await recordAuditEvent({
      context: actor,
      action: "comms.template_updated",
      resourceType: "message_template",
      resourceId: id,
      metadata: { channel, scope, versionId, variableNames: validation.names },
      correlationId: actor.correlationId,
      executor: database,
    })
    const saved = await database.prepare<TemplateRow>("SELECT * FROM mca_message_templates WHERE workspace_id=? AND id=?").get(actor.workspaceId, id)
    return hydrateTemplate(actor, saved!)
  })
}

export async function publishMessageTemplate(actor: DealActor, templateId: string, input: { versionId?: string } = {}): Promise<MessageTemplateView> {
  if (!isAdmin(actor) || actor.source !== "user") denied()
  const id = asId(templateId, "templateId")
  return withImmediateTransaction(async (database) => {
    const row = await database.prepare<TemplateRow>("SELECT * FROM mca_message_templates WHERE workspace_id=? AND id=?").get(actor.workspaceId, id)
    if (!row) throw new AppError(404, "template_not_found", "The requested message template was not found.")
    const version = input.versionId
      ? await database.prepare<VersionRow>("SELECT * FROM mca_message_template_versions WHERE workspace_id=? AND template_id=? AND id=?").get(actor.workspaceId, id, asId(input.versionId, "versionId"))
      : await database.prepare<VersionRow>("SELECT * FROM mca_message_template_versions WHERE workspace_id=? AND template_id=? ORDER BY version DESC LIMIT 1").get(actor.workspaceId, id)
    if (!version) throw new AppError(404, "template_version_not_found", "The requested template version was not found.")
    const channel = row.channel as MessageTemplateChannel
    const scope = row.scope as MessageTemplateScope
    if (channel === "email" && !String(version.subject ?? "").trim()) invalid("subject", "Enter an email subject.")
    if (!String(version.body ?? "").trim()) invalid("body", "Enter template text.")
    const validation = validateTemplateVariables({ subject: version.subject, body: String(version.body), channel, scope })
    if (!validation.publishable) publishBlockedError(validation, scope)
    const now = nowIso()
    await database.prepare("UPDATE mca_message_template_versions SET published=0 WHERE workspace_id=? AND template_id=? AND id<>?").run(actor.workspaceId, id, version.id)
    await database.prepare("UPDATE mca_message_template_versions SET published=1 WHERE workspace_id=? AND id=?").run(actor.workspaceId, version.id)
    await database.prepare("UPDATE mca_message_templates SET published_version_id=?, updated_at=? WHERE workspace_id=? AND id=?").run(version.id, now, actor.workspaceId, id)
    await recordAuditEvent({
      context: actor,
      action: "comms.template_published",
      resourceType: "message_template",
      resourceId: id,
      metadata: { channel, scope, versionId: version.id, version: Number(version.version), variableSchemaHash: validation.schemaHash },
      correlationId: actor.correlationId,
      executor: database,
    })
    const saved = await database.prepare<TemplateRow>("SELECT * FROM mca_message_templates WHERE workspace_id=? AND id=?").get(actor.workspaceId, id)
    return hydrateTemplate(actor, saved!)
  })
}

export async function previewMessageTemplate(actor: DealActor, input: {
  templateId?: string
  subject?: string | null
  body?: string
  channel?: MessageTemplateChannel
  scope?: MessageTemplateScope
  dealId?: string
  origin: string
}): Promise<RenderedMessageTemplate> {
  let channel: MessageTemplateChannel = input.channel ? asChannel(input.channel) : "email"
  let scope: MessageTemplateScope = input.scope ? asScope(input.scope) : "merchant"
  let subject = input.subject
  let body = input.body
  if (input.templateId) {
    const row = await loadTemplateRow(actor, asId(input.templateId, "templateId"))
    const versions = await loadVersions(actor.workspaceId, String(row.id))
    const published = versions.find((item) => item.id === row.published_version_id) ?? null
    const draft = isAdmin(actor) ? currentDraft(versions, row.published_version_id ? String(row.published_version_id) : null) : null
    const version = isAdmin(actor) ? (draft ?? published) : published
    if (!version) throw new AppError(404, "template_not_published", "This message template has no published version.")
    channel = row.channel as MessageTemplateChannel
    scope = row.scope as MessageTemplateScope
    if (subject == null) subject = version.subject
    if (body == null) body = version.body
  }
  const resolvedChannel = channel
  const resolvedBody = asBody(body, resolvedChannel, true)
  const resolvedSubject = asSubject(subject, resolvedChannel, false)
  const origin = input.origin.replace(/\/$/, "") || ""
  if (input.dealId) {
    const built = await buildDealTemplateValues(actor, { dealId: asId(input.dealId, "dealId"), origin, channel: resolvedChannel })
    return renderTemplateSource({
      subject: resolvedSubject,
      body: resolvedBody,
      channel: resolvedChannel,
      scope,
      values: built.values,
      origin,
      dealId: built.dealId,
      synthetic: false,
    })
  }
  return renderTemplateSource({
    subject: resolvedSubject,
    body: resolvedBody,
    channel: resolvedChannel,
    scope,
    values: buildSyntheticTemplateValues({ origin: origin || "https://app.example.test", workspaceId: actor.workspaceId, channel: resolvedChannel }),
    origin: origin || "https://app.example.test",
    dealId: SYNTHETIC_TEMPLATE_DEAL_ID,
    synthetic: true,
  })
}

export async function renderPublishedMessageTemplate(actor: DealActor, input: {
  templateId: string
  dealId: string
  origin: string
}): Promise<RenderedMessageTemplate> {
  const template = await getPublishedMessageTemplate(actor, input.templateId)
  const version = template.published
  if (!version) throw new AppError(404, "template_not_published", "This message template has no published version.")
  const built = await buildDealTemplateValues(actor, { dealId: asId(input.dealId, "dealId"), origin: input.origin, channel: template.channel })
  const rendered = renderTemplateSource({
    subject: version.subject,
    body: version.body,
    channel: template.channel,
    scope: template.scope,
    values: built.values,
    origin: input.origin,
    dealId: built.dealId,
    synthetic: false,
  })
  if (rendered.publishBlocked) publishBlockedError(validateTemplateVariables({
    subject: version.subject,
    body: version.body,
    channel: template.channel,
    scope: template.scope,
  }), template.scope)
  return rendered
}

export function assertTemplatePreviewSafe(rendered: RenderedMessageTemplate): void {
  const blob = `${rendered.subject ?? ""}\n${rendered.text}\n${rendered.html ?? ""}`
  for (const name of [...rendered.unknownVariables, ...rendered.forbiddenVariables]) {
    if (blob.includes(`{{${name}}}`) || blob.includes(`{${name}}`)) {
      throw new AppError(422, "unknown_variable", "Unknown variables cannot be published.")
    }
  }
}
