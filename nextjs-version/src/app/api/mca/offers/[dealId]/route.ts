import { NextResponse } from "next/server"
import { z } from "zod"
import { apiError } from "@/lib/mca/errors"
import { readJson } from "@/lib/mca/http"
import { requireOfferActor } from "@/lib/mca/offers/http"
import { createOffer, getOffers } from "@/lib/mca/offers/service"

export const runtime = "nodejs"
type Context = { params: Promise<{ dealId: string }> }
const terms = z.object({ product: z.string().optional(), amountCents: z.number().int().positive().optional(), factorRate: z.number().positive().optional(), buyRate: z.number().positive().optional(), termMonths: z.number().int().positive().optional(), paymentAmountCents: z.number().int().positive().optional(), paymentFrequency: z.enum(["daily", "weekly", "biweekly", "monthly", "irregular"]).optional(), feeCents: z.number().int().nonnegative().optional(), commissionCents: z.number().int().nonnegative().optional(), stipulations: z.array(z.string()).optional(), effectiveAt: z.string().optional() })
const create = z.object({ submissionId: z.string().optional(), funderId: z.string().optional(), funderName: z.string(), source: z.enum(["api", "email", "link", "manual", "historical"]).optional(), externalId: z.string().optional(), terms })

export async function GET(request: Request, context: Context) {
  try { const dealId = (await context.params).dealId; return NextResponse.json({ offers: await getOffers(await requireOfferActor(request, "read"), dealId) }, { headers: { "cache-control": "no-store" } }) }
  catch (error) { return apiError(error) }
}
export async function POST(request: Request, context: Context) {
  try { const dealId = (await context.params).dealId; return NextResponse.json(await createOffer(await requireOfferActor(request, "write"), { dealId, ...await readJson(request, create) }), { status: 201 }) }
  catch (error) { return apiError(error) }
}

