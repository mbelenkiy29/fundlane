import { NextResponse } from "next/server"
import { clientRateKey, consumeRequestRateLimit } from "@/lib/mca/auth"
import { apiError, AppError } from "@/lib/mca/errors"
import { uploadNativeApplyDocument } from "@/lib/mca/intake/native-apply"

export const runtime = "nodejs"

export async function POST(request: Request, { params }: { params: Promise<{ token: string }> }) {
  try {
    await consumeRequestRateLimit(clientRateKey(request, "native-apply-upload"), 20)
    const form = await request.formData()
    const file = form.get("file")
    if (!(file instanceof File)) throw new AppError(422, "file_required", "Choose a PDF, PNG, or JPEG file.")
    const dealId = String(form.get("dealId") ?? "").trim()
    if (!dealId) throw new AppError(422, "deal_required", "Submit the application before uploading documents.")
    return NextResponse.json(await uploadNativeApplyDocument({
      token: (await params).token,
      dealId,
      category: String(form.get("category") ?? ""),
      filename: file.name,
      mimeType: file.type,
      bytes: new Uint8Array(await file.arrayBuffer()),
      idempotencyKey: String(form.get("idempotencyKey") ?? ""),
    }), { status: 201 })
  } catch (error) {
    return apiError(error)
  }
}
