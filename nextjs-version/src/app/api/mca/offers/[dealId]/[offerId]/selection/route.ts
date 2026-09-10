import { NextResponse } from "next/server"
import { z } from "zod"
import { apiError } from "@/lib/mca/errors"
import { readJson } from "@/lib/mca/http"
import { requireOfferActor } from "@/lib/mca/offers/http"
import { selectOfferRevision } from "@/lib/mca/offers/service"

export const runtime = "nodejs"
type Context = { params: Promise<{ dealId: string; offerId: string }> }
const input = z.object({ revisionId: z.string().min(1), selected: z.boolean(), reason: z.string().max(500).optional() })
export async function POST(request: Request, context: Context) {
  try { const params = await context.params; return NextResponse.json(await selectOfferRevision(await requireOfferActor(request, "write"), { dealId: params.dealId, offerId: params.offerId, ...await readJson(request, input) })) }
  catch (error) { return apiError(error) }
}

