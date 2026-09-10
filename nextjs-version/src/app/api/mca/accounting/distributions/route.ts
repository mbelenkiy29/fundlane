import { NextResponse } from "next/server"
import { apiError } from "@/lib/mca/errors"
import { requirePaymentActor } from "@/lib/mca/accounting/access"
import { listDistributions } from "@/lib/mca/accounting/service"
export async function GET(request: Request) {
  try { const actor = await requirePaymentActor(request, "read"); return NextResponse.json({ distributions: await listDistributions(actor, new URL(request.url).searchParams.get("paymentId") ?? undefined) }) }
  catch (error) { return apiError(error) }
}
