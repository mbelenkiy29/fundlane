import { NextResponse } from "next/server"
import { requireWorkspaceAccess } from "@/lib/mca/auth"
import { actorForDeals } from "@/lib/mca/deals/service"
import { apiError, AppError } from "@/lib/mca/errors"
import { completeDriveOAuth } from "@/lib/mca/imports/drive-service"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function GET(request: Request) {
  try {
    const url = new URL(request.url)
    const oauthError = url.searchParams.get("error")
    if (oauthError) throw new AppError(403, "drive_oauth_denied", "Google Drive authorization was cancelled or denied.")
    const actor = await actorForDeals(await requireWorkspaceAccess(request, { roles: ["admin", "super_admin"], sessionOnly: true }))
    await completeDriveOAuth(actor, { state: url.searchParams.get("state") ?? "", code: url.searchParams.get("code") ?? "" })
    return NextResponse.redirect(new URL("/settings/connections?drive=connected", request.url))
  } catch (error) { return apiError(error) }
}
