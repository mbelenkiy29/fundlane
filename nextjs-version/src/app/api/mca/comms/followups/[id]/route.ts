import { NextResponse } from "next/server"
import {
  followupPolicyPatchSchema,
  getFollowupPolicy,
  requireFollowupAdmin,
  requireFollowupAdminRead,
  updateFollowupPolicy,
} from "@/lib/mca/comms/followups"
import { apiError } from "@/lib/mca/errors"
import { readJson } from "@/lib/mca/http"

export const runtime = "nodejs"
const noStore = { "cache-control": "no-store" }

interface RouteContext { params: Promise<{ id: string }> }

export async function GET(request: Request, context: RouteContext) {
  try {
    const actor = await requireFollowupAdminRead(request)
    return NextResponse.json(await getFollowupPolicy(actor, (await context.params).id), { headers: noStore })
  } catch (error) {
    return apiError(error)
  }
}

export async function PATCH(request: Request, context: RouteContext) {
  try {
    const actor = await requireFollowupAdmin(request)
    const input = await readJson(request, followupPolicyPatchSchema)
    return NextResponse.json(await updateFollowupPolicy(actor, (await context.params).id, input), { headers: noStore })
  } catch (error) {
    return apiError(error)
  }
}
