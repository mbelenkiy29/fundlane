import { NextResponse } from "next/server";
import { assertTrustedMutation, requireMembershipAccess } from "@/lib/mca/auth";
import { apiError } from "@/lib/mca/errors";
import { readJson, requestCorrelationId } from "@/lib/mca/http";
import { updateMembership } from "@/lib/mca/memberships";
import { membershipPatchSchema } from "@/lib/mca/schemas";

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const correlationId = requestCorrelationId(request);
  try {
    assertTrustedMutation(request);
    const context = await requireMembershipAccess(request, ["admin", "super_admin"]);
    const { id } = await params;
    return NextResponse.json(await updateMembership(context, id, await readJson(request, membershipPatchSchema)));
  } catch (error) { return apiError(error, correlationId); }
}
