import { NextResponse } from "next/server"
import { z } from "zod"
import { apiError } from "@/lib/mca/errors"
import { readJson } from "@/lib/mca/http"
import { requireOfferActor } from "@/lib/mca/offers/http"
import { reviseOffer } from "@/lib/mca/offers/service"

export const runtime = "nodejs"
type Context = { params: Promise<{ dealId: string; offerId: string }> }
const input = z.object({ expectedRevisionNumber: z.number().int().positive(), terms: z.object({ product: z.string().optional(), amountCents: z.number().int().positive().optional(), factorRate: z.number().positive().optional(), buyRate: z.number().positive().optional(), termMonths: z.number().int().positive().optional(), paymentAmountCents: z.number().int().positive().optional(), paymentFrequency: z.enum(["daily", "weekly", "biweekly", "monthly", "irregular"]).optional(), feeCents: z.number().int().nonnegative().optional(), commissionCents: z.number().int().nonnegative().optional(), stipulations: z.array(z.string()).optional(), effectiveAt: z.string().optional() }) })
export async function POST(request: Request, context: Context) {
  try { const params = await context.params; const actor = await requireOfferActor(request, "write"); const offer = await reviseOffer(actor, params.offerId, await readJson(request, input)); if (offer.dealId !== params.dealId) return NextResponse.json({ error: { code: "offer_not_found", message: "The requested offer was not found." } }, { status: 404 }); return NextResponse.json(offer) }
  catch (error) { return apiError(error) }
}

