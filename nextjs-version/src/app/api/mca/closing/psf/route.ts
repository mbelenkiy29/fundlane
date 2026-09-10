import { NextResponse } from "next/server"
import { z } from "zod"
import { apiError } from "@/lib/mca/errors"
import { readJson } from "@/lib/mca/http"
import { requireClosingActor } from "@/lib/mca/closing/http"
import { confirmPsfRequest } from "@/lib/mca/closing/service"

const schema = z.object({ dealId: z.string().min(1), offerId: z.string().optional(), revisionId: z.string().optional(), amountCents: z.number().int().positive(), bankName: z.string().min(1), routingNumber: z.string().min(1), accountNumber: z.string().min(1), businessName: z.string().min(1), contactName: z.string().min(1), contactEmail: z.email(), idempotencyKey: z.string().min(1), deliver: z.boolean().optional(), attemptKey: z.string().optional() }).strict()
export async function POST(request: Request) { try { return NextResponse.json(await confirmPsfRequest(await requireClosingActor(request, "write", true), await readJson(request, schema)), { status: 201 }) } catch (error) { return apiError(error) } }
