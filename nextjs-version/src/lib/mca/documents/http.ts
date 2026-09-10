import "server-only"

import { assertTrustedMutation, requireWorkspaceAccess } from "../auth"
import { actorForDeals } from "../deals/service"
import type { DealActor } from "../deals/schema"
import { requestCorrelationId } from "../http"

export async function requireDocumentActor(request: Request, mode: "read" | "write", options: { sessionOnly?: boolean } = {}): Promise<DealActor> {
  if (mode === "write") assertTrustedMutation(request)
  const auth = await requireWorkspaceAccess(request, { scopes: [mode === "read" ? "deals:read" : "deals:write"], sessionOnly: options.sessionOnly })
  return { ...await actorForDeals(auth), correlationId: requestCorrelationId(request) }
}
