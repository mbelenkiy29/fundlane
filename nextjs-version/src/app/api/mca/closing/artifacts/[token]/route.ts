import { apiError } from "@/lib/mca/errors"
import { clientRateKey, consumeRequestRateLimit } from "@/lib/mca/auth"
import { redeemClosingArtifact } from "@/lib/mca/closing/service"

export const runtime = "nodejs"
export async function GET(request: Request, { params }: { params: Promise<{ token: string }> }) {
  try {
    await consumeRequestRateLimit(clientRateKey(request, "closing-artifact"), 60)
    const result = await redeemClosingArtifact((await params).token)
    return new Response(Buffer.from(result.bytes), { headers: { "content-type": result.mimeType, "content-length": String(result.bytes.byteLength), "content-disposition": `attachment; filename="${result.filename.replace(/["\\]/g, "_")}"`, "cache-control": "private, no-store" } })
  } catch (error) { return apiError(error) }
}
