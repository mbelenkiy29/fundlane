import "server-only"
import type { SmsReadiness } from "./contracts"
import { decryptSensitive } from "../crypto"
import { createHash } from "node:crypto"
import { getDatabase, nowIso, withImmediateTransaction, type DbExecutor } from "../db"
import { AppError } from "../errors"
import {
  company,
  provider,
  publicOrigin,
  platformReady,
  type Company,
} from "./onboarding"
import { reserveUsage } from "./provisioning"
import type { DealActor } from "../deals/schema"
export function smsRecipientHash(workspaceId: string, phone: string) {
  return createHash("sha256").update(`${workspaceId}\0${phone}`).digest("hex")
}
export async function managedConfig(workspaceId: string, sender?: string) {
  const c = await company(workspaceId),
    p = c ? provider(c) : undefined
  if (!p?.apiKeySid || !p.apiKeySecret || !p.serviceSid) return undefined
  if (
    sender &&
    !(await getDatabase()
      .prepare("SELECT id FROM sms_numbers WHERE workspace_id=? AND phone=?")
      .get(workspaceId, sender))
  )
    return undefined
  return {
    accountSid: p.accountSid,
    apiKeySid: p.apiKeySid,
    apiKeySecret: p.apiKeySecret,
    authToken: p.authToken,
    publicBaseUrl: publicOrigin(),
    messagingServiceSid: p.serviceSid,
  }
}
export async function managedReadiness(
  workspaceId: string,
  accountId: string
): Promise<SmsReadiness> {
  const blockers: SmsReadiness["blockers"] = []
  const block = (code: string, message: string) => blockers.push({ code, message })
  const c = await company(workspaceId)
  const p = c ? provider(c) : undefined
  if (!c) block("company_missing", "Start company SMS setup in Settings → Connections.")
  else {
    if (!c.email_verified_at) block("email_unverified", "Verify the company owner's email.")
    if (c.review_state !== "approved") block("company_review_pending", "Company business review is awaiting approval.")
    if (c.registration_state !== "approved") block("registration_pending", "Carrier registration is awaiting approval.")
    if (c.suspended) block("company_suspended", "Company SMS is suspended. Contact the platform operator.")
    if (!c.opt_out_ready) block("opt_out_unconfirmed", "Advanced Opt-Out needs operator confirmation.")
  }
  if (!platformReady()) block("platform_pending", "Platform SMS eligibility is awaiting approval.")
  if (!p?.accountSid || !p.authToken || !p.apiKeySid || !p.apiKeySecret || !p.serviceSid || !p.brandSid || !p.campaignSid)
    block("provider_setup_missing", "Company SMS provider setup is incomplete.")
  try { publicOrigin() } catch { block("callback_origin_missing", "SMS callback origin needs operator configuration.") }
  const n = await getDatabase().prepare<{
    phone: string; state: string; membership_id: string | null; membership_status: string | null
    sender_kind: string | null; sender_identity_cipher: string | null; account_state: string | null; shared: number | null; credential_ref: string | null
  }>(`SELECT n.phone,n.state,n.membership_id,m.status AS membership_status,
    a.sender_kind,a.sender_identity_cipher,a.state AS account_state,a.shared,a.credential_ref
    FROM sms_numbers n LEFT JOIN memberships m ON m.id=n.membership_id AND m.workspace_id=n.workspace_id
    LEFT JOIN mca_sms_accounts a ON a.id=n.account_id AND a.workspace_id=n.workspace_id
    WHERE n.workspace_id=? AND n.account_id=?`).get(workspaceId, accountId)
  if (!n) block("number_missing", "No company number is connected to this text sender.")
  else {
    if (n.state !== "active") block("number_inactive", "This number is awaiting carrier activation or is unavailable.")
    if (n.shared !== 1 && n.membership_status !== "active") block("assignment_inactive", "Assign this number to an active employee.")
    if (n.account_state !== "active" || n.credential_ref !== "MANAGED") block("sender_inactive", "The company text sender is unavailable.")
    let identity: string | undefined
    try { if (n.sender_identity_cipher) identity = decryptSensitive(n.sender_identity_cipher, workspaceId) } catch { /* fail closed */ }
    if (n.sender_kind !== "phone_number" || identity !== n.phone) block("number_sender_mismatch", "The text sender does not match its company number. Contact the platform operator.")
  }
  return { ready: blockers.length === 0, blockers }
}

export async function managedReady(workspaceId: string, accountId: string): Promise<boolean> {
  return (await managedReadiness(workspaceId, accountId)).ready
}
export async function assertNotSuppressed(
  db: DbExecutor,
  workspaceId: string,
  recipient: string
) {
  await db
    .prepare("SELECT pg_advisory_xact_lock(hashtext(?))")
    .get(`sms-consent:${smsRecipientHash(workspaceId, recipient)}`)
  const s = await db
    .prepare<{
      state: string
    }>("SELECT state FROM sms_suppressions WHERE workspace_id=? AND recipient_hash=?")
    .get(workspaceId, smsRecipientHash(workspaceId, recipient))
  if (s?.state === "opted_out")
    throw new AppError(
      409,
      "sms_recipient_opted_out",
      "This recipient opted out of company texts."
    )
}
export async function reserveManagedSend(
  db: DbExecutor,
  actor: DealActor,
  accountId: string,
  messageId: string,
  body: string,
  recipient: string
) {
  await assertNotSuppressed(db, actor.workspaceId, recipient)
  const n = await db
    .prepare("SELECT id FROM sms_numbers WHERE workspace_id=? AND account_id=?")
    .get(actor.workspaceId, accountId)
  if (!n) return
  const c = await db
    .prepare<Company>(
      "SELECT * FROM sms_companies WHERE workspace_id=? FOR UPDATE"
    )
    .get(actor.workspaceId)
  if (!(await managedReady(actor.workspaceId, accountId)) || !c)
    throw new AppError(
      409,
      "sms_setup_incomplete",
      "Company SMS is suspended or awaiting verification, registration, or an active number."
    )
  if (!/^\+1\d{10}$/.test(recipient))
    throw new AppError(
      422,
      "sms_us_only",
      "The pilot supports US recipients only."
    )
  if (
    actor.source === "user" &&
    !(await db
      .prepare(
        "SELECT id FROM memberships WHERE id=? AND workspace_id=? AND user_id=? AND status='active'"
      )
      .get(actor.membershipId, actor.workspaceId, actor.userId))
  )
    throw new AppError(
      403,
      "employee_inactive",
      "Your employee account is inactive."
    )
  const segmentCents = Number(process.env.MCA_SMS_SEGMENT_ESTIMATE_CENTS)
  if (!Number.isSafeInteger(segmentCents) || segmentCents <= 0)
    throw new AppError(
      503,
      "sms_pricing_missing",
      "The operator must configure the SMS cost estimate."
    )
  // UTF-16 multipart bound also covers GSM extension characters conservatively.
  const segments = body.length <= 70 ? 1 : Math.ceil(body.length / 67)
  await reserveUsage(
    db,
    c,
    `message:${messageId}`,
    "sms_outbound",
    segments * segmentCents
  )
}
export async function suppress(
  workspaceId: string,
  recipient: string,
  state: "opted_out" | "opted_in"
) {
  await withImmediateTransaction(async (db) => {
    await db.prepare("SELECT pg_advisory_xact_lock(hashtext(?))")
      .get(`sms-consent:${smsRecipientHash(workspaceId, recipient)}`)
    await db.prepare(
      "INSERT INTO sms_suppressions (workspace_id,recipient_hash,state,updated_at) VALUES (?,?,?,?) ON CONFLICT (workspace_id,recipient_hash) DO UPDATE SET state=EXCLUDED.state,updated_at=EXCLUDED.updated_at"
    ).run(workspaceId, smsRecipientHash(workspaceId, recipient), state, nowIso())
  })
}
