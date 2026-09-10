import { NextResponse } from "next/server"
import { z } from "zod"
import { apiError } from "@/lib/mca/errors"
import { readJson } from "@/lib/mca/http"
import { requireClosingActor } from "@/lib/mca/closing/http"
import { recordPhonePitch } from "@/lib/mca/closing/service"

const schema = z.object({ dealId: z.string().min(1), offerId: z.string().optional(), revisionId: z.string().optional(), notes: z.string().max(1000).optional(), idempotencyKey: z.string().min(1) }).strict()
export async function POST(request: Request) { try { return NextResponse.json(await recordPhonePitch(await requireClosingActor(request, "write", true), await readJson(request, schema)), { status: 201 }) } catch (error) { return apiError(error) } }
