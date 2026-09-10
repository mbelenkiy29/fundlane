import { apiError } from "@/lib/mca/errors"
import { requireDocumentActor } from "@/lib/mca/documents/http"
import { redeemDocumentDownloadToken } from "@/lib/mca/documents/service"

export const runtime = "nodejs"
export async function GET(request: Request, context: { params: Promise<{ token: string }> }) {
  try {
    const actor = await requireDocumentActor(request, "read")
    const { document, bytes } = await redeemDocumentDownloadToken(actor, (await context.params).token)
    const disposition = new URL(request.url).searchParams.get("preview") === "1" ? "inline" : "attachment"
    return new Response(Buffer.from(bytes), { headers: {
      "content-type": document.mimeType,
      "content-length": String(bytes.byteLength),
      "content-disposition": `${disposition}; filename="${document.displayFilename.replace(/["\\]/g, "_")}"`,
      "cache-control": "private, no-store",
    } })
  } catch (error) { return apiError(error) }
}
