import { apiError } from "@/lib/mca/errors"
import { noStoreJson, readCreateExport, requireExportActor } from "@/lib/mca/exports/http"
import { createExportJob, listExportJobs } from "@/lib/mca/exports/service"

export const runtime = "nodejs"

export async function GET(request: Request) {
  try {
    return noStoreJson(await listExportJobs(await requireExportActor(request, "read")))
  } catch (error) {
    return apiError(error)
  }
}

export async function POST(request: Request) {
  try {
    const actor = await requireExportActor(request, "write")
    const input = await readCreateExport(request)
    const result = await createExportJob(actor, input)
    return noStoreJson(result, result.job.replayed ? 200 : 201)
  } catch (error) {
    return apiError(error)
  }
}
