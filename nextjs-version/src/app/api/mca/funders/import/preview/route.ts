import { NextResponse } from "next/server"
import { apiError, AppError } from "@/lib/mca/errors"
import { previewFunderImport, requireFunderImportActor } from "@/lib/mca/funders/import"

export const runtime = "nodejs"
const noStore = { "cache-control": "no-store" }

export async function POST(request: Request) {
  try {
    const actor = await requireFunderImportActor(request)
    const contentType = request.headers.get("content-type") ?? ""
    if (contentType.includes("multipart/form-data")) {
      const form = await request.formData()
      const file = form.get("file")
      if (file instanceof File) {
        return NextResponse.json(await previewFunderImport(actor, {
          filename: file.name,
          bytes: new Uint8Array(await file.arrayBuffer()),
        }), { headers: noStore })
      }
      const text = String(form.get("text") ?? "")
      if (text.trim()) return NextResponse.json(await previewFunderImport(actor, { text }), { headers: noStore })
      throw new AppError(422, "funder_import_empty", "Choose a CSV or JSON file of funders to review.")
    }
    let body: { funders?: unknown; text?: string }
    try {
      body = await request.json() as { funders?: unknown; text?: string }
    } catch {
      throw new AppError(400, "invalid_json", "Request body must be valid JSON.")
    }
    return NextResponse.json(await previewFunderImport(actor, body), { headers: noStore })
  } catch (error) {
    return apiError(error)
  }
}
