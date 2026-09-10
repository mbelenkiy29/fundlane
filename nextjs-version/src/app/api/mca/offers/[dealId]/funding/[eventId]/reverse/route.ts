import { NextResponse } from "next/server"
import { z } from "zod"
import { apiError } from "@/lib/mca/errors"
import { reverseFundingEvent } from "@/lib/mca/funding/service"
import { readJson } from "@/lib/mca/http"
import { requireOfferActor } from "@/lib/mca/offers/http"
export const runtime = "nodejs"
type Context = { params: Promise<{ dealId: string; eventId: string }> }
const input = z.object({ reason: z.string().min(1).max(500), reversedAt: z.string().min(1) })
export async function POST(request: Request, context: Context) { try { const params = await context.params; const result = await reverseFundingEvent(await requireOfferActor(request, "write", { administratorSession: true }), { fundingEventId: params.eventId, ...await readJson(request, input) }); if (result.dealId !== params.dealId) return NextResponse.json({ error: { code: "funding_event_not_found", message: "The funding event was not found." } }, { status: 404 }); return NextResponse.json(result) } catch (error) { return apiError(error) } }
