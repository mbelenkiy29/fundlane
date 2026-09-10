import { NextResponse } from "next/server"
import { apiError } from "@/lib/mca/errors"
import { requireDocumentActor } from "@/lib/mca/documents/http"
import { recordMerchantAuthorization } from "@/lib/mca/documents/pdf"

export const runtime = "nodejs"
export async function POST(request: Request) {
  try {
    const actor = await requireDocumentActor(request, "write", { sessionOnly: true })
    const input = await request.json() as { dealId: string; merchantName: string; authorizationReference: string }
    const record = await recordMerchantAuthorization(actor, input)
    return NextResponse.json({ id: record.id, dealId: record.dealId, merchantName: record.merchantName, authorizationReference: record.authorizationReference, recordedAt: record.recordedAt }, { status: 201, headers: { "cache-control": "no-store" } })
  } catch (error) { return apiError(error) }
}
