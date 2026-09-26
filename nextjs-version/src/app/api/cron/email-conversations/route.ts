import { timingSafeEqual } from "node:crypto"
import { NextResponse } from "next/server"
import { apiError, AppError } from "@/lib/mca/errors"
import { runScheduledEmailConversations } from "@/lib/mca/email-conversations/runtime"

export const runtime = "nodejs"
export const maxDuration = 300

export async function GET(request: Request) {
  try {
    if (process.env.MCA_EMAIL_CONVERSATIONS_RUNTIME !== "vercel_cron")
      return NextResponse.json({ enabled: false }, { headers: { "cache-control": "no-store" } })
    const secret = process.env.CRON_SECRET
    if (!secret) throw new AppError(503, "cron_unconfigured", "Email scheduler is not configured.")
    const received = Buffer.from(request.headers.get("authorization") ?? "")
    const expected = Buffer.from(`Bearer ${secret}`)
    if (received.length !== expected.length || !timingSafeEqual(received, expected))
      throw new AppError(401, "unauthorized", "Invalid scheduler credentials.")
    const started = Date.now()
    const result = await runScheduledEmailConversations(request.signal)
    return NextResponse.json({ enabled: true, ...result, durationMs: Date.now() - started },
      { headers: { "cache-control": "no-store" } })
  } catch (error) {
    return apiError(error)
  }
}
