import { NextResponse } from "next/server"
import { apiError } from "@/lib/mca/errors"
import { DOCUSEAL_SIGNATURE_HEADER } from "@/lib/mca/closing/docuseal-provider"
import { recordPsfDocuSealWebhook, recordPsfWebhook } from "@/lib/mca/closing/service"

export const runtime = "nodejs"
export async function POST(request: Request, { params }: { params: Promise<{ workspaceId: string }> }) {
  try {
    const workspaceId = (await params).workspaceId, rawBody = await request.text(), docuSealSignature = request.headers.get(DOCUSEAL_SIGNATURE_HEADER)
    return NextResponse.json(docuSealSignature
      ? await recordPsfDocuSealWebhook(workspaceId, rawBody, docuSealSignature)
      : await recordPsfWebhook(workspaceId, rawBody, request.headers.get("x-mca-signature")))
  } catch (error) { return apiError(error) }
}
