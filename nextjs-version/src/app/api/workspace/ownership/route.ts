import { NextResponse } from "next/server"
import { z } from "zod"
import { assertTrustedMutation, requireMembershipAccess } from "@/lib/mca/auth"
import { transferCompanyOwnership } from "@/lib/mca/company-ownership"
import { apiError } from "@/lib/mca/errors"
import { readJson, requestCorrelationId } from "@/lib/mca/http"
import { getDatabase } from "@/lib/mca/db"

const transferSchema = z.object({ membershipId: z.string().min(1).max(200) }).strict()

export async function GET(request:Request) {
  try {const context=await requireMembershipAccess(request,["admin","super_admin"]);const owner=await getDatabase().prepare<{membership_id:string}>("SELECT membership_id FROM workspace_owners WHERE workspace_id=?").get(context.workspaceId);return NextResponse.json({ownerMembershipId:owner?.membership_id??null,canTransfer:owner?.membership_id===context.membershipId},{headers:{"Cache-Control":"no-store"}})}catch(error){return apiError(error)}
}

export async function POST(request: Request) {
  const correlationId = requestCorrelationId(request)
  try {
    assertTrustedMutation(request)
    const context = await requireMembershipAccess(request, ["admin", "super_admin"])
    const input = await readJson(request, transferSchema)
    return NextResponse.json(await transferCompanyOwnership(context, input.membershipId))
  } catch (error) { return apiError(error, correlationId) }
}
