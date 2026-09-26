import { timingSafeEqual } from "node:crypto"
import { NextResponse } from "next/server"
import { apiError, AppError } from "@/lib/mca/errors"
import { withExecutionDeadline } from "@/lib/mca/jobs/execution"
import { runNextBackgroundJob } from "@/lib/mca/jobs/worker"
import { deliverPendingReceipts } from "@/lib/mca/intake/email"
import { privateEmailDeliveryEnabled } from "@/lib/mca/intake/email-readiness"
import { invitationEmailEnabled } from "@/lib/mca/applications/service"

export const runtime = "nodejs"
export const maxDuration = 120

export async function GET(request: Request) {
  try {
    if (process.env.MCA_PRIVATE_EMAIL_CRON_ENABLED !== "true") return NextResponse.json({ enabled: false }, { headers: { "cache-control": "no-store" } })
    const secret = process.env.CRON_SECRET
    if (!secret) throw new AppError(503, "cron_unconfigured", "Email scheduler is not configured.")
    const received = Buffer.from(request.headers.get("authorization") ?? "")
    const expected = Buffer.from(`Bearer ${secret}`)
    if (received.length !== expected.length || !timingSafeEqual(received, expected)) throw new AppError(401, "unauthorized", "Invalid scheduler credentials.")
    const started = Date.now()
    let jobs = 0, receipts = 0
    await withExecutionDeadline(async () => {
      if (invitationEmailEnabled()) {
        while (jobs < 3 && Date.now() - started < 90_000) {
          if (!(await runNextBackgroundJob(["application_invitation_email", "application_invitation_reminder"]))) break
          jobs++
        }
      }
      if (privateEmailDeliveryEnabled() && Date.now() - started < 90_000) {
        receipts = (await deliverPendingReceipts({ limit: 3 })).length
      }
    }, request.signal, 100_000)
    return NextResponse.json({ enabled: true, jobs, receipts, durationMs: Date.now() - started }, { headers: { "cache-control": "no-store" } })
  } catch (error) { return apiError(error) }
}
