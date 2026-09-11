import "server-only"
import { z } from "zod"
import { getDatabase } from "../db"
import { decryptSensitive, encryptSensitive } from "../crypto"
import { getDeal } from "../deals/service"
import { AppError } from "../errors"
import type { AssistantContext } from "./chatkit-context"

const id = z.string().min(1).max(128)
const record = z.record(z.string(), z.unknown())
export const storeRequest = z.object({
  op: z.enum(["load_thread", "save_thread", "load_threads", "delete_thread", "load_items", "load_item", "save_item", "delete_item"]),
  threadId: id.optional(), itemId: id.optional(), payload: record.optional(),
  after: id.nullish(), limit: z.number().int().min(1).max(100).default(20), order: z.enum(["asc", "desc"]).default("desc"),
}).strict()
type ThreadRow = { id: string; payload_cipher: string; access_stamp: string; created_at: string }
function encode(value: unknown, c: AssistantContext) {
  return encryptSensitive(JSON.stringify({ version: 1, data: value }), c.context.workspaceId)
}
function decode(cipher: string, c: AssistantContext): Record<string, unknown> {
  const envelope = JSON.parse(decryptSensitive(cipher, c.context.workspaceId))
  if (envelope.version !== 1) throw new AppError(409, "unsupported_history", "This conversation format is unavailable.")
  return envelope.data
}
export async function ownedThread(c: AssistantContext, threadId: string, checkAccess = true) {
  const row = await getDatabase().prepare<ThreadRow>(`SELECT id,payload_cipher,access_stamp,created_at FROM mca_chatkit_threads WHERE id=? AND workspace_id=? AND user_id=?`)
    .get(threadId, c.context.workspaceId, c.context.userId)
  if (!row) throw new AppError(404, "thread_not_found", "Conversation not found.")
  if (checkAccess) await assertThreadAccess(c, row)
  return row
}
async function assertThreadAccess(c: AssistantContext, row: ThreadRow) {
  if (row.access_stamp !== c.accessStamp) throw new AppError(403, "history_access_changed", "Access has changed. Start a new conversation or delete this one.")
  const refs = await getDatabase().prepare<{ deal_id: string }>("SELECT deal_id FROM mca_chatkit_references WHERE thread_id=?").all(row.id)
  for (const ref of refs) {
    try { await getDeal(c.actor, ref.deal_id) }
    catch (error) {
      if (!(error instanceof AppError) || ![403, 404].includes(error.status)) throw error
      throw new AppError(403, "history_access_changed", "Access has changed. Start a new conversation or delete this one.")
    }
  }
}
export async function rememberDeals(c: AssistantContext, threadId: string, dealIds: string[]) {
  await ownedThread(c, threadId)
  if (dealIds.length) await getDatabase().prepare(`INSERT INTO mca_chatkit_references(thread_id,deal_id)
    SELECT ?, value FROM jsonb_array_elements_text(?::jsonb) ON CONFLICT DO NOTHING`).run(threadId, JSON.stringify([...new Set(dealIds)]))
}
function required(value: string | undefined) {
  if (!value) throw new AppError(400, "invalid_request", "A record identifier is required.")
  return value
}
export async function storeOperation(c: AssistantContext, input: z.infer<typeof storeRequest>): Promise<unknown> {
  const db = getDatabase(), { workspaceId, userId } = c.context
  const { op, limit, order, after } = input
  if (op === "save_thread") {
    const payload = input.payload
    const metadata = z.object({ id, created_at: z.string().datetime({ offset: true }), title: z.string().max(250).nullish() }).passthrough().parse(payload)
    const existing = await db.prepare<{ id: string }>("SELECT id FROM mca_chatkit_threads WHERE id=?").get(metadata.id)
    if (existing) await ownedThread(c, metadata.id)
    const saved = await db.prepare(`INSERT INTO mca_chatkit_threads(id,workspace_id,user_id,payload_cipher,access_stamp,created_at)
      VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET payload_cipher=EXCLUDED.payload_cipher
      WHERE mca_chatkit_threads.workspace_id=EXCLUDED.workspace_id AND mca_chatkit_threads.user_id=EXCLUDED.user_id RETURNING id`)
      .get(metadata.id, workspaceId, userId, encode(metadata, c), c.accessStamp, metadata.created_at)
    if (!saved) throw new AppError(404, "thread_not_found", "Conversation not found.")
    return null
  }
  if (op === "load_threads") {
    const cursor = after ? await ownedThread(c, after, false) : null
    const rows = await db.prepare<ThreadRow>(`SELECT id,payload_cipher,access_stamp,created_at FROM mca_chatkit_threads
      WHERE workspace_id=? AND user_id=? ${cursor ? `AND (created_at,id) ${order === "asc" ? ">" : "<"} (?,?)` : ""}
      ORDER BY created_at ${order},id ${order} LIMIT ?`)
      .all(workspaceId, userId, ...(cursor ? [cursor.created_at, cursor.id] : []), limit + 1)
    const data = []
    for (const row of rows.slice(0, limit)) {
      try { await assertThreadAccess(c, row); data.push(decode(row.payload_cipher, c)) }
      catch (error) {
        if (!(error instanceof AppError) || error.code !== "history_access_changed") throw error
        data.push({ id: row.id, title: "Conversation unavailable — access changed", created_at: row.created_at, status: { type: "locked", reason: "Access changed. You can delete this conversation." } })
      }
    }
    return { data, has_more: rows.length > limit, after: rows.length > limit ? rows[limit - 1].id : null }
  }
  const threadId = required(input.threadId)
  const thread = await ownedThread(c, threadId, op !== "delete_thread")
  if (op === "delete_thread") { await db.prepare("DELETE FROM mca_chatkit_threads WHERE id=? AND workspace_id=? AND user_id=?").run(threadId, workspaceId, userId); return null }
  if (op === "load_thread") return decode(thread.payload_cipher, c)
  if (op === "load_items") {
    const cursor = after ? await db.prepare<{ sequence: string }>("SELECT sequence FROM mca_chatkit_items WHERE thread_id=? AND id=?").get(threadId, after) : null
    if (after && !cursor) throw new AppError(400, "invalid_cursor", "Invalid conversation cursor.")
    const rows = await db.prepare<{ id: string; payload_cipher: string }>(`SELECT id,payload_cipher FROM mca_chatkit_items WHERE thread_id=?
      ${cursor ? `AND sequence ${order === "asc" ? ">" : "<"} ?` : ""} ORDER BY sequence ${order} LIMIT ?`)
      .all(threadId, ...(cursor ? [cursor.sequence] : []), limit + 1)
    return { data: rows.slice(0, limit).map(row => decode(row.payload_cipher, c)), has_more: rows.length > limit, after: rows.length > limit ? rows[limit - 1].id : null }
  }
  if (op === "save_item") {
    const item = z.object({ id, thread_id: z.literal(threadId), type: z.string().min(1) }).passthrough().parse(input.payload)
    await db.prepare(`INSERT INTO mca_chatkit_items(thread_id,id,payload_cipher) VALUES(?,?,?)
      ON CONFLICT(thread_id,id) DO UPDATE SET payload_cipher=EXCLUDED.payload_cipher`).run(threadId, item.id, encode(item, c))
    return null
  }
  const itemId = required(input.itemId)
  if (op === "delete_item") { await db.prepare("DELETE FROM mca_chatkit_items WHERE thread_id=? AND id=?").run(threadId, itemId); return null }
  const row = await db.prepare<{ payload_cipher: string }>("SELECT payload_cipher FROM mca_chatkit_items WHERE thread_id=? AND id=?").get(threadId, itemId)
  if (!row) throw new AppError(404, "item_not_found", "Message not found.")
  return decode(row.payload_cipher, c)
}
