import { NextResponse } from "next/server"
import { z } from "zod"
import { consumeRequestRateLimit, clientRateKey } from "@/lib/mca/auth"
import {
  MESSAGE_TEMPLATE_CHANNELS,
  MESSAGE_TEMPLATE_SCOPES,
  assertTemplatePreviewSafe,
  previewMessageTemplate,
  requireTemplatePreview,
} from "@/lib/mca/comms/templates"
import { apiError } from "@/lib/mca/errors"
import { appOrigin, readJson } from "@/lib/mca/http"

export const runtime = "nodejs"
const noStore = { "cache-control": "no-store" }

const schema = z.object({
  templateId: z.string().min(1).max(80).optional(),
  subject: z.string().max(500).nullable().optional(),
  body: z.string().max(20_000).optional(),
  channel: z.enum(MESSAGE_TEMPLATE_CHANNELS).optional(),
  scope: z.enum(MESSAGE_TEMPLATE_SCOPES).optional(),
  dealId: z.string().min(1).max(80).optional(),
}).strict()

export async function POST(request: Request) {
  try {
    const actor = await requireTemplatePreview(request)
    const input = await readJson(request, schema)
    await consumeRequestRateLimit(clientRateKey(request, `message-template-preview:${actor.workspaceId}`), 60)
    const rendered = await previewMessageTemplate(actor, { ...input, origin: appOrigin(request) })
    assertTemplatePreviewSafe(rendered)
    return NextResponse.json(rendered, { headers: noStore })
  } catch (error) {
    return apiError(error)
  }
}
