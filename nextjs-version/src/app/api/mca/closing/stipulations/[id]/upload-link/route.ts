import { NextResponse } from "next/server"
import { z } from "zod"
import { apiError } from "@/lib/mca/errors"
import { appOrigin, readJson } from "@/lib/mca/http"
import { requireClosingActor } from "@/lib/mca/closing/http"
import { createMerchantUploadLink } from "@/lib/mca/closing/service"

const schema = z.object({ idempotencyKey: z.string().min(1), expiresInHours: z.number().int().min(1).max(168).optional(), maxUploads: z.number().int().min(1).max(10).optional() }).strict()
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) { try { return NextResponse.json(await createMerchantUploadLink(await requireClosingActor(request, "write"), { stipulationId: (await params).id, ...(await readJson(request, schema)), origin: appOrigin(request) }), { status: 201 }) } catch (error) { return apiError(error) } }
