/**
 * Server (Node.js runtime) Sentry initialisation. Loaded by src/instrumentation.ts
 * only when a DSN is configured, then registers the bridge reporter that
 * `apiError`, background jobs and session authentication report through.
 */
import * as Sentry from "@sentry/nextjs"
import { registerReporter } from "./bridge"
import { scrubBreadcrumb, scrubEvent, scrubLog, scrubSpan } from "./scrub"
import { DATA_COLLECTION, sentryEnvironment, serverSentryDsn, tracesSampleRate } from "./sentry-options"

Sentry.init({
  dsn: serverSentryDsn(),
  environment: sentryEnvironment(),
  dataCollection: DATA_COLLECTION,
  tracesSampleRate: tracesSampleRate(),
  // Never add sentry-trace/baggage headers to Stripe, OpenAI, Twilio, funder or customer webhook calls.
  tracePropagationTargets: [],
  // Existing operational logs are secret-free JSON (`{"event": ...}`); forward them as Sentry logs.
  integrations: [Sentry.consoleLoggingIntegration({ levels: ["info", "warn", "error"] })],
  beforeSend: (event, hint) => scrubEvent(event, hint),
  beforeBreadcrumb: (breadcrumb) => scrubBreadcrumb(breadcrumb),
  beforeSendLog: (log) => scrubLog(log),
  beforeSendSpan: (span) => scrubSpan(span),
})

registerReporter({
  captureException(error, { level = "error", tags, fingerprint }) {
    Sentry.withScope((scope) => {
      scope.setLevel(level)
      for (const [key, value] of Object.entries(tags ?? {})) if (value) scope.setTag(key, value)
      if (fingerprint) scope.setFingerprint(fingerprint)
      Sentry.captureException(error)
    })
  },
  identify({ authType, userId, workspaceId, role, apiKeyId }) {
    Sentry.setUser(userId ? { id: userId } : null)
    Sentry.setTags({ workspace_id: workspaceId, role: role ?? undefined, auth_type: authType, api_key_id: apiKeyId })
  },
})
