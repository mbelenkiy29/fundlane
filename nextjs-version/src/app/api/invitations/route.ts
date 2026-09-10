import { NextResponse } from "next/server";
import { assertTrustedMutation, requireMembershipAccess } from "@/lib/mca/auth";
import { apiError } from "@/lib/mca/errors";
import { appOrigin, readJson, requestCorrelationId } from "@/lib/mca/http";
import { inviteMember } from "@/lib/mca/memberships";
import { invitationSchema } from "@/lib/mca/schemas";

export async function POST(request: Request) {
  const correlationId = requestCorrelationId(request);
  try {
    assertTrustedMutation(request);
    const context = await requireMembershipAccess(request, ["admin", "super_admin"]);
    const result = await inviteMember(context, await readJson(request, invitationSchema), appOrigin(request));
    return NextResponse.json(result, { status: 201 });
  } catch (error) { return apiError(error, correlationId); }
}
