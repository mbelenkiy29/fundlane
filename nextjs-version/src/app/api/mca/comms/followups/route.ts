import { NextResponse } from "next/server"
import {
  createFollowupPolicy,
  followupPolicyCreateSchema,
  listFollowupPolicies,
  requireFollowupAdmin,
  requireFollowupAdminRead,
} from "@/lib/mca/comms/followups"
import { apiError } from "@/lib/mca/errors"
import { readJson } from "@/lib/mca/http"

export const runtime = "nodejs"
const noStore = { "cache-control": "no-store" }

export async function GET(request: Request) {
  try {
    const actor = await requireFollowupAdminRead(request)
    return NextResponse.json(await listFollowupPolicies(actor), { headers: noStore })
  } catch (error) {
    return apiError(error)
  }
}

export async function POST(request: Request) {
  try {
    const actor = await requireFollowupAdmin(request)
    const input = await readJson(request, followupPolicyCreateSchema)
    return NextResponse.json(await createFollowupPolicy(actor, input), { status: 201, headers: noStore })
  } catch (error) {
    return apiError(error)
  }
}
