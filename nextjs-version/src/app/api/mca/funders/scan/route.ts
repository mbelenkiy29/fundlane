import { NextResponse } from "next/server"
import { consumeRequestRateLimit } from "@/lib/mca/auth"
import { MAX_DOCUMENT_BYTES } from "@/lib/mca/documents/service"
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
    await consumeRequestRateLimit(`funder-criteria-scan:${actor.workspaceId}:${actor.membershipId}`, 10)
    const contentType = request.headers.get("content-type") ?? ""
    if (contentType.includes("multipart/form-data")) {
      const form = await request.formData()
      const file = form.get("file")
      if (!(file instanceof File)) throw new AppError(422, "file_required", "Choose a PDF, PNG, or JPEG criteria sheet.")
      if (file.size > MAX_DOCUMENT_BYTES) {
        throw new AppError(413, "document_size_invalid", `Documents must be between 1 byte and ${MAX_DOCUMENT_BYTES} bytes.`)
      }
      return NextResponse.json(await uploadAndScanFunderCriteria(actor, {
        funderId: String(form.get("funderId") ?? ""),
        dealId: String(form.get("dealId") ?? "") || undefined,
        idempotencyKey: String(form.get("idempotencyKey") ?? ""),
        filename: file.name,
        mimeType: file.type,
        bytes: new Uint8Array(await file.arrayBuffer()),
      }), { headers: noStore })
    }
    let body: { funderId?: string; documentId?: string } | unknown
    try {
      body = await request.json()
    } catch {
      throw new AppError(400, "invalid_json", "Request body must be valid JSON.")
    }
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw new AppError(400, "invalid_json", "Request body must be valid JSON.")
    }
    const payload = body as { funderId?: string; documentId?: string }
    if (!payload.funderId?.trim()) throw new AppError(422, "funder_id_required", "Choose a funder to scan criteria for.")
    if (!payload.documentId?.trim()) throw new AppError(422, "document_id_required", "Choose a clean vault document to scan.")
    return NextResponse.json(await scanFunderCriteria(actor, { funderId: payload.funderId, documentId: payload.documentId }), { headers: noStore })
  } catch (error) {
    return apiError(error)
  }
}
