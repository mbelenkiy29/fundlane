import { NextResponse } from "next/server"
import { apiError } from "@/lib/mca/errors"
import { requireApplicationActor } from "@/lib/mca/intake/review"
import { getApplicationReview } from "@/lib/mca/intake/review"
export const runtime = "nodejs"
export async function GET(request:Request,context:{params:Promise<{intakeId:string}>}) {
  try {
    const actor=await requireApplicationActor(request,"read")
    const {intakeId}=await context.params
    return NextResponse.json(await getApplicationReview(actor,intakeId),{headers:{"cache-control":"no-store"}})
  } catch(error) { return apiError(error) }
}
