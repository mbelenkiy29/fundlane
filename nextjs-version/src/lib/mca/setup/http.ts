import "server-only"

import { requireMembershipAccess, requireWorkspaceAccess } from "../auth"
import type { AuthContext, MembershipContext } from "../types"

export async function requireSetupReader(request: Request): Promise<AuthContext> {
  return requireWorkspaceAccess(request, { scopes: ["workspace:read"] })
}

export async function requireSetupEditor(request: Request): Promise<MembershipContext> {
  return requireMembershipAccess(request)
}
