import { NextResponse } from "next/server"
import {
  disableWorkflowWebhookEndpoint,
  getWorkflowWebhookEndpoint,
  requireWebhookAdmin,
  requireWebhookAdminRead,
  updateWorkflowWebhookEndpoint,
  webhookEndpointPatchSchema,
} from "@/lib/mca/comms/webhooks"
import { apiError } from "@/lib/mca/errors"
import { readJson } from "@/lib/mca/http"

export const runtime = "nodejs"
const noStore = { "cache-control": "no-store" }

interface RouteContext { params: Promise<{ id: string }> }

export async function GET(request: Request, context: RouteContext) {
  try {
    const actor = await requireWebhookAdminRead(request)
    return NextResponse.json(await getWorkflowWebhookEndpoint(actor, (await context.params).id), { headers: noStore })
  } catch (error) {
    return apiError(error)
  }
}

export async function PATCH(request: Request, context: RouteContext) {
  try {
    const actor = await requireWebhookAdmin(request)
    const input = await readJson(request, webhookEndpointPatchSchema)
    return NextResponse.json(await updateWorkflowWebhookEndpoint(actor, (await context.params).id, input), { headers: noStore })
  } catch (error) {
    return apiError(error)
  }
}

export async function DELETE(request: Request, context: RouteContext) {
  try {
    const actor = await requireWebhookAdmin(request)
    return NextResponse.json(await disableWorkflowWebhookEndpoint(actor, (await context.params).id), { headers: noStore })
  } catch (error) {
    return apiError(error)
  }
}
