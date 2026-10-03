import * as Sentry from "@sentry/nextjs"
import { replayAllowedPath, scrubBreadcrumb, scrubEvent, scrubLog, scrubSpan } from "@/lib/observability/scrub"
import { DATA_COLLECTION, browserSentryDsn, replaysOnErrorSampleRate, replaysSessionSampleRate, sentryEnvironment, tracesSampleRate } from "@/lib/observability/sentry-options"
import { stopSessionReplay } from "@/components/observability/replay-control"

const dsn = browserSentryDsn()

// Replay and the feedback form are added later by <SentrySession> on signed-in pages
// only, so public merchant, auth and marketing pages never load or record them.
if (dsn) {
  Sentry.init({
    dsn,
    environment: sentryEnvironment(),
    dataCollection: DATA_COLLECTION,
    tracesSampleRate: tracesSampleRate(),
    replaysSessionSampleRate: replaysSessionSampleRate(),
    replaysOnErrorSampleRate: replaysOnErrorSampleRate(),
    // Template pages console.log raw form values; only warnings and errors become logs.
    integrations: [Sentry.consoleLoggingIntegration({ levels: ["warn", "error"] })],
    ignoreErrors: ["ResizeObserver loop limit exceeded", "ResizeObserver loop completed with undelivered notifications"],
    beforeSend: (event, hint) => scrubEvent(event, hint),
    beforeBreadcrumb: (breadcrumb) => scrubBreadcrumb(breadcrumb),
    beforeSendLog: (log) => scrubLog(log),
    beforeSendSpan: (span) => scrubSpan(span),
  })
  // `beforeSend` skips feedback and replay events; scrub their URLs here too.
  Sentry.addEventProcessor((event, hint) => scrubEvent(event, hint))
}

export function onRouterTransitionStart(href: string, navigationType: string) {
  if (!dsn) return
  Sentry.captureRouterTransitionStart(href, navigationType)
  // Stop recording before a page outside the signed-in workspace renders.
  if (!replayAllowedPath(new URL(href, window.location.href).pathname)) void stopSessionReplay()
}
