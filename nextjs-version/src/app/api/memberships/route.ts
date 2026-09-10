import { NextResponse } from "next/server";
import { requireMembershipAccess } from "@/lib/mca/auth";
import { apiError } from "@/lib/mca/errors";
import { requestCorrelationId } from "@/lib/mca/http";
import { listMemberships } from "@/lib/mca/memberships";

export async function GET(request: Request) {
  const correlationId = requestCorrelationId(request);
  try {
    const context = await requireMembershipAccess(request, ["admin", "super_admin"]);
    return NextResponse.json({ memberships: await listMemberships(context.workspaceId) });
  } catch (error) { return apiError(error, correlationId); }
}
