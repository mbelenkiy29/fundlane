import { timingSafeEqual } from "node:crypto"
import { NextResponse } from "next/server"
import { runScheduledCommsJobs } from "@/lib/mca/comms/scheduler"
import { apiError, AppError } from "@/lib/mca/errors"

export const runtime = "nodejs"
export const maxDuration = 300

export async function GET(request: Request) {
  try {
    const secret = process.env.CRON_SECRET
    if (!secret) throw new AppError(503, "cron_unconfigured", "Communications scheduler is not configured.")
    const received = Buffer.from(request.headers.get("authorization") ?? "")
    const expected = Buffer.from(`Bearer ${secret}`)
    if (received.length !== expected.length || !timingSafeEqual(received, expected)) {
      throw new AppError(401, "unauthorized", "Invalid scheduler credentials.")
    }
    const clock = new URL(request.url).searchParams.get("nowIso")
    return NextResponse.json(await runScheduledCommsJobs(clock && Number.isFinite(Date.parse(clock)) ? clock : undefined), {
      headers: { "cache-control": "no-store" },
    })
  } catch (error) {
    return apiError(error)
  }
}
