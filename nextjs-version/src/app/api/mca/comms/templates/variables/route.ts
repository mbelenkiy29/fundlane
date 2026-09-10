import { NextResponse } from "next/server"
import { MESSAGE_TEMPLATE_SCOPES, listTemplateVariables, requireTemplateRead } from "@/lib/mca/comms/templates"
import { apiError } from "@/lib/mca/errors"

export const runtime = "nodejs"
const noStore = { "cache-control": "no-store" }

export async function GET(request: Request) {
  try {
    await requireTemplateRead(request)
    const scope = new URL(request.url).searchParams.get("scope")
    const resolved = scope && MESSAGE_TEMPLATE_SCOPES.includes(scope as (typeof MESSAGE_TEMPLATE_SCOPES)[number])
      ? scope as (typeof MESSAGE_TEMPLATE_SCOPES)[number]
      : undefined
    return NextResponse.json({ variables: listTemplateVariables(resolved) }, { headers: noStore })
  } catch (error) {
    return apiError(error)
  }
}
