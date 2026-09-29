import "server-only"

import { AppError } from "./errors"
import { sendUsesendEmail } from "./intake/usesend"

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

export async function sendSystemEmail(input: SystemEmailInput): Promise<{ emailId: string }> {
  if (!resendSystemEmailEnabled()) return sendUsesendEmail(input)
  const credentials = systemEmailCredentials()
  if (!credentials) throw new AppError(503, "system_email_unconfigured", "Configure the Resend API key and From address.")
  const response = await (input.fetchImpl ?? fetch)("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      accept: "application/json",
      authorization: `Bearer ${credentials.apiKey}`,
      "content-type": "application/json",
      "Idempotency-Key": input.idempotencyKey.slice(0, 256),
    },
    body: JSON.stringify({ from: credentials.from, to: [input.to], subject: input.subject, text: input.text, html: input.html }),
    redirect: "error",
    signal: AbortSignal.timeout(15_000),
  })
  const body = await response.json().catch(() => undefined) as { id?: unknown } | undefined
  if (response.status === 401 || response.status === 403) throw new AppError(503, "resend_auth_rejected", "Resend rejected the configured API key or sender.")
  if (response.status === 429) throw new AppError(503, "resend_rate_limited", "Resend rate limited the email. Retry later.")
  if (response.status === 409) throw new AppError(409, "resend_idempotency_conflict", "Resend already used this email idempotency key with a different payload.")
  if (!response.ok || typeof body?.id !== "string" || !body.id.trim()) {
    throw new AppError(502, "resend_send_failed", `Resend rejected the email with HTTP ${response.status}.`)
  }
  return { emailId: body.id }
}
