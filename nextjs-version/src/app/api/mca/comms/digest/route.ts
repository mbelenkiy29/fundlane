import { NextResponse } from "next/server"
import {
  digestSubscriptionPatchSchema,
  getDigestSubscription,
  requireDigestActor,
  requireDigestWrite,
  updateDigestSubscription,
} from "@/lib/mca/comms/digest"
import { apiError, AppError } from "@/lib/mca/errors"
import { readJson } from "@/lib/mca/http"

export const runtime = "nodejs"
const noStore = { "cache-control": "no-store" }

function clockFrom(request: Request, bodyNow?: string): string | undefined {
  const query = new URL(request.url).searchParams.get("nowIso") ?? bodyNow
  if (!query) return undefined
  if (!Number.isFinite(Date.parse(query))) {
    throw new AppError(422, "invalid_clock", "Provide a valid ISO-8601 nowIso for digest windows.")
  }
  return query
}

export async function GET(request: Request) {
  try {
    const actor = await requireDigestActor(request, "read")
    const nowIso = clockFrom(request)
    return NextResponse.json(await getDigestSubscription(actor, nowIso), { headers: noStore })
  } catch (error) {
    return apiError(error)
  }
}

export async function PATCH(request: Request) {
  try {
    const actor = await requireDigestWrite(request)
    const input = await readJson(request, digestSubscriptionPatchSchema)
    const nowIso = clockFrom(request, input.nowIso)
    return NextResponse.json(await updateDigestSubscription(actor, input, nowIso), { headers: noStore })
  } catch (error) {
    return apiError(error)
  }
}
