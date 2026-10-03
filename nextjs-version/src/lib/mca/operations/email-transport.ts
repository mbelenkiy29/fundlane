/** Shared transactional webhook transport. No framework imports: used by Next.js and the scheduled monitor. */
export function sendTransactionalWebhook(
  url: string,
  token: string | undefined,
  message: unknown,
  correlationId: string,
  fetcher: typeof fetch = fetch,
  timeout = 10000
) {
  return fetcher(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-correlation-id": correlationId,
      "idempotency-key": correlationId,
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(message),
    signal: AbortSignal.timeout(timeout),
    redirect: "error",
  })
}

export type TransactionalTemplate =
  | "workspace_invitation"
  | "account_recovery"
  | "funder_analysis_review"
  | "company_email_verification"
  | "ai_credit_alert"
  | "application_invitation"
  | "application_invitation_reminder"
  | "operations_alert"
export type TransactionalMessage = {
  recipient: string
  template: TransactionalTemplate
  actionUrl: string
  expiresAt: string
  data?: Record<string, unknown>
}
export type EmailContent = { subject: string; text: string; html: string }
export type SystemProvider = "usesend" | "resend"

export const escapeHtml = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (char) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        char
      ]!
  )
const stringValue = (data: Record<string, unknown> | undefined, key: string) =>
  typeof data?.[key] === "string" && data[key].trim()
    ? data[key].trim()
    : undefined

/** The single reviewable source for transactional email copy. This module is Web-API-only for the Edge monitor. */
export function renderEmailContent(
  message: TransactionalMessage
): EmailContent {
  const data = message.data
  const client = stringValue(data, "clientName")
  const employee = stringValue(data, "employeeName")
  const expiry = `This link expires at ${message.expiresAt}.`
  let subject: string, paragraph: string, cta: string
  const details: string[] = []
  switch (message.template) {
    case "application_invitation":
      subject = "Complete your business funding application"
      paragraph = `${client ? `Hi ${client}, ` : ""}${employee ? `${employee} invited you` : "You’ve been invited"} to complete your business funding application. Have your business details and recent bank statements ready.`
      cta = "Start application"
      break
    case "application_invitation_reminder": {
      subject = "Finish your business funding application"
      paragraph = `${client ? `Hi ${client}, ` : ""}this is a reminder to finish the business funding application${employee ? ` ${employee} invited you to complete` : " you were invited to complete"}.`
      cta = "Continue application"
      const form = stringValue(data, "formName"),
        step = stringValue(data, "lastStep")
      if (form) details.push(`Form: ${form}.`)
      if (step) details.push(`Current step: ${step}.`)
      break
    }
    case "workspace_invitation":
      subject = "You’re invited to join Fundlane"
      paragraph = "You’ve been invited to join a company workspace in Fundlane."
      cta = "Accept invitation"
      break
    case "account_recovery":
      subject = "Reset your Fundlane password"
      paragraph =
        "We received a request to reset your Fundlane password. If you did not request this, you can ignore this email."
      cta = "Reset password"
      break
    case "company_email_verification":
      subject = "Verify your company email"
      paragraph =
        "Verify your email address to continue setting up your company in Fundlane."
      cta = "Verify company email"
      break
    case "funder_analysis_review":
      subject = "Review Fundlane funder analysis"
      paragraph =
        "A funder analysis is ready for your review. Review the recommendations and confirm your selection."
      cta = "Review analysis"
      break
    case "ai_credit_alert": {
      const exhausted =
        stringValue(data, "kind") === "exhausted" || data?.total === 0
      subject = exhausted
        ? "Fundlane AI credits are exhausted"
        : "Fundlane AI credits are running low"
      paragraph = exhausted
        ? "Fundlane AI credits are exhausted."
        : "Fundlane AI credits are running low."
      cta = "Review AI credits"
      for (const [key, label] of [
        ["companyName", "Company"],
        ["userName", "User"],
        ["total", "Remaining"],
        ["allowance", "Allowance"],
        ["resetAt", "Reset"],
      ] as const) {
        const value = data?.[key]
        if (typeof value === "string" || typeof value === "number")
          details.push(`${label}: ${String(value)}.`)
      }
      break
    }
    case "operations_alert": {
      const component = stringValue(data, "component") ?? "platform"
      subject = `Fundlane operations alert: ${component}`
      paragraph =
        stringValue(data, "summary") ?? "A platform component needs attention."
      cta = "Open platform status"
      details.push(
        `Component: ${component}.`,
        `Time: ${stringValue(data, "time") ?? "Unavailable"}.`
      )
      break
    }
    default: {
      const exhaustive: never = message.template
      throw new Error(`Unsupported email template: ${exhaustive}`)
    }
  }
  const text = [
    paragraph,
    ...details,
    `${cta}: ${message.actionUrl}`,
    expiry,
  ].join("\n\n")
  const html = `<p>${escapeHtml(paragraph)}</p>${details.map((item) => `<p>${escapeHtml(item)}</p>`).join("")}<p><a href="${escapeHtml(message.actionUrl)}">${escapeHtml(cta)}</a></p><p>${escapeHtml(expiry)}</p>`
  return { subject, text, html }
}

function usesendOrigin(configured?: string): string {
  if (!configured) return "https://app.usesend.com"
  const url = new URL(configured)
  if (url.protocol !== "https:" || url.username || url.password)
    throw new Error("MCA_USESEND_BASE_URL must be an HTTPS origin.")
  return url.origin
}

export async function requestSystemEmail(
  input: EmailContent & {
    provider: SystemProvider
    apiKey: string
    from: string
    to: string | string[]
    cc?: string[]
    replyTo?: string
    attachments?: Array<{ filename: string; content: string }>
    headers?: Record<string, string>
    idempotencyKey: string
    fetchImpl?: typeof fetch
    /** Optional self-hosted useSend HTTPS origin (MCA_USESEND_BASE_URL); ignored for Resend. */
    baseUrl?: string
  }
): Promise<{ status: number; emailId?: string; errorCode?: string }> {
  const resend = input.provider === "resend"
  const response = await (input.fetchImpl ?? fetch)(
    resend
      ? "https://api.resend.com/emails"
      : new URL("/api/v1/emails", usesendOrigin(input.baseUrl)).href,
    {
      method: "POST",
      headers: {
        accept: "application/json",
        authorization: `Bearer ${input.apiKey}`,
        "content-type": "application/json",
        "Idempotency-Key": input.idempotencyKey.slice(0, 256),
        // useSend's edge rejects default runtime agents; match the app's useSend client.
        ...(resend
          ? {}
          : {
              "user-agent":
                "Mozilla/5.0 (compatible; MCA-Intake/1.0; +https://fundlane.io)",
            }),
      },
      body: JSON.stringify({
        from: input.from,
        to: resend ? [input.to].flat() : input.to,
        subject: input.subject,
        text: input.text,
        html: input.html,
        ...(input.replyTo !== undefined ? { [resend ? "reply_to" : "replyTo"]: input.replyTo } : {}),
        ...(input.cc?.length ? { cc: input.cc } : {}),
        ...(input.attachments?.length ? { attachments: input.attachments } : {}),
        ...(input.headers ? { headers: input.headers } : {}),
      }),
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    }
  )
  const body = (await response.json().catch(() => undefined)) as
    | Record<string, unknown>
    | undefined
  const error =
    body?.error && typeof body.error === "object"
      ? (body.error as Record<string, unknown>)
      : undefined
  const id = resend ? body?.id : (body?.emailId ?? body?.id)
  return {
    status: response.status,
    ...(typeof id === "string" && id.trim() ? { emailId: id } : {}),
    ...(typeof error?.code === "string"
      ? { errorCode: error.code }
      : typeof body?.code === "string"
        ? { errorCode: body.code }
        : {}),
  }
}
