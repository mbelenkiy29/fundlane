import { NextResponse } from "next/server"
import { apiError } from "@/lib/mca/errors"
import { requireDocumentActor } from "@/lib/mca/documents/http"
import { generateApplicationPdf, type GenerateApplicationPdfInput } from "@/lib/mca/documents/pdf"

export const runtime = "nodejs"
export async function POST(request: Request) {
  try {
    const actor = await requireDocumentActor(request, "write")
    const input = await request.json() as GenerateApplicationPdfInput
    return NextResponse.json(await generateApplicationPdf(actor, input), { headers: { "cache-control": "no-store" } })
  } catch (error) { return apiError(error) }
}
