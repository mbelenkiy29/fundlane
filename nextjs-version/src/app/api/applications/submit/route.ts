import { NextResponse } from "next/server"
import { assertTrustedMutation, clientRateKey, consumeRequestRateLimit } from "@/lib/mca/auth"
import { apiError } from "@/lib/mca/errors"
import { readJson } from "@/lib/mca/http"
import { sessionTokenInput } from "@/lib/mca/applications/contracts"
import { submitFundlaneApplication } from "@/lib/mca/applications/submit"

export const runtime = "nodejs"

export async function POST(request: Request) {
  try {
    assertTrustedMutation(request)
    await consumeRequestRateLimit(clientRateKey(request, "application-submit"), 20)
    const input = await readJson(request, sessionTokenInput)
    return NextResponse.json(await submitFundlaneApplication(input.token), { headers: { "Cache-Control": "no-store" } })
  } catch (error) { return apiError(error) }
}
