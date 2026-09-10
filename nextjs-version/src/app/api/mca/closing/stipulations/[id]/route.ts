import { NextResponse } from "next/server"
import { z } from "zod"
import { apiError } from "@/lib/mca/errors"
import { readJson } from "@/lib/mca/http"
import { requireClosingActor } from "@/lib/mca/closing/http"
import { updateStipulation } from "@/lib/mca/closing/service"

const schema = z.object({ status: z.enum(["verified", "waived"]), exceptionReason: z.string().max(500).optional() }).strict()
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) { try { return NextResponse.json(await updateStipulation(await requireClosingActor(request, "write"), (await params).id, await readJson(request, schema))) } catch (error) { return apiError(error) } }
