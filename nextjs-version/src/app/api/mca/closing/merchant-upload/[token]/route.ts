import { NextResponse } from "next/server"
import { apiError, AppError } from "@/lib/mca/errors"
import { clientRateKey, consumeRequestRateLimit } from "@/lib/mca/auth"
import { inspectMerchantUpload, uploadMerchantDocument } from "@/lib/mca/closing/service"

export async function GET(request: Request, { params }: { params: Promise<{ token: string }> }) { try { await consumeRequestRateLimit(clientRateKey(request, "merchant-upload-view"), 60); return NextResponse.json(await inspectMerchantUpload((await params).token)) } catch (error) { return apiError(error) } }
export async function POST(request: Request, { params }: { params: Promise<{ token: string }> }) {
  try {
    await consumeRequestRateLimit(clientRateKey(request, "merchant-upload"), 15)
    const form = await request.formData(), file = form.get("file")
    if (!(file instanceof File)) throw new AppError(422, "file_required", "Choose a PDF, PNG, or JPEG file.")
    return NextResponse.json(await uploadMerchantDocument((await params).token, { idempotencyKey: String(form.get("idempotencyKey") ?? ""), filename: file.name, mimeType: file.type, bytes: new Uint8Array(await file.arrayBuffer()) }), { status: 201 })
  } catch (error) { return apiError(error) }
}
