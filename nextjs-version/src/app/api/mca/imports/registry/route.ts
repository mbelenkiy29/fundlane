import { NextResponse } from "next/server"
import { assertTrustedMutation, requireWorkspaceAccess } from "@/lib/mca/auth"
import { actorForDeals } from "@/lib/mca/deals/service"
import { apiError, AppError } from "@/lib/mca/errors"
import { createImportSource, createLeadBatch, listImportRegistry, saveMappingProfile } from "@/lib/mca/imports/service"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

async function actor(request: Request) {
  return actorForDeals(await requireWorkspaceAccess(request, { roles: ["admin", "super_admin"], sessionOnly: true }))
}

export async function GET(request: Request) {
  try { return NextResponse.json(await listImportRegistry(await actor(request)), { headers: { "cache-control": "no-store" } }) }
  catch (error) { return apiError(error) }
}

export async function POST(request: Request) {
  try {
    assertTrustedMutation(request)
    const current = await actor(request)
    const input = await request.json() as { kind?: string; name?: string; sourceId?: string; sourceKind?: "spreadsheet" | "drive"; mapping?: Record<string, string>; originatorMapping?: Record<string, string> }
    if (input.kind === "source") return NextResponse.json(await createImportSource(current, { name: input.name ?? "", kind: input.sourceKind }), { status: 201 })
    if (input.kind === "batch") return NextResponse.json(await createLeadBatch(current, { sourceId: input.sourceId ?? "", name: input.name ?? "" }), { status: 201 })
    if (input.kind === "profile") return NextResponse.json(await saveMappingProfile(current, { name: input.name ?? "", mapping: input.mapping ?? {}, originatorMapping: input.originatorMapping }), { status: 201 })
    throw new AppError(422, "registry_kind", "Choose source, batch, or profile.")
  } catch (error) { return apiError(error) }
}
