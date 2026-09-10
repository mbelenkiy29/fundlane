import { NextResponse } from "next/server"
import { apiError, AppError } from "@/lib/mca/errors"
import { DOCUMENT_CATEGORIES, type DocumentCategory } from "@/lib/mca/documents/contracts"
import { requireDocumentActor } from "@/lib/mca/documents/http"
import { listDocuments, storeDocument } from "@/lib/mca/documents/service"

export const runtime = "nodejs"
const noStore = { "cache-control": "no-store" }

export async function GET(request: Request) {
  try {
    const actor = await requireDocumentActor(request, "read")
    const dealId = new URL(request.url).searchParams.get("dealId")?.trim()
    if (!dealId) throw new AppError(422, "deal_id_required", "Choose a deal to list documents.")
    return NextResponse.json({ documents: await listDocuments(actor, dealId) }, { headers: noStore })
  } catch (error) { return apiError(error) }
}

export async function POST(request: Request) {
  try {
    const actor = await requireDocumentActor(request, "write")
    const form = await request.formData()
    const file = form.get("file")
    const category = String(form.get("category") ?? "") as DocumentCategory
    if (!(file instanceof File)) throw new AppError(422, "file_required", "Choose a PDF, PNG, or JPEG file.")
    if (!DOCUMENT_CATEGORIES.includes(category)) throw new AppError(422, "category_invalid", "Choose a valid document category.")
    const document = await storeDocument(actor, {
      dealId: String(form.get("dealId") ?? ""), idempotencyKey: String(form.get("idempotencyKey") ?? ""),
      filename: file.name, mimeType: file.type, bytes: new Uint8Array(await file.arrayBuffer()), category,
      source: String(form.get("source") ?? "user_upload"), sourceReference: String(form.get("sourceReference") ?? "") || undefined,
    })
    return NextResponse.json(document, { status: 201, headers: noStore })
  } catch (error) { return apiError(error) }
}
