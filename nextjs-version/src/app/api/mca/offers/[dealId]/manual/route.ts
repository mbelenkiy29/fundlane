import { NextResponse } from "next/server"
import { z } from "zod"
import { apiError } from "@/lib/mca/errors"
import { readJson } from "@/lib/mca/http"
import { requireOfferActor } from "@/lib/mca/offers/http"
import { createManualSubmission, listManualSubmissions } from "@/lib/mca/offers/manual-submissions"

export const runtime = "nodejs"
type Context = { params: Promise<{ dealId: string }> }
const input = z.object({ funderId: z.string().optional(), funderName: z.string().min(1).max(200), historicalAt: z.string().min(1), reason: z.string().min(1).max(500), idempotencyKey: z.string().min(1).max(160), source: z.enum(["manual", "historical"]).optional() })
export async function GET(request: Request, context: Context) { try { const dealId = (await context.params).dealId; return NextResponse.json({ submissions: await listManualSubmissions(await requireOfferActor(request, "read", { administratorSession: true }), dealId), permission: "administrator_session" }, { headers: { "cache-control": "no-store" } }) } catch (error) { return apiError(error) } }
export async function POST(request: Request, context: Context) { try { const dealId = (await context.params).dealId; return NextResponse.json(await createManualSubmission(await requireOfferActor(request, "write", { administratorSession: true }), { dealId, ...await readJson(request, input) }), { status: 201 }) } catch (error) { return apiError(error) } }

