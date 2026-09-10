import { NextResponse } from "next/server"
import { z } from "zod"
import { apiError } from "@/lib/mca/errors"
import { readJson } from "@/lib/mca/http"
import { requireClosingActor } from "@/lib/mca/closing/http"
import { createStipulation } from "@/lib/mca/closing/service"

const schema = z.object({ dealId: z.string().min(1), offerId: z.string().optional(), revisionId: z.string().optional(), funderId: z.string().optional(), documentCategory: z.string().min(1), label: z.string().min(1).max(180), ownerMembershipId: z.string().optional(), dueDate: z.string().optional(), idempotencyKey: z.string().min(1) }).strict()
export async function POST(request: Request) { try { return NextResponse.json(await createStipulation(await requireClosingActor(request, "write"), await readJson(request, schema)), { status: 201 }) } catch (error) { return apiError(error) } }
