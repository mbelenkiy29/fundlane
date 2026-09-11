import "server-only"
import { z } from "zod"
import { getDatabase, newId, nowIso, withTransaction } from "../db"
import { hashOpaqueToken } from "../crypto"
import { AppError } from "../errors"
import type { DealActor } from "../deals/schema"
import {
  seal,
  unseal,
  ownedConversation,
  type Conversation
} from "./repository"
import { memoryInput, type MemoryView } from "./experience-contracts"
export interface MemorySettings {
  id: string
  enabled: number
  version: number
}
export async function memorySettings(workspace: string, user: string) {
  return (await getDatabase()
    .prepare<MemorySettings>(
      "INSERT INTO mca_assistant_memory_settings(id,workspace_id,user_id) VALUES (?,?,?) ON CONFLICT(workspace_id,user_id) DO UPDATE SET user_id=excluded.user_id RETURNING *"
    )
    .get(newId(), workspace, user))!
}
export async function readMemories(actor: DealActor, forModel = false) {
  if (!actor.userId)
    throw new AppError(401, "session_required", "Sign in to use memory.")
  const settings = await memorySettings(actor.workspaceId, actor.userId)
  const rows =
    !forModel || settings.enabled
      ? await getDatabase()
          .prepare<{
            id: string
            category: string
            content_cipher: string
            updated_at: string
            source_conversation_id: string | null
          }>("SELECT * FROM mca_assistant_memories WHERE settings_id=? AND deleted_at IS NULL ORDER BY updated_at DESC LIMIT 50")
          .all(settings.id)
      : []
  const memories: MemoryView[] = []
  for (const r of rows) {
    if (r.source_conversation_id)
      try {
        await ownedConversation(actor, r.source_conversation_id)
      } catch (e) {
        if (e instanceof AppError && [403, 404].includes(e.status)) continue
        throw e
      }
    memories.push({
      id: r.id,
      category: r.category,
      text: unseal<string>(actor.workspaceId, r.content_cipher),
      updatedAt: r.updated_at
    })
  }
  return {
    enabled: Boolean(settings.enabled),
    version: settings.version,
    memories
  }
}
export function safePreference(text: string) {
  return !/(?:sk-[a-z]|password|api.?key|secret|ssn|social security|routing|account number|bank account|\b\d{3}-\d{2}-\d{4}\b|\b\d{8,}\b|ignore.{0,30}instructions|bypass|always approve)/i.test(
    text
  )
}
export async function learnPreference(
  c: Conversation,
  runId: string,
  input: z.infer<typeof memoryInput>,
  quote: string
) {
  const parsed = memoryInput.parse(input)
  if (!safePreference(parsed.text) || !safePreference(quote))
    return {
      saved: false,
      reason:
        "Only non-sensitive communication and workflow preferences can be remembered."
    }
  const userMessages = await getDatabase()
    .prepare<{
      content_cipher: string
    }>("SELECT m.content_cipher FROM mca_assistant_messages m JOIN mca_assistant_message_parts p ON p.message_id=m.id WHERE p.run_id=? AND m.role='user' ORDER BY m.sequence DESC LIMIT 5")
    .all(runId)
  if (
    quote.trim().length < 4 ||
    !userMessages.some((m) =>
      unseal<string>(c.workspace_id, m.content_cipher).includes(quote)
    )
  )
    return {
      saved: false,
      reason: "A preference must be grounded in this user's current request."
    }
  return withTransaction(async (db) => {
    const settings = await memorySettings(c.workspace_id, c.user_id)
    await db
      .prepare(
        "SELECT id FROM mca_assistant_memory_settings WHERE id=? FOR UPDATE"
      )
      .get(settings.id)
    const current = await db
      .prepare<MemorySettings>(
        "SELECT * FROM mca_assistant_memory_settings WHERE id=?"
      )
      .get(settings.id)
    const run = await db
      .prepare<{
        memory_version: number
      }>("SELECT memory_version FROM mca_assistant_run_meta WHERE run_id=?")
      .get(runId)
    if (!current?.enabled || current.version !== run?.memory_version)
      return {
        saved: false,
        reason: "Memory settings changed during this request."
      }
    const fingerprint = hashOpaqueToken(
      `${c.workspace_id}:${c.user_id}:${parsed.category}`
    )
    if (
      await db
        .prepare(
          "SELECT 1 FROM mca_assistant_memories WHERE settings_id=? AND fingerprint=? AND deleted_at IS NOT NULL"
        )
        .get(settings.id, fingerprint)
    )
      return {
        saved: false,
        reason:
          "Automatic learning is paused for this deleted preference category. The user can add a preference in Memory settings."
      }
    await db
      .prepare(
        "INSERT INTO mca_assistant_memories(id,settings_id,category,content_cipher,source_conversation_id,fingerprint,updated_at) VALUES (?,?,?,?,?,?,?) ON CONFLICT(settings_id,fingerprint) DO UPDATE SET content_cipher=excluded.content_cipher,source_conversation_id=excluded.source_conversation_id,updated_at=excluded.updated_at WHERE mca_assistant_memories.deleted_at IS NULL"
      )
      .run(
        newId(),
        settings.id,
        parsed.category,
        seal(c.workspace_id, parsed.text),
        c.id,
        fingerprint,
        nowIso()
      )
    return { saved: true, category: parsed.category, text: parsed.text }
  })
}
export const memoryCommand = z.discriminatedUnion("action", [
  z.object({ action: z.literal("enabled"), enabled: z.boolean() }).strict(),
  z.object({ action: z.literal("save"), ...memoryInput.shape }).strict(),
  z.object({ action: z.literal("delete"), id: z.string().uuid() }).strict(),
  z.object({ action: z.literal("clear") }).strict()
])
export async function changeMemory(
  actor: DealActor,
  command: z.infer<typeof memoryCommand>
) {
  if (!actor.userId)
    throw new AppError(401, "session_required", "Sign in to use memory.")
  const userId = actor.userId
  await withTransaction(async (db) => {
    const s = await memorySettings(actor.workspaceId, userId)
    await db
      .prepare(
        "SELECT id FROM mca_assistant_memory_settings WHERE id=? FOR UPDATE"
      )
      .get(s.id)
    await db
      .prepare(
        "UPDATE mca_assistant_memory_settings SET version=version+1 WHERE id=?"
      )
      .run(s.id)
    if (command.action === "enabled")
      await db
        .prepare(
          "UPDATE mca_assistant_memory_settings SET enabled=? WHERE id=?"
        )
        .run(command.enabled ? 1 : 0, s.id)
    if (command.action === "clear") {
      // Preserve a tombstone for all four categories, including categories not yet learned.
      for (const category of [
        "writing_style",
        "format",
        "terminology",
        "workflow"
      ])
        await db
          .prepare(
            "INSERT INTO mca_assistant_memories(id,settings_id,category,fingerprint,deleted_at,updated_at) VALUES (?,?,?,?,?,?) ON CONFLICT(settings_id,fingerprint) DO UPDATE SET content_cipher=NULL,deleted_at=excluded.deleted_at"
          )
          .run(
            newId(),
            s.id,
            category,
            hashOpaqueToken(`${actor.workspaceId}:${actor.userId}:${category}`),
            nowIso(),
            nowIso()
          )
    }
    if (command.action === "delete")
      await db
        .prepare(
          "UPDATE mca_assistant_memories SET content_cipher=NULL,deleted_at=? WHERE id=? AND settings_id=?"
        )
        .run(nowIso(), command.id, s.id)
    if (command.action === "save") {
      if (!safePreference(command.text))
        throw new AppError(
          422,
          "memory_sensitive",
          "Save preferences without credentials or sensitive merchant information."
        )
      await db
        .prepare(
          "INSERT INTO mca_assistant_memories(id,settings_id,category,content_cipher,fingerprint,updated_at) VALUES (?,?,?,?,?,?) ON CONFLICT(settings_id,fingerprint) DO UPDATE SET content_cipher=excluded.content_cipher,deleted_at=NULL,source_conversation_id=NULL,updated_at=excluded.updated_at"
        )
        .run(
          newId(),
          s.id,
          command.category,
          seal(actor.workspaceId, command.text),
          hashOpaqueToken(
            `${actor.workspaceId}:${actor.userId}:${command.category}`
          ),
          nowIso()
        )
    }
  })
  return readMemories(actor)
}
