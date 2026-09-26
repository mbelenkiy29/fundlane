import { NextResponse } from "next/server"
import { requireMembershipAccess } from "@/lib/mca/auth"
import { getDatabase, nowIso } from "@/lib/mca/db"
import { apiError } from "@/lib/mca/errors"
import { requestCorrelationId } from "@/lib/mca/http"
import { deriveReadiness, makeDiagnosticBundle } from "@/lib/mca/setup/readiness"
import { getReadinessFacts, setupReadinessEnabled } from "@/lib/mca/setup/service"

export const runtime = "nodejs"

export async function GET(request: Request) {
  const correlationId = requestCorrelationId(request)
  try {
    const actor = await requireMembershipAccess(request, ["admin", "super_admin"], { allowPaused: true })
    if (!setupReadinessEnabled()) return NextResponse.json({ error: "setup_readiness_disabled" }, { status: 404 })
    const rows = await getDatabase().prepare<{ kind: "intake" | "submission"; id: string; state: string }>(`
      SELECT kind, id, state FROM (
        SELECT 'intake'::text kind, id, state, created_at FROM intake_events WHERE workspace_id=?
        UNION ALL
        SELECT 'submission'::text kind, id, state, created_at FROM mca_submission_jobs WHERE workspace_id=?
      ) recent ORDER BY created_at DESC LIMIT 20
    `).all(actor.workspaceId, actor.workspaceId)
    const bundle = makeDiagnosticBundle({
      workspaceId: actor.workspaceId, generatedAt: nowIso(),
      items: deriveReadiness(await getReadinessFacts(actor.workspaceId), actor.role), requests: rows,
    })
    return NextResponse.json(bundle, { headers: { "cache-control": "no-store", "content-disposition": "attachment; filename=workspace-setup-diagnostics.json" } })
  } catch (error) {
    return apiError(error, correlationId)
  }
}
