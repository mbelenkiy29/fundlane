import { apiError } from "@/lib/mca/errors"
import { readJson } from "@/lib/mca/http"
import { invalidExportId, mintExportSchema, noStoreJson, requireExportActor } from "@/lib/mca/exports/http"
import { mintExportDownload } from "@/lib/mca/exports/service"

export const runtime = "nodejs"

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const id = (await context.params).id
    if (!id?.trim()) invalidExportId()
    const actor = await requireExportActor(request, "write")
    const body = request.headers.get("content-type")?.includes("json") ? await readJson(request, mintExportSchema) : {}
    return noStoreJson({ download: await mintExportDownload(actor, id, body) })
  } catch (error) {
    return apiError(error)
  }
}
