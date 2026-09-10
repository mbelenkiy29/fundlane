import "server-only"

export const SENDER_PROVIDERS = ["google", "microsoft", "smtp", "sendgrid"] as const
export type SenderProvider = (typeof SENDER_PROVIDERS)[number]

export const SENDER_PURPOSES = ["merchant", "submission", "fallback"] as const
export type SenderPurpose = (typeof SENDER_PURPOSES)[number]

export const SENDER_STATES = ["pending", "verified", "expired", "revoked"] as const
export type SenderState = (typeof SENDER_STATES)[number]

export interface EmailSender {
  id: string
  workspaceId: string
  provider: SenderProvider
  purpose: SenderPurpose
  fromName: string
  fromAddress: string
  signature?: string
  state: SenderState
  isDefault: boolean
  verifiedAt?: string
  lastError?: string
  hasCredential: boolean
  memberIds: string[]
  createdAt: string
  updatedAt: string
}

export interface SenderTestSendResult {
  delivery: "sent" | "preview" | "failed"
  correlationId: string
  providerMessageId?: string
  previewUrl?: string
  error?: string
}
