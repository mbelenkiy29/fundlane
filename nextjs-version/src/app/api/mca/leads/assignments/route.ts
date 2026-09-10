import { NextResponse } from "next/server"
import { apiError } from "@/lib/mca/errors"
import { readJson } from "@/lib/mca/http"
import { assignmentSchema, leadsHeaders, requireLeadsActor } from "@/lib/mca/leads/http"
import { assignDealAcquisition } from "@/lib/mca/leads/service"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function POST(request: Request) {
  try {
    const actor = await requireLeadsActor(request, "write")
    const input = await readJson(request, assignmentSchema)
    return NextResponse.json(await assignDealAcquisition(actor, input), { status: 201, headers: leadsHeaders() })
  } catch (error) {
    return apiError(error)
  }
}
