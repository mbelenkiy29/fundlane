import { NextResponse } from "next/server"
import { assertTrustedMutation, clientRateKey, consumeRequestRateLimit } from "@/lib/mca/auth"
import { apiError, AppError } from "@/lib/mca/errors"
import { readJson } from "@/lib/mca/http"
import { draftInput } from "@/lib/mca/applications/contracts"
import { getApplicationSession, saveApplicationDraft } from "@/lib/mca/applications/draft"
import { INVITE_TOKEN_PATTERN } from "@/lib/mca/applications/form-schema"

export const runtime = "nodejs"

export async function GET(request: Request) {
  try {
    await consumeRequestRateLimit(clientRateKey(request, "application-session"), 120)
    const token = new URL(request.url).searchParams.get("token") ?? ""
    if (!INVITE_TOKEN_PATTERN.test(token)) throw new AppError(410, "invitation_inactive", "This application link is expired, completed, or no longer active.")
    return NextResponse.json(await getApplicationSession(token), { headers: { "Cache-Control": "no-store" } })
  } catch (error) { return apiError(error) }
}

export async function PATCH(request: Request) {
  try {
    assertTrustedMutation(request)
    await consumeRequestRateLimit(clientRateKey(request, "application-draft"), 180)
    const input = await readJson(request, draftInput)
    return NextResponse.json(await saveApplicationDraft(input.token, input.step, input.answers), { headers: { "Cache-Control": "no-store" } })
  } catch (error) { return apiError(error) }
}
