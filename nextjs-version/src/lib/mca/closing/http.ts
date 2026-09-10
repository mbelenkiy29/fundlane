import "server-only"

import { assertTrustedMutation, requireWorkspaceAccess } from "../auth"
import { actorForDeals } from "../deals/service"
import type { DealActor } from "../deals/schema"
import { requestCorrelationId } from "../http"
import { AppError } from "../errors"
import { getWorkspaceSettings } from "../workspaces"

export async function requireClosingActor(request: Request, mode: "read" | "write", sessionOnly = false): Promise<DealActor> {
  if (mode === "write") assertTrustedMutation(request)
  const context = await requireWorkspaceAccess(request, { scopes: [mode === "read" ? "deals:read" : "deals:write"], sessionOnly })
  if (context.authType === "session" && !(await getWorkspaceSettings(context.workspaceId)).pageVisibility.deals) {
    throw new AppError(403, "page_disabled", "Deals and closing workflows are disabled for this workspace.")
  }
  return { ...await actorForDeals(context), correlationId: requestCorrelationId(request) }
}
