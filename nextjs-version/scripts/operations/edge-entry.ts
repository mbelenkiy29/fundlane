import postgres from "npm:postgres@3.4.7"
// Bundled by build-monitor.mjs; deployed with the Deno runtime.
import { runMonitor } from "../../src/lib/mca/operations/monitor"
import { positiveThreshold } from "../../src/lib/mca/operations/contracts"
import { SUPABASE_DATABASE_CA } from "../../src/lib/mca/supabase-ca"
declare const Deno: {
  env: { get: (name: string) => string | undefined }
  serve: (handler: (request: Request) => Promise<Response>) => void
}
const env = (name: string) => Deno.env.get(name)
function queueThresholds(): Record<string, number> {
  try {
    const raw: unknown = JSON.parse(env("MCA_OPERATIONS_QUEUE_AGE_BY_KIND_SECONDS") ?? "{}")
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {}
    return Object.fromEntries(Object.entries(raw).filter(([kind, value]) => /^[a-z_]{1,50}$/.test(kind) && Number.isSafeInteger(value) && Number(value) > 0 && Number(value) <= 86400))
  } catch { return {} }
}
Deno.serve(async (request) => {
  const secret = env("MCA_MONITOR_TOKEN")
  if (
    request.method !== "POST" ||
    !secret ||
    secret.length < 32 ||
    request.headers.get("authorization") !== `Bearer ${secret}`
  )
    return new Response(null, { status: 401 })
  const url = env("MCA_MONITOR_DATABASE_URL")
  if (!url || !env("MCA_APP_ORIGIN")) return new Response(null, { status: 503 })
  let parsed: URL
  try { parsed = new URL(url) } catch { return new Response(null,{status:503}) }
  if (parsed.username.split(".")[0] !== "mca_app" || parsed.port !== "6543")
    return new Response(null, { status: 503 })
  const sql = postgres(url, {
    max: 1,
    prepare: false,
    connect_timeout: 5,
    idle_timeout: 1,
    ssl: { rejectUnauthorized: true, ca: SUPABASE_DATABASE_CA },
    connection: {
      statement_timeout: 3000,
      application_name: "fundlane-platform-monitor",
    },
  })
  try {
    const result = await runMonitor(
      { query: (query, values = []) => sql.unsafe(query, values as never[]) },
      {
        origin: env("MCA_APP_ORIGIN")!,
        token: secret,
        alerts: env("MCA_OPERATIONS_ALERTS_ENABLED") === "true",
        documentRuntimeEnabled: env("MCA_DOCUMENT_JOB_RUNTIME") === "vercel_cron" || env("MCA_NATIVE_DOCUMENT_EXECUTOR") === "true",
        billingReconciliationAlertsEnabled: env("MCA_BILLING_RECONCILIATION_ALERTS_ENABLED") === "true",
        recoveryAlerts: env("MCA_OPERATIONS_RECOVERY_ALERTS_ENABLED") === "true",
        assistantEnabled: env("MCA_ASSISTANT_ENABLED") === "true",
        thresholds: {
          workerSeconds: positiveThreshold(env("MCA_OPERATIONS_WORKER_STALE_SECONDS"), 90),
          queueSeconds: positiveThreshold(env("MCA_OPERATIONS_QUEUE_AGE_SECONDS"), 600),
          queueByKind: queueThresholds(),
          providerFailures: positiveThreshold(env("MCA_OPERATIONS_PROVIDER_FAILURES"), 5),
          billingFailures: positiveThreshold(env("MCA_OPERATIONS_BILLING_FAILURES"), 1),
          assistantRuns: positiveThreshold(env("MCA_OPERATIONS_ASSISTANT_RUNS_PER_HOUR"), 100),
        },
        recipient: env("MCA_OPERATIONS_ALERT_EMAIL"),
        webhook: env("MCA_EMAIL_WEBHOOK_URL"),
        webhookToken: env("MCA_EMAIL_WEBHOOK_TOKEN"),
      }
    )
    return Response.json(result)
  } catch {
    console.error(JSON.stringify({ event: "platform_monitor_failed" }))
    return new Response(null, { status: 503 })
  } finally {
    await sql.end({ timeout: 1 }).catch(() => undefined)
  }
})
