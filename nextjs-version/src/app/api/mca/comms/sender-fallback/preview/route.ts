import { NextResponse } from "next/server"
import {
  previewFollowupSender,
  requireSenderFallbackRead,
  senderFallbackPreviewSchema,
} from "@/lib/mca/comms/sender-fallback"
import { apiError } from "@/lib/mca/errors"
import { readJson } from "@/lib/mca/http"

export const runtime = "nodejs"
const noStore = { "cache-control": "no-store" }

export async function GET(request: Request) {
  try {
    const actor = await requireSenderFallbackRead(request)
    const url = new URL(request.url)
    return NextResponse.json(await previewFollowupSender(actor, {
      dealId: url.searchParams.get("dealId") ?? undefined,
      templateId: url.searchParams.get("templateId") ?? undefined,
      originatorMembershipId: url.searchParams.get("originatorMembershipId") ?? undefined,
    }), { headers: noStore })
  } catch (error) {
    return apiError(error)
  }
}

export async function POST(request: Request) {
  try {
    const actor = await requireSenderFallbackRead(request)
    const input = await readJson(request, senderFallbackPreviewSchema)
    return NextResponse.json(await previewFollowupSender(actor, input), { headers: noStore })
  } catch (error) {
    return apiError(error)
  }
}
