import { NextResponse } from "next/server"
import { z } from "zod"
import { apiError } from "@/lib/mca/errors"
import { readJson } from "@/lib/mca/http"
import { requireOfferActor } from "@/lib/mca/offers/http"
import { approveManualSubmission } from "@/lib/mca/offers/manual-submissions"

export const runtime = "nodejs"
type Context = { params: Promise<{ dealId: string; submissionId: string }> }
const input = z.object({ terms: z.object({ product: z.string().optional(), amountCents: z.number().int().positive().optional(), factorRate: z.number().positive().optional(), buyRate: z.number().positive().optional(), termMonths: z.number().int().positive().optional(), paymentAmountCents: z.number().int().positive().optional(), paymentFrequency: z.enum(["daily", "weekly", "biweekly", "monthly", "irregular"]).optional(), feeCents: z.number().int().nonnegative().optional(), commissionCents: z.number().int().nonnegative().optional(), stipulations: z.array(z.string()).optional(), effectiveAt: z.string().optional() }) })
export async function POST(request: Request, context: Context) { try { const params = await context.params; const result = await approveManualSubmission(await requireOfferActor(request, "write", { administratorSession: true }), { submissionId: params.submissionId, ...await readJson(request, input) }); if (result.submission.dealId !== params.dealId) return NextResponse.json({ error: { code: "manual_submission_not_found", message: "The requested manual submission was not found." } }, { status: 404 }); return NextResponse.json(result) } catch (error) { return apiError(error) } }

