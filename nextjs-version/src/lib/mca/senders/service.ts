import "server-only"

import { createOpaqueToken, hashOpaqueToken } from "../crypto"
import { assertTrustedMutation, requireWorkspaceAccess } from "../auth"
import { newId, nowIso, recordAuditEvent, withTransaction } from "../db"
import { actorForDeals } from "../deals/service"
import type { DealActor } from "../deals/schema"
import { AppError } from "../errors"
import { requestCorrelationId } from "../http"
import { canManageWorkspace } from "../policy"
import {
  SENDER_PROVIDERS,
  SENDER_PURPOSES,
  type EmailSender,
  type SenderProvider,
  type SenderPurpose,
  type SenderTestSendResult,
} from "./contracts"
import { deliverSenderTest } from "./delivery"
import {
  exchangeSenderAuthorizationCode,
  senderAuthorizationUrl,
  senderOAuthConfig,
  senderOAuthConfigured,
} from "./oauth"
import {
  activeMembershipIdsInWorkspace,
  clearDefaultSenders,
  consumeOauthState,
  decryptSenderCredential,
  encryptSenderCredential,
  findSenderById,
  insertSender,
  listSendersByWorkspace,
  saveOauthState,
  toPublicSender,
  updateSenderRecord,
  type SendGridCredential,
  type SmtpCredential,
  type StoredEmailSender,
  type StoredSenderCredential,
} from "./repository"

export type { EmailSender, SenderProvider, SenderPurpose, SenderState, SenderTestSendResult } from "./contracts"
export { setSenderOAuthFetchForTests, senderOAuthConfigured } from "./oauth"
export { setSenderDeliveryFetchForTests } from "./delivery"

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const FROM_NAME_MAX = 120
const SIGNATURE_MAX = 8_000

export interface SenderReconnect {
  available: true
  method: "oauth" | "credentials"
}

export interface SenderConnection extends EmailSender {
  reconnect?: SenderReconnect
}

export interface SenderListResult {
  senders: SenderConnection[]
  oauth: { google: boolean; microsoft: boolean }
  canManage: boolean
}

export interface SmtpSenderInput {
  host: string
  port: number
  username: string
  password: string
  secure?: boolean
}

export interface SendGridSenderInput {
  apiKey: string
}

export interface CreateSenderInput {
  provider: SenderProvider
  purpose: SenderPurpose
  fromName: string
  fromAddress: string
  signature?: string
  isDefault?: boolean
  memberIds?: string[]
  smtp?: SmtpSenderInput
  sendgrid?: SendGridSenderInput
}

export interface UpdateSenderInput {
  fromName?: string
  fromAddress?: string
  signature?: string | null
  isDefault?: boolean
  memberIds?: string[]
  smtp?: Partial<SmtpSenderInput>
  sendgrid?: Partial<SendGridSenderInput>
  revoke?: boolean
}

export interface SenderOAuthStart {
  authorizationUrl: string
  sender: SenderConnection
}

function invalid(field: string, message: string): never {
  throw new AppError(422, "validation_failed", "Review the highlighted fields.", { [field]: [message] })
}

function denied(message = "You do not have permission to perform this action."): never {
  throw new AppError(403, "permission_denied", message)
}

function isAdmin(actor: DealActor): boolean {
  return Boolean(actor.role && canManageWorkspace(actor.role))
}

function isMember(actor: DealActor, sender: StoredEmailSender): boolean {
  return Boolean(actor.membershipId && sender.memberIds.includes(actor.membershipId))
}

function canView(actor: DealActor, sender: StoredEmailSender): boolean {
  if (sender.workspaceId !== actor.workspaceId) return false
  if (isAdmin(actor) || actor.source === "api_key") return true
  return isMember(actor, sender)
}

function assertAdmin(actor: DealActor): void {
  if (!isAdmin(actor)) denied("Only workspace administrators can manage email senders.")
}

function assertCanView(actor: DealActor, sender: StoredEmailSender | undefined): StoredEmailSender {
  if (!sender || !canView(actor, sender)) denied()
  return sender
}

function assertCanUse(actor: DealActor, sender: StoredEmailSender | undefined): StoredEmailSender {
  if (!sender || sender.workspaceId !== actor.workspaceId) denied()
  if (isAdmin(actor) || actor.source === "system") return sender
  if (isMember(actor, sender)) return sender
  denied()
}

async function requireActor(request: Request, options: { write?: boolean; sessionOnly?: boolean; admin?: boolean }): Promise<DealActor> {
  if (options.write) assertTrustedMutation(request)
  const auth = await requireWorkspaceAccess(request, {
    sessionOnly: options.sessionOnly,
    roles: options.admin ? ["admin", "super_admin"] : undefined,
    scopes: options.write || options.admin ? undefined : ["deals:read"],
  })
  return { ...await actorForDeals(auth), correlationId: requestCorrelationId(request) }
}

export async function requireSenderRead(request: Request): Promise<DealActor> {
  return requireActor(request, {})
}

export async function requireSenderAdmin(request: Request): Promise<DealActor> {
  return requireActor(request, { write: true, sessionOnly: true, admin: true })
}

export async function requireSenderUse(request: Request): Promise<DealActor> {
  return requireActor(request, { write: true, sessionOnly: true })
}

function asProvider(value: unknown): SenderProvider {
  if (typeof value !== "string" || !SENDER_PROVIDERS.includes(value as SenderProvider)) {
    invalid("provider", "Choose google, microsoft, smtp, or sendgrid.")
  }
  return value as SenderProvider
}

function asPurpose(value: unknown): SenderPurpose {
  if (typeof value !== "string" || !SENDER_PURPOSES.includes(value as SenderPurpose)) {
    invalid("purpose", "Choose merchant, submission, or fallback.")
  }
  return value as SenderPurpose
}

function asFromName(value: unknown): string {
  if (typeof value !== "string") invalid("fromName", "Enter a from name.")
  const fromName = value.trim()
  if (!fromName || fromName.length > FROM_NAME_MAX) invalid("fromName", `Enter a from name up to ${FROM_NAME_MAX} characters.`)
  return fromName
}

function asFromAddress(value: unknown): string {
  if (typeof value !== "string") invalid("fromAddress", "Enter a from address.")
  const fromAddress = value.trim()
  if (!EMAIL_PATTERN.test(fromAddress) || fromAddress.length > 320) invalid("fromAddress", "Enter a valid from address.")
  return fromAddress
}

function asSignature(value: unknown): string | undefined {
  if (value == null) return undefined
  if (typeof value !== "string") invalid("signature", "Enter a signature as text.")
  const signature = value.trim()
  if (signature.length > SIGNATURE_MAX) invalid("signature", `Enter a signature up to ${SIGNATURE_MAX} characters.`)
  return signature || undefined
}

function asMemberIds(value: unknown): string[] | undefined {
  if (value == null) return undefined
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    invalid("memberIds", "Choose permitted workspace members.")
  }
  return [...new Set(value.map((item) => item.trim()).filter(Boolean))]
}

function asRecipient(value: unknown, fallback: string): string {
  if (value == null || value === "") return fallback
  if (typeof value !== "string" || !EMAIL_PATTERN.test(value.trim())) invalid("to", "Enter a valid test recipient.")
  return value.trim()
}

async function normalizeMemberIds(workspaceId: string, memberIds: string[] | undefined): Promise<string[]> {
  const requested = memberIds ?? []
  if (!requested.length) return []
  const active = await activeMembershipIdsInWorkspace(workspaceId, requested)
  if (active.length !== requested.length) invalid("memberIds", "Each permitted member must be an active workspace membership.")
  return requested
}

function smtpCredential(input: SmtpSenderInput, existing?: SmtpCredential): SmtpCredential {
  const host = (input.host ?? existing?.host)?.trim()
  const port = Number(input.port ?? existing?.port)
  const username = (input.username ?? existing?.username)?.trim()
  const password = input.password ?? existing?.password
  if (!host || host.length > 255) invalid("smtp.host", "Enter an SMTP host.")
  if (!Number.isInteger(port) || port < 1 || port > 65535) invalid("smtp.port", "Enter an SMTP port between 1 and 65535.")
  if (!username || username.length > 512) invalid("smtp.username", "Enter an SMTP username.")
  if (typeof password !== "string" || !password || password.length > 512) invalid("smtp.password", "Enter an SMTP password.")
  return { kind: "smtp", host, port, username, password, secure: input.secure ?? existing?.secure ?? port === 465 }
}

function sendGridCredential(input: SendGridSenderInput, existing?: SendGridCredential): SendGridCredential {
  const apiKey = (input.apiKey ?? existing?.apiKey)?.trim()
  if (!apiKey || apiKey.length < 8 || apiKey.length > 512) invalid("sendgrid.apiKey", "Enter a SendGrid API key between 8 and 512 characters.")
  return { kind: "sendgrid", apiKey }
}

function credentialForCreate(provider: SenderProvider, input: CreateSenderInput): StoredSenderCredential | undefined {
  if (provider === "smtp") {
    if (!input.smtp) invalid("smtp", "Enter SMTP host, port, username, and password.")
    return smtpCredential(input.smtp)
  }
  if (provider === "sendgrid") {
    if (!input.sendgrid) invalid("sendgrid", "Enter a SendGrid API key.")
    return sendGridCredential(input.sendgrid)
  }
  return undefined
}

function mergeCredential(sender: StoredEmailSender, input: UpdateSenderInput): StoredSenderCredential | undefined {
  const current = sender.credentialCipher ? decryptSenderCredential(sender.workspaceId, sender.credentialCipher) : undefined
  if (sender.provider === "smtp") {
    if (!input.smtp) return current
    const existing = current?.kind === "smtp" ? current : undefined
    return smtpCredential({
      host: input.smtp.host ?? existing?.host ?? "",
      port: input.smtp.port ?? existing?.port ?? 0,
      username: input.smtp.username ?? existing?.username ?? "",
      password: input.smtp.password ?? existing?.password ?? "",
      secure: input.smtp.secure,
    }, existing)
  }
  if (sender.provider === "sendgrid") {
    if (!input.sendgrid) return current
    const existing = current?.kind === "sendgrid" ? current : undefined
    return sendGridCredential({ apiKey: input.sendgrid.apiKey ?? existing?.apiKey ?? "" }, existing)
  }
  return current
}

function reconnectFor(sender: EmailSender): SenderReconnect | undefined {
  if (sender.state === "expired" || sender.state === "revoked") {
    return { available: true, method: sender.provider === "google" || sender.provider === "microsoft" ? "oauth" : "credentials" }
  }
  if (sender.state === "pending" && (sender.provider === "google" || sender.provider === "microsoft")) {
    return { available: true, method: "oauth" }
  }
  return undefined
}

function toConnection(record: StoredEmailSender): SenderConnection {
  const sender = toPublicSender(record)
  const reconnect = reconnectFor(sender)
  return reconnect ? { ...sender, reconnect } : sender
}

async function audit(actor: DealActor, action: string, sender: StoredEmailSender | EmailSender, extra: Record<string, unknown> = {}): Promise<void> {
  await recordAuditEvent({
    context: actor,
    action,
    resourceType: "email_sender",
    resourceId: sender.id,
    metadata: {
      provider: sender.provider,
      purpose: sender.purpose,
      state: sender.state,
      hasCredential: "hasCredential" in sender ? sender.hasCredential : Boolean((sender as StoredEmailSender).credentialCipher),
      ...extra,
    },
    correlationId: actor.correlationId,
  })
}

export async function listSenders(actor: DealActor): Promise<SenderListResult> {
  const stored = await listSendersByWorkspace(actor.workspaceId)
  return {
    senders: stored.filter((sender) => canView(actor, sender)).map(toConnection),
    oauth: { google: senderOAuthConfigured("google"), microsoft: senderOAuthConfigured("microsoft") },
    canManage: isAdmin(actor),
  }
}

export async function getSender(actor: DealActor, senderId: string): Promise<SenderConnection> {
  return toConnection(assertCanView(actor, await findSenderById(actor.workspaceId, senderId)))
}

export async function createSender(actor: DealActor, input: CreateSenderInput): Promise<SenderConnection> {
  assertAdmin(actor)
  const provider = asProvider(input.provider)
  const purpose = asPurpose(input.purpose)
  const fromName = asFromName(input.fromName)
  const fromAddress = asFromAddress(input.fromAddress)
  const signature = asSignature(input.signature)
  const memberIds = await normalizeMemberIds(actor.workspaceId, asMemberIds(input.memberIds))
  const credential = credentialForCreate(provider, input)
  const now = nowIso()
  const id = newId()
  const stored = await withTransaction(async (executor) => {
    if (input.isDefault) await clearDefaultSenders(actor.workspaceId, purpose, id, now, executor)
    return insertSender({
      id,
      workspaceId: actor.workspaceId,
      provider,
      purpose,
      fromName,
      fromAddress,
      signature: signature ?? null,
      credentialCipher: credential ? encryptSenderCredential(actor.workspaceId, credential) : null,
      state: "pending",
      isDefault: Boolean(input.isDefault),
      createdByUserId: actor.userId,
      createdAt: now,
      updatedAt: now,
      memberIds,
    }, executor)
  })
  await audit(actor, "sender.created", stored)
  return toConnection(stored)
}

export async function updateSender(actor: DealActor, senderId: string, input: UpdateSenderInput): Promise<SenderConnection> {
  assertAdmin(actor)
  const current = assertCanView(actor, await findSenderById(actor.workspaceId, senderId))
  if (input.revoke) return revokeSender(actor, senderId)
  const memberIds = input.memberIds !== undefined ? await normalizeMemberIds(actor.workspaceId, asMemberIds(input.memberIds)) : undefined
  const credential = mergeCredential(current, input)
  const replacedCredential = Boolean(input.smtp || input.sendgrid)
  const now = nowIso()
  let state = current.state
  if (replacedCredential && (current.state === "expired" || current.state === "revoked")) state = "pending"
  const stored = await withTransaction(async (executor) => {
    if (input.isDefault) await clearDefaultSenders(actor.workspaceId, current.purpose, current.id, now, executor)
    return updateSenderRecord({
      id: current.id,
      workspaceId: actor.workspaceId,
      fromName: input.fromName !== undefined ? asFromName(input.fromName) : undefined,
      fromAddress: input.fromAddress !== undefined ? asFromAddress(input.fromAddress) : undefined,
      signature: input.signature === undefined ? undefined : asSignature(input.signature) ?? null,
      credentialCipher: replacedCredential && credential ? encryptSenderCredential(actor.workspaceId, credential) : undefined,
      state,
      isDefault: input.isDefault,
      lastError: replacedCredential ? null : undefined,
      updatedAt: now,
      memberIds,
    }, executor)
  })
  await audit(actor, "sender.updated", stored)
  return toConnection(stored)
}

export async function revokeSender(actor: DealActor, senderId: string): Promise<SenderConnection> {
  assertAdmin(actor)
  const current = assertCanView(actor, await findSenderById(actor.workspaceId, senderId))
  const stored = await updateSenderRecord({
    id: current.id,
    workspaceId: actor.workspaceId,
    state: "revoked",
    isDefault: false,
    lastError: "Sender connection revoked.",
    updatedAt: nowIso(),
  })
  await audit(actor, "sender.revoked", stored)
  return toConnection(stored)
}

export async function setDefaultSender(actor: DealActor, senderId: string): Promise<SenderConnection> {
  return updateSender(actor, senderId, { isDefault: true })
}

function assertTestable(sender: StoredEmailSender): void {
  if (sender.state === "revoked") {
    throw new AppError(409, "sender_revoked", "This sender was revoked. Reconnect or restore it before sending.")
  }
  if (sender.state === "expired") {
    throw new AppError(409, "sender_expired", "This sender connection expired. Reconnect to resume sending.")
  }
  if ((sender.provider === "google" || sender.provider === "microsoft") && !sender.credentialCipher) {
    throw new AppError(409, "sender_not_usable", "Finish connecting this sender before sending a test.")
  }
  if ((sender.provider === "smtp" || sender.provider === "sendgrid") && !sender.credentialCipher) {
    throw new AppError(409, "sender_not_usable", "Save SMTP or SendGrid credentials before sending a test.")
  }
}

export async function testSend(actor: DealActor, senderId: string, input: { to?: string } = {}): Promise<SenderTestSendResult> {
  const sender = assertCanUse(actor, await findSenderById(actor.workspaceId, senderId))
  assertTestable(sender)
  const recipient = asRecipient(input.to, sender.fromAddress)
  const result = await deliverSenderTest({
    workspaceId: actor.workspaceId,
    senderId: sender.id,
    provider: sender.provider,
    purpose: sender.purpose,
    fromName: sender.fromName,
    fromAddress: sender.fromAddress,
    recipient,
  })
  if (result.delivery === "sent" || result.delivery === "preview") {
    const now = nowIso()
    await updateSenderRecord({
      id: sender.id,
      workspaceId: actor.workspaceId,
      state: "verified",
      verifiedAt: now,
      lastError: null,
      updatedAt: now,
    })
  } else {
    await updateSenderRecord({
      id: sender.id,
      workspaceId: actor.workspaceId,
      lastError: result.error ?? "Test send failed.",
      updatedAt: nowIso(),
    })
  }
  await audit(actor, "sender.test_sent", sender, { delivery: result.delivery })
  return result
}

export async function startSenderOAuth(actor: DealActor, senderId: string): Promise<SenderOAuthStart> {
  assertAdmin(actor)
  const sender = assertCanView(actor, await findSenderById(actor.workspaceId, senderId))
  if (sender.provider !== "google" && sender.provider !== "microsoft") {
    invalid("provider", "OAuth is only available for Google and Microsoft senders.")
  }
  senderOAuthConfig(sender.provider)
  const state = createOpaqueToken()
  const now = nowIso()
  await saveOauthState({
    stateHash: hashOpaqueToken(state),
    workspaceId: actor.workspaceId,
    senderId: sender.id,
    provider: sender.provider,
    purpose: sender.purpose,
    expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
    createdAt: now,
  })
  await audit(actor, "sender.oauth_started", sender)
  return {
    authorizationUrl: senderAuthorizationUrl(sender.provider, state),
    sender: toConnection(sender),
  }
}

export async function completeSenderOAuth(actor: DealActor, input: { state: string; code: string }): Promise<SenderConnection> {
  assertAdmin(actor)
  const pending = await consumeOauthState(actor.workspaceId, hashOpaqueToken(input.state), nowIso())
  if (!pending) throw new AppError(403, "sender_oauth_state", "The email sender authorization link expired or was already used. Start again.")
  const sender = await findSenderById(actor.workspaceId, pending.senderId)
  if (!sender || (sender.provider !== "google" && sender.provider !== "microsoft")) {
    throw new AppError(403, "sender_oauth_state", "The email sender authorization link expired or was already used. Start again.")
  }
  const existing = sender.credentialCipher ? decryptSenderCredential(sender.workspaceId, sender.credentialCipher) : undefined
  const previous = existing?.kind === "oauth" ? existing : undefined
  const credential = await exchangeSenderAuthorizationCode(sender.provider, input.code, previous)
  const now = nowIso()
  const stored = await updateSenderRecord({
    id: sender.id,
    workspaceId: actor.workspaceId,
    fromAddress: sender.fromAddress || credential.email,
    credentialCipher: encryptSenderCredential(actor.workspaceId, credential),
    state: "verified",
    verifiedAt: now,
    lastError: null,
    updatedAt: now,
  })
  await audit(actor, "sender.oauth_connected", stored)
  return toConnection(stored)
}

export async function expireSender(actor: DealActor, senderId: string, lastError = "The sender connection expired. Reconnect to resume sending."): Promise<SenderConnection> {
  assertAdmin(actor)
  const current = assertCanView(actor, await findSenderById(actor.workspaceId, senderId))
  const stored = await updateSenderRecord({
    id: current.id,
    workspaceId: actor.workspaceId,
    state: "expired",
    lastError,
    updatedAt: nowIso(),
  })
  await audit(actor, "sender.expired", stored)
  return toConnection(stored)
}

export async function assertSenderUsable(actor: DealActor, senderId: string, purpose: SenderPurpose): Promise<EmailSender> {
  const sender = assertCanUse(actor, await findSenderById(actor.workspaceId, senderId))
  if (sender.purpose !== purpose) {
    throw new AppError(422, "sender_purpose_mismatch", "That sender is not assigned to this purpose.")
  }
  if (sender.state === "expired") {
    throw new AppError(409, "sender_expired", "This sender connection expired. Reconnect to resume sending.")
  }
  if (sender.state === "revoked") {
    throw new AppError(409, "sender_revoked", "This sender was revoked. Reconnect or restore it before sending.")
  }
  if (sender.state !== "verified" || !sender.credentialCipher) {
    throw new AppError(409, "sender_not_usable", "This sender is not verified for sending.")
  }
  return toPublicSender(sender)
}

export function oauthStatus(): { google: boolean; microsoft: boolean } {
  return { google: senderOAuthConfigured("google"), microsoft: senderOAuthConfigured("microsoft") }
}
