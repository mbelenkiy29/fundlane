import { NextResponse } from "next/server"
import { z } from "zod"
import { assertTrustedMutation } from "@/lib/mca/auth"
import { apiError } from "@/lib/mca/errors"
import { readJson, requestCorrelationId } from "@/lib/mca/http"
import { requireSetupEditor, requireSetupReader } from "@/lib/mca/setup/http"
import { dismissWorkspaceSetup, getWorkspaceSetup } from "@/lib/mca/setup/service"

export const runtime = "nodejs"

const dismissInput = z.object({ dismissed: z.literal(true) }).strict()

export async function GET(request: Request) {
  const correlationId = requestCorrelationId(request)
  try {
    const context = await requireSetupReader(request)
    return NextResponse.json(await getWorkspaceSetup(context.workspaceId, context.role), { headers: { "cache-control": "no-store" } })
  } catch (error) {
    return apiError(error, correlationId)
  }
}

export async function POST(request: Request) {
  const correlationId = requestCorrelationId(request)
  try {
    assertTrustedMutation(request)
    const context = await requireSetupEditor(request)
    await readJson(request, dismissInput)
    return NextResponse.json(await dismissWorkspaceSetup(context), { headers: { "cache-control": "no-store" } })
  } catch (error) {
    return apiError(error, correlationId)
  }
}
