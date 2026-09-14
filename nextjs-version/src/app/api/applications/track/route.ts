import { NextResponse } from "next/server"
import { assertTrustedMutation, clientRateKey, consumeRequestRateLimit } from "@/lib/mca/auth"
import { apiError } from "@/lib/mca/errors"
import { readJson } from "@/lib/mca/http"
import { trackingInput } from "@/lib/mca/applications/contracts"
import { trackApplicationInvitation } from "@/lib/mca/applications/service"

export const runtime = "nodejs"
export async function POST(request: Request) {
  try {
    assertTrustedMutation(request)
    await consumeRequestRateLimit(clientRateKey(request, "application-track"), 120)
    const input = await readJson(request, trackingInput)
    await trackApplicationInvitation(input.token, input.kind)
    return NextResponse.json({ recorded: true }, { headers: { "Cache-Control": "no-store" } })
  } catch (error) { return apiError(error) }
}
