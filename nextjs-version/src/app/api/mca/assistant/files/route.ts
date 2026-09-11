import { NextResponse } from "next/server"
import { z } from "zod"
import { assertTrustedMutation, consumeRequestRateLimit } from "@/lib/mca/auth"
import { apiError, AppError } from "@/lib/mca/errors"
import { authorize } from "@/lib/mca/assistant/operations"
import { ownedConversation } from "@/lib/mca/assistant/repository"
import { filesEnabled } from "@/lib/mca/assistant/experience-contracts"
import {
  getFile,
  storeFile,
  fileView,
  MAX_FILE_BYTES
} from "@/lib/mca/assistant/files"
import { getDatabase, nowIso } from "@/lib/mca/db"
export const runtime = "nodejs"
export const maxDuration = 60
export async function POST(request: Request) {
  try {
    assertTrustedMutation(request)
    const actor = await authorize(request)
    if (!filesEnabled())
      throw new AppError(
        503,
        "files_disabled",
        "File processing is currently unavailable."
      )
    await consumeRequestRateLimit(
      `assistant:upload:${actor.workspaceId}:${actor.userId}`,
      12
    )
    const reader = request.body?.getReader()
    if (!reader) throw new AppError(422, "file_missing", "Choose a file.")
    const chunks: Uint8Array[] = []
    let size = 0
    for (;;) {
      const r = await reader.read()
      if (r.done) break
      size += r.value.length
      if (size > MAX_FILE_BYTES + 65536) {
        await reader.cancel()
        throw new AppError(413, "file_limit", "Files must be at most 25 MB.")
      }
      chunks.push(r.value)
    }
    const form = await new Response(Buffer.concat(chunks), {
      headers: { "content-type": request.headers.get("content-type") ?? "" }
    }).formData()
    const id = z.string().uuid().parse(form.get("conversationId")),
      file = form.get("file")
    if (!(file instanceof File))
      throw new AppError(422, "file_missing", "Choose a file.")
    const c = await ownedConversation(actor, id)
    return NextResponse.json(
      {
        file: await storeFile(
          actor,
          c,
          file.name,
          Buffer.from(await file.arrayBuffer())
        )
      },
      { headers: { "cache-control": "no-store" } }
    )
  } catch (e) {
    return apiError(e)
  }
}
export async function GET(request: Request) {
  try {
    const actor = await authorize(request)
    const rows = await getDatabase()
      .prepare<{
        id: string
      }>("SELECT id FROM mca_assistant_files WHERE workspace_id=? AND user_id=? AND state='ready' AND expires_at>? ORDER BY created_at DESC LIMIT 100")
      .all(actor.workspaceId, actor.userId, nowIso())
    const files = []
    for (const row of rows) {
      try {
        files.push(fileView(await getFile(actor, row.id)))
      } catch (e) {
        if (!(e instanceof AppError) || ![403, 404, 410].includes(e.status))
          throw e
      }
    }
    return NextResponse.json(
      { files },
      { headers: { "cache-control": "no-store" } }
    )
  } catch (e) {
    return apiError(e)
  }
}
