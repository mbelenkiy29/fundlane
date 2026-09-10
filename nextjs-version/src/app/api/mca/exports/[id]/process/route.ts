import { apiError } from "@/lib/mca/errors"
import { invalidExportId, noStoreJson, requireExportActor } from "@/lib/mca/exports/http"
import { processExportJob } from "@/lib/mca/exports/service"

export const runtime = "nodejs"

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const id = (await context.params).id
    if (!id?.trim()) invalidExportId()
    const job = await processExportJob(await requireExportActor(request, "write"), id)
    return noStoreJson({ job })
  } catch (error) {
    return apiError(error)
  }
}
