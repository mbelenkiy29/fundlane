import "server-only"
import { createHash } from "node:crypto"
import { getDatabase, nowIso, type DbExecutor } from "../db"
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
export async function managedReady(
  workspaceId: string,
  accountId: string
): Promise<boolean> {
  const c = await company(workspaceId)
  const p = c ? provider(c) : undefined
  if (
    !c ||
    !c.email_verified_at ||
    c.review_state !== "approved" ||
    c.registration_state !== "approved" ||
    c.suspended ||
    !c.opt_out_ready ||
    !platformReady() ||
    (process.env.MCA_SMS_CRON_ENABLED === "true" &&
      (!p?.accountSid ||
        !p.authToken ||
        !p.apiKeySid ||
        !p.apiKeySecret ||
        !p.serviceSid ||
        !p.brandSid ||
        !p.campaignSid))
  )
    return false
  return !!(await getDatabase()
    .prepare(
      "SELECT n.id FROM sms_numbers n JOIN memberships m ON m.id=n.membership_id AND m.workspace_id=n.workspace_id WHERE n.workspace_id=? AND n.account_id=? AND n.state='active' AND m.status='active'"
    )
    .get(workspaceId, accountId))
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
      "Company SMS is suspended or awaiting verification, registration, or an active employee."
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
  await getDatabase()
    .prepare("SELECT pg_advisory_xact_lock(hashtext(?))")
    .get(`sms-consent:${smsRecipientHash(workspaceId, recipient)}`)
  await getDatabase()
    .prepare(
      "INSERT INTO sms_suppressions (workspace_id,recipient_hash,state,updated_at) VALUES (?,?,?,?) ON CONFLICT (workspace_id,recipient_hash) DO UPDATE SET state=EXCLUDED.state,updated_at=EXCLUDED.updated_at"
    )
    .run(workspaceId, smsRecipientHash(workspaceId, recipient), state, nowIso())
}
