import { apiError, AppError } from "@/lib/mca/errors"
import {
  redeemProtectedPreview,
  requireDocumentProtectionDownload,
} from "@/lib/mca/submissions/document-protection"

export const runtime = "nodejs"

function previewTokenParam(raw: string): string {
  try {
    return decodeURIComponent(raw)
  } catch {
    throw new AppError(404, "download_link_invalid", "This download link is invalid or expired.")
  }
}

export async function GET(request: Request, context: { params: Promise<{ token: string }> }) {
  try {
    const actor = await requireDocumentProtectionDownload(request)
    const { filename, bytes } = await redeemProtectedPreview(actor, previewTokenParam((await context.params).token))
    const disposition = new URL(request.url).searchParams.get("preview") === "1" ? "inline" : "attachment"
    return new Response(Buffer.from(bytes), {
      headers: {
        "content-type": "application/pdf",
        "content-length": String(bytes.byteLength),
        "content-disposition": `${disposition}; filename="${filename}"`,
        "cache-control": "private, no-store",
      },
    })
  } catch (error) {
    return apiError(error)
  }
}
