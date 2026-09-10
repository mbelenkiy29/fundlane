import { NextResponse } from "next/server"
import { z } from "zod"
import {
  MESSAGE_TEMPLATE_CHANNELS,
  MESSAGE_TEMPLATE_SCOPES,
  requireTemplatePreview,
  validateTemplateVariables,
} from "@/lib/mca/comms/templates"
import { apiError } from "@/lib/mca/errors"
import { readJson } from "@/lib/mca/http"

export const runtime = "nodejs"
const noStore = { "cache-control": "no-store" }

const schema = z.object({
  subject: z.string().max(500).nullable().optional(),
  body: z.string().min(1).max(20_000),
  channel: z.enum(MESSAGE_TEMPLATE_CHANNELS),
  scope: z.enum(MESSAGE_TEMPLATE_SCOPES),
}).strict()

export async function POST(request: Request) {
  try {
    await requireTemplatePreview(request)
    const input = await readJson(request, schema)
    return NextResponse.json(validateTemplateVariables(input), { headers: noStore })
  } catch (error) {
    return apiError(error)
  }
}
