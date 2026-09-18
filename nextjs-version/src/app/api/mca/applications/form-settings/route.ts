import { NextResponse } from "next/server"
import { assertTrustedMutation } from "@/lib/mca/auth"
import { apiError } from "@/lib/mca/errors"
import { readJson } from "@/lib/mca/http"
import { formSettingsInput } from "@/lib/mca/applications/contracts"
import { formBranding, saveFormBranding, ensureFundlaneForm } from "@/lib/mca/applications/provision"
import { requireApplicationActor } from "@/lib/mca/applications/service"

export const runtime = "nodejs"

export async function GET(request: Request) {
  try {
    const actor = await requireApplicationActor(request)
    const form = await ensureFundlaneForm(actor)
    return NextResponse.json({ form, branding: await formBranding(actor.workspaceId, form.id) }, { headers: { "Cache-Control": "private, no-store" } })
  } catch (error) { return apiError(error) }
}

export async function PATCH(request: Request) {
  try {
    assertTrustedMutation(request)
    const actor = await requireApplicationActor(request, true)
    return NextResponse.json({ branding: await saveFormBranding(actor, await readJson(request, formSettingsInput)) }, { headers: { "Cache-Control": "private, no-store" } })
  } catch (error) { return apiError(error) }
}
