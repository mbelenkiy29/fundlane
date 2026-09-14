import { recordOperationalError } from "../operations/telemetry"
import "server-only"
import {
  getDatabase,
  newId,
  nowIso,
  withTransaction,
  type DbExecutor,
} from "../db"
import { decryptSensitive, encryptSensitive } from "../crypto"
import { AppError } from "../errors"
import { getDealForDocument } from "../deals/service"
import { findSenderById, type StoredEmailSender } from "../senders/repository"
import { Mailbox, EmailProviderError, type RemoteEmail } from "./providers"
import {
  liveEmailActor,
  emailSender,
  type ConversationRow,
  type MessageRow,
} from "./service"

const later = (seconds: number) =>
  new Date(Date.now() + seconds * 1000).toISOString()
const leaseSeconds = 120
const db = () => getDatabase()
async function lease(senderId: string, workspaceId: string) {
  const token = newId()
  const row = await db()
    .prepare<{
      token: string
    }>(
      `INSERT INTO mca_email_worker_leases(sender_id,workspace_id,token,expires_at) VALUES(?,?,?,?) ON CONFLICT(sender_id) DO UPDATE SET token=EXCLUDED.token,expires_at=EXCLUDED.expires_at WHERE mca_email_worker_leases.expires_at < ? RETURNING token`
    )
    .get(senderId, workspaceId, token, later(leaseSeconds), nowIso())
  return row?.token === token ? token : undefined
}
async function renew(senderId: string, token: string) {
  const updated = await db()
    .prepare(
      "UPDATE mca_email_worker_leases SET expires_at=? WHERE sender_id=? AND token=? AND expires_at > ?"
    )
    .run(later(leaseSeconds), senderId, token, nowIso())
  if (!updated.changes)
    throw new AppError(
      409,
      "email_lease_lost",
      "Messaging worker lease expired."
    )
}
async function fenced<T>(
  senderId: string,
  token: string,
  action: (executor: DbExecutor) => Promise<T>
) {
  return withTransaction(async (executor) => {
    const row = await executor
      .prepare(
        "SELECT token FROM mca_email_worker_leases WHERE sender_id=? AND token=? AND expires_at > ? FOR UPDATE"
      )
      .get(senderId, token, nowIso())
    if (!row)
      throw new AppError(
        409,
        "email_lease_lost",
        "Messaging worker lease expired."
      )
    return action(executor)
  })
}
async function sendPermission(c: ConversationRow, m: MessageRow) {
  if (!m.actor_membership_id)
    throw new AppError(
      403,
      "email_member_inactive",
      "The original sender is no longer available."
    )
  const actor = await liveEmailActor(c.workspace_id, m.actor_membership_id)
  const deal = await getDealForDocument(actor, c.deal_id)
  await emailSender(actor, c.sender_id, true)
  if (
    deal.contactEmail?.trim().toLowerCase() !==
    decryptSensitive(c.recipient_cipher, c.workspace_id).toLowerCase()
  )
    throw new AppError(
      409,
      "email_recipient_changed",
      "The deal contact email changed. Start a new conversation with the saved address."
    )
}
async function syncPermission(c: ConversationRow, sender: StoredEmailSender) {
  const members = await db()
    .prepare<{ id: string }>(
      "SELECT id FROM memberships WHERE workspace_id=? AND status='active' AND (role IN ('admin','super_admin') OR id=? OR id IN (SELECT membership_id FROM mca_email_sender_members WHERE workspace_id=? AND sender_id=?))"
    )
    .all(
      c.workspace_id,
      sender.ownerMembershipId ?? null,
      c.workspace_id,
      sender.id
    )
  for (const member of members) {
    try {
      const actor = await liveEmailActor(c.workspace_id, member.id)
      await getDealForDocument(actor, c.deal_id)
      await emailSender(actor, sender.id, true)
      return
    } catch (error) {
      if (!(error instanceof AppError)) throw error
    }
  }
  throw new AppError(
    403,
    "email_sync_access",
    "No active member has access to both this sender and deal."
  )
}
function providerFailure(error: unknown) {
  if (error instanceof EmailProviderError)
    return {
      message: error.message,
      delay: error.retryAfter,
      blocked: [401, 403].includes(error.status),
      retry: error.status === 429,
      unknown: error.uncertain,
    }
  if (error instanceof AppError)
    return {
      message: error.message,
      delay: 60,
      blocked: true,
      retry: false,
      unknown: false,
    }
  return {
    message:
      "Email processing failed. The worker will check the provider before proceeding.",
    delay: 60,
    blocked: false,
    retry: false,
    unknown: true,
  }
}
async function expireRejectedCredential(error: unknown, mailbox: Mailbox) {
  if (
    error instanceof EmailProviderError &&
    [401, 403].includes(error.status)
  ) {
    await db()
      .prepare(
        "UPDATE mca_email_senders SET state='expired',last_error='Reconnect to restore email read and send access.',updated_at=? WHERE id=? AND workspace_id=? AND credential_cipher=? AND state='verified'"
      )
      .run(
        nowIso(),
        mailbox.sender.id,
        mailbox.sender.workspaceId,
        mailbox.sender.credentialCipher
      )
  }
}
async function delivery(
  c: ConversationRow,
  m: MessageRow,
  mailbox: Mailbox,
  token: string
) {
  let attempted = false
  try {
    await sendPermission(c, m)
    await mailbox.connect()
    // Recheck live permissions after refreshing credentials and immediately before dispatch.
    await sendPermission(c, m)
    await fenced(c.sender_id, token, async (executor) => {
      await executor
        .prepare(
          "UPDATE mca_email_messages SET state='sending',attempts=attempts+1,updated_at=? WHERE id=?"
        )
        .run(nowIso(), m.id)
    })
    attempted = true
    const result = await mailbox.send({
      id: m.id,
      internetId: m.internet_message_id,
      replyTo: m.reply_to_message_id,
      threadId: c.provider_thread_id,
      to: decryptSensitive(c.recipient_cipher, c.workspace_id),
      subject: decryptSensitive(c.subject_cipher, c.workspace_id),
      body: decryptSensitive(m.body_cipher, c.workspace_id),
    })
    await fenced(c.sender_id, token, async (executor) => {
      await executor
        .prepare(
          "UPDATE mca_email_messages SET state='accepted',provider_message_id=?,error=NULL,updated_at=? WHERE id=?"
        )
        .run(result.id ?? null, nowIso(), m.id)
      await executor
        .prepare(
          "UPDATE mca_email_conversations SET provider_thread_id=COALESCE(provider_thread_id,?),next_sync_at=?,updated_at=? WHERE id=?"
        )
        .run(result.threadId ?? null, nowIso(), nowIso(), c.id)
    })
  } catch (error) {
    await expireRejectedCredential(error, mailbox)
    const failure = providerFailure(error)
    const terminalState = await fenced(c.sender_id, token, async (executor) => {
      const state =
        failure.unknown && attempted
          ? "unknown"
          : failure.blocked
            ? "blocked"
            : failure.retry
              ? "queued"
              : "failed"
      await executor
        .prepare(
          "UPDATE mca_email_messages SET state=?,error=?,next_attempt_at=?,updated_at=? WHERE id=?"
        )
        .run(
          state,
          failure.message,
          later(
            Math.max(
              failure.delay,
              Math.min(3600, 2 ** Math.min(m.attempts, 10) * 5)
            )
          ),
          nowIso(),
          m.id
        )
      return state
    })
    if (terminalState === "failed" || terminalState === "unknown") await recordOperationalError("email", terminalState === "unknown" ? "delivery_unknown" : "delivery_failed")
  }
}
/** Only persist messages linked by references to an app-created message, with the expected participants. */
export function associatedReplies(
  remote: RemoteEmail[],
  knownIds: Set<string>,
  from: string,
  to: string
): RemoteEmail[] {
  const result: RemoteEmail[] = [],
    pending = [...remote].sort((a, b) =>
      a.occurredAt.localeCompare(b.occurredAt)
    )
  let changed = true
  while (changed) {
    changed = false
    for (let i = pending.length - 1; i >= 0; i--) {
      const m = pending[i]
      if (!m.internetId || knownIds.has(m.internetId)) {
        pending.splice(i, 1)
        continue
      }
      const participants =
        (m.from === from && m.to.includes(to)) ||
        (m.from === to && m.to.includes(from))
      if (participants && m.references.some((id) => knownIds.has(id))) {
        knownIds.add(m.internetId)
        result.push(m)
        pending.splice(i, 1)
        changed = true
      }
    }
  }
  return result.sort((a, b) => a.occurredAt.localeCompare(b.occurredAt))
}
async function synchronize(
  c: ConversationRow,
  mailbox: Mailbox,
  token: string
) {
  try {
    await syncPermission(c, mailbox.sender)
    await mailbox.connect()
    let messages = await db()
      .prepare<MessageRow>(
        "SELECT * FROM mca_email_messages WHERE conversation_id=? ORDER BY sequence"
      )
      .all(c.id)
    // Reconcile accepted sends and crashed/uncertain attempts by a unique MIME identifier.
    for (const m of messages.filter((m) =>
      ["accepted", "unknown"].includes(m.state)
    )) {
      const found = await mailbox.findSent({
        id: m.id,
        internetId: m.internet_message_id,
        createdAt: m.created_at,
      })
      if (
        found &&
        found.from === mailbox.sender.fromAddress.toLowerCase() &&
        found.to.includes(
          decryptSensitive(c.recipient_cipher, c.workspace_id).toLowerCase()
        ) &&
        found.internetId
      ) {
        await fenced(c.sender_id, token, async (executor) => {
          await executor
            .prepare(
              "UPDATE mca_email_messages SET state='sent',provider_message_id=?,internet_message_id=?,error=NULL,updated_at=? WHERE id=?"
            )
            .run(found.id, found.internetId, nowIso(), m.id)
          await executor
            .prepare(
              "UPDATE mca_email_conversations SET provider_thread_id=COALESCE(provider_thread_id,?) WHERE id=?"
            )
            .run(found.threadId, c.id)
        })
        c.provider_thread_id ??= found.threadId
      }
    }
    if (c.provider_thread_id) {
      const remote = await mailbox.thread(c.provider_thread_id)
      messages = await db()
        .prepare<MessageRow>(
          "SELECT * FROM mca_email_messages WHERE conversation_id=?"
        )
        .all(c.id)
      const known = new Set(
        messages
          .filter((m) => ["sent", "received"].includes(m.state))
          .map((m) => m.internet_message_id)
      )
      const associated = associatedReplies(
        remote,
        known,
        mailbox.sender.fromAddress.toLowerCase(),
        decryptSensitive(c.recipient_cipher, c.workspace_id).toLowerCase()
      )
      await syncPermission(c, mailbox.sender)
      await fenced(c.sender_id, token, async (executor) => {
        for (const m of associated) {
          const inbound = m.from !== mailbox.sender.fromAddress.toLowerCase(),
            now = nowIso()
          const stored = await executor
            .prepare(
              `INSERT INTO mca_email_messages(id,workspace_id,conversation_id,direction,body_cipher,author_cipher,provider_message_id,internet_message_id,state,next_attempt_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(conversation_id,provider_message_id) DO NOTHING`
            )
            .run(
              newId(),
              c.workspace_id,
              c.id,
              inbound ? "inbound" : "outbound",
              encryptSensitive(m.body, c.workspace_id),
              encryptSensitive(m.from, c.workspace_id),
              m.id,
              m.internetId,
              inbound ? "received" : "sent",
              now,
              m.occurredAt,
              now
            )
          if (stored.changes)
            await executor
              .prepare(
                "UPDATE mca_email_conversations SET updated_at=? WHERE id=?"
              )
              .run(now, c.id)
        }
      })
    }
    await fenced(c.sender_id, token, async (executor) => {
      await executor
        .prepare(
          "UPDATE mca_email_conversations SET last_synced_at=?,next_sync_at=?,sync_error=NULL WHERE id=?"
        )
        .run(nowIso(), later(60), c.id)
    })
  } catch (error) {
    await expireRejectedCredential(error, mailbox)
    const failure = providerFailure(error)
    await fenced(c.sender_id, token, async (executor) => {
      await executor
        .prepare(
          "UPDATE mca_email_conversations SET next_sync_at=?,sync_error=? WHERE id=?"
        )
        .run(later(Math.max(failure.delay, 60)), failure.message, c.id)
    })
  }
}
export async function runMessagingWorkerOnce(
  shouldStop: () => boolean = () => false
) {
  const candidates = await db()
    .prepare<{
      sender_id: string
      workspace_id: string
    }>(
      `SELECT c.sender_id,c.workspace_id FROM mca_email_conversations c WHERE c.next_sync_at<=? OR EXISTS(SELECT 1 FROM mca_email_messages m WHERE m.conversation_id=c.id AND m.state IN ('queued','blocked','sending') AND m.next_attempt_at<=?) GROUP BY c.sender_id,c.workspace_id ORDER BY MIN(c.next_sync_at) LIMIT 25`
    )
    .all(nowIso(), nowIso())
  for (const candidate of candidates) {
    if (shouldStop()) break
    const token = await lease(candidate.sender_id, candidate.workspace_id)
    if (!token) continue
    try {
      const sender = await findSenderById(
        candidate.workspace_id,
        candidate.sender_id
      )
      if (!sender) continue
      // Any surviving sending row belongs to a crashed/expired worker. Never dispatch it again.
      await fenced(sender.id, token, async (executor) => {
        await executor
          .prepare(
            "UPDATE mca_email_messages SET state='unknown',error='Worker interrupted. Checking Sent mail; this message will not be sent again automatically.' WHERE state='sending' AND conversation_id IN (SELECT id FROM mca_email_conversations WHERE sender_id=?)"
          )
          .run(sender.id)
      })
      const mailbox = new Mailbox(sender, () => renew(sender.id, token))
      const conversations = await db()
        .prepare<ConversationRow>(
          `SELECT * FROM mca_email_conversations c WHERE sender_id=? AND (next_sync_at<=? OR EXISTS(SELECT 1 FROM mca_email_messages m WHERE m.conversation_id=c.id AND m.state IN ('queued','blocked') AND m.next_attempt_at<=?)) ORDER BY next_sync_at LIMIT 10`
        )
        .all(sender.id, nowIso(), nowIso())
      for (const c of conversations) {
        if (shouldStop()) break
        const message = await db()
          .prepare<MessageRow>(
            "SELECT * FROM mca_email_messages WHERE conversation_id=? AND direction='outbound' AND state IN ('queued','blocked') AND next_attempt_at<=? ORDER BY sequence LIMIT 1"
          )
          .get(c.id, nowIso())
        if (message) await delivery(c, message, mailbox, token)
        if (c.next_sync_at <= nowIso() || message)
          await synchronize(c, mailbox, token)
      }
    } finally {
      await db()
        .prepare(
          "DELETE FROM mca_email_worker_leases WHERE sender_id=? AND token=?"
        )
        .run(candidate.sender_id, token)
    }
  }
  return messagingHealth()
}
export async function messagingHealth() {
  return db()
    .prepare<{
      queued: string
      sync_failures: string
      unsynced: string
      expired_senders: string
      accepted: string
      unknown: string
      blocked: string
      oldest_queued_at: string | null
      oldest_sync_at: string | null
    }>(
      `SELECT (SELECT count(*) FROM mca_email_conversations WHERE sync_error IS NOT NULL) sync_failures,(SELECT count(*) FROM mca_email_conversations WHERE last_synced_at IS NULL) unsynced,(SELECT count(*) FROM mca_email_senders WHERE state='expired') expired_senders,(SELECT count(*) FROM mca_email_messages WHERE state='accepted') accepted,(SELECT count(*) FROM mca_email_messages WHERE state='queued') queued,(SELECT count(*) FROM mca_email_messages WHERE state='unknown') unknown,(SELECT count(*) FROM mca_email_messages WHERE state='blocked') blocked,(SELECT min(created_at) FROM mca_email_messages WHERE state='queued') oldest_queued_at,(SELECT min(last_synced_at) FROM mca_email_conversations) oldest_sync_at`
    )
    .get()
}
