import { NextResponse } from "next/server";
import { assertTrustedMutation, requireMembershipAccess } from "@/lib/mca/auth";
import { rotateApiKey } from "@/lib/mca/api-keys";
import { apiError } from "@/lib/mca/errors";
import { requestCorrelationId } from "@/lib/mca/http";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const correlationId = requestCorrelationId(request);
  try {
    assertTrustedMutation(request);
    const context = await requireMembershipAccess(request, ["admin", "super_admin"]);
    const { id } = await params;
    return NextResponse.json(await rotateApiKey(context, id));
  } catch (error) { return apiError(error, correlationId); }
}
