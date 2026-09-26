import { timingSafeEqual } from "node:crypto"
import { NextResponse } from "next/server"
import { apiError, AppError } from "@/lib/mca/errors"
import { runNextBackgroundJob } from "@/lib/mca/jobs/worker"
import { withExecutionDeadline } from "@/lib/mca/jobs/execution"
import type { BackgroundJobKind } from "@/lib/mca/jobs/queue"

export const runtime = "nodejs"
export const maxDuration = 300

// These jobs generate private exports without native binaries or outbound delivery.
const VERCEL_JOB_KINDS: readonly BackgroundJobKind[] = ["export_create", "export"]
const BUDGET_MS = 240_000
const MAX_JOBS = 3

export async function GET(request: Request) {
  try {
    if (process.env.MCA_JOB_RUNTIME !== "vercel_cron") return NextResponse.json({ enabled: false }, { headers: { "cache-control": "no-store" } })
    const secret = process.env.CRON_SECRET
    if (!secret) throw new AppError(503, "cron_unconfigured", "Job scheduler is not configured.")
    const received = Buffer.from(request.headers.get("authorization") ?? "")
    const expected = Buffer.from(`Bearer ${secret}`)
    if (received.length !== expected.length || !timingSafeEqual(received, expected)) throw new AppError(401, "unauthorized", "Invalid scheduler credentials.")
    const started = Date.now()
    let processed = 0
    await withExecutionDeadline(async () => {
      while (processed < MAX_JOBS && Date.now() - started < BUDGET_MS - 10_000) {
        if (!(await runNextBackgroundJob(VERCEL_JOB_KINDS))) break
        processed++
      }
    }, request.signal, BUDGET_MS)
    return NextResponse.json({ enabled: true, processed, durationMs: Date.now() - started }, { headers: { "cache-control": "no-store" } })
  } catch (error) { return apiError(error) }
}
