import "server-only"
import {
  getDatabase,
  withImmediateTransaction,
  newId,
  nowIso,
  recordAuditEvent,
} from "../db"
import { encryptSensitive, decryptSensitive } from "../crypto"
import { AppError } from "../errors"
import { getDealForDocument } from "../deals/service"
import type { DealActor } from "../deals/schema"
import { smsRecipientHash, suppress } from "./managed"
import { admin } from "./onboarding"

type Conversation = {
  id: string
  workspace_id: string
  account_id: string
  recipient_hash: string
  recipient_cipher: string
  deal_id: string | null
  updated_at: string
  unread?: number
}
export async function persistInbound(
  workspaceId: string,
  accountId: string,
  params: URLSearchParams,
  senderKind: string,
  sender: string
) {
  const recipient = params.get("From")?.trim() ?? "",
    to = params.get("To")?.trim() ?? "",
    sid = params.get("MessageSid")?.trim() ?? "",
    body = params.get("Body") ?? ""
  if (!/^\+[1-9]\d{7,14}$/.test(recipient))
    throw new AppError(422, "inbound_phone_invalid", "Invalid inbound sender.")
  if (senderKind === "phone_number" && to !== sender)
    throw new AppError(
      401,
      "twilio_sender_mismatch",
      "The receiving number does not match this route."
    )
  if (
    senderKind === "messaging_service" &&
    params.get("MessagingServiceSid") !== sender
  )
    throw new AppError(
      401,
      "twilio_service_mismatch",
      "The receiving service does not match this route."
    )
  const type =
    params.get("OptOutType")?.toUpperCase() ??
    (/^(STOP|STOPALL|UNSUBSCRIBE|CANCEL|END|QUIT|REVOKE|OPTOUT)$/i.test(
      body.trim()
    )
      ? "STOP"
      : /^(START|UNSTOP)$/i.test(body.trim())
        ? "START"
        : "")
  await withImmediateTransaction(async (db) => {
    if (
      sid &&
      (await db
        .prepare(
          "SELECT id FROM sms_inbox_messages WHERE workspace_id=? AND provider_id=?"
        )
        .get(workspaceId, sid))
    )
      return
    if (type === "STOP") await suppress(workspaceId, recipient, "opted_out")
    // START removes a suppression only when Twilio explicitly confirms the opt-in.
    if (type === "START" && params.get("OptOutType") === "START")
      await suppress(workspaceId, recipient, "opted_in")
    if (!/^(SM|MM)[a-fA-F0-9]{32}$/.test(sid)) {
      if (type) return
      throw new AppError(
        422,
        "inbound_sid_invalid",
        "Invalid inbound message identifier."
      )
    }
    if (
      await db
        .prepare(
          "SELECT id FROM sms_inbox_messages WHERE workspace_id=? AND provider_id=?"
        )
        .get(workspaceId, sid)
    )
      return
    const hash = smsRecipientHash(workspaceId, recipient)
    const candidates = await db
      .prepare<{
        id: string
        contact_phone_cipher: string
      }>(
        "SELECT id,contact_phone_cipher FROM deals WHERE workspace_id=? AND contact_phone_cipher IS NOT NULL"
      )
      .all(workspaceId)
    const matches = candidates.filter((d) => {
      try {
        let phone = decryptSensitive(d.contact_phone_cipher, workspaceId).trim()
        const digits = phone.replace(/\D/g, "")
        if (digits.length === 10) phone = `+1${digits}`
        return phone === recipient
      } catch {
        return false
      }
    })
    const existing = await db
      .prepare<Conversation>(
        "SELECT * FROM sms_conversations WHERE workspace_id=? AND account_id=? AND recipient_hash=? FOR UPDATE"
      )
      .get(workspaceId, accountId, hash)
    if (existing?.deal_id && matches.length !== 1) {
      const manuallyAssociated = await db
        .prepare(
          "SELECT id FROM audit_events WHERE workspace_id=? AND resource_id=? AND action='sms.conversation_associated' LIMIT 1"
        )
        .get(workspaceId, existing.id)
      if (!manuallyAssociated)
        await db
          .prepare(
            "UPDATE sms_conversations SET deal_id=NULL WHERE workspace_id=? AND id=?"
          )
          .run(workspaceId, existing.id)
    }
    const conversationId = existing?.id ?? newId()
    await db
      .prepare(
        "INSERT INTO sms_conversations (id,workspace_id,account_id,recipient_hash,recipient_cipher,deal_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?) ON CONFLICT (workspace_id,account_id,recipient_hash) DO UPDATE SET updated_at=EXCLUDED.updated_at"
      )
      .run(
        conversationId,
        workspaceId,
        accountId,
        hash,
        encryptSensitive(recipient, workspaceId),
        matches.length === 1 ? matches[0].id : null,
        nowIso(),
        nowIso()
      )
    const actual = await db
      .prepare<{
        id: string
      }>(
        "SELECT id FROM sms_conversations WHERE workspace_id=? AND account_id=? AND recipient_hash=?"
      )
      .get(workspaceId, accountId, hash)
    await db
      .prepare(
        "INSERT INTO sms_inbox_messages (id,workspace_id,conversation_id,provider_id,direction,body_cipher,created_at) VALUES (?,?,?,?,'inbound',?,?) ON CONFLICT DO NOTHING"
      )
      .run(
        newId(),
        workspaceId,
        actual!.id,
        sid,
        encryptSensitive(body.slice(0, 10000), workspaceId),
        nowIso()
      )
    await recordAuditEvent({
      context: { workspaceId, userId: null, source: "system" },
      action: "sms.inbound_received",
      resourceType: "sms_conversation",
      resourceId: actual!.id,
    })
  })
}
async function visible(actor: DealActor, c: Conversation): Promise<boolean> {
  const administrative =
    actor.source === "user" &&
    ["admin", "super_admin"].includes(actor.role ?? "")
  if (
    !administrative &&
    !(await getDatabase()
      .prepare(
        "SELECT am.account_id FROM mca_sms_account_members am JOIN memberships m ON m.id=am.membership_id AND m.workspace_id=am.workspace_id WHERE am.workspace_id=? AND am.account_id=? AND am.membership_id=? AND m.status='active'"
      )
      .get(actor.workspaceId, c.account_id, actor.membershipId))
  )
    return false
  if (!c.deal_id) return administrative
  try {
    await getDealForDocument(actor, c.deal_id)
    return true
  } catch (error) {
    if (error instanceof AppError && [403, 404].includes(error.status))
      return false
    throw error
  }
}
export async function listConversations(actor: DealActor, dealId?: string) {
  if (dealId) await getDealForDocument(actor, dealId)
  const rows = await getDatabase()
    .prepare<Conversation>(
      `SELECT c.*, (SELECT count(*)::int FROM sms_inbox_messages im WHERE im.conversation_id=c.id AND im.workspace_id=c.workspace_id AND im.created_at>COALESCE((SELECT read_at FROM sms_conversation_reads WHERE conversation_id=c.id AND membership_id=?),'')) unread FROM sms_conversations c WHERE c.workspace_id=? AND (?::text IS NULL OR c.deal_id=?) ORDER BY c.updated_at DESC LIMIT 200`
    )
    .all(actor.membershipId, actor.workspaceId, dealId ?? null, dealId ?? null)
  const result = []
  for (const c of rows)
    if (await visible(actor, c))
      result.push({
        id: c.id,
        accountId: c.account_id,
        dealId: c.deal_id,
        recipient: decryptSensitive(c.recipient_cipher, actor.workspaceId),
        unread: c.unread,
        updatedAt: c.updated_at,
      })
  return { conversations: result }
}
export async function conversationDetail(actor: DealActor, id: string) {
  const c = await getDatabase()
    .prepare<Conversation>(
      "SELECT * FROM sms_conversations WHERE workspace_id=? AND id=?"
    )
    .get(actor.workspaceId, id)
  if (!c || !(await visible(actor, c)))
    throw new AppError(404, "conversation_missing", "Conversation not found.")
  const incoming = await getDatabase()
    .prepare<{
      id: string
      body_cipher: string
      created_at: string
    }>(
      "SELECT id,body_cipher,created_at FROM sms_inbox_messages WHERE workspace_id=? AND conversation_id=? ORDER BY created_at DESC LIMIT 100"
    )
    .all(actor.workspaceId, id)
  const outgoing = c.deal_id
    ? await getDatabase()
        .prepare<{
          id: string
          body_cipher: string
          created_at: string
          state: string
          error_message: string | null
        }>(
          "SELECT id,body_cipher,created_at,state,error_message FROM mca_sms_messages WHERE workspace_id=? AND account_id=? AND deal_id=? AND recipient_hash=? ORDER BY created_at DESC LIMIT 100"
        )
        .all(actor.workspaceId, c.account_id, c.deal_id, c.recipient_hash)
    : []
  return {
    id: c.id,
    dealId: c.deal_id,
    accountId: c.account_id,
    recipient: decryptSensitive(c.recipient_cipher, actor.workspaceId),
    messages: [
      ...incoming.map((m) => ({
        id: m.id,
        body: decryptSensitive(m.body_cipher, actor.workspaceId),
        direction: "inbound",
        createdAt: m.created_at,
        state: "received",
        error: null,
      })),
      ...outgoing.map((m) => ({
        id: m.id,
        body: decryptSensitive(m.body_cipher, actor.workspaceId),
        direction: "outbound",
        createdAt: m.created_at,
        state: m.state,
        error: m.error_message,
      })),
    ].sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
  }
}
export async function readConversation(actor: DealActor, id: string) {
  await conversationDetail(actor, id)
  await getDatabase()
    .prepare(
      "INSERT INTO sms_conversation_reads (conversation_id,membership_id,read_at) VALUES (?,?,?) ON CONFLICT (conversation_id,membership_id) DO UPDATE SET read_at=EXCLUDED.read_at"
    )
    .run(id, actor.membershipId, nowIso())
  return { read: true }
}
export async function associateConversation(
  actor: DealActor,
  id: string,
  dealId: string
) {
  admin(actor)
  const c = await conversationDetail(actor, id),
    deal = await getDealForDocument(actor, dealId)
  const digits = deal.contactPhone?.replace(/\D/g, "") ?? "",
    phone = digits.length === 10 ? `+1${digits}` : `+${digits}`
  if (phone !== c.recipient)
    throw new AppError(
      422,
      "conversation_recipient_mismatch",
      "The deal phone must match this conversation."
    )
  if (c.dealId && c.dealId !== dealId)
    throw new AppError(
      409,
      "conversation_already_associated",
      "This conversation is already associated with a deal."
    )
  await getDatabase()
    .prepare(
      "UPDATE sms_conversations SET deal_id=? WHERE workspace_id=? AND id=?"
    )
    .run(dealId, actor.workspaceId, id)
  await recordAuditEvent({
    context: actor,
    action: "sms.conversation_associated",
    resourceType: "sms_conversation",
    resourceId: id,
    metadata: { dealId },
  })
  return { updated: true }
}
export async function rememberOutbound(
  workspaceId: string,
  accountId: string,
  dealId: string,
  recipient: string
) {
  const hash = smsRecipientHash(workspaceId, recipient)
  await getDatabase()
    .prepare(
      "INSERT INTO sms_conversations (id,workspace_id,account_id,recipient_hash,recipient_cipher,deal_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?) ON CONFLICT (workspace_id,account_id,recipient_hash) DO UPDATE SET updated_at=EXCLUDED.updated_at"
    )
    .run(
      newId(),
      workspaceId,
      accountId,
      hash,
      encryptSensitive(recipient, workspaceId),
      dealId,
      nowIso(),
      nowIso()
    )
}
