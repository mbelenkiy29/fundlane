import { NextResponse } from "next/server"
import { apiError } from "@/lib/mca/errors"
import { DOCUSEAL_SIGNATURE_HEADER } from "@/lib/mca/closing/docuseal-provider"
import { contractDocuSealEnabled, contractDocuSealVerificationEnabled, recordContractDocuSealWebhook, verifyContractDocuSealCompletion } from "@/lib/mca/closing/contract-docuseal-service"

export const runtime = "nodejs"
export async function POST(request: Request, { params }: { params: Promise<{ workspaceId: string }> }) {
  if (!contractDocuSealEnabled()) return NextResponse.json({ error: { code: "not_found", message: "Not found." } }, { status: 404 })
  try {
    const workspaceId = (await params).workspaceId
    const rawBody = await request.text()
    const receipt = await recordContractDocuSealWebhook(workspaceId, rawBody, request.headers.get(DOCUSEAL_SIGNATURE_HEADER))
    if (receipt.state === "received" && contractDocuSealVerificationEnabled()) {
      const payload = JSON.parse(rawBody) as { data?: { id?: string | number } }
      return NextResponse.json(await verifyContractDocuSealCompletion(workspaceId, String(payload.data?.id)))
    }
    return NextResponse.json(receipt)
  } catch (error) { return apiError(error) }
}
