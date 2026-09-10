import { NextResponse } from "next/server"
import { listMessageTemplateVersions, requireTemplateAdminRead } from "@/lib/mca/comms/templates"
import { apiError } from "@/lib/mca/errors"

export const runtime = "nodejs"
const noStore = { "cache-control": "no-store" }

interface RouteContext { params: Promise<{ id: string }> }

export async function GET(request: Request, context: RouteContext) {
  try {
    const actor = await requireTemplateAdminRead(request)
    return NextResponse.json(await listMessageTemplateVersions(actor, (await context.params).id), { headers: noStore })
  } catch (error) {
    return apiError(error)
  }
}
