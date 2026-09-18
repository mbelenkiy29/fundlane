import { NextResponse } from "next/server"
import { assertTrustedMutation, clientRateKey, consumeRequestRateLimit } from "@/lib/mca/auth"
import { apiError, AppError } from "@/lib/mca/errors"
import { INVITE_TOKEN_PATTERN } from "@/lib/mca/applications/form-schema"
import { stageInvitationFile } from "@/lib/mca/applications/files"

export const runtime = "nodejs"

export async function POST(request: Request) {
  try {
    assertTrustedMutation(request)
    await consumeRequestRateLimit(clientRateKey(request, "application-file"), 30)
    const form = await request.formData()
    const token = String(form.get("token") ?? "")
    if (!INVITE_TOKEN_PATTERN.test(token)) throw new AppError(410, "invitation_inactive", "This application link is expired, completed, or no longer active.")
    const file = form.get("file")
    if (!(file instanceof File)) throw new AppError(422, "file_required", "Choose a PDF, PNG, or JPEG file.")
    return NextResponse.json(await stageInvitationFile({
      token,
      idempotencyKey: String(form.get("idempotencyKey") ?? ""),
      category: String(form.get("category") ?? "statement"),
      filename: file.name,
      mimeType: file.type || "application/pdf",
      bytes: new Uint8Array(await file.arrayBuffer()),
    }), { status: 201, headers: { "Cache-Control": "no-store" } })
  } catch (error) { return apiError(error) }
}
