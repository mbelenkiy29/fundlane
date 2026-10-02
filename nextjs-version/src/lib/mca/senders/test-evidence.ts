import "server-only"
import { z } from "zod"
import { encryptSensitive, hashOpaqueToken, hmacScopedToken, createOpaqueToken } from "../crypto"
import { getDatabase, newId, nowIso, withTransaction } from "../db"
import type { DealActor } from "../deals/schema"
import { AppError } from "../errors"
import { findSenderById, type StoredEmailSender } from "./repository"
import type { SenderTestSendResult } from "./contracts"
import { postmarkTransportIdentity } from "../closing/delivery"

export const senderTestInput = z.object({ to: z.email().max(254), recipientControlConfirmed: z.literal(true), requestKey: z.string().regex(/^[a-zA-Z0-9_-]{8,100}$/) }).strict()
export type SenderTestState = "sending" | "preview" | "accepted" | "received" | "uncertain" | "failed"
export interface SenderTestEvidence { testId: string; state: SenderTestState; evidenceSource?: "user_confirmed" | "provider_delivered"; canConfirm: boolean }
interface TestRow { id: string; state: SenderTestState; sender_fingerprint: string; recipient_hash: string; created_by_user_id: string; claim_token: string | null; lease_until: string | null; evidence_source: "user_confirmed" | "provider_delivered" | null; provider_message_id: string | null }

/** Configuration identity, independent of bookkeeping timestamps and test-result state changes. */
export function senderTestFingerprint(sender: StoredEmailSender): string {
  const transport = process.env.MCA_CLOSING_EMAIL_PROVIDER === "postmark"
    ? { provider: "postmark", ...postmarkTransportIdentity({ workspaceId: sender.workspaceId, senderId: sender.id, sender: { fromName: sender.fromName, fromAddress: sender.fromAddress } }) }
    : { provider: "webhook", webhook: process.env.MCA_EMAIL_WEBHOOK_URL?.trim(), webhookToken: hashOpaqueToken(process.env.MCA_EMAIL_WEBHOOK_TOKEN ?? "") }
  return hashOpaqueToken(JSON.stringify({ provider: sender.provider, purpose: sender.purpose, fromName: sender.fromName, fromAddress: sender.fromAddress, signature: sender.signature, credential: sender.credentialCipher, transport }))
}
function result(row: TestRow): SenderTestSendResult {
  return { testId: row.id, correlationId: row.id, delivery: row.state === "accepted" || row.state === "received" ? "sent" : row.state === "preview" ? "preview" : row.state === "failed" ? "failed" : "uncertain", evidence: row.state, evidenceSource: row.evidence_source ?? undefined, providerMessageId: row.provider_message_id ?? undefined,
    ...(row.state === "uncertain" || row.state === "sending" ? { error: "Acceptance is uncertain or still pending. This attempt will not resend; check the controlled inbox." } : {}) }
}
export async function latestSenderTestEvidence(sender: StoredEmailSender, userId?: string | null): Promise<SenderTestEvidence | undefined> {
  if (["expired", "revoked"].includes(sender.state)) return undefined
  const row = await getDatabase().prepare<TestRow>("SELECT * FROM mca_sender_test_runs WHERE workspace_id=? AND sender_id=? AND sender_fingerprint=? ORDER BY created_at DESC,id DESC LIMIT 1").get(sender.workspaceId, sender.id, senderTestFingerprint(sender))
  if (!row) return undefined
  const state = row.state === "sending" && row.lease_until && row.lease_until <= nowIso() ? "uncertain" : row.state
  return { testId: row.id, state, evidenceSource: row.evidence_source ?? undefined, canConfirm: row.created_by_user_id === userId && ["accepted", "uncertain"].includes(state) }
}
/** Caller already enforced session, active membership, sender-use, MFA and operational access. */
export async function claimSenderTest(actor: DealActor, sender: StoredEmailSender, value: unknown): Promise<{ previous?: SenderTestSendResult; id: string; claimToken?: string; recipient: string; fingerprint: string }> {
  const parsed = senderTestInput.safeParse(value)
  if (!parsed.success) throw new AppError(422, "validation_failed", "Enter an address you control, confirm control, and provide a unique request key.")
  const recipient = parsed.data.to.toLowerCase(), fingerprint = senderTestFingerprint(sender), recipientHash = hmacScopedToken("sender-test-recipient", actor.workspaceId, recipient)
  return withTransaction(async db => {
    await db.prepare("SELECT id FROM mca_email_senders WHERE workspace_id=? AND id=? FOR UPDATE").get(actor.workspaceId, sender.id)
    const current = await db.prepare<{ credential_cipher: string | null; from_address: string; from_name: string; signature: string | null; is_default: number; state: string }>("SELECT credential_cipher,from_address,from_name,signature,is_default,state FROM mca_email_senders WHERE workspace_id=? AND id=?").get(actor.workspaceId, sender.id)
    if (!current || current.credential_cipher !== (sender.credentialCipher ?? null) || current.from_address !== sender.fromAddress || current.from_name !== sender.fromName || current.signature !== (sender.signature ?? null) || Boolean(current.is_default) !== sender.isDefault || ["expired", "revoked"].includes(current.state)) throw new AppError(409, "sender_connection_changed", "The sender changed. Reload before testing.")
    const prior = await db.prepare<TestRow>("SELECT * FROM mca_sender_test_runs WHERE workspace_id=? AND sender_id=? AND request_key=? FOR UPDATE").get(actor.workspaceId, sender.id, parsed.data.requestKey)
    if (prior) {
      if (prior.created_by_user_id !== actor.userId) throw new AppError(403, "permission_denied", "This test belongs to another customer.")
      if (prior.sender_fingerprint !== fingerprint || prior.recipient_hash !== recipientHash) throw new AppError(409, "sender_test_request_conflict", "That request key belongs to a different sender test.")
      if (prior.state === "sending" && prior.lease_until && prior.lease_until <= nowIso()) { await db.prepare("UPDATE mca_sender_test_runs SET state='uncertain',claim_token=NULL,lease_until=NULL,error_code='sender_test_uncertain',updated_at=? WHERE id=?").run(nowIso(), prior.id); prior.state = "uncertain" }
      return { previous: result(prior), id: prior.id, recipient, fingerprint: prior.sender_fingerprint }
    }
    const held = await db.prepare<TestRow>("SELECT * FROM mca_sender_test_runs WHERE workspace_id=? AND sender_id=? AND sender_fingerprint=? AND state IN ('sending','uncertain') LIMIT 1").get(actor.workspaceId, sender.id, fingerprint)
    if (held) throw new AppError(409, "sender_test_uncertain", "A previous test is pending or uncertain. Check the controlled inbox and confirm receipt; do not resend.")
    const id = newId(), claimToken = createOpaqueToken(), now = nowIso()
    await db.prepare(`INSERT INTO mca_sender_test_runs(id,workspace_id,sender_id,request_key,sender_fingerprint,recipient_cipher,recipient_hash,recipient_control_confirmed,provider,state,claim_token,lease_until,created_by_user_id,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,true,?,'sending',?,?,?,?,?)`).run(id, actor.workspaceId, sender.id, parsed.data.requestKey, fingerprint, encryptSensitive(recipient, actor.workspaceId), recipientHash,
      process.env.MCA_CLOSING_EMAIL_PROVIDER === "postmark" ? "postmark" : process.env.MCA_EMAIL_WEBHOOK_URL ? "webhook" : "preview", claimToken, new Date(Date.now() + 30_000).toISOString(), actor.userId, now, now)
    return { id, claimToken, recipient, fingerprint }
  })
}
export async function finishSenderTest(actor: DealActor, senderId: string, id: string, claimToken: string, delivery: SenderTestSendResult): Promise<SenderTestSendResult> {
  const state = delivery.delivery === "sent" ? "accepted" : delivery.delivery
  const now = nowIso()
  await getDatabase().prepare(`UPDATE mca_sender_test_runs SET state=?,provider_message_id=?,accepted_at=?,claim_token=NULL,lease_until=NULL,error_code=?,updated_at=?
    WHERE workspace_id=? AND sender_id=? AND id=? AND state='sending' AND claim_token=? AND lease_until>?`).run(state, delivery.providerMessageId ?? null, state === "accepted" ? now : null, state === "uncertain" ? "sender_test_uncertain" : state === "failed" ? "sender_test_failed" : null, now, actor.workspaceId, senderId, id, claimToken, now)
  // A late completion cannot overwrite another transition; hold its uncertainty rather than issue a second send.
  await getDatabase().prepare("UPDATE mca_sender_test_runs SET state='uncertain',claim_token=NULL,lease_until=NULL,error_code='sender_test_uncertain',updated_at=? WHERE workspace_id=? AND id=? AND state='sending' AND lease_until<=?").run(now, actor.workspaceId, id, now)
  const row = await getDatabase().prepare<TestRow>("SELECT * FROM mca_sender_test_runs WHERE workspace_id=? AND sender_id=? AND id=?").get(actor.workspaceId, senderId, id)
  if (!row) throw new AppError(409, "sender_test_missing", "Reload sender tests.")
  return result(row)
}
export async function confirmTestReceipt(actor: DealActor, sender: StoredEmailSender, id: string, value: unknown): Promise<SenderTestSendResult> {
  if (!z.object({ received: z.literal(true) }).strict().safeParse(value).success) throw new AppError(422, "validation_failed", "Explicitly confirm that this test reached the inbox you control.")
  return withTransaction(async db => {
    await db.prepare("SELECT id FROM mca_email_senders WHERE workspace_id=? AND id=? FOR UPDATE").get(actor.workspaceId, sender.id)
    const current = await findSenderById(actor.workspaceId, sender.id, db)
    const row = await db.prepare<TestRow>("SELECT * FROM mca_sender_test_runs WHERE workspace_id=? AND sender_id=? AND id=? FOR UPDATE").get(actor.workspaceId, sender.id, id)
    if (!row || row.created_by_user_id !== actor.userId) throw new AppError(403, "permission_denied", "You can only confirm receipt of your own sender test.")
    if (!current || row.sender_fingerprint !== senderTestFingerprint(current) || ["expired", "revoked"].includes(current.state)) throw new AppError(409, "sender_connection_changed", "This test belongs to a previous sender configuration.")
    const expiredClaim = row.state === "sending" && row.lease_until && row.lease_until <= nowIso()
    if (!["accepted", "uncertain", "received"].includes(row.state) && !expiredClaim) throw new AppError(409, "sender_test_not_confirmable", "Only an actual send attempt can have customer-confirmed receipt.")
    const now = nowIso()
    await db.prepare("UPDATE mca_sender_test_runs SET state='received',received_at=COALESCE(received_at,?),evidence_source='user_confirmed',claim_token=NULL,lease_until=NULL,updated_at=? WHERE workspace_id=? AND id=?").run(now, now, actor.workspaceId, id)
    return result({ ...row, state: "received", evidence_source: "user_confirmed" })
  })
}
