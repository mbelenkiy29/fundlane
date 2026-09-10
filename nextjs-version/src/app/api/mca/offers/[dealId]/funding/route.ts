import { NextResponse } from "next/server"
import { z } from "zod"
import { apiError } from "@/lib/mca/errors"
import { readJson } from "@/lib/mca/http"
import { confirmOfferFunding, getFundingForDeal } from "@/lib/mca/funding/service"
import { requireOfferActor } from "@/lib/mca/offers/http"

export const runtime = "nodejs"
type Context = { params: Promise<{ dealId: string }> }
const input = z.object({ offerId: z.string().min(1), offerRevisionId: z.string().min(1), idempotencyKey: z.string().min(1).max(160), fundedAt: z.string().min(1), amountCents: z.number().int().positive().optional(), commissionCents: z.number().int().nonnegative().optional(), feeCents: z.number().int().nonnegative().optional(), expectedCommissionAt: z.string().optional(), expectedFeeAt: z.string().optional(), paymentCount: z.number().int().positive().optional(), paymentFrequency: z.enum(["daily", "weekly", "biweekly", "monthly"]).optional(), calendarConvention: z.enum(["calendar_days", "business_days", "fixed_count"]).optional(), splits: z.array(z.object({ recipientMembershipId: z.string().min(1), percentageBasisPoints: z.number().int().positive() })).optional(), source: z.enum(["live", "manual", "historical"]).optional(), manualSubmissionId: z.string().optional(), correctionOfEventId: z.string().optional() })
export async function GET(request: Request, context: Context) { try { const dealId = (await context.params).dealId; return NextResponse.json({ funding: await getFundingForDeal(await requireOfferActor(request, "read"), dealId) }, { headers: { "cache-control": "no-store" } }) } catch (error) { return apiError(error) } }
export async function POST(request: Request, context: Context) { try { const dealId = (await context.params).dealId; const body = await readJson(request, input); return NextResponse.json(await confirmOfferFunding(await requireOfferActor(request, "write", { administratorSession: body.source === "manual" || body.source === "historical" || Boolean(body.manualSubmissionId) }), { dealId, ...body }), { status: 201 }) } catch (error) { return apiError(error) } }
