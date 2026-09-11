import "server-only"
import type { AgentInputItem } from "@openai/agents"
import { getDatabase } from "../db"
import { seal, unseal, type Conversation } from "./repository"

/** Bounded, extractive recall avoids a second model request and never treats old facts as current. */
export async function conversationContext(c: Conversation) {
  const db = getDatabase()
  const rows = await db
    .prepare<{
      role: "user" | "assistant"
      content_cipher: string
      sequence: number
    }>("SELECT role,content_cipher,sequence FROM mca_assistant_messages WHERE conversation_id=? ORDER BY sequence DESC LIMIT 120")
    .all(c.id)
  const recent = rows.slice(0, 20).reverse()
  const older = rows.slice(20).reverse()
  let summary = ""
  if (older.length) {
    const boundary = Number(older.at(-1)!.sequence)
    const saved = await db
      .prepare<{
        summary_cipher: string | null
        summary_sequence: number
      }>("SELECT summary_cipher,summary_sequence FROM mca_assistant_conversation_meta WHERE conversation_id=?")
      .get(c.id)
    if (saved?.summary_sequence === boundary && saved.summary_cipher)
      summary = unseal(c.workspace_id, saved.summary_cipher)
    else {
      const snippets = older.map(
        (r) =>
          `${r.role}: ${unseal<string>(c.workspace_id, r.content_cipher).replace(/\s+/g, " ").slice(0, 240)}`
      )
      summary = snippets.join("\n").slice(-8000)
      await db
        .prepare(
          "INSERT INTO mca_assistant_conversation_meta(conversation_id,summary_cipher,summary_sequence) VALUES (?,?,?) ON CONFLICT(conversation_id) DO UPDATE SET summary_cipher=excluded.summary_cipher,summary_sequence=excluded.summary_sequence WHERE mca_assistant_conversation_meta.deleted_at IS NULL"
        )
        .run(c.id, seal(c.workspace_id, summary), boundary)
    }
  }
  let budget = 48000
  const input: AgentInputItem[] = []
  for (const row of [...recent].reverse()) {
    const text = unseal<string>(c.workspace_id, row.content_cipher).slice(
      0,
      Math.min(row === recent.at(-1) ? 8000 : 6000, budget)
    )
    if (!text) break
    budget -= text.length
    input.unshift(
      row.role === "user"
        ? { role: "user", content: text }
        : {
            role: "assistant",
            status: "completed",
            content: [{ type: "output_text", text }]
          }
    )
  }
  return { input, summary }
}
