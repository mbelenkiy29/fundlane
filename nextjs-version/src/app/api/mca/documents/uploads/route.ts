import { NextResponse } from "next/server"
import { assertTrustedMutation, clientRateKey, consumeRequestRateLimit } from "@/lib/mca/auth"
import { authorizeDirectUpload, uploadPrincipal, type DirectUploadInput } from "@/lib/mca/documents/direct-uploads"
import { requireDocumentActor } from "@/lib/mca/documents/http"
import { apiError } from "@/lib/mca/errors"

export const runtime = "nodejs"
export async function POST(request: Request) {
  try {
    assertTrustedMutation(request)
    await consumeRequestRateLimit(clientRateKey(request, "direct-upload-authorize"), 30)
    const input = await request.json() as DirectUploadInput
    const principal = await uploadPrincipal(input.merchantToken ? undefined : await requireDocumentActor(request, "write"), input.merchantToken)
    return NextResponse.json(await authorizeDirectUpload(principal, input), { headers: { "cache-control": "no-store" } })
  } catch (error) { return apiError(error) }
}
