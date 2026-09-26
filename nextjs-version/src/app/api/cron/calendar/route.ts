import { timingSafeEqual } from "node:crypto"
import { NextResponse } from "next/server"
import { apiError, AppError } from "@/lib/mca/errors"
import { withTransactionAdvisoryLock } from "@/lib/mca/db"
import { runCalendarWorkerOnce } from "@/lib/mca/calendar/sync"
import { withExecutionDeadline } from "@/lib/mca/jobs/execution"

export const runtime = "nodejs"
export const maxDuration = 300

const BUDGET_MS = 240_000
const MAX_CONNECTIONS = 3

export async function GET(request: Request) {
  try {
    if (process.env.MCA_CALENDAR_GOOGLE_ENABLED !== "true" || process.env.MCA_CALENDAR_RUNTIME !== "vercel_cron")
      return NextResponse.json({ enabled: false }, { headers: { "cache-control": "no-store" } })
    const secret = process.env.CRON_SECRET
    if (!secret) throw new AppError(503, "cron_unconfigured", "Calendar scheduler is not configured.")
    const received = Buffer.from(request.headers.get("authorization") ?? "")
    const expected = Buffer.from(`Bearer ${secret}`)
    if (received.length !== expected.length || !timingSafeEqual(received, expected))
      throw new AppError(401, "unauthorized", "Invalid scheduler credentials.")

    const started = Date.now()
    const tick = await withTransactionAdvisoryLock("calendar:cron:consumer", () =>
      withExecutionDeadline(() => runCalendarWorkerOnce(MAX_CONNECTIONS, started + BUDGET_MS - 10_000), request.signal, BUDGET_MS - 10_000))
    return NextResponse.json({ enabled: true, busy: tick.busy, processed: tick.busy ? 0 : tick.result, durationMs: Date.now() - started }, { headers: { "cache-control": "no-store" } })
  } catch (error) { return apiError(error) }
}
