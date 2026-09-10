import { NextResponse } from "next/server"
import { apiError, AppError } from "@/lib/mca/errors"
import { requireDocumentActor } from "@/lib/mca/documents/http"
import { createApplicationDraft } from "@/lib/mca/documents/application-drafts"

export const runtime = "nodejs"
export async function POST(request: Request) {
  try {
    const actor = await requireDocumentActor(request, "write")
    const form = await request.formData()
    const file = form.get("file")
    if (!(file instanceof File)) throw new AppError(422, "file_required", "Choose an application PDF.")
    const draft = await createApplicationDraft(actor, { idempotencyKey: String(form.get("idempotencyKey") ?? ""), filename: file.name, mimeType: file.type, bytes: new Uint8Array(await file.arrayBuffer()) })
    return NextResponse.json(draft, { status: 201, headers: { "cache-control": "no-store" } })
  } catch (error) { return apiError(error) }
}
