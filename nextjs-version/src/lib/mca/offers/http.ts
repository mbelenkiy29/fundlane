import "server-only"

import { assertTrustedMutation, requireWorkspaceAccess } from "../auth"
import { actorForDeals } from "../deals/service"
import type { DealActor } from "../deals/schema"
import { AppError } from "../errors"
import { requestCorrelationId } from "../http"
import { getWorkspaceSettings } from "../workspaces"

export async function requireOfferActor(request: Request, mode: "read" | "write", options: { administratorSession?: boolean } = {}): Promise<DealActor> {
  if (mode === "write") assertTrustedMutation(request)
  const context = await requireWorkspaceAccess(request, {
    scopes: [mode === "read" ? "deals:read" : "deals:write"],
    ...(options.administratorSession ? { sessionOnly: true, roles: ["admin", "super_admin"] as const } : {}),
  })
  if (context.authType === "session" && !(await getWorkspaceSettings(context.workspaceId)).pageVisibility.deals) throw new AppError(403, "page_disabled", "Deals and offer workflows are disabled for this workspace.")
  return { ...await actorForDeals(context), correlationId: requestCorrelationId(request) }
}
