import { NextResponse } from "next/server"
import { assertTrustedMutation, requireWorkspaceAccess } from "@/lib/mca/auth"
import { actorForDeals } from "@/lib/mca/deals/service"
import { apiError, AppError } from "@/lib/mca/errors"
import { DOCUMENT_CATEGORIES, type DocumentCategory } from "@/lib/mca/documents/contracts"
import { attachIntakeDocument } from "@/lib/mca/intake/service"

export const runtime = "nodejs"
interface Context { params: Promise<{ intakeId: string }> }

export async function POST(request: Request, context: Context) {
  try {
    assertTrustedMutation(request)
    const auth = await requireWorkspaceAccess(request, { scopes: ["intake:write"] })
    const body = await request.json() as { attachmentId?: string; filename?: string; mimeType?: string; base64?: string; category?: string }
    if (!body.attachmentId || !body.filename || !body.mimeType || !body.base64 || !DOCUMENT_CATEGORIES.includes(body.category as DocumentCategory)) {
      throw new AppError(422, "attachment_validation_failed", "Provide attachmentId, filename, MIME type, category, and base64 file content.")
    }
    const bytes = Buffer.from(body.base64, "base64")
    const document = await attachIntakeDocument(await actorForDeals(auth), {
      intakeId: (await context.params).intakeId, attachmentId: body.attachmentId, filename: body.filename,
      mimeType: body.mimeType, bytes, category: body.category as DocumentCategory,
    })
    return NextResponse.json(document, { status: 201 })
  } catch (error) { return apiError(error) }
}
