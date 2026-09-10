import { NextResponse } from "next/server"
import { apiError } from "@/lib/mca/errors"
import { readJson } from "@/lib/mca/http"
import { leadsHeaders, purchasedCommitSchema, requireLeadsActor } from "@/lib/mca/leads/http"
import { commitPurchasedPackage } from "@/lib/mca/leads/service"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

interface RouteContext { params: Promise<{ runId: string }> }

export async function POST(request: Request, context: RouteContext) {
  try {
    const actor = await requireLeadsActor(request, "write")
    const input = await readJson(request, purchasedCommitSchema)
    return NextResponse.json(await commitPurchasedPackage(actor, {
      runId: (await context.params).runId,
      expectedPreviewRevision: input.expectedPreviewRevision,
    }), { headers: leadsHeaders() })
  } catch (error) {
    return apiError(error)
  }
}
