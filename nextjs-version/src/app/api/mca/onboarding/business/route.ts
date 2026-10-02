import { NextResponse } from "next/server"
import { apiError } from "@/lib/mca/errors"
import { readJson } from "@/lib/mca/http"
import { z } from "zod"
import { getBusinessBasics, requireBusinessActor, saveBusinessBasics } from "@/lib/mca/onboarding/business-profile"
export const runtime = "nodejs"
const headers = { "cache-control": "no-store" }
export async function GET(request: Request) {
  try { return NextResponse.json(await getBusinessBasics(await requireBusinessActor(request)), { headers }) } catch (e) { return apiError(e) }
}
export async function POST(request: Request) {
  try { const actor = await requireBusinessActor(request, true); return NextResponse.json(await saveBusinessBasics(actor, await readJson(request, z.unknown()) as Parameters<typeof saveBusinessBasics>[1]), { headers }) } catch (e) { return apiError(e) }
}
