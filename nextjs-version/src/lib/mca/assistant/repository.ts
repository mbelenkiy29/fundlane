import { experienceEnabled } from "./experience-contracts"
import "server-only"
import { decryptSensitive, encryptSensitive } from "../crypto"
import { getDatabase, newId, nowIso, withTransaction } from "../db"
import {
  reserveCredit,
  resolveCreditAllowance,
  settleCredit,
  releaseExpiredReservations
} from "./credits"
import { getDeal, listDeals } from "../deals/service"
import { AppError } from "../errors"
import type { DealActor } from "../deals/schema"
import type {
  ActionKind,
  ApprovalPreview,
  ConversationView,
  RunStatus
} from "./contracts"

export interface Conversation {
  id: string
  workspace_id: string
  user_id: string
  deal_id: string | null
}
export interface Run {
  id: string
  conversation_id: string
  status: RunStatus
  state_cipher: string | null
  error: string | null
  expires_at: string
  selected_deal_id?: string | null
  mutation_deal_id?: string | null
  model_turns?: number
}
export interface Approval {
  id: string
  run_id: string
  kind: ActionKind
  status: string
  payload_cipher: string
  preview_cipher: string
  fingerprint: string
  call_id: string | null
  result_cipher: string | null
}
export const seal = (workspaceId: string, data: unknown) =>
  encryptSensitive(JSON.stringify(data), workspaceId)
export const unseal = <T>(workspaceId: string, cipher: string): T =>
  JSON.parse(decryptSensitive(cipher, workspaceId)) as T

export async function ownedConversation(
  actor: DealActor,
  id: string
): Promise<Conversation> {
  const row = await getDatabase()
    .prepare<Conversation>(
      "SELECT * FROM mca_assistant_conversations WHERE id=? AND workspace_id=? AND user_id=?"
    )
    .get(id, actor.workspaceId, actor.userId)
  if (!row)
    throw new AppError(
      404,
      "conversation_not_found",
      "This conversation is unavailable."
    )
  if (experienceEnabled())
    await (await import("./experience")).assertNotDeleted(row)
  await assertConversationAccess(actor, row)
  return row
}
export async function openConversation(
  actor: DealActor,
  dealId: string | null = null
): Promise<Conversation> {
  return (await getDatabase()
    .prepare<Conversation>(
      `INSERT INTO mca_assistant_conversations (id,workspace_id,user_id,deal_id,created_at)
    VALUES (?,?,?,?,?) ON CONFLICT(workspace_id,user_id,deal_id) DO UPDATE SET deal_id=excluded.deal_id RETURNING *`
    )
    .get(newId(), actor.workspaceId, actor.userId, dealId, nowIso()))!
}
export async function addMessage(
  c: Conversation,
  role: "user" | "assistant",
  text: string
) {
  return withTransaction(async (db) => {
    await db
      .prepare(
        "SELECT id FROM mca_assistant_conversations WHERE id=? FOR UPDATE"
      )
      .get(c.id)
    if (experienceEnabled())
      await (await import("./experience")).assertNotDeleted(c)
    const id = newId()
    await db
      .prepare(
        "INSERT INTO mca_assistant_messages (id,conversation_id,role,content_cipher,created_at) VALUES (?,?,?,?,?)"
      )
      .run(id, c.id, role, seal(c.workspace_id, text), nowIso())
    return id
  })
}
export async function expireRuns(conversationId: string) {
  await getDatabase()
    .prepare(
      "UPDATE mca_assistant_runs SET status='failed',error='This session expired. Review recorded results before starting again.' WHERE conversation_id=? AND status IN ('running','awaiting_approval','awaiting_input') AND expires_at<?"
    )
    .run(conversationId, nowIso())
}
export async function createRun(
  c: Conversation,
  requestId: string,
  message: string,
  attachmentIds: string[] = []
): Promise<Run> {
  const allowance = await resolveCreditAllowance(c.workspace_id)
  await releaseExpiredReservations()
  return withTransaction(async (db) => {
    await db
      .prepare(
        "SELECT id FROM mca_assistant_conversations WHERE id=? FOR UPDATE"
      )
      .get(c.id)
    await expireRuns(c.id)
    if (
      await db
        .prepare(
          "SELECT id FROM mca_assistant_runs WHERE conversation_id=? AND request_id=?"
        )
        .get(c.id, requestId)
    )
      throw new AppError(
        409,
        "request_already_recorded",
        "This request is already recorded. Refresh to see its result."
      )
    if (
      await db
        .prepare(
          "SELECT id FROM mca_assistant_runs WHERE conversation_id=? AND status IN ('running','awaiting_approval','awaiting_input')"
        )
        .get(c.id)
    )
      throw new AppError(
        409,
        "run_active",
        "Finish or cancel the current task first."
      )
    const prior = await db
      .prepare<{
        selected_deal_id: string | null
      }>("SELECT selected_deal_id FROM mca_assistant_runs WHERE conversation_id=? ORDER BY created_at DESC,id DESC LIMIT 1")
      .get(c.id)
    const run = (await db
      .prepare<Run>(
        "INSERT INTO mca_assistant_runs (id,conversation_id,request_id,status,created_at,expires_at,selected_deal_id) VALUES (?,?,?,'running',?,?,?) RETURNING *"
      )
      .get(
        newId(),
        c.id,
        requestId,
        nowIso(),
        new Date(Date.now() + 180_000).toISOString(),
        c.deal_id ?? prior?.selected_deal_id ?? null
      ))!
    await reserveCredit(db, c, run.id, allowance)
    const messageId = await addMessage(c, "user", message)
    if (experienceEnabled()) {
      const e = await import("./experience")
      await e.initializeRun(c, run, attachmentIds)
      const files = attachmentIds.length
        ? await db
            .prepare<
              import("./files").FileRecord
            >(`SELECT * FROM mca_assistant_files WHERE id IN (${attachmentIds.map(() => "?").join(",")}) AND workspace_id=? AND user_id=?`)
            .all(...attachmentIds, c.workspace_id, c.user_id)
        : []
      const { fileView } = await import("./files")
      await e.saveParts(c, messageId, {
        runId: run.id,
        files: files.map(fileView)
      })
    }
    return run
  })
}
export async function getRun(id: string): Promise<Run> {
  const row = await getDatabase()
    .prepare<Run>("SELECT * FROM mca_assistant_runs WHERE id=?")
    .get(id)
  if (!row)
    throw new AppError(404, "run_not_found", "This task is unavailable.")
  return row
}
export async function assertRunning(id: string) {
  const run = await getRun(id)
  if (run.status !== "running" || run.expires_at < nowIso())
    throw new AppError(409, "run_stopped", "The assistant task has stopped.")
}
export async function finishRun(
  c: Conversation,
  runId: string,
  status: RunStatus,
  state?: string,
  error?: string
) {
  await getDatabase()
    .prepare(
      `UPDATE mca_assistant_runs SET status=?,state_cipher=?,error=?,expires_at=?
    WHERE id=? AND conversation_id=? AND status='running'`
    )
    .run(
      status,
      state ? seal(c.workspace_id, state) : null,
      error ?? null,
      new Date(Date.now() + 86400_000).toISOString(),
      runId,
      c.id
    )
}
export async function cancelConversation(c: Conversation) {
  await withTransaction(async (db) => {
    const activeRuns = await db
      .prepare<{
        id: string
      }>("SELECT id FROM mca_assistant_runs WHERE conversation_id=? AND status IN ('running','awaiting_approval','awaiting_input') FOR UPDATE")
      .all(c.id)
    for (const r of activeRuns) await settleCredit(r.id, "release")
    await db
      .prepare(
        "UPDATE mca_assistant_runs SET status='cancelled',state_cipher=NULL WHERE conversation_id=? AND status IN ('running','awaiting_approval','awaiting_input')"
      )
      .run(c.id)
    await db
      .prepare(
        "UPDATE mca_assistant_approvals SET status='cancelled' WHERE run_id IN (SELECT id FROM mca_assistant_runs WHERE conversation_id=? AND status='cancelled') AND status IN ('prepared','pending','approved')"
      )
      .run(c.id)
  })
}
export async function approvalForRun(
  runId: string,
  approvalId: string
): Promise<Approval> {
  const a = await getDatabase()
    .prepare<Approval>(
      "SELECT * FROM mca_assistant_approvals WHERE id=? AND run_id=?"
    )
    .get(approvalId, runId)
  if (!a)
    throw new AppError(
      404,
      "approval_not_found",
      "This approval is unavailable."
    )
  return a
}
export async function saveApproval(
  c: Conversation,
  runId: string,
  kind: ActionKind,
  payload: unknown,
  preview: ApprovalPreview,
  fingerprint: string
) {
  const id = newId()
  await getDatabase()
    .prepare(
      "INSERT INTO mca_assistant_approvals (id,run_id,kind,status,payload_cipher,preview_cipher,fingerprint,created_at) VALUES (?,?,?,'prepared',?,?,?,?)"
    )
    .run(
      id,
      runId,
      kind,
      seal(c.workspace_id, payload),
      seal(c.workspace_id, preview),
      fingerprint,
      nowIso()
    )
  return id
}
export async function decideApproval(
  c: Conversation,
  approvalId: string,
  approve: boolean
): Promise<Run> {
  return withTransaction(async (db) => {
    const run = await db
      .prepare<Run>(
        `SELECT r.* FROM mca_assistant_runs r JOIN mca_assistant_approvals a ON a.run_id=r.id
      WHERE a.id=? AND r.conversation_id=? FOR UPDATE OF r`
      )
      .get(approvalId, c.id)
    if (!run || run.status !== "awaiting_approval" || run.expires_at < nowIso())
      throw new AppError(
        409,
        "approval_expired",
        "This approval is no longer active."
      )
    const updated = await db
      .prepare(
        "UPDATE mca_assistant_approvals SET status=? WHERE id=? AND run_id=? AND status='pending'"
      )
      .run(approve ? "approved" : "rejected", approvalId, run.id)
    if (!updated.changes)
      throw new AppError(
        409,
        "approval_decided",
        "This approval has already been decided."
      )
    await db
      .prepare(
        "UPDATE mca_assistant_runs SET status='running',expires_at=? WHERE id=?"
      )
      .run(new Date(Date.now() + 180_000).toISOString(), run.id)
    return { ...run, status: "running" }
  })
}
export async function conversationView(
  c: Conversation
): Promise<ConversationView> {
  await expireRuns(c.id)
  const db = getDatabase()
  const messages = await db
    .prepare<{
      id: string
      role: "user" | "assistant"
      content_cipher: string
      sequence: number
    }>(
      "SELECT * FROM (SELECT * FROM mca_assistant_messages WHERE conversation_id=? ORDER BY sequence DESC LIMIT 100) recent ORDER BY sequence"
    )
    .all(c.id)
  const run = await db
    .prepare<Run>(
      "SELECT * FROM mca_assistant_runs WHERE conversation_id=? ORDER BY created_at DESC,id DESC LIMIT 1"
    )
    .get(c.id)
  const approvals = run
    ? await db
        .prepare<Approval>(
          "SELECT * FROM mca_assistant_approvals WHERE run_id=? AND status<>'prepared' ORDER BY created_at,id"
        )
        .all(run.id)
    : []
  return {
    ...(experienceEnabled()
      ? { experience: await (await import("./experience")).experienceView(c) }
      : {}),
    id: c.id,
    dealId: run?.selected_deal_id ?? c.deal_id,
    messages: messages.map((m) => ({
      id: m.id,
      role: m.role,
      text: unseal<string>(c.workspace_id, m.content_cipher)
    })),
    olderCursor: messages.length === 100 ? Number(messages[0].sequence) : null,
    run: run ? { id: run.id, status: run.status, error: run.error } : null,
    approvals: approvals.map((a) => ({
      id: a.id,
      status:
        run?.status === "cancelled" && a.status === "pending"
          ? "cancelled"
          : a.status,
      preview: unseal<ApprovalPreview>(c.workspace_id, a.preview_cipher),
      ...(a.result_cipher
        ? { result: unseal(c.workspace_id, a.result_cipher) }
        : {})
    }))
  }
}

export async function trackDeal(c: Conversation, dealId: string) {
  await getDatabase()
    .prepare(
      "INSERT INTO mca_assistant_references (id,conversation_id,deal_id) VALUES (?,?,?) ON CONFLICT(conversation_id,deal_id) DO NOTHING"
    )
    .run(newId(), c.id, dealId)
}
export async function assertConversationAccess(
  actor: DealActor,
  c: Conversation
) {
  if (actor.workspaceId !== c.workspace_id || actor.userId !== c.user_id)
    throw new AppError(
      404,
      "conversation_not_found",
      "This conversation is unavailable."
    )
  const refs = await getDatabase()
    .prepare<{
      deal_id: string
    }>("SELECT deal_id FROM mca_assistant_references WHERE conversation_id=?")
    .all(c.id)
  const ids = new Set(
    [c.deal_id, ...refs.map((r) => r.deal_id)].filter((id): id is string =>
      Boolean(id)
    )
  )
  if (ids.size > 5) {
    const visible = new Set((await listDeals(actor, {})).deals.map((d) => d.id))
    if ([...ids].some((id) => !visible.has(id)))
      throw new AppError(
        403,
        "referenced_deal_unavailable",
        "This conversation references a deal you can no longer access."
      )
  } else for (const id of ids) await getDeal(actor, id)
}
export async function listAssistantConversations(
  actor: DealActor,
  options: { before?: string; query?: string } = {}
) {
  const rows = await getDatabase()
    .prepare<Conversation & { created_at: string }>(
      "SELECT * FROM mca_assistant_conversations WHERE workspace_id=? AND user_id=? AND (?::text IS NULL OR created_at<?) ORDER BY created_at DESC,id DESC LIMIT 50"
    )
    .all(
      actor.workspaceId,
      actor.userId,
      options.before ?? null,
      options.before ?? null
    )
  const accessible = []
  for (const c of rows) {
    try {
      if (experienceEnabled())
        await (await import("./experience")).assertNotDeleted(c)
      await assertConversationAccess(actor, c)
      const title = experienceEnabled()
        ? await (await import("./experience")).titleFor(c)
        : undefined
      let matches =
        !options.query ||
        title?.toLowerCase().includes(options.query.toLowerCase())
      if (!matches && options.query) {
        const messages = await getDatabase()
          .prepare<{
            content_cipher: string
          }>("SELECT content_cipher FROM mca_assistant_messages WHERE conversation_id=? ORDER BY sequence DESC LIMIT 100")
          .all(c.id)
        matches = messages.some((m) =>
          unseal<string>(c.workspace_id, m.content_cipher)
            .toLowerCase()
            .includes(options.query!.toLowerCase())
        )
      }
      if (matches)
        accessible.push({
          id: c.id,
          dealId: c.deal_id,
          createdAt: c.created_at,
          ...(title ? { title } : {})
        })
    } catch (e) {
      if (!(e instanceof AppError) || ![403, 404].includes(e.status)) throw e
    }
  }
  return {
    conversations: accessible,
    nextBefore: rows.length === 50 ? rows.at(-1)!.created_at : null
  }
}
