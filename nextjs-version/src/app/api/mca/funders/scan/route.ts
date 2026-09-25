import { NextResponse } from "next/server"
import { apiError, AppError } from "@/lib/mca/errors"
import {
  listCriteriaScanDocuments,
  listCriteriaScans,
  requireCriteriaScanActor,
  scanFunderCriteria,
  uploadAndScanFunderCriteria,
} from "@/lib/mca/funders/criteria-scan"
import { listFunderCriteria } from "@/lib/mca/funders/criteria"
import { getFunder } from "@/lib/mca/funders/directory"

export const runtime = "nodejs"
const noStore = { "cache-control": "no-store" }

export async function GET(request: Request) {
  try {
    const actor = await requireCriteriaScanActor(request, "read")
    const funderId = new URL(request.url).searchParams.get("funderId")?.trim()
    if (!funderId) throw new AppError(422, "funder_id_required", "Choose a funder to list criteria scans.")
    const funder = await getFunder(actor, funderId)
    const dealId = new URL(request.url).searchParams.get("dealId")?.trim()
    const current = await listFunderCriteria(actor, funder.id)
    return NextResponse.json({
      proposals: await listCriteriaScans(actor, funder.id),
      currentRules: current.rules,
      contacts: funder.contacts,
      criteriaVersion: funder.criteriaVersion,
      ...(dealId ? { documents: await listCriteriaScanDocuments(actor, dealId) } : {}),
    }, { headers: noStore })
  } catch (error) {
    return apiError(error)
  }
}

export async function POST(request: Request) {
  try {
    const actor = await requireCriteriaScanActor(request, "write")
    const contentType = request.headers.get("content-type") ?? ""
    if (contentType.includes("multipart/form-data")) {
      const form = await request.formData()
      const file = form.get("file")
      if (!(file instanceof File)) throw new AppError(422, "file_required", "Choose a PDF, PNG, or JPEG criteria sheet.")
      return NextResponse.json(await uploadAndScanFunderCriteria(actor, {
        funderId: String(form.get("funderId") ?? ""),
        dealId: String(form.get("dealId") ?? "") || undefined,
        idempotencyKey: String(form.get("idempotencyKey") ?? ""),
        filename: file.name,
        mimeType: file.type,
        bytes: new Uint8Array(await file.arrayBuffer()),
      }), { headers: noStore })
    }
    let body: { funderId?: string; documentId?: string }
    try {
      body = await request.json() as { funderId?: string; documentId?: string }
    } catch {
      throw new AppError(400, "invalid_json", "Request body must be valid JSON.")
    }
    if (!body.funderId?.trim()) throw new AppError(422, "funder_id_required", "Choose a funder to scan criteria for.")
    if (!body.documentId?.trim()) throw new AppError(422, "document_id_required", "Choose a clean vault document to scan.")
    return NextResponse.json(await scanFunderCriteria(actor, { funderId: body.funderId, documentId: body.documentId }), { headers: noStore })
  } catch (error) {
    return apiError(error)
  }
}
