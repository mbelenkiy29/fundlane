import { NextResponse } from "next/server"
import {
  createWorkflowWebhookEndpoint,
  listWorkflowWebhookConsole,
  requireWebhookAdmin,
  requireWebhookAdminRead,
  webhookEndpointCreateSchema,
} from "@/lib/mca/comms/webhooks"
import { apiError } from "@/lib/mca/errors"
import { readJson } from "@/lib/mca/http"

export const runtime = "nodejs"
const noStore = { "cache-control": "no-store" }

export async function GET(request: Request) {
  try {
    const actor = await requireWebhookAdminRead(request)
    return NextResponse.json(await listWorkflowWebhookConsole(actor), { headers: noStore })
  } catch (error) {
    return apiError(error)
  }
}

export async function POST(request: Request) {
  try {
    const actor = await requireWebhookAdmin(request)
    const input = await readJson(request, webhookEndpointCreateSchema)
    return NextResponse.json(await createWorkflowWebhookEndpoint(actor, input), { status: 201, headers: noStore })
  } catch (error) {
    return apiError(error)
  }
}
