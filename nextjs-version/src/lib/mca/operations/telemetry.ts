import "server-only"
import { createHash, randomUUID } from "node:crypto"
import { Pool } from "pg"
import { headers } from "next/headers"
import { after } from "next/server"
import { postgresConnection } from "../db-connection"
import { safeIdentifier, safeRoute, isInteractiveApi } from "./contracts"
import type { ErrorDiagnostics } from "../error-diagnostics"

let pool: Pool | undefined
const COMPONENTS = new Set(["application", "api", "worker", "email", "database", "billing"])
const CODES = new Set([
  "internal_error", "job_failed", "delivery_unknown", "delivery_failed", "idle_connection_lost",
  "transaction_rollback_callback_failed", "transaction_rollback_failed", "reconciliation_failed",
  "trial_resume_rollback_reconciliation_deferred", "card_required_trial_checkout_unconfigured", "immediate_reconciliation_failed",
])
function telemetryPool() {
  if (!pool) {
    pool = new Pool({
      ...postgresConnection(process.env.DATABASE_URL!),
      max: 1,
      connectionTimeoutMillis: 500,
      idleTimeoutMillis: 1000,
      statement_timeout: 500,
      query_timeout: 750,
      allowExitOnIdle: true,
    })
    pool.on("error", () => {
      console.error(JSON.stringify({ event: "telemetry_unavailable" }))
    })
  }
  return pool
}
export async function boundedTelemetry(sql: string, values: unknown[]) {
  if (
    process.env.MCA_OPERATIONS_ENABLED !== "true" ||
    !process.env.DATABASE_URL
  )
    return
  try {
    await telemetryPool().query(sql, values)
  } catch {
    /* Native logs remain authoritative during telemetry outages. */
  }
}
function defer(write: () => Promise<void>) {
  try {
    after(write)
  } catch {
    /* Worker callers explicitly await recordOperationalError instead. */
  }
}
export function operationalEvent(
  component: string,
  code: string,
  correlationId?: string,
  route?: string
) {
  return {
    id: randomUUID(),
    component: COMPONENTS.has(component) ? component : "application",
    code: CODES.has(code) ? code : "internal_error",
    // Request IDs can be supplied by clients; syntax validation alone is not redaction.
    correlationId: safeIdentifier(correlationId) ? createHash("sha256").update(correlationId!).digest("hex") : null,
    route: route ? safeRoute(route) : null,
    deployment: safeIdentifier(process.env.VERCEL_DEPLOYMENT_ID),
  }
}
export async function persistEvent(event: ReturnType<typeof operationalEvent>) {
  await boundedTelemetry(
    `INSERT INTO mca_private.ops_errors(id,component,code,correlation_id,route,deployment) VALUES($1,$2,$3,$4,$5,$6)`,
    [
      event.id,
      event.component,
      event.code,
      event.correlationId,
      event.route,
      event.deployment,
    ]
  )
}
export function logApiFailure(correlationId?: string, diagnostics?: ErrorDiagnostics) {
  const event = operationalEvent("api", "internal_error", correlationId)
  // Diagnostics are redacted and go to native logs only; the persisted row stays minimal.
  console.error(JSON.stringify({ event: "operational_error", ...event, ...(diagnostics ? { cause: diagnostics } : {}) }))
  let context: ReturnType<typeof headers> | undefined
  try {
    context = headers()
    void context.catch(() => undefined)
  } catch {}
  defer(async () => {
    try {
      const h = await context
      const path = h?.get("x-mca-pathname")
      if (path) event.route = safeRoute(path)
    } catch {}
    await persistEvent(event)
  })
}
export async function recordOperationalError(component: string, code: string) {
  const event = operationalEvent(component, code)
  console.error(JSON.stringify({ event: "operational_error", ...event }))
  await persistEvent(event)
}
export function recordActivity(request: Request, userId: string) {
  if (!isInteractiveApi(request)) return
  defer(() =>
    boundedTelemetry(
      "INSERT INTO mca_private.ops_activity(day,user_id) VALUES((now() AT TIME ZONE 'UTC')::date,$1) ON CONFLICT(day,user_id) DO UPDATE SET last_seen_at=now()",
      [userId]
    )
  )
}
