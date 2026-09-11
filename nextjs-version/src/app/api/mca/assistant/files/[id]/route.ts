import { NextResponse } from "next/server"
import { assertTrustedMutation } from "@/lib/mca/auth"
import { apiError } from "@/lib/mca/errors"
import { authorize } from "@/lib/mca/assistant/operations"
import {
  fileBytes,
  fileView,
  deleteFile,
  previewFile
} from "@/lib/mca/assistant/files"
type Context = { params: Promise<{ id: string }> }
export async function GET(request: Request, context: Context) {
  try {
    const actor = await authorize(request),
      { id } = await context.params
    if (new URL(request.url).searchParams.has("preview"))
      return NextResponse.json(await previewFile(actor, id), {
        headers: { "cache-control": "no-store" }
      })
    const { record, bytes } = await fileBytes(actor, id),
      file = fileView(record)
    return new Response(new Uint8Array(bytes), {
      headers: {
        "content-type": file.mime,
        "content-length": String(bytes.length),
        "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(file.name)}`,
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
        "content-security-policy": "default-src 'none'; sandbox"
      }
    })
  } catch (e) {
    return apiError(e)
  }
}
export async function DELETE(request: Request, context: Context) {
  try {
    assertTrustedMutation(request)
    await deleteFile(await authorize(request), (await context.params).id)
    return NextResponse.json({ deleted: true })
  } catch (e) {
    return apiError(e)
  }
}
