import type { Instrumentation } from "next"
import { serverSentryDsn } from "./lib/observability/sentry-options"

// Sentry stays completely unloaded unless a DSN is configured (CI, tests and local dev).
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs" && serverSentryDsn()) await import("./lib/observability/sentry-server")
}

// Server Component, layout and route errors that escape `apiError`.
export const onRequestError: Instrumentation.onRequestError = async (...args) => {
  if (!serverSentryDsn()) return
  const { captureRequestError } = await import("@sentry/nextjs")
  captureRequestError(...args)
}
