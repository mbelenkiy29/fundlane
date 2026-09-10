import { apiError } from "@/lib/mca/errors"
import { invalidExportId, noStoreJson, requireExportActor } from "@/lib/mca/exports/http"
import { getExportJob } from "@/lib/mca/exports/service"

export const runtime = "nodejs"

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const id = (await context.params).id
    if (!id?.trim()) invalidExportId()
    return noStoreJson({ job: await getExportJob(await requireExportActor(request, "read"), id) })
  } catch (error) {
    return apiError(error)
  }
}
