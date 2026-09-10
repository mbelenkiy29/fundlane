import { NextResponse } from "next/server"
import { z } from "zod"
import { apiError } from "@/lib/mca/errors"
import { readJson } from "@/lib/mca/http"
import { requireClosingActor } from "@/lib/mca/closing/http"
import { sendMerchantOfferPreview } from "@/lib/mca/closing/service"

const schema = z.object({ attemptKey: z.string().min(1) }).strict()
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) { try { const body = await readJson(request, schema); return NextResponse.json(await sendMerchantOfferPreview(await requireClosingActor(request, "write"), (await params).id, body.attemptKey)) } catch (error) { return apiError(error) } }
