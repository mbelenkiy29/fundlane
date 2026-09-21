import { apiError } from "@/lib/mca/errors"
import { downloadApprovedPortalDocument } from "@/lib/mca/submissions/portal"
import { requireSubmissionActor } from "@/lib/mca/submissions/queue"

export const runtime = "nodejs"

export async function GET(request: Request, context: { params: Promise<{ dealId: string; jobId: string; documentId: string }> }) {
  try {
    const actor = await requireSubmissionActor(request, "read")
    const { dealId, jobId, documentId } = await context.params
    const { bytes, filename } = await downloadApprovedPortalDocument(actor, dealId, jobId, documentId)
    return new Response(Buffer.from(bytes), { headers: {
      "content-type": "application/octet-stream",
      "content-length": String(bytes.byteLength),
      "content-disposition": `attachment; filename="${filename.replace(/[^\x20-\x7e]|["\\]/g, "_")}"`,
      "cache-control": "private, no-store",
      "x-content-type-options": "nosniff",
    } })
  } catch (error) { return apiError(error) }
}
