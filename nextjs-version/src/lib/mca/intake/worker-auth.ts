import "server-only"

import { timingSafeEqual } from "node:crypto"
import { requireMembershipAccess } from "../auth"
import { AppError } from "../errors"

function equal(left: string, right: string): boolean {
  const a = Buffer.from(left); const b = Buffer.from(right)
  return a.length === b.length && timingSafeEqual(a, b)
}

export async function intakeWorkerScope(request: Request): Promise<{ workspaceId?: string; source: "worker" | "admin" }> {
  const authorization = request.headers.get("authorization")
  const supplied = authorization?.toLowerCase().startsWith("bearer ") ? authorization.slice(7).trim() : undefined
  const configured = process.env.MCA_INTAKE_WORKER_TOKEN
  if (supplied && configured && equal(supplied, configured)) return { source: "worker" }
  try {
    const actor = await requireMembershipAccess(request, ["admin", "super_admin"])
    return { source: "admin", workspaceId: actor.workspaceId }
  } catch {
    if (!configured) throw new AppError(503, "intake_worker_unconfigured", "Configure MCA_INTAKE_WORKER_TOKEN for scheduled intake processing, or sign in as an administrator.")
    throw new AppError(401, "intake_worker_credential_invalid", "A valid intake worker credential or administrator session is required.")
  }
}
