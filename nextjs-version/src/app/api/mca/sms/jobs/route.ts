import { timingSafeEqual } from "node:crypto"
import { NextResponse } from "next/server"
import { apiError, AppError } from "@/lib/mca/errors"
import { maintenance } from "@/lib/mca/sms/maintenance"
export async function POST(request: Request) {
  try {
    const configured = process.env.MCA_SMS_JOB_TOKEN,
      a = Buffer.from(request.headers.get("authorization") ?? ""),
      b = Buffer.from(`Bearer ${configured ?? ""}`)
    if (!configured || a.length !== b.length || !timingSafeEqual(a, b))
      throw new AppError(401, "job_auth_required", "Invalid job credential.")
    return NextResponse.json(await maintenance(), {
      headers: { "cache-control": "no-store" },
    })
  } catch (e) {
    return apiError(e)
  }
}
