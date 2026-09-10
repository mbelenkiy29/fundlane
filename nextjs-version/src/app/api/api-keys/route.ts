import { NextResponse } from "next/server";
import { assertTrustedMutation, requireMembershipAccess } from "@/lib/mca/auth";
import { createApiKey, listApiKeys } from "@/lib/mca/api-keys";
import { apiError } from "@/lib/mca/errors";
import { readJson, requestCorrelationId } from "@/lib/mca/http";
import { apiKeyCreateSchema } from "@/lib/mca/schemas";

export async function GET(request: Request) {
  const correlationId = requestCorrelationId(request);
  try {
    const context = await requireMembershipAccess(request, ["admin", "super_admin"]);
    return NextResponse.json({ apiKeys: await listApiKeys(context.workspaceId) });
  } catch (error) { return apiError(error, correlationId); }
}

export async function POST(request: Request) {
  const correlationId = requestCorrelationId(request);
  try {
    assertTrustedMutation(request);
    const context = await requireMembershipAccess(request, ["admin", "super_admin"]);
    return NextResponse.json(await createApiKey(context, await readJson(request, apiKeyCreateSchema)), { status: 201 });
  } catch (error) { return apiError(error, correlationId); }
}
