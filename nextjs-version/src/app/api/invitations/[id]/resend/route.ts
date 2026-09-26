import { NextResponse } from "next/server";
import { assertTrustedMutation, consumeRequestRateLimit, requireMembershipAccess } from "@/lib/mca/auth";
import { billingSeatSyncEnabled } from "@/lib/mca/billing";
import { apiError } from "@/lib/mca/errors";
import { appOrigin, requestCorrelationId } from "@/lib/mca/http";
import { resendInvitation } from "@/lib/mca/memberships";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const correlationId = requestCorrelationId(request);
  try {
    assertTrustedMutation(request);
    const context = await requireMembershipAccess(request, ["admin", "super_admin"]);
    if (billingSeatSyncEnabled()) await consumeRequestRateLimit(`team-invitation:${context.workspaceId}:${context.userId}`, 30);
    const { id } = await params;
    return NextResponse.json(await resendInvitation(context, id, appOrigin(request)), { status: 201 });
  } catch (error) { return apiError(error, correlationId); }
}
