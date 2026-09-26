import "server-only"
import { createHmac } from "node:crypto"
import {
  assertTrustedMutation,
  clientRateKey,
  consumeRequestRateLimit,
} from "../mca/auth"
import { AppError } from "../mca/errors"
import { getDemoConfiguration } from "./config"
import { demoSchema, type DemoRequest } from "./demo-schema"
import { deliverStoredDemoSubmission, demoVisibilityEnabled, storeDemoSubmission } from "./demo-storage"

const MAX_BODY_BYTES = 12_000
const RETRY_SECONDS = 60

type Dependencies = {
  configuration: typeof getDemoConfiguration
  rateLimit: typeof consumeRequestRateLimit
  fetch: typeof fetch
  timeout: () => AbortSignal
  store: typeof storeDemoSubmission
  notify: (requestId: string, contact: Pick<DemoRequest, "name" | "email" | "brokerage" | "teamSize" | "message">) => Promise<boolean>
  metric: (event: "accepted" | "delivery_failed" | "notification_failed" | "notification_skipped", requestId: string) => void
}

const defaults: Dependencies = {
  configuration: getDemoConfiguration,
  rateLimit: consumeRequestRateLimit,
  fetch: (...args) => fetch(...args),
  timeout: () => AbortSignal.timeout(10_000),
  store: storeDemoSubmission,
  notify: deliverStoredDemoSubmission,
  metric: (event, requestId) =>
    (event === "notification_failed" || event === "notification_skipped" ? console.warn : console.info)(
      JSON.stringify({ event: `marketing_demo_${event}`, requestId })
    ),
}

function json(body: unknown, status: number) {
  return Response.json(body, {
    status,
    headers: {
      "Cache-Control": "no-store",
      ...(status === 429 ? { "Retry-After": String(RETRY_SECONDS) } : {}),
    },
  })
}

async function readBody(request: Request): Promise<unknown> {
  if (
    !request.headers
      .get("content-type")
      ?.toLowerCase()
      .startsWith("application/json")
  )
    throw new AppError(415, "unsupported_media_type", "Send the form as JSON.")
  const length = Number(request.headers.get("content-length") || 0)
  if (length > MAX_BODY_BYTES)
    throw new AppError(
      413,
      "body_too_large",
      "Your request is too long. Shorten your message and try again."
    )
  const reader = request.body?.getReader()
  if (!reader)
    throw new AppError(400, "invalid_body", "Complete the form and try again.")
  let size = 0
  const chunks: Uint8Array[] = []
  try {
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) break
      size += chunk.value.byteLength
      if (size > MAX_BODY_BYTES) {
        await reader.cancel()
        throw new AppError(
          413,
          "body_too_large",
          "Your request is too long. Shorten your message and try again."
        )
      }
      chunks.push(chunk.value)
    }
  } finally {
    reader.releaseLock()
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"))
  } catch {
    throw new AppError(400, "invalid_json", "Complete the form and try again.")
  }
}

// The sales receiver must atomically deduplicate Idempotency-Key before storing
// or notifying sales. A timeout can mean accepted-but-response-lost; retries use
// the same key, including across application instances and restarts.
export function createDemoHandler(overrides: Partial<Dependencies> = {}) {
  const deps = { ...defaults, ...overrides }
  return async function handleDemo(request: Request) {
    try {
      assertTrustedMutation(request)
      const config = deps.configuration()
      if (!config.enabled || (!config.databaseEnabled && (!config.webhookUrl || !config.token)))
        return json(
          {
            error:
              "Demo requests are temporarily unavailable. Please check back soon.",
          },
          503
        )
      await deps.rateLimit("marketing-demo:global", 120)
      await deps.rateLimit(clientRateKey(request, "marketing-demo"), 5)
      const result = demoSchema.safeParse(await readBody(request))
      if (!result.success)
        return json(
          {
            error: "Check the highlighted fields and try again.",
            fields: result.error.flatten().fieldErrors,
          },
          400
        )
      const {
        requestId: clientId,
        name,
        email,
        brokerage,
        teamSize,
        message,
      } = result.data
      const contact = { name, email, brokerage, teamSize, message }
      if (config.databaseEnabled) {
        try {
          const inserted = await deps.store(clientId, contact)
          if (inserted || demoVisibilityEnabled()) {
            try {
              if (!await deps.notify(clientId, contact) && inserted) deps.metric("notification_skipped", clientId)
            } catch {
              deps.metric("notification_failed", clientId)
            }
          }
        } catch {
          deps.metric("delivery_failed", clientId)
          return json({ error: "Demo requests are temporarily unavailable. Please try again shortly." }, 503)
        }
        deps.metric("accepted", clientId)
        return json({ accepted: true, requestId: clientId }, 202)
      }
      // Bind the ID to the normalized payload so editing a failed form creates a
      // different operation. The key never contains contact data or credentials.
      const requestId = createHmac("sha256", config.token!)
        .update(JSON.stringify({ clientId, ...contact }))
        .digest("hex")
      try {
        const response = await deps.fetch(config.webhookUrl!, {
          method: "POST",
          redirect: "error",
          signal: deps.timeout(),
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${config.token!}`,
            "Idempotency-Key": requestId,
          },
          body: JSON.stringify({
            type: "fundlane.demo_requested",
            version: 1,
            requestId,
            ...contact,
          }),
        })
        // Do not consume or expose provider response bodies: they may contain PII.
        await response.body?.cancel()
        if (!response.ok)
          throw new Error("Sales receiver did not accept the request")
      } catch {
        deps.metric("delivery_failed", requestId)
        return json(
          {
            error:
              "We couldn’t confirm your request. Your details are still here—please try again.",
          },
          502
        )
      }
      deps.metric("accepted", requestId)
      return json({ accepted: true, requestId }, 202)
    } catch (error) {
      if (error instanceof AppError)
        return json({ error: error.message }, error.status)
      // Rate-limit storage and unexpected failures fail closed without logging PII.
      return json(
        {
          error:
            "Demo requests are temporarily unavailable. Please try again shortly.",
        },
        503
      )
    }
  }
}
