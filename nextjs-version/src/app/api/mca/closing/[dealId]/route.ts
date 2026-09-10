import { NextResponse } from "next/server"
import { apiError } from "@/lib/mca/errors"
import { requireClosingActor } from "@/lib/mca/closing/http"
import { getClosingSnapshot } from "@/lib/mca/closing/service"

export async function GET(request: Request, { params }: { params: Promise<{ dealId: string }> }) {
  try { const actor = await requireClosingActor(request, "read"); return NextResponse.json(await getClosingSnapshot(actor, (await params).dealId)) }
  catch (error) { return apiError(error) }
}
