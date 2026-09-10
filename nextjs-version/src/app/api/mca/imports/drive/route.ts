import { NextResponse } from "next/server"
import { assertTrustedMutation, requireWorkspaceAccess } from "@/lib/mca/auth"
import { actorForDeals } from "@/lib/mca/deals/service"
import { apiError } from "@/lib/mca/errors"
import { applyDriveDocuments, beginDriveOAuth, disconnectDrive, getDriveStatus, listDrivePackage, previewDrivePackage } from "@/lib/mca/imports/drive-service"
import type { ArchiveCategory } from "@/lib/mca/imports/contracts"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

async function actor(request: Request) {
  return actorForDeals(await requireWorkspaceAccess(request, { roles: ["admin", "super_admin"], sessionOnly: true }))
}

export async function GET(request: Request) {
  try {
    const current = await actor(request)
    const status = await getDriveStatus(current)
    if (new URL(request.url).searchParams.get("files") !== "true") return NextResponse.json(status, { headers: { "cache-control": "no-store" } })
    return NextResponse.json({ connection: status, files: await listDrivePackage(current) }, { headers: { "cache-control": "no-store" } })
  } catch (error) { return apiError(error) }
}

export async function POST(request: Request) {
  try {
    assertTrustedMutation(request)
    const current = await actor(request)
    const input = await request.json() as { action: string; folderUrl?: string; sourceId?: string; batchId?: string; assignmentPool?: string[]; useAiMapping?: boolean; runId?: string; confirmations?: Array<{ fileId: string; rowId: string; category: ArchiveCategory }> }
    if (input.action === "oauth_start") return NextResponse.json(await beginDriveOAuth(current, input.folderUrl ?? ""), { status: 201 })
    if (input.action === "preview") return NextResponse.json(await previewDrivePackage(current, { sourceId: input.sourceId ?? "", batchId: input.batchId ?? "", assignmentPool: input.assignmentPool, useAiMapping: input.useAiMapping }), { status: 201 })
    if (input.action === "apply") return NextResponse.json(await applyDriveDocuments(current, { runId: input.runId ?? "", confirmations: input.confirmations ?? [] }))
    return NextResponse.json({ error: { code: "drive_action", message: "Choose oauth_start, preview, or apply." } }, { status: 422 })
  } catch (error) { return apiError(error) }
}

export async function DELETE(request: Request) {
  try { assertTrustedMutation(request); await disconnectDrive(await actor(request)); return NextResponse.json({ revoked: true }) }
  catch (error) { return apiError(error) }
}
