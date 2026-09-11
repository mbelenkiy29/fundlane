import "server-only"
import { requireWorkspaceAccess } from "../auth"
import { AppError } from "../errors"
export async function assistantCreditIdentity(request: Request, admin = false) {
  const c = await requireWorkspaceAccess(request, {
    sessionOnly: true,
    ...(admin
      ? { roles: ["admin", "super_admin"] as ("admin" | "super_admin")[] }
      : {})
  })
  if (!c.userId || !c.role)
    throw new AppError(401, "session_required", "Sign in to access AI credits.")
  return { ...c, userId: c.userId, role: c.role }
}
export const creditHeaders = { "cache-control": "no-store" }
