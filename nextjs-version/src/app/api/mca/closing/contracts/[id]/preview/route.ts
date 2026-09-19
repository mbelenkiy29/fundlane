import { NextResponse } from "next/server"
import { z } from "zod"
import { apiError } from "@/lib/mca/errors"
import { readJson } from "@/lib/mca/http"
import { requireClosingActor } from "@/lib/mca/closing/http"
import { previewContractAction } from "@/lib/mca/closing/service"

const schema = z.object({ action: z.enum(["request_contract", "request_repricing"]), recipient: z.email().optional(), overrideReason: z.string().trim().min(8).max(500).optional(), senderId: z.string().min(1), attachedDocumentIds: z.array(z.string()).optional(), exceptions: z.record(z.string(), z.string()).optional(), reason: z.string().trim().min(1).max(1_000).optional(), idempotencyKey: z.string().min(1) }).strict().superRefine((value, context) => { if (value.action === "request_repricing" && !value.reason) context.addIssue({ code: "custom", path: ["reason"], message: "A repricing reason is required." }) })
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) { try { return NextResponse.json(await previewContractAction(await requireClosingActor(request, "write"), { workflowId: (await params).id, ...(await readJson(request, schema)) }), { status: 201 }) } catch (error) { return apiError(error) } }
