import "server-only"

import { hashOpaqueToken, hmacScopedToken } from "../crypto"
import { getDatabase, newId, nowIso } from "../db"
import { actorForDeals } from "../deals/service"
import type { DealActor, DealWriteInput, EntityType } from "../deals/schema"
import { ENTITY_TYPES } from "../deals/schema"
import { storeDocument } from "../documents/service"
import type { DocumentCategory } from "../documents/contracts"
import { AppError } from "../errors"
import { getMembership } from "../memberships"
import { canManageWorkspace } from "../policy"
import type { AuthContext } from "../types"
import { getWorkspaceSettings } from "../workspaces"
import type { IntakeResult } from "./contracts"
import {
  findNativeApplyIntegration,
  putAttributionToken,
  resolveNativeAttributionToken,
  saveIntegration,
} from "./repository"
import { captureIntakeAnswers } from "./providers"
import { ingestApplication } from "./service"
import { sendUsesendEmail } from "./usesend"

export const NATIVE_APPLY_PROVIDER = "native"
export const NATIVE_APPLY_FORM_ID = "apply"
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{32,128}$/
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

const UPLOAD_CATEGORIES = {
  statement: "statement",
  driver_license: "driver_license",
  voided_check: "voided_check",
} as const satisfies Record<string, DocumentCategory>

export function nativeApplyToken(workspaceId: string, membershipId: string): string {
  return hmacScopedToken("native-apply", workspaceId, membershipId)
}

export function parseNativeApplication(body: unknown): DealWriteInput {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new AppError(422, "invalid_application", "Provide application fields as JSON.")
  }
  const input = body as Record<string, unknown>
  const legalName = text(input.legalName)
  if (!legalName) throw new AppError(422, "invalid_application", "Business name is required.", { legalName: ["Enter the legal business name."] })
  const entityType = input.entityType
  if (entityType != null && (typeof entityType !== "string" || !ENTITY_TYPES.includes(entityType as EntityType))) {
    throw new AppError(422, "invalid_application", "Choose a valid entity type.", { entityType: ["Choose a valid entity type."] })
  }
  const requestedAmount = numberField(input.requestedAmount)
  if (requestedAmount != null && requestedAmount <= 0) {
    throw new AppError(422, "invalid_application", "Requested amount must be greater than zero.", { requestedAmount: ["Enter an amount greater than zero."] })
  }
  const owners = Array.isArray(input.owners)
    ? input.owners.map((owner, index) => {
        if (!owner || typeof owner !== "object" || Array.isArray(owner)) {
          throw new AppError(422, "invalid_application", "Owner details are invalid.", { owners: [`Owner ${index + 1} is invalid.`] })
        }
        const record = owner as Record<string, unknown>
        const identityLast4 = text(record.identityLast4)?.replace(/\D/g, "")
        if (identityLast4 && !/^\d{4}$/.test(identityLast4)) {
          throw new AppError(422, "invalid_application", "Owner identity last-four must be four digits.", { owners: ["Use the last four digits only."] })
        }
        return {
          firstName: text(record.firstName),
          lastName: text(record.lastName),
          ownershipPercent: numberField(record.ownershipPercent),
          isPrimary: record.isPrimary === true,
          identityLast4,
        }
      })
    : undefined
  const address = input.address && typeof input.address === "object" && !Array.isArray(input.address)
    ? {
        line1: text((input.address as Record<string, unknown>).line1),
        line2: text((input.address as Record<string, unknown>).line2),
        city: text((input.address as Record<string, unknown>).city),
        state: text((input.address as Record<string, unknown>).state),
        postalCode: text((input.address as Record<string, unknown>).postalCode),
        country: text((input.address as Record<string, unknown>).country) ?? "US",
      }
    : undefined
  return {
    legalName,
    dbaName: text(input.dbaName),
    ein: text(input.ein),
    entityType: entityType as EntityType | undefined,
    address,
    contactName: text(input.contactName),
    contactEmail: text(input.contactEmail),
    contactPhone: text(input.contactPhone),
    startDate: text(input.startDate),
    industry: text(input.industry),
    monthlyRevenue: numberField(input.monthlyRevenue),
    requestedAmount: requestedAmount ?? undefined,
    fundingPurpose: text(input.fundingPurpose),
    owners,
    fieldSource: "api",
  }
}

function text(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined
  const trimmed = value.trim()
  return trimmed ? trimmed.slice(0, 200) : undefined
}

function numberField(value: unknown): number | undefined {
  if (value == null || value === "") return undefined
  const numeric = typeof value === "number" ? value : Number(value)
  return Number.isFinite(numeric) ? numeric : undefined
}

async function ensureNativeIntegration(workspaceId: string) {
  const existing = await findNativeApplyIntegration(workspaceId)
  if (existing) return existing
  return saveIntegration({
    id: newId(),
    workspaceId,
    provider: NATIVE_APPLY_PROVIDER,
    displayName: "Fundlane application",
    formId: NATIVE_APPLY_FORM_ID,
    mapping: {},
    allowedHosts: [],
    senderRules: [],
    assignmentPool: [],
    initialStatus: "new_application",
    enabled: true,
    automaticProcessing: true,
    automaticSince: nowIso(),
    approvalState: "approved",
  })
}

async function actorForNativeWorkspace(workspaceId: string, membershipId: string): Promise<DealActor> {
  const context: AuthContext = {
    authType: "api_key",
    userId: null,
    membershipId,
    workspaceId,
    role: null,
    scopes: ["intake:write", "deals:write"],
    sessionId: null,
  }
  return actorForDeals(context)
}

export async function brokerIntakeLink(
  actor: DealActor,
  origin: string,
  membershipId = actor.membershipId
): Promise<{ url: string; membershipId: string; mailConfigured: boolean }> {
  if (!membershipId) throw new AppError(403, "membership_required", "Sign in with a workspace membership to copy your application link.")
  if (membershipId !== actor.membershipId && !canManageWorkspace(actor.role ?? "rep")) {
    throw new AppError(403, "forbidden", "You can only copy your own application link.")
  }
  const member = await getMembership(actor.workspaceId, membershipId)
  if (member.status !== "active") throw new AppError(422, "inactive_rep", "Create links only for active workspace members.")
  const integration = await ensureNativeIntegration(actor.workspaceId)
  const token = nativeApplyToken(actor.workspaceId, membershipId)
  await putAttributionToken({
    workspaceId: actor.workspaceId,
    integrationId: integration.id,
    membershipId,
    tokenHash: hashOpaqueToken(token),
  })
  const url = `${origin.replace(/\/$/, "")}/apply/r/${encodeURIComponent(token)}`
  const mailConfigured = Boolean(process.env.MCA_USESEND_API_KEY?.trim() && process.env.MCA_USESEND_FROM?.trim())
  return { url, membershipId, mailConfigured }
}

export async function sendBrokerIntakeEmail(
  actor: DealActor,
  origin: string,
  recipient: string,
  membershipId = actor.membershipId
): Promise<{ sent: true }> {
  const email = recipient.trim().toLowerCase()
  if (!EMAIL_PATTERN.test(email)) throw new AppError(422, "invalid_email", "Enter a valid client email address.")
  const link = await brokerIntakeLink(actor, origin, membershipId)
  const apiKey = process.env.MCA_USESEND_API_KEY?.trim()
  const from = process.env.MCA_USESEND_FROM?.trim()
  if (!apiKey || !from) {
    throw new AppError(503, "intake_mail_unconfigured", "Connect email in Settings before sending this link.")
  }
  const member = await getMembership(actor.workspaceId, link.membershipId)
  await sendUsesendEmail({
    apiKey,
    from,
    to: email,
    subject: `${member.name} sent you a funding application`,
    text: [
      `${member.name} invited you to complete a short business funding application.`,
      `Open this secure link: ${link.url}`,
      "You can fill the application and upload bank statements, a photo ID, and a voided check.",
    ].join("\n\n"),
    html: `<p>${escapeHtml(member.name)} invited you to complete a short business funding application.</p><p><a href="${escapeHtml(link.url)}">Open your application</a></p><p>You can fill the form and upload bank statements, a photo ID, and a voided check.</p>`,
    idempotencyKey: `native-apply-email:${hashOpaqueToken(`${link.membershipId}:${email}:${link.url}`)}`,
  })
  return { sent: true }
}

export async function inspectNativeApply(token: string): Promise<{ representativeName: string }> {
  const attribution = await requireNativeToken(token)
  const member = await getMembership(attribution.workspaceId, attribution.membershipId)
  return { representativeName: member.name }
}

export async function submitNativeApply(token: string, body: unknown): Promise<IntakeResult & { dealId: string }> {
  const attribution = await requireNativeToken(token)
  const application = parseNativeApplication(body)
  const actor = await actorForNativeWorkspace(attribution.workspaceId, attribution.membershipId)
  const eventId = `native:${hashOpaqueToken(JSON.stringify({ token: attribution.membershipId, legalName: application.legalName, ein: application.ein, requestedAmount: application.requestedAmount }))}`
  const result = await ingestApplication(actor, {
    schemaVersion: 1,
    provider: NATIVE_APPLY_PROVIDER,
    eventId,
    answers: captureIntakeAnswers(application),
    application: {
      ...application,
      assignments: [{ membershipId: attribution.membershipId, kind: "originator", isPrimary: true }],
    },
    sourceReference: `native-apply:${attribution.membershipId}`,
    initialStatus: "new_application",
  }, undefined, attribution.integrationId)
  if (!result.dealId) throw new AppError(500, "intake_deal_missing", "The application was received but a deal was not created.")
  return { ...result, dealId: result.dealId }
}

export async function uploadNativeApplyDocument(input: {
  token: string
  dealId: string
  category: string
  filename: string
  mimeType: string
  bytes: Uint8Array
  idempotencyKey: string
}) {
  const attribution = await requireNativeToken(input.token)
  const intake = await getDatabase().prepare<{ id: string }>(`SELECT id FROM intake_events
    WHERE workspace_id=? AND deal_id=? AND provider='native' AND integration_id=? AND source_reference=?`).get(
    attribution.workspaceId, input.dealId, attribution.integrationId, `native-apply:${attribution.membershipId}`,
  )
  if (!intake) throw new AppError(404, "intake_not_found", "This application was not submitted through this link.")
  const category = UPLOAD_CATEGORIES[input.category as keyof typeof UPLOAD_CATEGORIES]
  if (!category) throw new AppError(422, "invalid_category", "Upload a bank statement, ID, or voided check.")
  const actor = await actorForNativeWorkspace(attribution.workspaceId, attribution.membershipId)
  return storeDocument(actor, {
    dealId: input.dealId,
    idempotencyKey: input.idempotencyKey,
    filename: input.filename,
    mimeType: input.mimeType,
    bytes: input.bytes,
    category,
    source: "native_apply",
    sourceReference: `native-apply:${attribution.membershipId}`,
  })
}

async function requireNativeToken(token: string) {
  if (!TOKEN_PATTERN.test(token)) throw new AppError(404, "apply_link_invalid", "This application link is invalid or no longer active.")
  const attribution = await resolveNativeAttributionToken(hashOpaqueToken(token))
  if (!attribution) throw new AppError(404, "apply_link_invalid", "This application link is invalid or no longer active.")
  const expected = nativeApplyToken(attribution.workspaceId, attribution.membershipId)
  if (hashOpaqueToken(expected) !== hashOpaqueToken(token)) {
    throw new AppError(404, "apply_link_invalid", "This application link is invalid or no longer active.")
  }
  await getWorkspaceSettings(attribution.workspaceId)
  return attribution
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char] ?? char))
}
