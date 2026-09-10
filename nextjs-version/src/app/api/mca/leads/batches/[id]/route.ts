import { NextResponse } from "next/server"
import { apiError } from "@/lib/mca/errors"
import { readJson } from "@/lib/mca/http"
import { leadsHeaders, purchaseBatchUpdateSchema, requireLeadsActor } from "@/lib/mca/leads/http"
import { updatePurchaseBatch } from "@/lib/mca/leads/service"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

interface RouteContext { params: Promise<{ id: string }> }

export async function PATCH(request: Request, context: RouteContext) {
  try {
    const actor = await requireLeadsActor(request, "write")
    const input = await readJson(request, purchaseBatchUpdateSchema)
    return NextResponse.json(await updatePurchaseBatch(actor, (await context.params).id, input), { headers: leadsHeaders() })
  } catch (error) {
    return apiError(error)
  }
}
