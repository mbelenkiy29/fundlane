import { NextResponse } from "next/server"
import { apiError } from "@/lib/mca/errors"
import { getHistoricalImport } from "@/lib/mca/historical/service"
import { requireOfferActor } from "@/lib/mca/offers/http"
export const runtime = "nodejs"
type Context = { params: Promise<{ runId: string }> }
export async function GET(request: Request, context: Context) { try { return NextResponse.json(await getHistoricalImport(await requireOfferActor(request, "read", { administratorSession: true }), (await context.params).runId), { headers: { "cache-control": "no-store" } }) } catch (error) { return apiError(error) } }

