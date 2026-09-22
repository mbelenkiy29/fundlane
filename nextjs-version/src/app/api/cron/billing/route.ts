import { timingSafeEqual } from "node:crypto"
import { NextResponse } from "next/server"
import { runBillingMaintenance } from "@/lib/mca/billing-operations"
import { apiError, AppError } from "@/lib/mca/errors"
export const runtime = "nodejs"
export const maxDuration = 300
export async function GET(request: Request) {
  try {
    const secret = process.env.CRON_SECRET
    if (!secret) throw new AppError(503,"cron_unconfigured","Billing scheduler is not configured.")
    const received = Buffer.from(request.headers.get("authorization") ?? ""), expected = Buffer.from(`Bearer ${secret}`)
    if (received.length !== expected.length || !timingSafeEqual(received,expected)) throw new AppError(401,"unauthorized","Invalid scheduler credentials.")
    return NextResponse.json(await runBillingMaintenance())
  } catch (error) { return apiError(error) }
}
