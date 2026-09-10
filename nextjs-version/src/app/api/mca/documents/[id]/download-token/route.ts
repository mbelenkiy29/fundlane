import { NextResponse } from "next/server"
import { apiError } from "@/lib/mca/errors"
import { assertTrustedMutation } from "@/lib/mca/auth"
import { requireDocumentActor } from "@/lib/mca/documents/http"
import { createDocumentDownloadToken } from "@/lib/mca/documents/service"

export const runtime = "nodejs"
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    assertTrustedMutation(request)
    const actor = await requireDocumentActor(request, "read")
    const result = await createDocumentDownloadToken(actor, (await context.params).id)
    return NextResponse.json({ ...result, url: `/api/mca/documents/download/${encodeURIComponent(result.token)}` }, { headers: { "cache-control": "no-store" } })
  } catch (error) { return apiError(error) }
}
