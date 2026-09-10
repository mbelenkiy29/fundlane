import { NextResponse } from "next/server"
import { z } from "zod"
import { consumeRequestRateLimit, clientRateKey } from "@/lib/mca/auth"
import { publishMessageTemplate, requireTemplateAdmin } from "@/lib/mca/comms/templates"
import { apiError } from "@/lib/mca/errors"
import { readJson } from "@/lib/mca/http"

export const runtime = "nodejs"
const noStore = { "cache-control": "no-store" }

const schema = z.object({
  versionId: z.string().min(1).max(80).optional(),
}).strict()

interface RouteContext { params: Promise<{ id: string }> }

export async function POST(request: Request, context: RouteContext) {
  try {
    const actor = await requireTemplateAdmin(request)
    const input = await readJson(request, schema)
    await consumeRequestRateLimit(clientRateKey(request, `message-template-publish:${actor.workspaceId}`), 30)
    return NextResponse.json(await publishMessageTemplate(actor, (await context.params).id, input), { headers: noStore })
  } catch (error) {
    return apiError(error)
  }
}
