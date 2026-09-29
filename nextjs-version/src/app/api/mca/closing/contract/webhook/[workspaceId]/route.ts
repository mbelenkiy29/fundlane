import { NextResponse } from "next/server"
import { apiError } from "@/lib/mca/errors"
import { DOCUSEAL_SIGNATURE_HEADER } from "@/lib/mca/closing/docuseal-provider"
import { contractDocuSealEnabled, recordContractDocuSealWebhook } from "@/lib/mca/closing/contract-docuseal-service"

export const runtime = "nodejs"
export async function POST(request: Request, { params }: { params: Promise<{ workspaceId: string }> }) {
  if (!contractDocuSealEnabled()) return NextResponse.json({ error: { code: "not_found", message: "Not found." } }, { status: 404 })
  try {
    const workspaceId = (await params).workspaceId
    return NextResponse.json(await recordContractDocuSealWebhook(workspaceId, await request.text(), request.headers.get(DOCUSEAL_SIGNATURE_HEADER)))
  } catch (error) { return apiError(error) }
}
