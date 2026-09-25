import { NextResponse } from "next/server"
import { assertTrustedMutation, requireWorkspaceAccess } from "@/lib/mca/auth"
import { actorForDeals } from "@/lib/mca/deals/service"
import { apiError, AppError } from "@/lib/mca/errors"
import { requestCorrelationId } from "@/lib/mca/http"
import { getSandboxFunderStatus, setSandboxFunderEnabled } from "@/lib/mca/sandbox/service"

export const runtime = "nodejs"
const noStore = { "cache-control": "no-store" }

export async function GET(request: Request) {
  try {
    const actor = {
      ...await actorForDeals(await requireWorkspaceAccess(request, { scopes: ["deals:read"] })),
      correlationId: requestCorrelationId(request),
    }
    return NextResponse.json(await getSandboxFunderStatus(actor), { headers: noStore })
  } catch (error) {
    return apiError(error)
  }
}

export async function POST(request: Request) {
  try {
    assertTrustedMutation(request)
    const actor = {
      ...await actorForDeals(await requireWorkspaceAccess(request, { sessionOnly: true, roles: ["admin", "super_admin"] })),
      correlationId: requestCorrelationId(request),
    }
    let body: { enabled?: unknown }
    try {
      body = await request.json() as { enabled?: unknown }
    } catch {
      throw new AppError(400, "invalid_json", "Request body must be valid JSON.")
    }
    if (typeof body.enabled !== "boolean") {
      throw new AppError(422, "validation_failed", "Review the highlighted fields.", { enabled: ["Choose whether the sandbox funder is enabled."] })
    }
    return NextResponse.json(await setSandboxFunderEnabled(actor, body.enabled), { headers: noStore })
  } catch (error) {
    return apiError(error)
  }
}
