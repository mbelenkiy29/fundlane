import "server-only"
import { getDatabase, newId, nowIso, withTransaction } from "../db"
import { AppError } from "../errors"
import { getDeal } from "../deals/service"
import type { DealActor } from "../deals/schema"
import {
  addMessage,
  assertConversationAccess,
  cancelConversation,
  getRun,
  seal,
  unseal,
  trackDeal,
  type Conversation,
  type Run
} from "./repository"
import {
  ACTIVE_BUDGET_MS,
  questionsSchema,
  type Activity,
  type AssistantFile,
  type ExperienceView,
  type MessageParts
} from "./experience-contracts"

export interface RunMeta {
  run_id: string
  version: number
  elapsed_ms: number
  active_since: string | null
  search_calls: number
  code_calls: number
  attachments_cipher: string | null
  memory_version: number
}
export async function runMeta(runId: string) {
  return getDatabase()
    .prepare<RunMeta>("SELECT * FROM mca_assistant_run_meta WHERE run_id=?")
    .get(runId)
}
export async function initializeRun(
  c: Conversation,
  run: Run,
  files: string[] = []
) {
  const settings = await getDatabase()
    .prepare<{
      version: number
    }>(
      "SELECT version FROM mca_assistant_memory_settings WHERE workspace_id=? AND user_id=?"
    )
    .get(c.workspace_id, c.user_id)
  await getDatabase()
    .prepare(
      "INSERT INTO mca_assistant_run_meta(run_id,attachments_cipher,memory_version) VALUES (?,?,?) ON CONFLICT DO NOTHING"
    )
    .run(run.id, seal(c.workspace_id, files), settings?.version ?? 0)
  await getDatabase()
    .prepare("UPDATE mca_assistant_runs SET expires_at=? WHERE id=?")
    .run(new Date(Date.now() + ACTIVE_BUDGET_MS).toISOString(), run.id)
}
export async function beginExecution(runId: string) {
  return withTransaction(async (db) => {
    const meta = await db
      .prepare<RunMeta>(
        "SELECT * FROM mca_assistant_run_meta WHERE run_id=? FOR UPDATE"
      )
      .get(runId)
    if (!meta) return 175_000
    if (meta.active_since)
      throw new AppError(
        409,
        "run_executing",
        "This request is already executing."
      )
    const remaining = ACTIVE_BUDGET_MS - meta.elapsed_ms
    if (remaining <= 0)
      throw new AppError(
        409,
        "execution_limit",
        "This request reached its five-minute execution limit."
      )
    await db
      .prepare(
        "UPDATE mca_assistant_run_meta SET active_since=? WHERE run_id=?"
      )
      .run(nowIso(), runId)
    await db
      .prepare(
        "UPDATE mca_assistant_runs SET expires_at=? WHERE id=? AND status='running'"
      )
      .run(new Date(Date.now() + remaining).toISOString(), runId)
    return remaining
  })
}
export async function endExecution(runId: string) {
  await getDatabase()
    .prepare(
      "UPDATE mca_assistant_run_meta SET elapsed_ms=elapsed_ms+LEAST(300000,GREATEST(0,EXTRACT(EPOCH FROM (CURRENT_TIMESTAMP-active_since::timestamptz))*1000))::integer,active_since=NULL WHERE run_id=? AND active_since IS NOT NULL"
    )
    .run(runId)
}
export async function consumeHostedBudget(
  runId: string,
  kind: "search" | "code",
  count = 1
) {
  const column = kind === "search" ? "search_calls" : "code_calls",
    limit = kind === "search" ? 4 : 8
  const updated = await getDatabase()
    .prepare(
      `UPDATE mca_assistant_run_meta SET ${column}=${column}+? WHERE run_id=? AND ${column}+?<=? RETURNING run_id`
    )
    .get(count, runId, count, limit)
  if (!updated)
    throw new AppError(
      409,
      "hosted_tool_limit",
      `This request reached its ${kind === "search" ? "research" : "file execution"} limit.`
    )
}
export type StoredEvent =
  | { type: "delta"; text: string }
  | { type: "activity"; activity: Activity }
  | { type: "file"; file: AssistantFile }
export async function saveEvent(
  c: Conversation,
  runId: string,
  event: StoredEvent
) {
  return withTransaction(async (db) => {
    await db
      .prepare(
        "SELECT id FROM mca_assistant_conversations WHERE id=? FOR UPDATE"
      )
      .get(c.id)
    await assertNotDeleted(c)
    const r = await db
      .prepare<{
        event_sequence: number
      }>(
        "UPDATE mca_assistant_run_meta SET event_sequence=event_sequence+1 WHERE run_id=? AND event_sequence<4000 RETURNING event_sequence"
      )
      .get(runId)
    if (!r)
      throw new AppError(
        409,
        "event_limit",
        "This request reached its output limit."
      )
    const sequence = r.event_sequence
    const payload =
      event.type === "activity"
        ? { ...event, activity: { ...event.activity, sequence } }
        : event
    await db
      .prepare(
        "INSERT INTO mca_assistant_events(id,run_id,sequence,payload_cipher,created_at) VALUES (?,?,?,?,?)"
      )
      .run(newId(), runId, sequence, seal(c.workspace_id, payload), nowIso())
    return { ...payload, runId, sequence }
  })
}
export async function savedEvents(c: Conversation, runId: string, after = 0) {
  const run = await getRun(runId)
  if (run.conversation_id !== c.id)
    throw new AppError(404, "run_not_found", "This task is unavailable.")
  const rows = await getDatabase()
    .prepare<{
      sequence: number
      payload_cipher: string
    }>(
      "SELECT sequence,payload_cipher FROM mca_assistant_events WHERE run_id=? AND sequence>? ORDER BY sequence LIMIT 500"
    )
    .all(runId, after)
  return rows.map((r) => ({
    ...unseal<StoredEvent>(c.workspace_id, r.payload_cipher),
    runId,
    sequence: r.sequence
  }))
}
export async function assertNotDeleted(c: Conversation) {
  if (
    await getDatabase()
      .prepare(
        "SELECT 1 FROM mca_assistant_conversation_meta WHERE conversation_id=? AND deleted_at IS NOT NULL"
      )
      .get(c.id)
  )
    throw new AppError(
      404,
      "conversation_not_found",
      "This conversation is unavailable."
    )
}
export async function titleFor(c: Conversation) {
  const row = await getDatabase()
    .prepare<{
      title_cipher: string | null
    }>(
      "SELECT title_cipher FROM mca_assistant_conversation_meta WHERE conversation_id=?"
    )
    .get(c.id)
  if (row?.title_cipher) return unseal<string>(c.workspace_id, row.title_cipher)
  const first = await getDatabase()
    .prepare<{
      content_cipher: string
    }>(
      "SELECT content_cipher FROM mca_assistant_messages WHERE conversation_id=? AND role='user' ORDER BY sequence LIMIT 1"
    )
    .get(c.id)
  return first
    ? unseal<string>(c.workspace_id, first.content_cipher)
        .replace(/\s+/g, " ")
        .slice(0, 65)
    : "New conversation"
}
export async function renameConversation(c: Conversation, title: string) {
  await getDatabase()
    .prepare(
      "INSERT INTO mca_assistant_conversation_meta(conversation_id,title_cipher) VALUES (?,?) ON CONFLICT(conversation_id) DO UPDATE SET title_cipher=excluded.title_cipher"
    )
    .run(c.id, seal(c.workspace_id, title))
}
export async function deleteConversation(c: Conversation) {
  await cancelConversation(c)
  await withTransaction(async (db) => {
    await db
      .prepare(
        "SELECT id FROM mca_assistant_conversations WHERE id=? FOR UPDATE"
      )
      .get(c.id)
    await db
      .prepare(
        "INSERT INTO mca_assistant_conversation_meta(conversation_id,deleted_at) VALUES (?,?) ON CONFLICT(conversation_id) DO UPDATE SET deleted_at=excluded.deleted_at,title_cipher=NULL,summary_cipher=NULL"
      )
      .run(c.id, nowIso())
    await db
      .prepare("DELETE FROM mca_assistant_messages WHERE conversation_id=?")
      .run(c.id)
    await db
      .prepare(
        "DELETE FROM mca_assistant_events WHERE run_id IN (SELECT id FROM mca_assistant_runs WHERE conversation_id=?)"
      )
      .run(c.id)
    await db
      .prepare(
        "UPDATE mca_assistant_runs SET state_cipher=NULL WHERE conversation_id=?"
      )
      .run(c.id)
    await db
      .prepare(
        "UPDATE mca_assistant_approvals SET payload_cipher=?,preview_cipher=?,result_cipher=NULL WHERE run_id IN (SELECT id FROM mca_assistant_runs WHERE conversation_id=?)"
      )
      .run(
        seal(c.workspace_id, {}),
        seal(c.workspace_id, { title: "Deleted conversation", details: [] }),
        c.id
      )
    await db
      .prepare(
        "UPDATE mca_assistant_run_meta SET attachments_cipher=NULL WHERE run_id IN (SELECT id FROM mca_assistant_runs WHERE conversation_id=?)"
      )
      .run(c.id)
    await db
      .prepare(
        "UPDATE mca_assistant_executions SET result_cipher=NULL WHERE run_id IN (SELECT id FROM mca_assistant_runs WHERE conversation_id=?)"
      )
      .run(c.id)
    await db
      .prepare(
        "UPDATE mca_assistant_files SET expires_at=? WHERE conversation_id=?"
      )
      .run(nowIso(), c.id)
    await db
      .prepare(
        "DELETE FROM mca_assistant_questions WHERE run_id IN (SELECT id FROM mca_assistant_runs WHERE conversation_id=?)"
      )
      .run(c.id)
    // Tombstones prevent deleted learned preferences from resurfacing through old sources.
    await db
      .prepare(
        "UPDATE mca_assistant_memories SET content_cipher=NULL,deleted_at=? WHERE source_conversation_id=?"
      )
      .run(nowIso(), c.id)
    await db
      .prepare(
        "UPDATE mca_assistant_memory_settings SET version=version+1 WHERE workspace_id=? AND user_id=?"
      )
      .run(c.workspace_id, c.user_id)
    // Release the legacy one-conversation-per-deal key; the embedded entry opens a fresh chat.
    await db
      .prepare("UPDATE mca_assistant_conversations SET deal_id=NULL WHERE id=?")
      .run(c.id)
  })
}
export async function saveParts(
  c: Conversation,
  messageId: string,
  parts: MessageParts
) {
  if (parts.runId)
    parts.eventCursor =
      (
        await getDatabase()
          .prepare<{
            event_sequence: number
          }>("SELECT event_sequence FROM mca_assistant_run_meta WHERE run_id=?")
          .get(parts.runId)
      )?.event_sequence ?? 0
  await getDatabase()
    .prepare(
      "INSERT INTO mca_assistant_message_parts(message_id,run_id,payload_cipher) VALUES (?,?,?) ON CONFLICT(message_id) DO UPDATE SET payload_cipher=excluded.payload_cipher"
    )
    .run(messageId, parts.runId ?? null, seal(c.workspace_id, parts))
}
export async function refreshPartFiles(
  c: Conversation,
  parts: Record<string, MessageParts>
) {
  const ids = [
    ...new Set(
      Object.values(parts).flatMap((p) => p.files?.map((f) => f.id) ?? [])
    )
  ]
  if (!ids.length) return
  const { fileView } = await import("./files")
  const rows = await getDatabase()
    .prepare<
      import("./files").FileRecord
    >("SELECT * FROM mca_assistant_files WHERE id=ANY(?::text[]) AND workspace_id=? AND user_id=?")
    .all(ids, c.workspace_id, c.user_id)
  const files = new Map(rows.map((row) => [row.id, fileView(row)]))
  for (const p of Object.values(parts))
    p.files = p.files?.map((f) => files.get(f.id) ?? { ...f, state: "expired" })
}
export async function experienceView(c: Conversation): Promise<ExperienceView> {
  const db = getDatabase()
  const rows = await db
    .prepare<{
      payload_cipher: string
      run_id: string
      sequence: number
    }>(
      "SELECT e.payload_cipher,e.run_id,e.sequence FROM mca_assistant_events e JOIN mca_assistant_runs r ON r.id=e.run_id WHERE r.conversation_id=? ORDER BY r.created_at DESC,e.sequence DESC LIMIT 2000"
    )
    .all(c.id)
  const activity = new Map<string, Activity>()
  for (const r of rows) {
    const e = unseal<StoredEvent>(c.workspace_id, r.payload_cipher)
    if (
      e.type === "activity" &&
      (!activity.has(e.activity.id) ||
        activity.get(e.activity.id)!.sequence < e.activity.sequence)
    )
      activity.set(e.activity.id, e.activity)
  }
  const partsRows = await db
    .prepare<{
      message_id: string
      payload_cipher: string
    }>(
      "SELECT p.* FROM mca_assistant_message_parts p JOIN mca_assistant_messages m ON m.id=p.message_id WHERE m.conversation_id=? ORDER BY m.sequence DESC LIMIT 100"
    )
    .all(c.id)
  const q = await db
    .prepare<{
      id: string
      questions_cipher: string
      status: string
    }>(
      "SELECT q.* FROM mca_assistant_questions q JOIN mca_assistant_runs r ON r.id=q.run_id WHERE r.conversation_id=? AND r.status='awaiting_input' AND q.status='pending' ORDER BY q.created_at LIMIT 1"
    )
    .get(c.id)
  const { listFiles } = await import("./files")
  const files = await listFiles(c)
  const parts: Record<string, MessageParts> = {}
  for (const row of partsRows) {
    const p = unseal<MessageParts>(c.workspace_id, row.payload_cipher)
    parts[row.message_id] = p
  }
  await refreshPartFiles(c, parts)
  const latest = await db
    .prepare<{
      id: string
      status: string
    }>(
      "SELECT id,status FROM mca_assistant_runs WHERE conversation_id=? ORDER BY created_at DESC,id DESC LIMIT 1"
    )
    .get(c.id)
  const cursor = Math.max(
    0,
    ...Object.values(parts)
      .filter((p) => p.runId === latest?.id)
      .map((p) => p.eventCursor ?? 0)
  )
  const partial =
    latest && ["running", "failed", "cancelled"].includes(latest.status)
      ? rows
          .filter((r) => r.run_id === latest.id && r.sequence > cursor)
          .sort((a, b) => a.sequence - b.sequence)
          .map((r) => {
            const e = unseal<StoredEvent>(c.workspace_id, r.payload_cipher)
            return e.type === "delta" ? e.text : ""
          })
          .join("")
      : ""
  return {
    title: await titleFor(c),
    activities: [...activity.values()]
      .map((a) =>
        a.runId === latest?.id &&
        latest.status !== "running" &&
        a.status === "running"
          ? { ...a, status: "cancelled" as const }
          : a
      )
      .sort(
        (a, b) =>
          a.startedAt.localeCompare(b.startedAt) || a.sequence - b.sequence
      ),
    question: q
      ? {
          id: q.id,
          status: q.status,
          questions: unseal(c.workspace_id, q.questions_cipher)
        }
      : null,
    files,
    parts,
    partial
  }
}
export async function saveQuestion(
  c: Conversation,
  runId: string,
  callId: string,
  questions: unknown
) {
  const parsed = questionsSchema.parse(questions)
  if (new Set(parsed.map((q) => q.id)).size !== parsed.length)
    throw new AppError(
      422,
      "question_invalid",
      "Question identifiers must be unique."
    )
  await getDatabase()
    .prepare(
      "INSERT INTO mca_assistant_questions(id,run_id,call_id,questions_cipher,created_at) VALUES (?,?,?,?,?) ON CONFLICT(run_id,call_id) DO NOTHING"
    )
    .run(newId(), runId, callId, seal(c.workspace_id, parsed), nowIso())
}
export async function answerQuestion(
  c: Conversation,
  id: string,
  requestId: string,
  answers: Record<string, string>
): Promise<Run> {
  return withTransaction(async (db) => {
    const q = await db
      .prepare<{
        run_id: string
        questions_cipher: string
        status: string
      }>(
        "SELECT q.* FROM mca_assistant_questions q JOIN mca_assistant_runs r ON r.id=q.run_id WHERE q.id=? AND r.conversation_id=? FOR UPDATE OF r,q"
      )
      .get(id, c.id)
    const r = q ? await getRun(q.run_id) : undefined
    if (
      !q ||
      q.status !== "pending" ||
      r?.status !== "awaiting_input" ||
      r.expires_at < nowIso()
    )
      throw new AppError(
        409,
        "question_expired",
        "This question is no longer waiting for an answer."
      )
    const questions = unseal<ReturnType<typeof questionsSchema.parse>>(
      c.workspace_id,
      q.questions_cipher
    )
    if (
      Object.keys(answers).length !== questions.length ||
      questions.some(
        (x) => !answers[x.id]?.trim() || answers[x.id].length > 4000
      )
    )
      throw new AppError(
        422,
        "answer_invalid",
        "Answer each question before continuing."
      )
    await db
      .prepare(
        "UPDATE mca_assistant_questions SET status='answered',answer_cipher=?,answer_request_id=? WHERE id=?"
      )
      .run(seal(c.workspace_id, answers), requestId, id)
    await db
      .prepare(
        "UPDATE mca_assistant_runs SET status='running',expires_at=? WHERE id=?"
      )
      .run(new Date(Date.now() + ACTIVE_BUDGET_MS).toISOString(), r.id)
    const message = await addMessage(
      c,
      "user",
      questions.map((x) => `${x.question}\n${answers[x.id]}`).join("\n\n")
    )
    await saveParts(c, message, { runId: r.id })
    return { ...r, status: "running" }
  })
}
export async function questionAnswer(
  c: Conversation,
  runId: string,
  questionId?: string
) {
  const q = await getDatabase()
    .prepare<{ call_id: string; answer_cipher: string }>(
      "SELECT call_id,answer_cipher FROM mca_assistant_questions WHERE run_id=? AND status='answered' AND (?::text IS NULL OR id=?) ORDER BY created_at DESC LIMIT 1"
    )
    .get(runId, questionId ?? null, questionId ?? null)
  if (!q)
    throw new AppError(
      409,
      "answer_missing",
      "The saved answer is unavailable."
    )
  return {
    callId: q.call_id,
    answers: unseal<Record<string, string>>(c.workspace_id, q.answer_cipher)
  }
}
export async function recallConversations(
  actor: DealActor,
  query: string,
  currentId: string
) {
  const rows = await getDatabase()
    .prepare<Conversation>(
      "SELECT c.* FROM mca_assistant_conversations c LEFT JOIN mca_assistant_conversation_meta m ON m.conversation_id=c.id WHERE c.workspace_id=? AND c.user_id=? AND c.id<>? AND m.deleted_at IS NULL ORDER BY c.created_at DESC LIMIT 50"
    )
    .all(actor.workspaceId, actor.userId, currentId)
  const results = []
  for (const c of rows) {
    try {
      await assertConversationAccess(actor, c)
    } catch (e) {
      if (e instanceof AppError && [403, 404].includes(e.status)) continue
      throw e
    }
    const messages = await getDatabase()
      .prepare<{
        role: string
        content_cipher: string
      }>(
        "SELECT role,content_cipher FROM mca_assistant_messages WHERE conversation_id=? ORDER BY sequence DESC LIMIT 20"
      )
      .all(c.id)
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean)
    const relevant = messages
      .map(
        (m) => `${m.role}: ${unseal<string>(c.workspace_id, m.content_cipher)}`
      )
      .filter(
        (t) =>
          terms.length === 0 ||
          terms.some((term) => t.toLowerCase().includes(term))
      )
    if (relevant.length) {
      const refs = await getDatabase()
        .prepare<{
          deal_id: string
        }>(
          "SELECT deal_id FROM mca_assistant_references WHERE conversation_id=?"
        )
        .all(c.id)
      const current = {
        id: currentId,
        workspace_id: c.workspace_id,
        user_id: c.user_id,
        deal_id: null
      }
      for (const id of [c.deal_id, ...refs.map((r) => r.deal_id)].filter(
        (id): id is string => Boolean(id)
      ))
        await trackDeal(current, id)
      results.push({
        id: c.id,
        title: await titleFor(c),
        excerpt: relevant.slice(0, 3).join("\n").slice(0, 3500),
        link: `/assistant?conversation=${c.id}`
      })
    }
    if (results.length === 5) break
  }
  return results
}
export async function assertProvenance(actor: DealActor, ids: string[]) {
  for (const id of ids) await getDeal(actor, id)
}
