import { NextResponse } from "next/server"
import {
  listFollowupSenderCatalog,
  requireSenderFallbackAdmin,
  requireSenderFallbackRead,
  senderFallbackPatchSchema,
  updateFollowupSenderSettings,
} from "@/lib/mca/comms/sender-fallback"
import { apiError } from "@/lib/mca/errors"
import { readJson } from "@/lib/mca/http"

export const runtime = "nodejs"
const noStore = { "cache-control": "no-store" }

export async function GET(request: Request) {
  try {
    const actor = await requireSenderFallbackRead(request)
    return NextResponse.json(await listFollowupSenderCatalog(actor), { headers: noStore })
  } catch (error) {
    return apiError(error)
  }
}

export async function PATCH(request: Request) {
  try {
    const actor = await requireSenderFallbackAdmin(request)
    const input = await readJson(request, senderFallbackPatchSchema)
    return NextResponse.json(await updateFollowupSenderSettings(actor, input), { headers: noStore })
  } catch (error) {
    return apiError(error)
  }
}
