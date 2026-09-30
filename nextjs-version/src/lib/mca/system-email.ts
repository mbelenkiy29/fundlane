import "server-only"

import { AppError } from "./errors"
import { parseEmailAddress, sendUsesendEmail } from "./intake/usesend"
import { requestSystemEmail } from "./operations/email-transport"

type SystemEmailInput = Parameters<typeof sendUsesendEmail>[0]

export function resendSystemEmailEnabled(): boolean {
  return process.env.MCA_SYSTEM_EMAIL_PROVIDER === "resend"
}

export function systemEmailCredentials(): { apiKey: string; from: string } | undefined {
  const resend = resendSystemEmailEnabled()
  const apiKey = (resend ? process.env.MCA_RESEND_API_KEY : process.env.MCA_USESEND_API_KEY)?.trim()
  const from = (resend ? process.env.MCA_RESEND_FROM?.trim() || process.env.MCA_USESEND_FROM : process.env.MCA_USESEND_FROM)?.trim()
  return apiKey && from ? { apiKey, from } : undefined
}

export function systemEmailReplyTo(): string | undefined {
  const replyTo = process.env.MCA_SYSTEM_EMAIL_REPLY_TO?.trim()
  if (replyTo && !parseEmailAddress(replyTo)) {
    throw new AppError(503, "system_email_reply_to_invalid", "MCA_SYSTEM_EMAIL_REPLY_TO must be an email address.")
  }
  return replyTo || undefined
}

export async function sendSystemEmail(input: SystemEmailInput): Promise<{ emailId: string }> {
  if (!resendSystemEmailEnabled()) {
    // Only Fundlane's own sender gets the system Reply-To; tenant integration
    // senders are left untouched (and never fail on this setting).
    const senderAddress = parseEmailAddress(input.from)
    const systemSender = Boolean(senderAddress) && senderAddress === parseEmailAddress(systemEmailCredentials()?.from)
    const replyTo = input.replyTo ?? (systemSender ? systemEmailReplyTo() : undefined)
    return sendUsesendEmail({ ...input, ...(replyTo !== undefined ? { replyTo } : {}) })
  }
  const credentials = systemEmailCredentials()
  if (!credentials) throw new AppError(503, "system_email_unconfigured", "Configure the Resend API key and From address.")
  const replyTo = input.replyTo ?? systemEmailReplyTo()
  const result = await requestSystemEmail({ ...input, provider:"resend", apiKey:credentials.apiKey, from:credentials.from, ...(replyTo !== undefined ? { replyTo } : {}) })
  const extra = { providerStatus:result.status }
  if (result.status === 401 || result.status === 403) throw new AppError(503, "resend_auth_rejected", "Resend rejected the configured API key or sender.", undefined, extra)
  if (result.status === 429) throw new AppError(503, "resend_rate_limited", "Resend rate limited the email. Retry later.", undefined, extra)
  if (result.status === 409) throw new AppError(409, "resend_idempotency_conflict", "Resend already used this email idempotency key with a different payload.", undefined, extra)
  if (result.status < 200 || result.status >= 300 || !result.emailId) {
    throw new AppError(502, "resend_send_failed", `Resend rejected the email with HTTP ${result.status}.`, undefined, extra)
  }
  return { emailId:result.emailId }
}
