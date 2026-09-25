import { apiError, AppError } from "@/lib/mca/errors"
import { getProtectedPreviewFile, requireDocumentProtectionPreview } from "@/lib/mca/submissions/document-protection"

export const runtime = "nodejs"

export async function GET(request: Request) {
  try {
    const actor = await requireDocumentProtectionPreview(request)
    const url = new URL(request.url)
    const documentId = url.searchParams.get("documentId") ?? undefined
    const funderId = url.searchParams.get("funderId") ?? undefined
    if (!documentId || !funderId) {
      throw new AppError(422, "validation_failed", "Review the highlighted fields.", {
        ...(documentId ? {} : { documentId: ["Choose a document to preview."] }),
        ...(funderId ? {} : { funderId: ["Choose a destination funder."] }),
      })
    }
    const { filename, bytes } = await getProtectedPreviewFile(actor, { documentId, funderId })
    const safeName = filename.replace(/["\\\r\n]/g, "_")
    return new Response(Buffer.from(bytes), {
      headers: {
        "content-type": "application/pdf",
        "content-length": String(bytes.byteLength),
        "content-disposition": `inline; filename="${safeName}"`,
        "cache-control": "private, no-store",
      },
    })
  } catch (error) {
    return apiError(error)
  }
}
