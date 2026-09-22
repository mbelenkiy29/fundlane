import { NextResponse } from "next/server"
import { apiError, AppError } from "@/lib/mca/errors"
import { requireApplicationActor } from "@/lib/mca/intake/review"
import { prepareApplicationSubmission } from "@/lib/mca/intake/submission-review"
export const runtime = "nodejs"
export async function POST(request:Request,context:{params:Promise<{intakeId:string}>}) {
  try {
    const actor=await requireApplicationActor(request,"write")
    const {intakeId}=await context.params
    let input: Record<string,unknown>
    try { input=await request.json(); if(!input || typeof input!=="object" || Array.isArray(input)) throw new Error() }
    catch { throw new AppError(400,"invalid_json","Request body must be a JSON object.") }
    return NextResponse.json(await prepareApplicationSubmission(actor,intakeId,input.funderIds),{headers:{"cache-control":"no-store"}})
  } catch(error) { return apiError(error) }
}
