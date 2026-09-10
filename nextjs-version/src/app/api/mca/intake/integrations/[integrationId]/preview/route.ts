import { NextResponse } from "next/server"
import { assertTrustedMutation, requireMembershipAccess } from "@/lib/mca/auth"
import { apiError, AppError } from "@/lib/mca/errors"
import { getIntegration } from "@/lib/mca/intake/repository"
import { normalizeProviderPayload } from "@/lib/mca/intake/providers"

export const runtime = "nodejs"
interface Context { params: Promise<{ integrationId: string }> }

export async function POST(request: Request, context: Context) {
  try {
    assertTrustedMutation(request)
    const actor = await requireMembershipAccess(request, ["admin", "super_admin"])
    const integration = await getIntegration(actor.workspaceId, (await context.params).integrationId)
    if (!integration) throw new AppError(404, "integration_not_found", "The intake integration was not found.")
    const normalized = normalizeProviderPayload(integration.provider, await request.json(), integration)
    return NextResponse.json({
      eventId: normalized.eventId,
      sourceReference: normalized.sourceReference,
      application: normalized.application,
      attributionPresent: Boolean(normalized.attributionToken),
      attachments: normalized.attachments.map(({ id, filename, mimeType, category }) => ({ id, filename, mimeType, category })),
    }, { headers: { "cache-control": "no-store" } })
  } catch (error) { return apiError(error) }
}
