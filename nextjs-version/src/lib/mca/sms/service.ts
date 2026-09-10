import "server-only"
import { managedConfig, managedReady, reserveManagedSend, smsRecipientHash } from "./managed"
import { persistInbound, rememberOutbound } from "./inbox"

import { createHash } from "node:crypto"
import { AppError } from "../errors"
import { decryptSensitive, encryptSensitive } from "../crypto"
import { getDatabase, newId, nowIso, recordAuditEvent, withImmediateTransaction, type DbExecutor } from "../db"
import { getDealForDocument } from "../deals/service"
import type { DealActor } from "../deals/schema"
import type { SmsAccount, SmsAccountState, SmsDeliveryResult, SmsMessage, SmsMessageState, SmsProvider, SmsRoute, SmsSenderKind } from "./contracts"
import { SMS_PROVIDERS } from "./contracts"
import { getSmsAdapter } from "./adapters/registry"
import { type TwilioSmsTransport, validateTwilioFormSignature } from "./twilio"

type Row = Record<string, string | number | null>
const e164Pattern = /^\+[1-9]\d{7,14}$/
const messagingServicePattern = /^MG[0-9a-fA-F]{32}$/
const accountSidPattern = /^AC[0-9a-fA-F]{32}$/
const apiKeySidPattern = /^SK[0-9a-fA-F]{32}$/
const credentialRefPattern = /^[A-Z][A-Z0-9_]{0,39}$/
const idempotencyPattern = /^[A-Za-z0-9._:-]{1,160}$/

type TwilioConfig = { accountSid: string; apiKeySid: string; apiKeySecret: string; authToken: string; publicBaseUrl: string; messagingServiceSid?: string }
type TwilioEnvironmentAccount = { accountSid?: unknown; apiKeySid?: unknown; apiKeySecret?: unknown; authToken?: unknown; allowedSenders?: unknown }

function required(value: string | undefined, field: string, max: number): string {
  const normalized = value?.trim()
  if (!normalized || normalized.length > max) throw new AppError(422, "validation_failed", "Review the highlighted fields.", { [field]: [`${field} is required and must be at most ${max} characters.`] })
  return normalized
}

function stableKey(value: string): string {
  if (!idempotencyPattern.test(value)) throw new AppError(422, "invalid_idempotency_key", "Provide a stable idempotency key using letters, numbers, period, underscore, colon, or hyphen.")
  return value
}

export function normalizeSmsRecipient(value: string): string {
  const trimmed = value.trim()
  if (e164Pattern.test(trimmed)) return trimmed
  const digits = trimmed.replace(/\D/g, "")
  const normalized = digits.length === 10 ? `+1${digits}` : trimmed.startsWith("+") ? `+${digits}` : ""
  if (!e164Pattern.test(normalized)) throw new AppError(422, "recipient_invalid", "Enter a merchant mobile number in E.164 format, such as +12125551212.")
  return normalized
}

function normalizeSender(value: string, kind: SmsSenderKind): string {
  const normalized = value.trim()
  if (kind === "phone_number") return normalizeSmsRecipient(normalized)
  if (!messagingServicePattern.test(normalized)) throw new AppError(422, "sender_invalid", "Enter a Twilio Messaging Service SID beginning with MG.")
  return normalized
}

function recipientHash(workspaceId: string, recipient: string): string {
  return createHash("sha256").update(`${workspaceId}\0${recipient}`).digest("hex")
}

function contentHash(value: unknown): string { return createHash("sha256").update(JSON.stringify(value)).digest("hex") }
function maskPhone(value: string): string { return `•••${value.replace(/\D/g, "").slice(-4)}` }
function maskSender(value: string, kind: SmsSenderKind): string { return kind === "phone_number" ? maskPhone(value) : `MG••••${value.slice(-6)}` }

function asSmsProvider(value: unknown): SmsProvider {
  const provider = String(value)
  if ((SMS_PROVIDERS as readonly string[]).includes(provider)) return provider as SmsProvider
  throw new AppError(422, "sms_provider_unsupported", "That SMS provider is not supported.")
}

function adapterEnvironment(): "development" | "production" {
  return process.env.NODE_ENV === "production" ? "production" : "development"
}

function adapterRegistered(provider: SmsProvider): boolean {
  const result = getSmsAdapter(provider).validate({})
  return result.ok || result.fields.provider !== "This SMS provider is not registered yet."
}

function parsedCredentialRecord(value: string): Record<string, string> {
  try {
    const parsed = JSON.parse(value) as unknown
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {}
    const credentials: Record<string, string> = {}
    for (const [key, item] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof key === "string" && typeof item === "string" && item) credentials[key] = item
    }
    return credentials
  } catch {
    return {}
  }
}

async function structuredAdapterCredentials(workspaceId: string, provider: SmsProvider): Promise<Record<string, string>> {
  if (provider === "twilio") return {}
  try {
    const row = await getDatabase().prepare<{ payload_cipher: string }>(
      "SELECT payload_cipher FROM mca_sms_adapter_credentials WHERE workspace_id=? AND provider=? AND environment=?",
    ).get(workspaceId, provider, adapterEnvironment())
    if (!row) return {}
    return parsedCredentialRecord(decryptSensitive(String(row.payload_cipher), workspaceId))
  } catch {
    return {}
  }
}

async function twilioSendCredentials(workspaceId: string, credentialRef: string, senderIdentity: string): Promise<Record<string, string>> {
  const config = await twilioConfig(workspaceId, credentialRef, senderIdentity)
  if (!config) return {}
  return { accountSid: config.accountSid, apiKeySid: config.apiKeySid, apiKeySecret: config.apiKeySecret, ...(config.messagingServiceSid ? { messagingServiceSid: config.messagingServiceSid } : {}) }
}

async function twilioStatusCallbackUrl(workspaceId: string, credentialRef: string, senderIdentity: string, accountId: string, messageId: string): Promise<string> {
  const config = await twilioConfig(workspaceId, credentialRef, senderIdentity)
  if (!config) return ""
  return `${config.publicBaseUrl}/api/mca/sms/webhooks/twilio/${encodeURIComponent(accountId)}/status?messageId=${encodeURIComponent(messageId)}`
}

async function isAccountConfigured(workspaceId: string, provider: SmsProvider, credentialRef: string, senderIdentity: string, structuredReady = false): Promise<boolean> {
  if (provider === "twilio") return Boolean(await twilioConfig(workspaceId, credentialRef, senderIdentity))
  return adapterRegistered(provider) && structuredReady
}

async function dispatchOutboundSms(input: {
  actor: DealActor
  accountRow: Row
  route: SmsRoute
  messageId: string
  recipient: string
  body: string
  correlationId: string
  transport?: TwilioSmsTransport
}): Promise<SmsDeliveryResult> {
  const provider = asSmsProvider(input.accountRow.provider)
  const credentialRef = String(input.accountRow.credential_ref)
  if (input.transport && provider === "twilio") {
    const config = await twilioConfig(input.actor.workspaceId, credentialRef, input.route.senderIdentity)
    if (!config) return { state: "failed", errorCode: "twilio_unconfigured", errorMessage: "Twilio is not configured for this SMS account." }
    return input.transport.send({
      accountSid: config.accountSid,
      apiKeySid: config.apiKeySid,
      apiKeySecret: config.apiKeySecret,
      messagingServiceSid: config.messagingServiceSid,
      senderKind: input.route.senderKind,
      senderIdentity: input.route.senderIdentity,
      recipient: input.recipient,
      body: input.body,
      statusCallbackUrl: await twilioStatusCallbackUrl(input.actor.workspaceId, credentialRef, input.route.senderIdentity, input.route.accountId, input.messageId),
      correlationId: input.correlationId,
    })
  }
  const credentials = provider === "twilio"
    ? await twilioSendCredentials(input.actor.workspaceId, credentialRef, input.route.senderIdentity)
    : await structuredAdapterCredentials(input.actor.workspaceId, provider)
  return getSmsAdapter(provider).send({
    account: await account(input.accountRow, []),
    senderKind: input.route.senderKind,
    senderIdentity: input.route.senderIdentity,
    recipient: input.recipient,
    body: input.body,
    statusCallbackUrl: provider === "twilio" ? await twilioStatusCallbackUrl(input.actor.workspaceId, credentialRef, input.route.senderIdentity, input.route.accountId, input.messageId) : "",
    correlationId: input.correlationId,
    credentials,
  })
}

async function twilioConfig(workspaceId: string, reference: string, senderIdentity?: string): Promise<TwilioConfig | undefined> {
  if (reference === "MANAGED") return managedConfig(workspaceId, senderIdentity)
  if (process.env.MCA_SMS_PROVIDER !== "twilio") return undefined
  let configured: TwilioEnvironmentAccount | undefined
  try {
    const workspaces = JSON.parse(process.env.MCA_SMS_TWILIO_ACCOUNTS_JSON ?? "{}") as Record<string, Record<string, TwilioEnvironmentAccount>>
    configured = workspaces[workspaceId]?.[reference]
  } catch { return undefined }
  const accountSid = typeof configured?.accountSid === "string" ? configured.accountSid.trim() : ""
  const apiKeySid = typeof configured?.apiKeySid === "string" ? configured.apiKeySid.trim() : ""
  const apiKeySecret = typeof configured?.apiKeySecret === "string" ? configured.apiKeySecret.trim() : ""
  const authToken = typeof configured?.authToken === "string" ? configured.authToken.trim() : ""
  const allowedSenders = Array.isArray(configured?.allowedSenders) ? configured.allowedSenders.filter((value): value is string => typeof value === "string") : []
  let publicBaseUrl = ""
  try {
    const parsed = new URL(process.env.MCA_SMS_PUBLIC_BASE_URL?.trim() ?? "")
    if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.search || parsed.hash || parsed.pathname !== "/") return undefined
    publicBaseUrl = parsed.origin
  } catch { return undefined }
  if (!accountSidPattern.test(accountSid) || !apiKeySidPattern.test(apiKeySid) || !apiKeySecret || !authToken || (senderIdentity && !allowedSenders.includes(senderIdentity))) return undefined
  return { accountSid, apiKeySid, apiKeySecret, authToken, publicBaseUrl }
}

async function account(row: Row, memberIds: string[], structuredReady = false): Promise<SmsAccount> {
  const workspaceId = String(row.workspace_id)
  const provider = asSmsProvider(row.provider)
  const kind = String(row.sender_kind) as SmsSenderKind
  const senderIdentity = decryptSensitive(String(row.sender_identity_cipher), workspaceId)
  return {
    id: String(row.id), workspaceId, provider, label: String(row.label), senderKind: kind,
    senderMasked: maskSender(senderIdentity, kind), credentialRef: String(row.credential_ref),
    state: String(row.state) as SmsAccountState, isDefault: Number(row.is_default) === 1, memberIds,
    providerConfigured: row.credential_ref === "MANAGED" ? await managedReady(workspaceId, String(row.id)) : await isAccountConfigured(workspaceId, provider, String(row.credential_ref), senderIdentity, structuredReady), createdAt: String(row.created_at), updatedAt: String(row.updated_at),
  }
}

function message(row: Row): SmsMessage {
  const workspaceId = String(row.workspace_id), sender = decryptSensitive(String(row.sender_identity_cipher), workspaceId), recipient = decryptSensitive(String(row.recipient_cipher), workspaceId)
  return {
    id: String(row.id), dealId: String(row.deal_id), accountId: String(row.account_id), provider: asSmsProvider(row.provider),
    senderMasked: sender.startsWith("MG") ? maskSender(sender, "messaging_service") : maskPhone(sender), recipientMasked: maskPhone(recipient),
    state: String(row.state) as SmsMessageState, providerStatus: row.provider_status ? String(row.provider_status) : undefined,
    externalId: row.provider_message_id ? String(row.provider_message_id) : undefined, errorCode: row.error_code ? String(row.error_code) : undefined,
    errorMessage: row.error_message ? String(row.error_message) : undefined, correlationId: String(row.correlation_id),
    acceptedAt: row.accepted_at ? String(row.accepted_at) : undefined, deliveredAt: row.delivered_at ? String(row.delivered_at) : undefined,
    createdAt: String(row.created_at), updatedAt: String(row.updated_at),
  }
}

function assertAdmin(actor: DealActor): void {
  if (actor.source !== "user" || !["admin", "super_admin"].includes(actor.role ?? "")) throw new AppError(403, "sms_admin_required", "SMS account settings require a workspace administrator.")
}

async function assertMembers(database: DbExecutor, workspaceId: string, memberIds: readonly string[]): Promise<void> {
  if (!memberIds.length) throw new AppError(422, "sms_members_required", "Assign at least one active workspace member to this SMS account.")
  const unique = [...new Set(memberIds)]
  const rows = await database.prepare<{ id: string }>("SELECT id FROM memberships WHERE workspace_id=? AND status='active' AND id=ANY(?::text[])").all(workspaceId, unique)
  if (rows.length !== unique.length) throw new AppError(422, "sms_member_invalid", "Every assigned SMS user must be an active workspace member.")
}

export async function listSmsAccounts(actor: DealActor): Promise<{ accounts: SmsAccount[]; canManage: boolean }> {
  const administrative = actor.source === "user" && ["admin", "super_admin"].includes(actor.role ?? "")
  const rows = administrative
    ? await getDatabase().prepare<Row>("SELECT * FROM mca_sms_accounts WHERE workspace_id=? ORDER BY is_default DESC,lower(label),id").all(actor.workspaceId)
    : actor.membershipId ? await getDatabase().prepare<Row>(`SELECT a.* FROM mca_sms_accounts a JOIN mca_sms_account_members am ON am.workspace_id=a.workspace_id AND am.account_id=a.id
      WHERE a.workspace_id=? AND a.state='active' AND am.membership_id=? ORDER BY a.is_default DESC,lower(a.label),a.id`).all(actor.workspaceId, actor.membershipId) : []
  const members = rows.length ? await getDatabase().prepare<{ account_id: string; membership_id: string }>("SELECT account_id,membership_id FROM mca_sms_account_members WHERE workspace_id=? AND account_id=ANY(?::text[]) ORDER BY membership_id").all(actor.workspaceId, rows.map((row) => String(row.id))) : []
  const structured = rows.some((row) => String(row.provider) !== "twilio")
    ? new Set((await getDatabase().prepare<{ provider: string }>("SELECT DISTINCT provider FROM mca_sms_adapter_credentials WHERE workspace_id=? AND environment=?").all(actor.workspaceId, adapterEnvironment())).map((item) => String(item.provider)))
    : new Set<string>()
  return { accounts: await Promise.all(rows.map((row) => account(row, members.filter((item) => item.account_id === row.id).map((item) => item.membership_id), structured.has(String(row.provider))))), canManage: administrative }
}

export async function createSmsAccount(actor: DealActor, input: { label: string; senderKind: SmsSenderKind; senderIdentity: string; credentialRef: string; memberIds: string[]; isDefault?: boolean }): Promise<SmsAccount> {
  assertAdmin(actor)
  const label = required(input.label, "label", 100), credentialRef = input.credentialRef?.trim().toUpperCase()
  if (!credentialRefPattern.test(credentialRef)) throw new AppError(422, "credential_ref_invalid", "Use an uppercase credential reference containing letters, numbers, or underscores.")
  if (input.credentialRef === "MANAGED") throw new AppError(422,"reserved_credential","This reference is reserved for provisioned numbers.")
  const senderIdentity = normalizeSender(input.senderIdentity, input.senderKind)
  return withImmediateTransaction(async (database) => {
    await assertMembers(database, actor.workspaceId, input.memberIds)
    const now = nowIso(), id = newId()
    if (input.isDefault) await database.prepare("UPDATE mca_sms_accounts SET is_default=0,updated_at=? WHERE workspace_id=? AND is_default=1").run(now, actor.workspaceId)
    let row: Row | undefined
    try {
      row = await database.prepare<Row>(`INSERT INTO mca_sms_accounts
        (id,workspace_id,provider,label,sender_kind,sender_identity_cipher,credential_ref,state,is_default,created_by_user_id,created_at,updated_at)
        VALUES (?,?,'twilio',?,?,?,?, 'active',?,?,?,?) RETURNING *`).get(id, actor.workspaceId, label, input.senderKind, encryptSensitive(senderIdentity, actor.workspaceId), credentialRef, input.isDefault ? 1 : 0, actor.userId, now, now)
    } catch (error) {
      if ((error as { code?: string }).code === "23505") throw new AppError(409, "sms_account_label_conflict", "An SMS account already uses that label.")
      throw error
    }
    for (const memberId of new Set(input.memberIds)) await database.prepare("INSERT INTO mca_sms_account_members (workspace_id,account_id,membership_id,assigned_at,assigned_by_user_id) VALUES (?,?,?,?,?)").run(actor.workspaceId, id, memberId, now, actor.userId)
    await recordAuditEvent({ context: actor, action: "sms.account_created", resourceType: "sms_account", resourceId: id, metadata: { provider: "twilio", senderKind: input.senderKind, memberCount: new Set(input.memberIds).size, providerConfigured: Boolean(await twilioConfig(actor.workspaceId, credentialRef, senderIdentity)) }, correlationId: actor.correlationId, executor: database })
    return account(row!, [...new Set(input.memberIds)])
  })
}

export async function updateSmsAccount(actor: DealActor, id: string, input: { memberIds?: string[]; isDefault?: boolean; state?: SmsAccountState }): Promise<SmsAccount> {
  assertAdmin(actor)
  return withImmediateTransaction(async (database) => {
    const existing = await database.prepare<Row>("SELECT * FROM mca_sms_accounts WHERE workspace_id=? AND id=? FOR UPDATE").get(actor.workspaceId, id)
    if (!existing) throw new AppError(404, "sms_account_not_found", "The SMS account was not found.")
    if (existing.credential_ref === "MANAGED" && (input.memberIds || input.state)) throw new AppError(409,"managed_number_settings","Use company number management to reassign or release this sender.")
    if (input.memberIds) await assertMembers(database, actor.workspaceId, input.memberIds)
    const now = nowIso(), nextState = input.state ?? String(existing.state)
    const nextDefault = nextState === "revoked" ? false : input.isDefault ?? Number(existing.is_default) === 1
    if (input.isDefault) await database.prepare("UPDATE mca_sms_accounts SET is_default=0,updated_at=? WHERE workspace_id=? AND id<>? AND is_default=1").run(now, actor.workspaceId, id)
    const row = await database.prepare<Row>("UPDATE mca_sms_accounts SET state=?,is_default=?,updated_at=? WHERE workspace_id=? AND id=? RETURNING *").get(nextState, nextDefault ? 1 : 0, now, actor.workspaceId, id)
    if (input.memberIds) {
      await database.prepare("DELETE FROM mca_sms_account_members WHERE workspace_id=? AND account_id=?").run(actor.workspaceId, id)
      for (const memberId of new Set(input.memberIds)) await database.prepare("INSERT INTO mca_sms_account_members (workspace_id,account_id,membership_id,assigned_at,assigned_by_user_id) VALUES (?,?,?,?,?)").run(actor.workspaceId, id, memberId, now, actor.userId)
    }
    const memberRows = await database.prepare<{ membership_id: string }>("SELECT membership_id FROM mca_sms_account_members WHERE workspace_id=? AND account_id=? ORDER BY membership_id").all(actor.workspaceId, id)
    await recordAuditEvent({ context: actor, action: "sms.account_updated", resourceType: "sms_account", resourceId: id, metadata: { state: nextState, isDefault: nextDefault, memberCount: memberRows.length }, correlationId: actor.correlationId, executor: database })
    return account(row!, memberRows.map((item) => item.membership_id))
  })
}

export async function resolveSmsRoute(actor: DealActor, input: { dealId: string; senderAccountId?: string }): Promise<SmsRoute> {
  await getDealForDocument(actor, input.dealId)
  const administrative = actor.source === "user" && ["admin", "super_admin"].includes(actor.role ?? "")
  let row: Row | undefined
  if (input.senderAccountId) {
    row = await getDatabase().prepare<Row>("SELECT * FROM mca_sms_accounts WHERE workspace_id=? AND id=? AND state='active'").get(actor.workspaceId, input.senderAccountId)
    if (!row) throw new AppError(404, "sms_account_not_found", "The selected SMS account is unavailable.")
    if (!administrative) {
      const assignment = actor.membershipId ? await getDatabase().prepare<Row>("SELECT account_id FROM mca_sms_account_members WHERE workspace_id=? AND account_id=? AND membership_id=?").get(actor.workspaceId, row.id, actor.membershipId) : undefined
      if (!assignment) throw new AppError(403, "sms_account_not_assigned", "You cannot send through an unassigned SMS account.")
    }
  } else if (administrative) {
    row = await getDatabase().prepare<Row>("SELECT * FROM mca_sms_accounts WHERE workspace_id=? AND state='active' ORDER BY is_default DESC,lower(label),id LIMIT 1").get(actor.workspaceId)
  } else if (actor.membershipId) {
    row = await getDatabase().prepare<Row>(`SELECT a.* FROM mca_sms_accounts a JOIN mca_sms_account_members am ON am.workspace_id=a.workspace_id AND am.account_id=a.id
      WHERE a.workspace_id=? AND a.state='active' AND am.membership_id=? ORDER BY a.is_default DESC,lower(a.label),a.id LIMIT 1`).get(actor.workspaceId, actor.membershipId)
  }
  if (!row) throw new AppError(409, "sms_route_unavailable", "No assigned SMS account is available. Ask an administrator to assign one in Settings.")
  const provider = asSmsProvider(row.provider)
  const senderIdentity = decryptSensitive(String(row.sender_identity_cipher), actor.workspaceId)
  if (row.credential_ref === "MANAGED" && !await managedReady(actor.workspaceId, String(row.id))) throw new AppError(409,"sms_setup_incomplete","SMS is awaiting company or carrier approval, or an active employee number.")
  const structuredReady = provider !== "twilio" && Object.keys(await structuredAdapterCredentials(actor.workspaceId, provider)).length > 0
  return { accountId: String(row.id), provider, senderKind: String(row.sender_kind) as SmsSenderKind, senderIdentity, providerConfigured: await isAccountConfigured(actor.workspaceId, provider, String(row.credential_ref), senderIdentity, structuredReady) }
}

async function assertRecipient(actor: DealActor, dealId: string, recipient: string): Promise<string> {
  const deal = await getDealForDocument(actor, dealId)
  const normalized = normalizeSmsRecipient(recipient)
  if (!deal.contactPhone || normalizeSmsRecipient(deal.contactPhone) !== normalized) throw new AppError(422, "recipient_deal_mismatch", "The mobile recipient must match the merchant phone saved on this deal.")
  return normalized
}

export async function recordSmsConsent(actor: DealActor, input: { dealId: string; recipient: string; state: "opted_in" | "opted_out"; evidence: string; effectiveAt?: string; idempotencyKey: string }) {
  const recipient = await assertRecipient(actor, input.dealId, input.recipient), evidence = required(input.evidence, "evidence", 500), key = stableKey(input.idempotencyKey)
  const effectiveAt = input.effectiveAt ?? nowIso()
  if (!Number.isFinite(Date.parse(effectiveAt))) throw new AppError(422, "consent_date_invalid", "Enter a valid consent date and time.")
  const id = newId(), createdAt = nowIso(), hash = recipientHash(actor.workspaceId, recipient)
  const inserted = await getDatabase().prepare<Row>(`INSERT INTO mca_sms_consent_events
    (id,workspace_id,deal_id,recipient_hash,recipient_cipher,state,source,evidence,idempotency_key,actor_user_id,effective_at,created_at)
    VALUES (?,?,?,?,?,?,'manual',?,?,?,?,?) ON CONFLICT (workspace_id,idempotency_key) DO NOTHING RETURNING *`).get(id, actor.workspaceId, input.dealId, hash, encryptSensitive(recipient, actor.workspaceId), input.state, evidence, key, actor.userId, effectiveAt, createdAt)
  const row = inserted ?? await getDatabase().prepare<Row>("SELECT * FROM mca_sms_consent_events WHERE workspace_id=? AND idempotency_key=?").get(actor.workspaceId, key)
  if (!row || row.deal_id !== input.dealId || row.recipient_hash !== hash || row.state !== input.state || row.evidence !== evidence) throw new AppError(409, "idempotency_conflict", "That retry key already identifies different SMS consent evidence.")
  if (inserted) await recordAuditEvent({ context: actor, action: `sms.consent_${input.state}`, resourceType: "deal", resourceId: input.dealId, metadata: { source: "manual", recipientMasked: maskPhone(recipient), effectiveAt }, correlationId: actor.correlationId })
  return { id: String(row.id), dealId: input.dealId, state: String(row.state), recipientMasked: maskPhone(recipient), evidence: String(row.evidence), effectiveAt: String(row.effective_at), created: Boolean(inserted) }
}

export async function getSmsConsent(actor: DealActor, dealId: string, recipient: string) {
  const normalized = await assertRecipient(actor, dealId, recipient)
  const suppression = await getDatabase().prepare<{state:string}>("SELECT state FROM sms_suppressions WHERE workspace_id=? AND recipient_hash=?").get(actor.workspaceId, smsRecipientHash(actor.workspaceId, normalizeSmsRecipient(recipient)))
  if (suppression?.state === "opted_out") return { state: "opted_out", source: "provider_webhook" }
  const row = await getDatabase().prepare<Row>(`SELECT * FROM mca_sms_consent_events WHERE workspace_id=? AND deal_id=? AND recipient_hash=?
    ORDER BY effective_at DESC,created_at DESC,id DESC LIMIT 1`).get(actor.workspaceId, dealId, recipientHash(actor.workspaceId, normalized))
  return row ? { id: String(row.id), state: String(row.state), source: String(row.source), recipientMasked: maskPhone(normalized), effectiveAt: String(row.effective_at) } : { state: "unknown", recipientMasked: maskPhone(normalized) }
}

function storedResult(row: Row): SmsDeliveryResult {
  const state = String(row.state)
  if (["accepted", "sent", "delivered"].includes(state) && row.provider_message_id) return { state: "accepted", messageId: String(row.id), externalId: String(row.provider_message_id) }
  if (state === "failed") return { state: "failed", messageId: String(row.id), errorCode: row.error_code ? String(row.error_code) : undefined, errorMessage: row.error_message ? String(row.error_message) : undefined }
  return { state: "unknown", messageId: String(row.id), errorCode: row.error_code ? String(row.error_code) : "provider_outcome_unknown", errorMessage: row.error_message ? String(row.error_message) : "The provider outcome is unknown. Check provider activity before retrying." }
}

export async function deliverClosingSms(actor: DealActor, input: { dealId: string; recipient: string; body: string; senderAccountId?: string; idempotencyKey: string; correlationId: string; payloadHash: string; deliveryMode: "never_attempted" | "reconcile_only" }, transport?: TwilioSmsTransport): Promise<SmsDeliveryResult> {
  const recipient = await assertRecipient(actor, input.dealId, input.recipient), body = required(input.body, "body", 1600), key = stableKey(input.idempotencyKey)
  if (input.deliveryMode === "reconcile_only") {
    const existing = await getDatabase().prepare<Row>("SELECT * FROM mca_sms_messages WHERE workspace_id=? AND idempotency_key=?").get(actor.workspaceId, key)
    if (!existing) return { state: "unknown", errorCode: "provider_outcome_unknown", errorMessage: "No provider attempt is recorded. Review the closing delivery before retrying." }
    const hash = contentHash({ dealId: input.dealId, accountId: String(existing.account_id), recipient, body, payloadHash: input.payloadHash })
    if (existing.content_hash !== hash) throw new AppError(409, "idempotency_conflict", "That retry key already identifies a different text message.")
    return storedResult(existing)
  }
  const consent = await getSmsConsent(actor, input.dealId, recipient)
  if (consent.state !== "opted_in") throw new AppError(409, consent.state === "opted_out" ? "sms_recipient_opted_out" : "sms_consent_required", consent.state === "opted_out" ? "This merchant opted out of text messages." : "Record merchant SMS consent before sending.")
  const route = await resolveSmsRoute(actor, { dealId: input.dealId, senderAccountId: input.senderAccountId })
  const hash = contentHash({ dealId: input.dealId, accountId: route.accountId, recipient, body, payloadHash: input.payloadHash })
  const prepared = await withImmediateTransaction(async (database) => {
    const existing = await database.prepare<Row>("SELECT * FROM mca_sms_messages WHERE workspace_id=? AND idempotency_key=? FOR UPDATE").get(actor.workspaceId, key)
    if (existing) {
      if (existing.content_hash !== hash) throw new AppError(409, "idempotency_conflict", "That retry key already identifies a different text message.")
      return { row: existing, created: false }
    }
    const accountRow = await database.prepare<Row>("SELECT * FROM mca_sms_accounts WHERE workspace_id=? AND id=? AND state='active' FOR UPDATE").get(actor.workspaceId, route.accountId)
    if (!accountRow) throw new AppError(409, "sms_route_unavailable", "The selected SMS account became unavailable.")
    const administrative = actor.source === "user" && ["admin", "super_admin"].includes(actor.role ?? "")
    if (!administrative) {
      const assignment = actor.membershipId ? await database.prepare<Row>("SELECT account_id FROM mca_sms_account_members WHERE workspace_id=? AND account_id=? AND membership_id=?").get(actor.workspaceId, route.accountId, actor.membershipId) : undefined
      if (!assignment) throw new AppError(403, "sms_account_not_assigned", "You cannot send through an unassigned SMS account.")
    }
    const latestConsent = await database.prepare<Row>(`SELECT state FROM mca_sms_consent_events WHERE workspace_id=? AND deal_id=? AND recipient_hash=?
      ORDER BY effective_at DESC,created_at DESC,id DESC LIMIT 1`).get(actor.workspaceId, input.dealId, recipientHash(actor.workspaceId, recipient))
    if (latestConsent?.state !== "opted_in") throw new AppError(409, latestConsent?.state === "opted_out" ? "sms_recipient_opted_out" : "sms_consent_required", latestConsent?.state === "opted_out" ? "This merchant opted out of text messages." : "Record merchant SMS consent before sending.")
    const now = nowIso(), id = newId()
    await reserveManagedSend(database, actor, route.accountId, id, body, recipient)
    const row = await database.prepare<Row>(`INSERT INTO mca_sms_messages
      (id,workspace_id,deal_id,account_id,provider,sender_identity_cipher,recipient_hash,recipient_cipher,body_cipher,content_hash,payload_hash,state,provider_message_id,provider_status,error_code,error_message,idempotency_key,correlation_id,actor_user_id,accepted_at,delivered_at,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,'pending',NULL,NULL,NULL,NULL,?,?,?,NULL,NULL,?,?) RETURNING *`).get(id, actor.workspaceId, input.dealId, route.accountId, route.provider, encryptSensitive(route.senderIdentity, actor.workspaceId), recipientHash(actor.workspaceId, recipient), encryptSensitive(recipient, actor.workspaceId), encryptSensitive(body, actor.workspaceId), hash, input.payloadHash, key, input.correlationId, actor.userId, now, now)
    return { row: row!, created: true, accountRow }
  })
  if (!prepared.created) return storedResult(prepared.row)
  await rememberOutbound(actor.workspaceId,route.accountId,input.dealId,recipient)
  const result = await dispatchOutboundSms({ actor, accountRow: prepared.accountRow!, route, messageId: String(prepared.row.id), recipient, body, correlationId: input.correlationId, transport })
  const now = nowIso()
  const saved = await getDatabase().prepare<Row>(`UPDATE mca_sms_messages SET state=?,provider_message_id=?,provider_status=?,error_code=?,error_message=?,accepted_at=?,updated_at=?
    WHERE workspace_id=? AND id=? AND state='pending' RETURNING *`).get(result.state, result.externalId ?? null, result.providerStatus ?? null, result.errorCode ?? null, result.errorMessage ?? null, result.state === "accepted" ? now : null, now, actor.workspaceId, prepared.row.id)
  const row = saved ?? await getDatabase().prepare<Row>("SELECT * FROM mca_sms_messages WHERE workspace_id=? AND id=?").get(actor.workspaceId, prepared.row.id)
  await recordAuditEvent({ context: actor, action: `sms.message_${result.state}`, resourceType: "sms_message", resourceId: String(prepared.row.id), metadata: { dealId: input.dealId, accountId: route.accountId, provider: route.provider, externalIdPresent: Boolean(result.externalId) }, correlationId: input.correlationId })
  return storedResult(row!)
}

export async function listSmsMessages(actor: DealActor, dealId: string): Promise<SmsMessage[]> {
  await getDealForDocument(actor, dealId)
  const rows = await getDatabase().prepare<Row>("SELECT m.* FROM mca_sms_messages m WHERE m.workspace_id=? AND m.deal_id=? AND (?::boolean OR EXISTS (SELECT 1 FROM mca_sms_account_members am JOIN memberships ms ON ms.id=am.membership_id AND ms.workspace_id=am.workspace_id WHERE am.workspace_id=m.workspace_id AND am.account_id=m.account_id AND am.membership_id=? AND ms.status='active')) ORDER BY m.created_at DESC,m.id DESC LIMIT 50").all(actor.workspaceId, dealId, actor.source === "user" && ["admin","super_admin"].includes(actor.role ?? ""), actor.membershipId)
  return rows.map(message)
}

export interface SmsComposerMessage extends SmsMessage {
  body: string
}

export interface SmsDirectPreview {
  dealId: string
  recipient: string
  recipientMasked: string
  body: string
  accountId: string
  provider: SmsProvider
  senderKind: SmsSenderKind
  senderMasked: string
  providerConfigured: boolean
  consentState: string
  canSend: boolean
  block?: { code: string; message: string }
}

export interface SmsComposerContext {
  dealId: string
  merchantName: string
  recipient: string | null
  recipientMasked: string | null
  consent: { id?: string; state: string; source?: string; recipientMasked?: string; effectiveAt?: string }
  accounts: SmsAccount[]
  messages: SmsComposerMessage[]
}

function dealRecipient(deal: { contactPhone?: string }): { recipient: string; recipientMasked: string } | null {
  if (!deal.contactPhone) return null
  try {
    const recipient = normalizeSmsRecipient(deal.contactPhone)
    return { recipient, recipientMasked: maskPhone(recipient) }
  } catch {
    return null
  }
}

export async function getSmsComposerContext(actor: DealActor, dealId: string): Promise<SmsComposerContext> {
  const deal = await getDealForDocument(actor, dealId)
  const mobile = dealRecipient(deal)
  const listed = await listSmsAccounts(actor)
  const accounts = listed.accounts.filter((item) => item.state === "active")
  const consent = mobile ? await getSmsConsent(actor, dealId, mobile.recipient) : { state: "unknown" as const, recipientMasked: undefined }
  const rows = await getDatabase().prepare<Row>("SELECT m.* FROM mca_sms_messages m WHERE m.workspace_id=? AND m.deal_id=? AND (?::boolean OR EXISTS (SELECT 1 FROM mca_sms_account_members am JOIN memberships ms ON ms.id=am.membership_id AND ms.workspace_id=am.workspace_id WHERE am.workspace_id=m.workspace_id AND am.account_id=m.account_id AND am.membership_id=? AND ms.status='active')) ORDER BY m.created_at DESC,m.id DESC LIMIT 50").all(actor.workspaceId, dealId, actor.source === "user" && ["admin","super_admin"].includes(actor.role ?? ""), actor.membershipId)
  return {
    dealId,
    merchantName: deal.dbaName || deal.legalName || deal.displayId,
    recipient: mobile?.recipient ?? null,
    recipientMasked: mobile?.recipientMasked ?? null,
    consent,
    accounts,
    messages: rows.map((row) => ({ ...message(row), body: decryptSensitive(String(row.body_cipher), actor.workspaceId) })),
  }
}

export async function previewDirectSms(actor: DealActor, input: { dealId: string; recipient: string; body: string; senderAccountId?: string }): Promise<SmsDirectPreview> {
  const recipient = await assertRecipient(actor, input.dealId, input.recipient)
  const body = required(input.body, "body", 1600)
  const consent = await getSmsConsent(actor, input.dealId, recipient)
  const route = await resolveSmsRoute(actor, { dealId: input.dealId, senderAccountId: input.senderAccountId })
  const block = consent.state === "opted_out"
    ? { code: "sms_recipient_opted_out", message: "This merchant opted out of text messages." }
    : consent.state !== "opted_in"
      ? { code: "sms_consent_required", message: "Record merchant SMS consent before sending." }
      : !route.providerConfigured
        ? { code: "sms_provider_unconfigured", message: "The assigned text messaging account is not ready. Ask an administrator to finish its provider setup in Settings." }
        : undefined
  return {
    dealId: input.dealId,
    recipient,
    recipientMasked: maskPhone(recipient),
    body,
    accountId: route.accountId,
    provider: route.provider,
    senderKind: route.senderKind,
    senderMasked: maskSender(route.senderIdentity, route.senderKind),
    providerConfigured: route.providerConfigured,
    consentState: consent.state,
    canSend: !block,
    block,
  }
}

async function webhookAccount(accountId: string): Promise<{ row: Row; config: TwilioConfig; workspaceId: string }> {
  const row = await getDatabase().prepare<Row>("SELECT * FROM mca_sms_accounts WHERE id=? AND provider='twilio'").get(accountId)
  if (!row) throw new AppError(404, "sms_account_not_found", "The SMS webhook route is unavailable.")
  const senderIdentity = decryptSensitive(String(row.sender_identity_cipher), String(row.workspace_id))
  const config = await twilioConfig(String(row.workspace_id), String(row.credential_ref), senderIdentity)
  if (!config) throw new AppError(503, "twilio_webhook_unconfigured", "Twilio webhook validation is not configured.")
  return { row, config, workspaceId: String(row.workspace_id) }
}

function assertWebhookSignature(config: TwilioConfig, signature: string | null, url: string, params: URLSearchParams): void {
  if (!validateTwilioFormSignature({ authToken: config.authToken, signature, url, params })) throw new AppError(401, "twilio_signature_invalid", "The Twilio webhook signature is invalid.")
}

function assertWebhookAccount(config: TwilioConfig, params: URLSearchParams): void {
  if (params.get("AccountSid")?.trim() !== config.accountSid) throw new AppError(401, "twilio_account_mismatch", "The Twilio webhook account does not match this SMS route.")
}

export async function processTwilioStatus(accountId: string, params: URLSearchParams, signature: string | null, requestUrl: string) {
  const { config, workspaceId } = await webhookAccount(accountId)
  const localMessageId = new URL(requestUrl).searchParams.get("messageId")?.trim() ?? ""
  if (!localMessageId || !idempotencyPattern.test(localMessageId)) throw new AppError(422, "twilio_status_invalid", "The SMS callback route is incomplete.")
  const canonicalUrl = `${config.publicBaseUrl}/api/mca/sms/webhooks/twilio/${encodeURIComponent(accountId)}/status?messageId=${encodeURIComponent(localMessageId)}`
  assertWebhookSignature(config, signature, canonicalUrl, params)
  assertWebhookAccount(config, params)
  const providerId = params.get("MessageSid")?.trim() ?? "", providerStatus = params.get("MessageStatus")?.trim().toLowerCase() ?? ""
  if (!/^(?:SM|MM)[0-9a-fA-F]{32}$/.test(providerId) || !providerStatus) throw new AppError(422, "twilio_status_invalid", "Twilio status data is incomplete.")
  const acceptedStatuses = ["accepted", "queued", "scheduled"], sentStatuses = ["sending", "sent"], failedStatuses = ["failed", "undelivered", "canceled"]
  if (![...acceptedStatuses, ...sentStatuses, ...failedStatuses, "delivered"].includes(providerStatus)) throw new AppError(422, "twilio_status_unsupported", "The Twilio message status is not supported.")
  const eventKey = contentHash([...params.entries()].sort(([a], [b]) => a.localeCompare(b)))
  return withImmediateTransaction(async (database) => {
    const row = await database.prepare<Row>("SELECT * FROM mca_sms_messages WHERE workspace_id=? AND account_id=? AND id=? FOR UPDATE").get(workspaceId, accountId, localMessageId)
    if (!row) throw new AppError(404, "sms_message_not_found", "No SMS message matches this provider identity.")
    if (row.provider_message_id && row.provider_message_id !== providerId) throw new AppError(409, "twilio_message_mismatch", "The Twilio message identity does not match this SMS delivery.")
    const callbackRecipient = normalizeSmsRecipient(params.get("To") ?? "")
    if (decryptSensitive(String(row.recipient_cipher), workspaceId) !== callbackRecipient) throw new AppError(401, "twilio_recipient_mismatch", "The Twilio recipient does not match this SMS delivery.")
    const accountRow = await database.prepare<Row>("SELECT sender_kind FROM mca_sms_accounts WHERE workspace_id=? AND id=?").get(workspaceId, accountId)
    if (accountRow?.sender_kind === "phone_number") {
      const callbackSender = normalizeSmsRecipient(params.get("From") ?? "")
      if (decryptSensitive(String(row.sender_identity_cipher), workspaceId) !== callbackSender) throw new AppError(401, "twilio_sender_mismatch", "The Twilio sender does not match this SMS delivery.")
    } else if (!params.get("From")?.trim()) throw new AppError(422, "twilio_status_invalid", "The Twilio sender is missing.")
    const now = nowIso(), eventId = newId(), errorCode = params.get("ErrorCode")?.trim() || null
    const inserted = await database.prepare<Row>(`INSERT INTO mca_sms_status_events (id,workspace_id,message_id,provider_message_id,provider_status,error_code,event_key,received_at)
      VALUES (?,?,?,?,?,?,?,?) ON CONFLICT (workspace_id,event_key) DO NOTHING RETURNING id`).get(eventId, workspaceId, row.id, providerId, providerStatus, errorCode, eventKey, now)
    if (inserted) {
      const current = String(row.state), next: SmsMessageState = providerStatus === "delivered" ? "delivered"
        : failedStatuses.includes(providerStatus) ? "failed" : sentStatuses.includes(providerStatus) ? "sent" : "accepted"
      const rank: Record<SmsMessageState, number> = { pending: 0, unknown: 0, accepted: 1, sent: 2, failed: 3, delivered: 4 }
      const shouldUpdate = current !== "delivered" && (current !== "failed" || next === "delivered") && rank[next] >= (rank[current as SmsMessageState] ?? 0)
      if (shouldUpdate) await database.prepare(`UPDATE mca_sms_messages SET state=?,provider_message_id=?,provider_status=?,error_code=?,error_message=?,delivered_at=?,updated_at=?
        WHERE workspace_id=? AND id=?`).run(next, providerId, providerStatus, errorCode, next === "failed" ? "Twilio reported that the message was not delivered." : null, next === "delivered" ? now : null, now, workspaceId, row.id)
      await recordAuditEvent({ context: { workspaceId, userId: null, source: "system" }, action: "sms.status_received", resourceType: "sms_message", resourceId: String(row.id), metadata: { provider: "twilio", providerStatus, errorCodePresent: Boolean(errorCode) }, correlationId: eventKey, executor: database })
    }
    return { messageId: String(row.id), providerStatus, replayed: !inserted }
  })
}

export async function processTwilioOptOut(accountId: string, params: URLSearchParams, signature: string | null, requestUrl: string) {
  const { row, config, workspaceId } = await webhookAccount(accountId)
  const canonicalUrl = `${config.publicBaseUrl}/api/mca/sms/webhooks/twilio/${encodeURIComponent(accountId)}/inbound`
  assertWebhookSignature(config, signature, canonicalUrl || requestUrl, params)
  assertWebhookAccount(config, params)
  await persistInbound(workspaceId, accountId, params, String(row.sender_kind), decryptSensitive(String(row.sender_identity_cipher), workspaceId))
  const type = params.get("OptOutType")?.trim().toUpperCase()
  if (!type || type === "HELP") return { updated: 0, type: type ?? "none" }
  if (!["STOP", "START"].includes(type)) throw new AppError(422, "twilio_opt_out_invalid", "Unsupported Twilio opt-out event.")
  const recipient = normalizeSmsRecipient(params.get("From") ?? ""), hash = recipientHash(workspaceId, recipient)
  const deals = await getDatabase().prepare<{ deal_id: string }>(`SELECT DISTINCT deal_id FROM (
    SELECT deal_id FROM mca_sms_messages WHERE workspace_id=? AND recipient_hash=?
    UNION SELECT deal_id FROM mca_sms_consent_events WHERE workspace_id=? AND recipient_hash=?
  ) routes ORDER BY deal_id`).all(workspaceId, hash, workspaceId, hash)
  const providerId = params.get("MessageSid")?.trim() || contentHash([...params.entries()].sort(([a], [b]) => a.localeCompare(b)))
  const now = nowIso(), state = type === "STOP" ? "opted_out" : "opted_in"
  let updated = 0
  for (const deal of deals) {
    const key = `twilio:${accountId}:${providerId}:${type}:${deal.deal_id}`.slice(0, 160)
    const inserted = await getDatabase().prepare<Row>(`INSERT INTO mca_sms_consent_events
      (id,workspace_id,deal_id,recipient_hash,recipient_cipher,state,source,evidence,idempotency_key,actor_user_id,effective_at,created_at)
      VALUES (?,?,?,?,?,?,'provider_webhook',?,?,NULL,?,?) ON CONFLICT (workspace_id,idempotency_key) DO NOTHING RETURNING id`).get(newId(), workspaceId, deal.deal_id, hash, encryptSensitive(recipient, workspaceId), state, `Twilio Advanced Opt-Out ${type}`, key, now, now)
    if (inserted) updated += 1
  }
  if (updated) await recordAuditEvent({ context: { workspaceId, userId: null, source: "system" }, action: `sms.consent_${state}`, resourceType: "sms_account", resourceId: accountId, metadata: { provider: "twilio", affectedDeals: updated }, correlationId: providerId })
  return { updated, type }
}
