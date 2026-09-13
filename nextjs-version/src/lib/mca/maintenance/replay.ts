import "server-only"
import { withWebhookReplayClock, webhookVerificationTime } from "./replay-clock"
import { maintenanceEnabled, type CapturedWebhook } from "./capture"

/** Dispatch only known ingress endpoints; no arbitrary network request or handler is allowed. */
export async function replayCapturedWebhook(record: CapturedWebhook): Promise<Response> {
  if (maintenanceEnabled()) throw new Error("Reopen the application only after parity checks before replaying events.")
  const url = new URL(record.url)
  const allowedOrigins = [process.env.MCA_APP_ORIGIN, ...(process.env.MCA_MAINTENANCE_REPLAY_ALLOWED_ORIGINS ?? "").split(",")].filter(Boolean).map(value => new URL(value!.trim()).origin)
  if (!allowedOrigins.includes(url.origin)) throw new Error("Captured webhook origin is not an approved application origin.")
  const bytes = Buffer.from(record.bodyBase64, "base64")
  if (bytes.toString("base64") !== record.bodyBase64) throw new Error("Invalid captured request bytes.")
  const request = new Request(record.url, { method: record.method, headers: record.headers, body: new Uint8Array(bytes) })
  return withWebhookReplayClock(record.receivedAt, async () => {
    if (url.pathname === "/api/webhooks/stripe") {
      const { POST } = await import("../../../app/api/webhooks/stripe/route")
      return POST(request)
    }
    if (url.pathname === "/api/webhooks/stripe-credits") {
      // The HTTP wrapper uses Next.after, which requires a live HTTP lifecycle. The
      // exact same verifier and idempotent business handler run in the replay worker.
      const { creditStripe, processCreditPaymentEvent } = await import("../assistant/purchases")
      const secret = process.env.STRIPE_WEBHOOK_SECRET
      if (!secret) throw new Error("Credit billing webhook is not configured.")
      const client = creditStripe()
      const event = client.webhooks.constructEvent(bytes, request.headers.get("stripe-signature") ?? "", secret, undefined, undefined, webhookVerificationTime())
      await processCreditPaymentEvent(event, client)
      return Response.json({ received: true })
    }
    let match = /^\/api\/mca\/intake\/email\/([^/]+)$/.exec(url.pathname)
    if (match) {
      const { POST } = await import("../../../app/api/mca/intake/email/[integrationId]/route")
      return POST(request, { params: Promise.resolve({ integrationId: decodeURIComponent(match[1]) }) })
    }
    match = /^\/api\/mca\/intake\/providers\/([^/]+)\/([^/]+)$/.exec(url.pathname)
    if (match) {
      const { POST } = await import("../../../app/api/mca/intake/providers/[provider]/[integrationId]/route")
      return POST(request, { params: Promise.resolve({ provider: decodeURIComponent(match[1]), integrationId: decodeURIComponent(match[2]) }) })
    }
    match = /^\/api\/mca\/sms\/webhooks\/twilio\/([^/]+)\/(inbound|status)$/.exec(url.pathname)
    if (match) {
      const { POST } = match[2] === "inbound" ? await import("../../../app/api/mca/sms/webhooks/twilio/[accountId]/inbound/route") : await import("../../../app/api/mca/sms/webhooks/twilio/[accountId]/status/route")
      return POST(request, { params: Promise.resolve({ accountId: decodeURIComponent(match[1]) }) })
    }
    match = /^\/api\/mca\/sms\/webhooks\/registration\/([^/]+)$/.exec(url.pathname)
    if (match) {
      const { POST } = await import("../../../app/api/mca/sms/webhooks/registration/[workspaceId]/route")
      return POST(request, { params: Promise.resolve({ workspaceId: decodeURIComponent(match[1]) }) })
    }
    match = /^\/api\/mca\/closing\/psf\/webhook\/([^/]+)$/.exec(url.pathname)
    if (match) {
      const { POST } = await import("../../../app/api/mca/closing/psf/webhook/[workspaceId]/route")
      return POST(request, { params: Promise.resolve({ workspaceId: decodeURIComponent(match[1]) }) })
    }
    match = /^\/api\/mca\/submissions\/webhooks\/(?!refresh$)([^/]+)$/.exec(url.pathname)
    if (match) {
      const { POST } = await import("../../../app/api/mca/submissions/webhooks/[slug]/route")
      return POST(request, { params: Promise.resolve({ slug: decodeURIComponent(match[1]) }) })
    }
    throw new Error("Unsupported captured webhook route.")
  })
}
