import { NextResponse } from "next/server"
import { z } from "zod"
import { apiError } from "@/lib/mca/errors"
import { readJson } from "@/lib/mca/http"
import { requireClosingActor } from "@/lib/mca/closing/http"
import { acceptOfferForClosing } from "@/lib/mca/closing/service"

const schema = z.object({ dealId: z.string().min(1), offerId: z.string().optional(), revisionId: z.string().optional(), idempotencyKey: z.string().min(1) }).strict()
export async function POST(request: Request) { try { return NextResponse.json(await acceptOfferForClosing(await requireClosingActor(request, "write"), await readJson(request, schema)), { status: 201 }) } catch (error) { return apiError(error) } }
