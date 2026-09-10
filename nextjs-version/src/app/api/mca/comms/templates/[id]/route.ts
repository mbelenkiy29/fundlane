import { NextResponse } from "next/server"
import { z } from "zod"
import { consumeRequestRateLimit, clientRateKey } from "@/lib/mca/auth"
import {
  getMessageTemplate,
  requireTemplateAdmin,
  requireTemplateAdminRead,
  saveMessageTemplateDraft,
} from "@/lib/mca/comms/templates"
import { apiError } from "@/lib/mca/errors"
import { readJson } from "@/lib/mca/http"

export const runtime = "nodejs"
const noStore = { "cache-control": "no-store" }

const patchSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  subject: z.string().max(500).nullable().optional(),
  body: z.string().max(20_000).optional(),
}).strict()

interface RouteContext { params: Promise<{ id: string }> }

export async function GET(request: Request, context: RouteContext) {
  try {
    const actor = await requireTemplateAdminRead(request)
    return NextResponse.json(await getMessageTemplate(actor, (await context.params).id), { headers: noStore })
  } catch (error) {
    return apiError(error)
  }
}

export async function PATCH(request: Request, context: RouteContext) {
  try {
    const actor = await requireTemplateAdmin(request)
    const input = await readJson(request, patchSchema)
    await consumeRequestRateLimit(clientRateKey(request, `message-template-save:${actor.workspaceId}`), 60)
    return NextResponse.json(await saveMessageTemplateDraft(actor, (await context.params).id, input), { headers: noStore })
  } catch (error) {
    return apiError(error)
  }
}
