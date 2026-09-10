import { NextResponse } from "next/server"
import { publishWorkflowWebhook, requireWebhookAdmin, webhookPublishSchema } from "@/lib/mca/comms/webhooks"
import { apiError } from "@/lib/mca/errors"
import { readJson } from "@/lib/mca/http"

export const runtime = "nodejs"
const noStore = { "cache-control": "no-store" }

export async function POST(request: Request) {
  try {
    const actor = await requireWebhookAdmin(request)
    const input = await readJson(request, webhookPublishSchema)
    return NextResponse.json(await publishWorkflowWebhook(actor, input), { status: 201, headers: noStore })
  } catch (error) {
    return apiError(error)
  }
}
