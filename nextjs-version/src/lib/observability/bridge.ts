/**
 * Dependency-free bridge between shared server code and the Sentry SDK.
 *
 * `errors.ts`, `jobs/worker.ts` and `supabase-auth.ts` are also bundled into the
 * Supabase Edge functions and the historical standalone workers, so they must not
 * import `@sentry/*`. `sentry-server.ts` registers the real reporter when the
 * Next.js server starts with a DSN; everywhere else these calls do nothing.
 */

export type ReportLevel = "error" | "warning"

export interface ReportContext {
  level?: ReportLevel
  tags?: Record<string, string | undefined>
  fingerprint?: string[]
}

export interface ServerIdentity {
  authType: "session" | "api_key"
  userId: string | null
  workspaceId: string
  role: string | null
  apiKeyId?: string
}

export interface ObservabilityReporter {
  captureException(error: unknown, context: ReportContext): void
  identify(identity: ServerIdentity): void
}

const REPORTER = Symbol.for("fundlane.observability.reporter")
type ReporterHolder = { [REPORTER]?: ObservabilityReporter }
const holder = () => globalThis as unknown as ReporterHolder

export function registerReporter(reporter: ObservabilityReporter | undefined) {
  holder()[REPORTER] = reporter
}

export function reportException(error: unknown, context: ReportContext = {}) {
  try {
    holder()[REPORTER]?.captureException(error, context)
  } catch {
    /* Reporting must never change the response or job outcome. */
  }
}

export function identifyServerUser(identity: ServerIdentity) {
  try {
    holder()[REPORTER]?.identify(identity)
  } catch {
    /* Identity is best-effort context for reports. */
  }
}
