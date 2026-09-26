import { timingSafeEqual } from "node:crypto"
import { NextResponse } from "next/server"
import { apiError, AppError } from "@/lib/mca/errors"
import { withExecutionDeadline } from "@/lib/mca/jobs/execution"
import { runScheduledSmsJobs } from "@/lib/mca/sms/scheduler"

export const runtime = "nodejs"
export const maxDuration = 300

const BUDGET_MS = 240_000

export async function GET(request: Request) {
  try {
    if (process.env.MCA_SMS_CRON_ENABLED !== "true") {
      return NextResponse.json({ enabled: false }, { headers: { "cache-control": "no-store" } })
    }
    const secret = process.env.CRON_SECRET
    if (!secret) throw new AppError(503, "cron_unconfigured", "SMS scheduler is not configured.")
    const received = Buffer.from(request.headers.get("authorization") ?? "")
    const expected = Buffer.from(`Bearer ${secret}`)
    if (received.length !== expected.length || !timingSafeEqual(received, expected)) {
      throw new AppError(401, "unauthorized", "Invalid scheduler credentials.")
    }
    const started = Date.now()
    const result = await withExecutionDeadline(runScheduledSmsJobs, request.signal, BUDGET_MS)
    return NextResponse.json({ enabled: true, ...result, durationMs: Date.now() - started }, {
      headers: { "cache-control": "no-store" },
    })
  } catch (error) {
    return apiError(error)
  }
}
