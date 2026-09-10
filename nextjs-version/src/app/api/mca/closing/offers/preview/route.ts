import { NextResponse } from "next/server"
import { z } from "zod"
import { apiError } from "@/lib/mca/errors"
import { readJson } from "@/lib/mca/http"
import { requireClosingActor } from "@/lib/mca/closing/http"
import { previewMerchantOffers } from "@/lib/mca/closing/service"

const schema = z.object({ dealId: z.string().min(1), selectionMode: z.enum(["selected", "all", "highest"]), revisionId: z.string().optional(), channel: z.enum(["email", "sms"]), senderId: z.string().optional(), recipient: z.string().min(1), idempotencyKey: z.string().min(1) }).strict()
export async function POST(request: Request) { try { return NextResponse.json(await previewMerchantOffers(await requireClosingActor(request, "write"), await readJson(request, schema)), { status: 201 }) } catch (error) { return apiError(error) } }
