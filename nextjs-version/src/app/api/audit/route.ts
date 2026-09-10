import { NextResponse } from "next/server";
import { requireMembershipAccess } from "@/lib/mca/auth";
import { getDatabase, parseJson } from "@/lib/mca/db";
import { apiError } from "@/lib/mca/errors";
import { requestCorrelationId } from "@/lib/mca/http";
import type { AuditEvent } from "@/lib/mca/types";

export async function GET(request: Request) {
  const correlationId = requestCorrelationId(request);
  try {
    const context = await requireMembershipAccess(request, ["admin", "super_admin"]);
    const rows = await getDatabase().prepare<Record<string, string | null>>(`SELECT * FROM audit_events
      WHERE workspace_id = ? ORDER BY created_at DESC LIMIT 200`).all(context.workspaceId);
    const events: AuditEvent[] = rows.map((row) => ({
      id: String(row.id), workspaceId: String(row.workspace_id), actorUserId: row.actor_user_id,
      source: row.source as AuditEvent["source"], action: String(row.action), resourceType: String(row.resource_type),
      resourceId: String(row.resource_id), metadata: parseJson(row.metadata, {}), correlationId: String(row.correlation_id),
      createdAt: String(row.created_at),
    }));
    return NextResponse.json({ events });
  } catch (error) { return apiError(error, correlationId); }
}
