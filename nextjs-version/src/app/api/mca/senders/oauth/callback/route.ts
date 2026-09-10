import { NextResponse } from "next/server"
import { requireWorkspaceAccess } from "@/lib/mca/auth"
import { actorForDeals } from "@/lib/mca/deals/service"
import { apiError, AppError } from "@/lib/mca/errors"
import { requestCorrelationId } from "@/lib/mca/http"
import { completeSenderOAuth } from "@/lib/mca/senders/service"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

function redirectToConnections(request: Request, query: string) {
  return NextResponse.redirect(new URL(`/settings/connections?${query}`, request.url))
}

export async function GET(request: Request) {
  try {
    const url = new URL(request.url)
    const oauthError = url.searchParams.get("error")
    if (oauthError) throw new AppError(403, "sender_oauth_denied", "Email sender authorization was cancelled or denied.")
    const auth = await requireWorkspaceAccess(request, { roles: ["admin", "super_admin"], sessionOnly: true })
    const actor = { ...await actorForDeals(auth), correlationId: requestCorrelationId(request) }
    await completeSenderOAuth(actor, {
      state: url.searchParams.get("state") ?? "",
      code: url.searchParams.get("code") ?? "",
    })
    return redirectToConnections(request, "sender=connected")
  } catch (error) {
    const code = error instanceof AppError ? error.code : "sender_oauth_failed"
    const accept = request.headers.get("accept") ?? ""
    if (accept.includes("text/html")) return redirectToConnections(request, `sender=error&code=${encodeURIComponent(code)}`)
    return apiError(error)
  }
}
