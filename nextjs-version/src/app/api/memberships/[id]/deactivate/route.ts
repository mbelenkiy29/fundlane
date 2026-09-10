import { NextResponse } from "next/server";
import { assertTrustedMutation, requireMembershipAccess } from "@/lib/mca/auth";
import { apiError } from "@/lib/mca/errors";
import { requestCorrelationId } from "@/lib/mca/http";
import { deactivateMembership } from "@/lib/mca/memberships";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const correlationId = requestCorrelationId(request);
  try {
    assertTrustedMutation(request);
    const context = await requireMembershipAccess(request, ["admin", "super_admin"]);
    const { id } = await params;
    await deactivateMembership(context, id);
    return NextResponse.json({ success: true });
  } catch (error) { return apiError(error, correlationId); }
}
