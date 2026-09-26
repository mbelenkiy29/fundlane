import postgres from "npm:postgres@3.4.7"
// Bundled by build-monitor.mjs; deployed with the Deno runtime.
import { runMonitor } from "../../src/lib/mca/operations/monitor"
import { SUPABASE_DATABASE_CA } from "../../src/lib/mca/supabase-ca"
declare const Deno: {
  env: { get: (name: string) => string | undefined }
  serve: (handler: (request: Request) => Promise<Response>) => void
}
const env = (name: string) => Deno.env.get(name)
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
