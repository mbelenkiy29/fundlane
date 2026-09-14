import { NextResponse } from "next/server"
import { clientRateKey, consumeRequestRateLimit } from "@/lib/mca/auth"
import { apiError } from "@/lib/mca/errors"
import { inspectNativeApply, submitNativeApply } from "@/lib/mca/intake/native-apply"

export const runtime = "nodejs"

export async function GET(request: Request, { params }: { params: Promise<{ token: string }> }) {
  try {
    await consumeRequestRateLimit(clientRateKey(request, "native-apply-view"), 60)
    return NextResponse.json(await inspectNativeApply((await params).token), { headers: { "cache-control": "no-store" } })
  } catch (error) {
    return apiError(error)
  }
}

export async function POST(request: Request, { params }: { params: Promise<{ token: string }> }) {
  try {
    await consumeRequestRateLimit(clientRateKey(request, "native-apply-submit"), 10)
    const body = await request.json().catch(() => null)
    return NextResponse.json(await submitNativeApply((await params).token, body), { status: 201 })
  } catch (error) {
    return apiError(error)
  }
}
