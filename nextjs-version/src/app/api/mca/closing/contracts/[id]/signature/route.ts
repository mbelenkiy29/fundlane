import { NextResponse } from "next/server"
import { z } from "zod"
import { apiError } from "@/lib/mca/errors"
import { readJson } from "@/lib/mca/http"
import { requireClosingActor } from "@/lib/mca/closing/http"
import { recordContractSignature } from "@/lib/mca/closing/service"

const schema = z.object({ source: z.enum(["external", "manual"]), externalId: z.string().optional(), evidenceDocumentId: z.string().optional(), manualReason: z.string().optional() }).strict()
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) { try { return NextResponse.json(await recordContractSignature(await requireClosingActor(request, "write", true), { workflowId: (await params).id, ...(await readJson(request, schema)) })) } catch (error) { return apiError(error) } }
