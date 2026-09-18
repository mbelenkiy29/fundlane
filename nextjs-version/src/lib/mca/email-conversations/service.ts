import "server-only"
import { createHash } from "node:crypto"
import {
  getDatabase,
  newId,
  nowIso,
  recordAuditEvent,
  withTransaction,
} from "../db"
import { encryptSensitive, decryptSensitive } from "../crypto"
import { actorForDeals, getDealForDocument } from "../deals/service"
import type { DealActor } from "../deals/schema"
import type { Role } from "../types"
import { AppError } from "../errors"
import { getWorkspaceSettings } from "../workspaces"
import {
  findSenderById,
  listSendersByWorkspace,
  senderConversationReady,
  toPublicSender,
  type StoredEmailSender,
} from "../senders/repository"
import {
  emailSendSchema,
  emailReplySchema,
  type EmailSendInput,
  type EmailState,
  type ConversationSummary,
  type ConversationPage,
  type MessagePage,
} from "./contracts"

export interface ConversationRow {
  id: string
  workspace_id: string
  deal_id: string
  sender_id: string
  recipient_cipher: string
  subject_cipher: string
  provider_thread_id: string | null
  created_at: string
  updated_at: string
  next_sync_at: string
  last_synced_at: string | null
  sync_error: string | null
}
export interface MessageRow {
  id: string
  workspace_id: string
  conversation_id: string
  sequence: string
  direction: "inbound" | "outbound"
  body_cipher: string
  author_cipher: string
  actor_membership_id: string | null
  request_key: string | null
  payload_hash: string | null
  provider_message_id: string | null
  internet_message_id: string
  reply_to_message_id: string | null
  state: EmailState
  attempts: number
  next_attempt_at: string
  error: string | null
  created_at: string
  updated_at: string
}
const admin = (actor: DealActor) =>
  actor.role === "admin" || actor.role === "super_admin"
export function canUseConversationSender(
  actor: DealActor,
  sender: StoredEmailSender
): boolean {
  return (
    sender.workspaceId === actor.workspaceId &&
    Boolean(
      actor.membershipId &&
      (admin(actor) ||
        sender.ownerMembershipId === actor.membershipId ||
        sender.memberIds.includes(actor.membershipId))
    )
  )
}
export async function liveEmailActor(
  workspaceId: string,
  membershipId: string
): Promise<DealActor> {
  const row = await getDatabase()
    .prepare<{
      user_id: string
      role: Role
    }>(
      "SELECT user_id,role FROM memberships WHERE id=? AND workspace_id=? AND status='active'"
    )
    .get(membershipId, workspaceId)
  if (!row)
    throw new AppError(
      403,
      "email_member_inactive",
      "An active company membership is required."
    )
  const settings = await getWorkspaceSettings(workspaceId)
  if (!settings.pageVisibility.deals)
    throw new AppError(
      403,
      "page_disabled",
      "Messaging is disabled for this company."
    )
  return actorForDeals({
    workspaceId,
    membershipId,
    userId: row.user_id,
    role: row.role,
    authType: "session",
    sessionId: null,
    scopes: [],
  })
}
export async function assertEmailActor(actor: DealActor): Promise<DealActor> {
  if (actor.source !== "user" || !actor.membershipId)
    throw new AppError(
      403,
      "email_session_required",
      "Sign in to use email conversations."
    )
  return liveEmailActor(actor.workspaceId, actor.membershipId)
}
export async function emailSender(
  actor: DealActor,
  id: string,
  ready = false
): Promise<StoredEmailSender> {
  const sender = await findSenderById(actor.workspaceId, id)
  if (
    !sender ||
    !canUseConversationSender(actor, sender) ||
    sender.purpose !== "merchant"
  )
    throw new AppError(
      404,
      "email_sender_unavailable",
      "This email sender is not available to you."
    )
  if (ready && !senderConversationReady(sender))
    throw new AppError(
      409,
      "email_reconnect_required",
      "Connect or reconnect this Google or Microsoft account to enable sending and replies."
    )
  return sender
}
export async function emailContext(inputActor: DealActor, dealId: string) {
  const actor = await assertEmailActor(inputActor),
    deal = await getDealForDocument(actor, dealId)
  const senders = (await listSendersByWorkspace(actor.workspaceId))
    .filter(
      (s) =>
        s.purpose === "merchant" &&
        ["google", "microsoft"].includes(s.provider) &&
        canUseConversationSender(actor, s)
    )
    .map(toPublicSender)
  return { dealId, recipient: deal.contactEmail ?? null, senders }
}
export async function authorizedConversation(
  inputActor: DealActor,
  id: string
) {
  const actor = await assertEmailActor(inputActor)
  const row = await getDatabase()
    .prepare<ConversationRow>(
      "SELECT * FROM mca_email_conversations WHERE workspace_id=? AND id=?"
    )
    .get(actor.workspaceId, id)
  if (!row)
    throw new AppError(
      404,
      "email_conversation_missing",
      "Conversation not found."
    )
  await getDealForDocument(actor, row.deal_id)
  const sender = await emailSender(actor, row.sender_id)
  return { actor, row, sender }
}
async function summary(
  actor: DealActor,
  row: ConversationRow,
  sender: StoredEmailSender
): Promise<ConversationSummary> {
  const unread = await getDatabase()
    .prepare<{
      n: string
    }>(
      `SELECT count(*) n FROM mca_email_messages m WHERE m.conversation_id=? AND m.direction='inbound' AND m.sequence > COALESCE((SELECT last_sequence FROM mca_email_reads WHERE conversation_id=? AND membership_id=?),0)`
    )
    .get(row.id, row.id, actor.membershipId)
  return {
    id: row.id,
    dealId: row.deal_id,
    senderId: sender.id,
    senderAddress: sender.fromAddress,
    recipient: decryptSensitive(row.recipient_cipher, row.workspace_id),
    subject: decryptSensitive(row.subject_cipher, row.workspace_id),
    updatedAt: row.updated_at,
    unread: Number(unread?.n ?? 0),
    lastSyncedAt: row.last_synced_at,
    syncError: row.sync_error,
  }
}
function conversationCursor(row: { id: string; updatedAt: string }) {
  return Buffer.from(JSON.stringify([row.updatedAt, row.id])).toString(
    "base64url"
  )
}
export async function listEmailConversations(
  inputActor: DealActor,
  dealId?: string,
  cursor?: string
): Promise<ConversationPage> {
  const actor = await assertEmailActor(inputActor)
  if (dealId) await getDealForDocument(actor, dealId)
  let boundary: string[] | undefined
  if (cursor) {
    try {
      const value = JSON.parse(Buffer.from(cursor, "base64url").toString())
      if (
        !Array.isArray(value) ||
        value.length !== 2 ||
        !value.every((v) => typeof v === "string") ||
        !Number.isFinite(Date.parse(value[0])) ||
        !/^[a-f0-9-]{36}$/.test(value[1])
      )
        throw new Error()
      boundary = value
    } catch {
      throw new AppError(
        400,
        "email_cursor_invalid",
        "Refresh the conversation list and try again."
      )
    }
  }
  const conversations: ConversationSummary[] = []
  // Scan bounded pages and apply current record permissions before returning any metadata.
  while (true) {
    const rows = await getDatabase()
      .prepare<ConversationRow>(
        `SELECT * FROM mca_email_conversations WHERE workspace_id=? ${dealId ? "AND deal_id=?" : ""} ${boundary ? "AND (updated_at,id) < (?,?)" : ""} ORDER BY updated_at DESC,id DESC LIMIT 50`
      )
      .all(actor.workspaceId, ...(dealId ? [dealId] : []), ...(boundary ?? []))
    for (const row of rows) {
      boundary = [row.updated_at, row.id]
      try {
        await getDealForDocument(actor, row.deal_id)
        const sender = await emailSender(actor, row.sender_id)
        if (conversations.length === 25)
          return {
            conversations,
            nextCursor: conversationCursor(conversations[24]),
          }
        conversations.push(await summary(actor, row, sender))
      } catch (error) {
        if (!(error instanceof AppError && [403, 404].includes(error.status)))
          throw error
      }
    }
    if (rows.length < 50) return { conversations, nextCursor: null }
  }
}
export async function emailMessages(
  actor: DealActor,
  id: string,
  before?: string
): Promise<MessagePage> {
  const context = await authorizedConversation(actor, id),
    db = getDatabase()
  const rows = await db
    .prepare<MessageRow>(
      `SELECT * FROM mca_email_messages WHERE workspace_id=? AND conversation_id=? ${before ? "AND sequence < ?" : ""} ORDER BY sequence DESC LIMIT 51`
    )
    .all(actor.workspaceId, id, ...(before ? [before] : []))
  const nextCursor = rows.length > 50 ? String(rows[49].sequence) : null
  return {
    conversation: await summary(context.actor, context.row, context.sender),
    messages: rows
      .slice(0, 50)
      .reverse()
      .map((m) => ({
        id: m.id,
        sequence: String(m.sequence),
        direction: m.direction,
        body: decryptSensitive(m.body_cipher, actor.workspaceId),
        author: decryptSensitive(m.author_cipher, actor.workspaceId),
        state: m.state,
        error: m.error,
        createdAt: m.created_at,
      })),
    nextCursor,
  }
}
export async function markEmailRead(
  actor: DealActor,
  id: string,
  sequence: string
) {
  await authorizedConversation(actor, id)
  // Only mark the last message actually rendered, so concurrent replies stay unread.
  const message = await getDatabase()
    .prepare(
      "SELECT id FROM mca_email_messages WHERE workspace_id=? AND conversation_id=? AND sequence=?"
    )
    .get(actor.workspaceId, id, sequence)
  if (!message)
    throw new AppError(
      422,
      "email_read_cursor",
      "Message not found in this conversation."
    )
  await getDatabase()
    .prepare(
      `INSERT INTO mca_email_reads(workspace_id,conversation_id,membership_id,last_sequence) VALUES(?,?,?,?) ON CONFLICT(conversation_id,membership_id) DO UPDATE SET last_sequence=GREATEST(mca_email_reads.last_sequence,EXCLUDED.last_sequence)`
    )
    .run(actor.workspaceId, id, actor.membershipId, sequence)
}
export async function queueEmail(
  inputActor: DealActor,
  raw: EmailSendInput | { body: string; idempotencyKey: string },
  conversationId?: string
) {
  const actor = await assertEmailActor(inputActor)
  const context = conversationId
    ? await authorizedConversation(actor, conversationId)
    : undefined
  const input = conversationId
    ? emailReplySchema.parse(raw)
    : emailSendSchema.parse(raw)
  const data = conversationId
    ? {
        ...input,
        dealId: context!.row.deal_id,
        senderId: context!.row.sender_id,
        recipient: decryptSensitive(
          context!.row.recipient_cipher,
          actor.workspaceId
        ),
        subject: decryptSensitive(
          context!.row.subject_cipher,
          actor.workspaceId
        ),
      }
    : (input as EmailSendInput)
  const deal = await getDealForDocument(actor, data.dealId)
  const sender = await emailSender(actor, data.senderId, true)
  if (
    !deal.contactEmail ||
    deal.contactEmail.trim().toLowerCase() !==
      data.recipient.trim().toLowerCase()
  )
    throw new AppError(
      422,
      "email_recipient_changed",
      "Update the contact email on this deal before starting a new conversation."
    )
  const hash = createHash("sha256")
    .update(
      JSON.stringify([
        actor.membershipId,
        conversationId ?? null,
        data.dealId,
        data.senderId,
        data.recipient.toLowerCase(),
        data.subject,
        data.body,
      ])
    )
    .digest("hex")
  return withTransaction(async (db) => {
    await db
      .prepare("SELECT id FROM workspaces WHERE id=? FOR UPDATE")
      .get(actor.workspaceId)
    const existing = await db
      .prepare<MessageRow>(
        "SELECT * FROM mca_email_messages WHERE workspace_id=? AND request_key=?"
      )
      .get(actor.workspaceId, data.idempotencyKey)
    if (existing) {
      if (existing.payload_hash !== hash)
        throw new AppError(
          409,
          "email_idempotency_conflict",
          "This send key belongs to a different message."
        )
      return {
        id: existing.id,
        conversationId: existing.conversation_id,
        state: existing.state,
      }
    }
    if (
      conversationId &&
      (await db
        .prepare(
          "SELECT id FROM mca_email_messages WHERE conversation_id=? AND state IN ('queued','sending','accepted','unknown','blocked') LIMIT 1"
        )
        .get(conversationId))
    )
      throw new AppError(
        409,
        "email_delivery_pending",
        "Wait for the previous message to be confirmed before replying."
      )
    const id = newId(),
      cid = conversationId ?? newId(),
      now = nowIso()
    if (!conversationId)
      await db
        .prepare(
          `INSERT INTO mca_email_conversations(id,workspace_id,deal_id,sender_id,recipient_cipher,subject_cipher,created_at,updated_at,next_sync_at) VALUES(?,?,?,?,?,?,?,?,?)`
        )
        .run(
          cid,
          actor.workspaceId,
          data.dealId,
          sender.id,
          encryptSensitive(data.recipient, actor.workspaceId),
          encryptSensitive(data.subject, actor.workspaceId),
          now,
          now,
          now
        )
    const previous = conversationId
      ? await db
          .prepare<MessageRow>(
            "SELECT * FROM mca_email_messages WHERE conversation_id=? AND state IN ('sent','received') ORDER BY sequence DESC LIMIT 1"
          )
          .get(cid)
      : undefined
    const body = [data.body, sender.signature].filter(Boolean).join("\n\n")
    await db
      .prepare(
        `INSERT INTO mca_email_messages(id,workspace_id,conversation_id,direction,body_cipher,author_cipher,actor_membership_id,request_key,payload_hash,internet_message_id,reply_to_message_id,state,next_attempt_at,created_at,updated_at) VALUES(?,?,?,'outbound',?,?,?,?,?,?,?,'queued',?,?,?)`
      )
      .run(
        id,
        actor.workspaceId,
        cid,
        encryptSensitive(body, actor.workspaceId),
        encryptSensitive(sender.fromAddress, actor.workspaceId),
        actor.membershipId,
        data.idempotencyKey,
        hash,
        `<${id}@fundlane.io>`,
        previous?.internet_message_id ?? null,
        now,
        now,
        now
      )
    await db
      .prepare(
        "UPDATE mca_email_conversations SET updated_at=?,next_sync_at=? WHERE id=?"
      )
      .run(now, now, cid)
    await recordAuditEvent({
      context: actor,
      action: "email.queued",
      resourceType: "email_message",
      resourceId: id,
      metadata: {
        dealId: data.dealId,
        senderId: sender.id,
        conversationId: cid,
      },
      correlationId: actor.correlationId,
    })
    return { id, conversationId: cid, state: "queued" as const }
  })
}

/** Explicit retry is allowed only after a definite rejection, never an ambiguous send. */
export async function retryEmail(inputActor: DealActor, messageId: string) {
  const actor = await assertEmailActor(inputActor)
  const message = await getDatabase()
    .prepare<MessageRow>(
      "SELECT * FROM mca_email_messages WHERE workspace_id=? AND id=?"
    )
    .get(actor.workspaceId, messageId)
  if (!message || message.actor_membership_id !== actor.membershipId)
    throw new AppError(
      404,
      "email_message_missing",
      "This message is not available for retry."
    )
  const { row } = await authorizedConversation(actor, message.conversation_id)
  await emailSender(actor, row.sender_id, true)
  const deal = await getDealForDocument(actor, row.deal_id)
  if (
    deal.contactEmail?.trim().toLowerCase() !==
    decryptSensitive(row.recipient_cipher, actor.workspaceId).toLowerCase()
  )
    throw new AppError(
      409,
      "email_recipient_changed",
      "The saved contact address changed. Start a new conversation."
    )
  return withTransaction(async (db) => {
    await db
      .prepare("SELECT id FROM workspaces WHERE id=? FOR UPDATE")
      .get(actor.workspaceId)
    const pending = await db
      .prepare(
        "SELECT id FROM mca_email_messages WHERE conversation_id=? AND state IN ('queued','sending','accepted','unknown','blocked') LIMIT 1"
      )
      .get(row.id)
    if (pending)
      throw new AppError(
        409,
        "email_delivery_pending",
        "Resolve the pending or uncertain send before retrying."
      )
    const changed = await db
      .prepare(
        "UPDATE mca_email_messages SET state='queued',error=NULL,next_attempt_at=?,updated_at=? WHERE id=? AND state='failed'"
      )
      .run(nowIso(), nowIso(), message.id)
    if (!changed.changes)
      throw new AppError(
        409,
        "email_retry_not_allowed",
        "Only a definitively failed email can be retried."
      )
    await recordAuditEvent({
      context: actor,
      action: "email.retry_queued",
      resourceType: "email_message",
      resourceId: message.id,
      metadata: { conversationId: row.id },
    })
    return { id: message.id, conversationId: row.id, state: "queued" as const }
  })
}
