import { NextResponse } from "next/server"
import { apiError } from "@/lib/mca/errors"
import { getDealDataMerch, requireDataMerchActor, runDataMerchCheck } from "@/lib/mca/datamerch/service"

export const runtime = "nodejs"
const noStore = { "cache-control": "no-store" }

interface RouteContext { params: Promise<{ dealId: string }> }

export async function GET(request: Request, context: RouteContext) {
  try {
    const actor = await requireDataMerchActor(request, "read")
    return NextResponse.json(await getDealDataMerch(actor, (await context.params).dealId), { headers: noStore })
  } catch (error) {
    return apiError(error)
  }
}

export async function POST(request: Request, context: RouteContext) {
  try {
    const actor = await requireDataMerchActor(request, "write")
    return NextResponse.json(await runDataMerchCheck(actor, (await context.params).dealId), { headers: noStore })
  } catch (error) {
    return apiError(error)
  }
}
