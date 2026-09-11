import { NextResponse } from "next/server"
import { z } from "zod"
import { getDatabase } from "@/lib/mca/db"
import { apiError } from "@/lib/mca/errors"
import { authorize } from "@/lib/mca/assistant/operations"
import { ownedConversation, unseal } from "@/lib/mca/assistant/repository"
import { refreshPartFiles } from "@/lib/mca/assistant/experience"
import type { MessageParts } from "@/lib/mca/assistant/experience-contracts"
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const c = await ownedConversation(
      await authorize(request),
      (await params).id
    )
    const before = z.coerce
      .number()
      .int()
      .positive()
      .max(Number.MAX_SAFE_INTEGER)
      .parse(new URL(request.url).searchParams.get("before"))
    const rows = await getDatabase()
      .prepare<{
        id: string
        role: "user" | "assistant"
        sequence: number
        content_cipher: string
        payload_cipher: string | null
      }>(
        "SELECT m.id,m.role,m.sequence,m.content_cipher,p.payload_cipher FROM mca_assistant_messages m LEFT JOIN mca_assistant_message_parts p ON p.message_id=m.id WHERE m.conversation_id=? AND m.sequence<? ORDER BY m.sequence DESC LIMIT 50"
      )
      .all(c.id, before)
    rows.reverse()
    const parts: Record<string, MessageParts> = {}
    for (const r of rows)
      if (r.payload_cipher) {
        const p = unseal<MessageParts>(c.workspace_id, r.payload_cipher)
        parts[r.id] = p
      }
    await refreshPartFiles(c, parts)
    return NextResponse.json(
      {
        messages: rows.map((r) => ({
          id: r.id,
          role: r.role,
          text: unseal<string>(c.workspace_id, r.content_cipher)
        })),
        parts,
        olderCursor: rows.length === 50 ? Number(rows[0].sequence) : null
      },
      { headers: { "cache-control": "no-store" } }
    )
  } catch (e) {
    return apiError(e)
  }
}
