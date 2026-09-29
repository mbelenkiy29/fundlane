import { NextResponse } from "next/server"
import { requireClosingActor } from "@/lib/mca/closing/http"
import { contractDocuSealSendEnabled, sendContractWithDocuSeal } from "@/lib/mca/closing/contract-docuseal-service"
import { apiError } from "@/lib/mca/errors"

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    // Do not authenticate or inspect the request while this separately shipped surface is disabled.
    if (!contractDocuSealSendEnabled()) return new NextResponse(null, { status: 404 })
    const result = await sendContractWithDocuSeal(await requireClosingActor(request, "write", true), (await params).id)
    return NextResponse.json(result, { status: result.state === "delivery_uncertain" ? 202 : 200 })
  } catch (error) { return apiError(error) }
}
