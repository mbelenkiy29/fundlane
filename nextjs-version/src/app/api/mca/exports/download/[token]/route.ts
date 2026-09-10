import { apiError } from "@/lib/mca/errors"
import { csvResponse, requireExportActor } from "@/lib/mca/exports/http"
import { redeemExportDownload } from "@/lib/mca/exports/service"

export const runtime = "nodejs"

export async function GET(request: Request, context: { params: Promise<{ token: string }> }) {
  try {
    const token = (await context.params).token
    const actor = await requireExportActor(request, "download")
    const result = await redeemExportDownload(actor, token)
    return csvResponse(result.csv, result.filename)
  } catch (error) {
    return apiError(error)
  }
}
