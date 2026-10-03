import * as Sentry from "@sentry/nextjs"
import { scrubRecordingEvent } from "@/lib/observability/scrub"

const FEEDBACK_ACCENT = { accentBackground: "var(--primary)", accentForeground: "var(--primary-foreground)", successColor: "var(--primary)" }

let replayAdded = false
let feedbackAdded = false

/** True when the browser SDK was initialised (a public DSN is configured). */
export function sentryActive() {
  return Boolean(Sentry.getClient())
}

/**
 * Adds Session Replay once, from allowed signed-in pages only. Adding it starts
 * Sentry's sampling: a full session at the configured session rate, otherwise a
 * rolling buffer that is sent with errors and feedback.
 */
export function ensureReplayIntegration() {
  if (replayAdded || !sentryActive()) return
  replayAdded = true
  Sentry.addIntegration(Sentry.replayIntegration({
    maskAllText: true,
    maskAllInputs: true,
    blockAllMedia: true,
    block: ["[data-sentry-block]", "iframe"],
    networkDetailAllowUrls: [],
    beforeAddRecordingEvent: (event) => scrubRecordingEvent(event),
  }))
}

/**
 * Adds the feedback form once. The synchronous build bundles the form and
 * screenshot editor; the async variant loads them from Sentry's CDN, which the
 * CSP does not allow. Adding feedback never starts a recording.
 */
export function ensureFeedbackIntegration() {
  if (feedbackAdded || !sentryActive()) return
  feedbackAdded = true
  Sentry.addIntegration(Sentry.feedbackIntegration({
    autoInject: false,
    colorScheme: "system",
    enableScreenshot: true,
    showBranding: false,
    useSentryUser: { name: "username", email: "email" },
    // The app's color tokens inherit into the form's shadow root, so the accent follows the brand and the app theme.
    themeLight: FEEDBACK_ACCENT,
    themeDark: FEEDBACK_ACCENT,
  }))
}
