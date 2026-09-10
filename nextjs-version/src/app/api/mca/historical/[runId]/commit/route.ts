import { NextResponse } from "next/server"
import { z } from "zod"
import { apiError } from "@/lib/mca/errors"
import { commitHistoricalImport } from "@/lib/mca/historical/service"
import { readJson } from "@/lib/mca/http"
import { requireOfferActor } from "@/lib/mca/offers/http"
export const runtime = "nodejs"
type Context = { params: Promise<{ runId: string }> }
const input = z.object({ expectedPreviewRevision: z.number().int().positive() })
export async function POST(request: Request, context: Context) { try { const runId = (await context.params).runId; return NextResponse.json(await commitHistoricalImport(await requireOfferActor(request, "write", { administratorSession: true }), { runId, ...await readJson(request, input) })) } catch (error) { return apiError(error) } }

