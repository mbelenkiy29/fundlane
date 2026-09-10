import { NextResponse } from "next/server"
import { apiError } from "@/lib/mca/errors"
import { readJson } from "@/lib/mca/http"
import { leadProviderCreateSchema, leadsHeaders, requireLeadsActor } from "@/lib/mca/leads/http"
import { createLeadProvider } from "@/lib/mca/leads/service"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function POST(request: Request) {
  try {
    const actor = await requireLeadsActor(request, "write")
    const input = await readJson(request, leadProviderCreateSchema)
    return NextResponse.json(await createLeadProvider(actor, input), { status: 201, headers: leadsHeaders() })
  } catch (error) {
    return apiError(error)
  }
}
