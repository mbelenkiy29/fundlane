import "server-only"

import { AppError } from "./errors"
import { parseEmailAddress, sendUsesendEmail } from "./intake/usesend"
import { requestSystemEmail, type EmailContent, type SystemProvider } from "./operations/email-transport"
import { hmacScopedToken } from "./crypto"

type SystemEmailInput = Parameters<typeof sendUsesendEmail>[0]

/** Resend is primary: `resend` selects it, unset selects it whenever MCA_RESEND_API_KEY is set, and any other value (e.g. `usesend`) keeps the useSend fallback. */
export function resendSystemEmailEnabled(): boolean {
  const selected = process.env.MCA_SYSTEM_EMAIL_PROVIDER?.trim()
  return selected ? selected === "resend" : Boolean(process.env.MCA_RESEND_API_KEY?.trim())
}

export function systemEmailCredentials(provider?: SystemProvider): { apiKey: string; from: string } | undefined {
  const resend = provider ? provider === "resend" : resendSystemEmailEnabled()
  const apiKey = (resend ? process.env.MCA_RESEND_API_KEY : process.env.MCA_USESEND_API_KEY)?.trim()
  const from = (resend ? process.env.MCA_RESEND_FROM?.trim() || process.env.MCA_USESEND_FROM : process.env.MCA_USESEND_FROM)?.trim()
  return apiKey && from ? { apiKey, from } : undefined
}

export interface FrozenSystemEmailConfiguration {
  provider: SystemProvider
  from: string
  replyTo: string | null
  endpoint: string
  keyIdentity: string
}

/** Freeze configuration identity, never the API key. This is not verified provider account evidence. */
export function systemEmailConfiguration(): FrozenSystemEmailConfiguration {
  const provider = resendSystemEmailEnabled() ? "resend" : "usesend"
  const credentials = systemEmailCredentials(provider)
  if (!credentials) throw new AppError(503, "onboarding_email_unconfigured", "Configure the service email provider.")
  if (!parseEmailAddress(credentials.from) || /[\r\n]/.test(credentials.from)) throw new AppError(503, "onboarding_email_from_invalid", "Configure a valid service email sender.")
  let base: URL
  try { base = new URL(provider === "usesend" ? process.env.MCA_USESEND_BASE_URL?.trim() || "https://app.usesend.com" : "https://app.usesend.com") }
  catch { throw new AppError(503, "onboarding_email_endpoint_invalid", "Configure a secure service email endpoint.") }
  if (provider === "usesend" && (base.protocol !== "https:" || base.username || base.password)) throw new AppError(503, "onboarding_email_endpoint_invalid", "Configure a secure service email endpoint.")
  return { provider, from: credentials.from, replyTo: systemEmailReplyTo() ?? null, endpoint: provider === "resend" ? "https://api.resend.com/emails" : new URL("/api/v1/emails", base.origin).href, keyIdentity: hmacScopedToken("onboarding-system-email-key", "platform", credentials.apiKey) }
}

/** Explicit frozen provider path, independent of the legacy sendSystemEmail environment selector. */
export async function requestFrozenSystemEmail(input: EmailContent & { to: string; idempotencyKey: string; fetchImpl?: typeof fetch }, configuration: FrozenSystemEmailConfiguration): Promise<Awaited<ReturnType<typeof requestSystemEmail>>> {
  let current: FrozenSystemEmailConfiguration
  try { current = systemEmailConfiguration() } catch { throw new AppError(503, "onboarding_email_provider_unavailable", "The frozen service email provider is unavailable.") }
  if (JSON.stringify(current) !== JSON.stringify(configuration)) throw new AppError(409, "onboarding_email_provider_changed", "Review the changed service email provider configuration.")
  const credentials = systemEmailCredentials(configuration.provider)!
  return requestSystemEmail({ ...input, provider: configuration.provider, apiKey: credentials.apiKey, from: configuration.from, ...(configuration.replyTo ? { replyTo: configuration.replyTo } : {}), baseUrl: new URL(configuration.endpoint).origin })
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
