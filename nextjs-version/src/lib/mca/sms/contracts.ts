export const SMS_ACCOUNT_STATES = ["active", "revoked"] as const
export type SmsAccountState = (typeof SMS_ACCOUNT_STATES)[number]
export type SmsSenderKind = "phone_number" | "messaging_service"
export type SmsConsentState = "opted_in" | "opted_out"
export type SmsMessageState = "pending" | "accepted" | "sent" | "delivered" | "failed" | "unknown"

export const SMS_PROVIDERS = [
  "twilio",
  "entrance",
  "texttorrent",
  "textus",
  "openphone",
  "gohighlevel",
] as const
export type SmsProvider = (typeof SMS_PROVIDERS)[number]

export const SMS_ADAPTER_ENVIRONMENTS = ["development", "production"] as const
export type SmsAdapterEnvironment = (typeof SMS_ADAPTER_ENVIRONMENTS)[number]

export interface SmsReadiness {
  ready: boolean
  blockers: { code: string; message: string }[]
}

export interface SmsAccount {
  id: string
  workspaceId: string
  provider: SmsProvider
  label: string
  senderKind: SmsSenderKind
  senderMasked: string
  credentialRef: string
  state: SmsAccountState
  isDefault: boolean
  memberIds: string[]
  providerConfigured: boolean
  readiness?: SmsReadiness
  createdAt: string
  updatedAt: string
}

export interface SmsRoute {
  accountId: string
  provider: SmsProvider
  senderKind: SmsSenderKind
  senderIdentity: string
  providerConfigured: boolean
}

export interface SmsMessage {
  id: string
  dealId: string
  accountId: string
  provider: SmsProvider
  senderMasked: string
  recipientMasked: string
  state: SmsMessageState
  providerStatus?: string
  externalId?: string
  errorCode?: string
  errorMessage?: string
  correlationId: string
  acceptedAt?: string
  deliveredAt?: string
  createdAt: string
  updatedAt: string
}

export interface SmsDeliveryResult {
  state: "accepted" | "failed" | "unknown"
  messageId?: string
  externalId?: string
  providerStatus?: string
  errorCode?: string
  errorMessage?: string
}

export interface SmsAdapterSendInput {
  account: SmsAccount
  idempotencyKey: string
  senderKind: SmsSenderKind
  senderIdentity: string
  recipient: string
  body: string
  statusCallbackUrl: string
  correlationId: string
  credentials: Record<string, string>
}

export interface SmsAdapterStatus {
  providerMessageId: string
  providerStatus: string
  errorCode?: string
  recipient?: string
  sender?: string
  eventKey: string
}

export interface SmsAdapterInbound {
  kind: "opt_out" | "opt_in" | "message"
  recipient: string
  providerMessageId?: string
  body?: string
}

export interface SmsAdapter {
  slug: SmsProvider
  validate(input: unknown): { ok: true } | { ok: false; fields: Record<string, string> }
  testConnection(account: SmsAccount): Promise<{ ok: true } | { ok: false; code: string }>
  send(input: SmsAdapterSendInput): Promise<SmsDeliveryResult>
  parseStatus?(headers: Record<string, string>, body: unknown): Promise<SmsAdapterStatus>
  parseInbound?(headers: Record<string, string>, body: unknown): Promise<SmsAdapterInbound | { ignored: true }>
  capabilities: {
    send: true
    statusCallbacks: boolean
    inbound: boolean
    optOut: boolean
  }
}
