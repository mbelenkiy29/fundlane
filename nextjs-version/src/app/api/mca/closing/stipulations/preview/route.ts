import { NextResponse } from "next/server"
import { z } from "zod"
import { apiError } from "@/lib/mca/errors"
import { appOrigin, readJson } from "@/lib/mca/http"
import { requireClosingActor } from "@/lib/mca/closing/http"
import { previewStipulationRequest } from "@/lib/mca/closing/service"

const schema = z.object({ dealId: z.string().min(1), stipulationIds: z.array(z.string().min(1)).min(1), recipient: z.string().min(1), senderId: z.string().optional(), channel: z.enum(["email", "sms"]).optional(), idempotencyKey: z.string().min(1) }).strict()
export async function POST(request: Request) { try { return NextResponse.json(await previewStipulationRequest(await requireClosingActor(request, "write"), { ...(await readJson(request, schema)), origin: appOrigin(request) }), { status: 201 }) } catch (error) { return apiError(error) } }
