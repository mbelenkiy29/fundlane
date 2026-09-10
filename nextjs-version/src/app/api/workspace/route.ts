import { NextResponse } from "next/server";
import { assertTrustedMutation, requireMembershipAccess, requireWorkspaceAccess } from "@/lib/mca/auth";
import { apiError } from "@/lib/mca/errors";
import { readJson, requestCorrelationId } from "@/lib/mca/http";
import { workspacePatchSchema } from "@/lib/mca/schemas";
import { getWorkspaceSettings, updateWorkspaceSettings } from "@/lib/mca/workspaces";

export async function GET(request: Request) {
  const correlationId = requestCorrelationId(request);
  try {
    const context = await requireWorkspaceAccess(request, { scopes: ["workspace:read"] });
    return NextResponse.json(await getWorkspaceSettings(context.workspaceId));
  } catch (error) { return apiError(error, correlationId); }
}

export async function PATCH(request: Request) {
  const correlationId = requestCorrelationId(request);
  try {
    assertTrustedMutation(request);
    const context = await requireMembershipAccess(request, ["admin", "super_admin"]);
    const patch = await readJson(request, workspacePatchSchema);
    return NextResponse.json(await updateWorkspaceSettings(context, patch));
  } catch (error) { return apiError(error, correlationId); }
}
