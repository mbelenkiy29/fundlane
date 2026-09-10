import { NextResponse } from "next/server"
import { apiError } from "@/lib/mca/errors"
import { leadsHeaders, requireLeadsActor } from "@/lib/mca/leads/http"
import { listLeadWorkspace } from "@/lib/mca/leads/service"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function GET(request: Request) {
  try {
    return NextResponse.json(await listLeadWorkspace(await requireLeadsActor(request, "read")), { headers: leadsHeaders() })
  } catch (error) {
    return apiError(error)
  }
}
