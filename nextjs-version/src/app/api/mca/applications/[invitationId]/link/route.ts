import { NextResponse } from "next/server"
import { assertTrustedMutation } from "@/lib/mca/auth"
import { apiError } from "@/lib/mca/errors"
import { appOrigin } from "@/lib/mca/http"
import { copyApplicationLink, requireApplicationActor } from "@/lib/mca/applications/service"

export const runtime = "nodejs"
export async function POST(request: Request, context: { params: Promise<{ invitationId: string }> }) {
  try {
    assertTrustedMutation(request)
    return NextResponse.json(await copyApplicationLink(await requireApplicationActor(request, true), (await context.params).invitationId, appOrigin(request)), { headers: { "Cache-Control": "private, no-store" } })
  } catch (error) { return apiError(error) }
}
