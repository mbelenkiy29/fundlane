import { NextResponse } from "next/server"
import { z } from "zod"
import { consumeRequestRateLimit, clientRateKey } from "@/lib/mca/auth"
import {
  MESSAGE_TEMPLATE_CHANNELS,
  MESSAGE_TEMPLATE_SCOPES,
  createMessageTemplate,
  listMessageTemplates,
  requireTemplateAdmin,
  requireTemplateAdminRead,
} from "@/lib/mca/comms/templates"
import { apiError } from "@/lib/mca/errors"
import { readJson } from "@/lib/mca/http"

export const runtime = "nodejs"
const noStore = { "cache-control": "no-store" }

const createSchema = z.object({
  name: z.string().min(1).max(120),
  channel: z.enum(MESSAGE_TEMPLATE_CHANNELS),
  scope: z.enum(MESSAGE_TEMPLATE_SCOPES),
  subject: z.string().max(500).nullable().optional(),
  body: z.string().max(20_000).optional(),
}).strict()

export async function GET(request: Request) {
  try {
    const actor = await requireTemplateAdminRead(request)
    return NextResponse.json(await listMessageTemplates(actor), { headers: noStore })
  } catch (error) {
    return apiError(error)
  }
}

export async function POST(request: Request) {
  try {
    const actor = await requireTemplateAdmin(request)
    const input = await readJson(request, createSchema)
    await consumeRequestRateLimit(clientRateKey(request, `message-template-create:${actor.workspaceId}`), 30)
    return NextResponse.json(await createMessageTemplate(actor, input), { status: 201, headers: noStore })
  } catch (error) {
    return apiError(error)
  }
}
