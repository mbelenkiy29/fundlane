import { timingSafeEqual } from "node:crypto"
import { NextResponse } from "next/server"
import { apiError, AppError } from "@/lib/mca/errors"
import { runNextBackgroundJob, touchDocumentWorkerHeartbeat } from "@/lib/mca/jobs/worker"
import { withExecutionDeadline } from "@/lib/mca/jobs/execution"
import { runDueAttachmentJobs } from "@/lib/mca/intake/service"
import { scheduleIntakeProcessing } from "@/lib/mca/intake/processing"
import type { BackgroundJobKind } from "@/lib/mca/jobs/queue"
import { scanBypassEnabled } from "@/lib/mca/documents/scanner"

export const runtime = "nodejs"
export const maxDuration = 300

const API_KINDS: readonly BackgroundJobKind[] = ["draft_extract"]
const SCAN_KINDS: readonly BackgroundJobKind[] = ["document_upload", "document_scan", "draft_scan", "assistant_scan", "intake_process"]
const BUDGET_MS = 240_000

export async function GET(request: Request) {
  try {
    if (process.env.MCA_DOCUMENT_JOB_RUNTIME !== "vercel_cron") return NextResponse.json({ enabled: false }, { headers: { "cache-control": "no-store" } })
    const secret = process.env.CRON_SECRET
    if (!secret) throw new AppError(503, "cron_unconfigured", "Document scheduler is not configured.")
    const received = Buffer.from(request.headers.get("authorization") ?? "")
    const expected = Buffer.from(`Bearer ${secret}`)
    if (received.length !== expected.length || !timingSafeEqual(received, expected)) throw new AppError(401, "unauthorized", "Invalid scheduler credentials.")
    const started = Date.now()
    const kinds = process.env.MCA_DOCUMENT_SCANNER === "cloudmersive" || scanBypassEnabled() ? [...API_KINDS, ...SCAN_KINDS] : API_KINDS
    let processed = 0
    let attachments = 0
    let scheduled = 0
    const heartbeat = setInterval(() => { void touchDocumentWorkerHeartbeat().catch(() => console.error(JSON.stringify({ event: "document_cron_heartbeat_failed" }))) }, 30_000)
    try {
      await withExecutionDeadline(async () => {
        await touchDocumentWorkerHeartbeat()
        attachments = (await runDueAttachmentJobs(2)).length
        scheduled = await scheduleIntakeProcessing(10)
        while (processed < 2 && Date.now() - started < BUDGET_MS - 10_000) {
          if (!(await runNextBackgroundJob(kinds))) break
          processed++
        }
      }, request.signal, BUDGET_MS - 10_000)
    } finally { clearInterval(heartbeat) }
    return NextResponse.json({ enabled: true, processed, attachments, scheduled, durationMs: Date.now() - started }, { headers: { "cache-control": "no-store" } })
  } catch (error) { return apiError(error) }
}
