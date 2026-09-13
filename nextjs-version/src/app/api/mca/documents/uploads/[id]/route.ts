import { NextResponse } from "next/server"
import { assertTrustedMutation, clientRateKey, consumeRequestRateLimit } from "@/lib/mca/auth"
import { completeDirectUpload, directUploadStatus, uploadPrincipal } from "@/lib/mca/documents/direct-uploads"
import { requireDocumentActor } from "@/lib/mca/documents/http"
import { apiError } from "@/lib/mca/errors"

export const runtime = "nodejs"
type Context = { params: Promise<{ id: string }> }
async function principal(request: Request) {
  const token = request.headers.get("x-merchant-upload-token") ?? undefined
  return uploadPrincipal(token ? undefined : await requireDocumentActor(request, request.method === "GET" ? "read" : "write"), token, true)
}
export async function POST(request: Request, context: Context) {
  try {
    assertTrustedMutation(request)
    await consumeRequestRateLimit(clientRateKey(request, "direct-upload-complete"), 60)
    return NextResponse.json(await completeDirectUpload(await principal(request), (await context.params).id), { status: 202, headers: { "cache-control": "no-store" } })
  } catch (error) { return apiError(error) }
}
export async function GET(request: Request, context: Context) {
  try {
    return NextResponse.json(await directUploadStatus(await principal(request), (await context.params).id), { headers: { "cache-control": "no-store" } })
  } catch (error) { return apiError(error) }
}
