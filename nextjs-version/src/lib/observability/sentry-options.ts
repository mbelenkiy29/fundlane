/**
 * Options shared by the browser and server Sentry SDKs. Sentry v11 collects
 * cookies, headers, bodies, query values, AI prompts/outputs, database parameters,
 * IP addresses and stack-frame variables by default; Fundlane handles merchant and
 * banking data, so every category is disabled or allowlisted here.
 */

export const SENTRY_TUNNEL_ROUTE = "/monitoring"

export const DATA_COLLECTION = {
  userInfo: false,
  cookies: false,
  httpHeaders: { request: { allow: ["user-agent", "content-type", "accept", "accept-language", "x-request-id", "x-vercel-id"] }, response: false },
  httpBodies: [] as never[],
  urlQueryParams: false,
  graphQL: { document: false, variables: false },
  genAI: { inputs: false, outputs: false },
  databaseQueryData: false,
  queues: false,
  stackFrameVariables: false,
}

/** Parses an optional 0–1 sample rate, falling back when unset or invalid. */
export function sampleRate(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === "") return fallback
  const value = Number(raw)
  if (!Number.isFinite(value)) return fallback
  return Math.min(1, Math.max(0, value))
}

// NEXT_PUBLIC_* values must be read literally so Next.js inlines them in the browser bundle.
export const browserSentryDsn = () => process.env.NEXT_PUBLIC_SENTRY_DSN || undefined
export const serverSentryDsn = () => process.env.SENTRY_DSN || process.env.NEXT_PUBLIC_SENTRY_DSN || undefined
export const sentryEnvironment = () => process.env.NEXT_PUBLIC_SENTRY_ENVIRONMENT || undefined
export const tracesSampleRate = () => sampleRate(process.env.NEXT_PUBLIC_SENTRY_TRACES_SAMPLE_RATE, 0.1)
export const replaysSessionSampleRate = () => sampleRate(process.env.NEXT_PUBLIC_SENTRY_REPLAYS_SESSION_SAMPLE_RATE, 0.1)
export const replaysOnErrorSampleRate = () => sampleRate(process.env.NEXT_PUBLIC_SENTRY_REPLAYS_ON_ERROR_SAMPLE_RATE, 1)
