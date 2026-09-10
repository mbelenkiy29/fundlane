import { NextResponse } from "next/server"
import { apiError, AppError } from "@/lib/mca/errors"
import { requireDocumentActor } from "@/lib/mca/documents/http"
import { applyStatementFilename, previewStatementFilename } from "@/lib/mca/documents/statement-filenames"
import { renameDocument } from "@/lib/mca/documents/service"

export const runtime = "nodejs"
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const actor = await requireDocumentActor(request, "write")
    const documentId = (await context.params).id
    const body = await request.json() as { action?: string; bankLabel?: string; statementMonth?: string; accountSuffix?: string; displayFilename?: string }
    if (body.action === "rename") return NextResponse.json(await renameDocument(actor, documentId, body.displayFilename ?? ""), { headers: { "cache-control": "no-store" } })
    if (body.action === "preview") return NextResponse.json(await previewStatementFilename(actor, documentId), { headers: { "cache-control": "no-store" } })
    if (body.action === "apply" || body.action === "correct") return NextResponse.json(await applyStatementFilename(actor, { documentId, bankLabel: body.bankLabel, statementMonth: body.statementMonth, accountSuffix: body.accountSuffix }), { headers: { "cache-control": "no-store" } })
    throw new AppError(422, "filename_action_invalid", "Choose preview, apply, correct, or rename.")
  } catch (error) { return apiError(error) }
}
