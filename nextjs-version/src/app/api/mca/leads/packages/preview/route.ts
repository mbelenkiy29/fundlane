import { NextResponse } from "next/server"
import { AppError, apiError } from "@/lib/mca/errors"
import { leadsHeaders, requireLeadsActor } from "@/lib/mca/leads/http"
import { previewPurchasedPackage } from "@/lib/mca/leads/service"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function POST(request: Request) {
  try {
    const actor = await requireLeadsActor(request, "write")
    const form = await request.formData()
    const file = form.get("file")
    if (!(file instanceof File)) throw new AppError(422, "import_file_required", "Choose a purchased-package spreadsheet to preview.")
    const mappingRaw = form.get("mapping")
    const mapping = typeof mappingRaw === "string" && mappingRaw ? JSON.parse(mappingRaw) as Record<string, string> : undefined
    const preview = await previewPurchasedPackage(actor, {
      sourceId: String(form.get("sourceId") ?? ""),
      batchId: String(form.get("batchId") ?? ""),
      filename: file.name,
      bytes: new Uint8Array(await file.arrayBuffer()),
      mapping,
    })
    return NextResponse.json(preview, { status: 201, headers: leadsHeaders() })
  } catch (error) {
    return apiError(error)
  }
}
