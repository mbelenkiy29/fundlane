import { NextResponse } from "next/server"
import { assertTrustedMutation, requireWorkspaceAccess } from "@/lib/mca/auth"
import { actorForDeals } from "@/lib/mca/deals/service"
import { apiError, AppError } from "@/lib/mca/errors"
import { applyArchiveMatches } from "@/lib/mca/imports/archive-service"
import type { ArchiveCategory } from "@/lib/mca/imports/contracts"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function POST(request: Request) {
  try {
    assertTrustedMutation(request)
    const actor = await actorForDeals(await requireWorkspaceAccess(request, { roles: ["admin", "super_admin"], sessionOnly: true }))
    const form = await request.formData()
    const archives = form.getAll("archives")
    if (!archives.length || archives.some((file) => !(file instanceof File))) throw new AppError(422, "archives_required", "Choose the same ZIP archives used for preview.")
    const confirmations = JSON.parse(String(form.get("confirmations") ?? "[]")) as Array<{ archiveName: string; path: string; rowId: string; category: ArchiveCategory }>
    return NextResponse.json(await applyArchiveMatches(actor, { runId: String(form.get("runId") ?? ""), confirmations, archives: await Promise.all((archives as File[]).map(async (file) => ({ filename: file.name, bytes: new Uint8Array(await file.arrayBuffer()) }))) }))
  } catch (error) { return apiError(error) }
}
