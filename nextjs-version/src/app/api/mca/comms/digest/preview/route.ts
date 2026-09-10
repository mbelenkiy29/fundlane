import { NextResponse } from "next/server"
import { previewDigest, requireDigestActor } from "@/lib/mca/comms/digest"
import { apiError, AppError } from "@/lib/mca/errors"

export const runtime = "nodejs"
const noStore = { "cache-control": "no-store" }

export async function GET(request: Request) {
  try {
    const actor = await requireDigestActor(request, "read")
    const nowIso = new URL(request.url).searchParams.get("nowIso")
    if (nowIso && !Number.isFinite(Date.parse(nowIso))) {
      throw new AppError(422, "invalid_clock", "Provide a valid ISO-8601 nowIso for digest windows.")
    }
    return NextResponse.json(await previewDigest(actor, nowIso ?? undefined), { headers: noStore })
  } catch (error) {
    return apiError(error)
  }
}
