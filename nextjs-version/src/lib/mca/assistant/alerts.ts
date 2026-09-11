import "server-only"
import { z } from "zod"
import { getDatabase, newId, nowIso, withTransaction } from "../db"
import { AppError } from "../errors"
import { getClerkClient } from "../clerk-client"
import { deliverEmail } from "../email"
import { creditMonth, nextReset, type CreditAccount } from "./credits"
import { seal, unseal } from "./repository"

export const alertSettingsSchema = z
  .object({
    mode: z.enum(["percent", "fixed"]),
    threshold: z.number().int().min(1).max(100000)
  })
  .strict()
  .refine((s) => s.mode !== "percent" || s.threshold <= 100, {
    message: "Percentage must be between 1 and 100.",
    path: ["threshold"]
  })
export interface CreditAlertPayload {
  workspaceId: string
  userName: string
  companyName: string
  included: number
  purchased: number
  total: number
  allowance: number
  resetAt: string
  userId: string
}
export async function getAlertSettings(workspaceId: string) {
  return (
    (await getDatabase()
      .prepare<{
        mode: "percent" | "fixed"
        threshold: number
      }>("SELECT mode,threshold FROM mca_credit_alert_settings WHERE workspace_id=?")
      .get(workspaceId)) ?? { mode: "percent" as const, threshold: 20 }
  )
}
export async function saveAlertSettings(workspaceId: string, input: unknown) {
  const s = alertSettingsSchema.parse(input)
  await getDatabase()
    .prepare(
      "INSERT INTO mca_credit_alert_settings (workspace_id,mode,threshold,updated_at) VALUES (?,?,?,?) ON CONFLICT(workspace_id) DO UPDATE SET mode=EXCLUDED.mode,threshold=EXCLUDED.threshold,updated_at=EXCLUDED.updated_at"
    )
    .run(workspaceId, s.mode, s.threshold, nowIso())
  return s
}
/** Replay ordered balance snapshots so delayed workers cannot lose low/recovery episodes. */
export async function processCreditAlerts(workspaceId?: string) {
  const accounts = await getDatabase()
    .prepare<CreditAccount>(
      "SELECT * FROM mca_credit_accounts WHERE alert_dirty=1" +
        (workspaceId ? " AND workspace_id=?" : "") +
        " ORDER BY id LIMIT 100"
    )
    .all(...(workspaceId ? [workspaceId] : []))
  for (const account of accounts)
    await withTransaction(async (db) => {
      const a = await db
        .prepare<
          CreditAccount & { alert_dirty: number }
        >("SELECT * FROM mca_credit_accounts WHERE id=? FOR UPDATE")
        .get(account.id)
      if (!a?.alert_dirty) return
      const events = await db
        .prepare<{
          id: number
          month: string
          allowance: number
          included: number
          purchased: number
          threshold_mode: string
          threshold_value: number
          created_at: string
        }>(
          "SELECT * FROM mca_credit_balance_events WHERE account_id=? AND processed_at IS NULL ORDER BY id LIMIT 500"
        )
        .all(a.id)
      // Backfill-free recovery of an account marked dirty by maintenance.
      if (!events.length) {
        const m = await db
          .prepare<{
            allowance: number
            remaining: number
          }>("SELECT effective_allowance AS allowance,GREATEST(0,remaining-(allowance-effective_allowance)) AS remaining FROM mca_credit_months WHERE account_id=? AND month=?")
          .get(a.id, creditMonth())
        if (!m) return
        const settings = await getAlertSettings(a.workspace_id)
        events.push({
          id: 0,
          month: creditMonth(),
          allowance: m.allowance,
          included: m.remaining,
          purchased: Math.max(0, a.purchased_balance),
          threshold_mode: settings.mode,
          threshold_value: settings.threshold,
          created_at: nowIso()
        })
      }
      const details = await db
        .prepare<{
          user_name: string
          company_name: string
        }>("SELECT u.name user_name,w.name company_name FROM users u JOIN memberships m ON m.user_id=u.id JOIN workspaces w ON w.id=m.workspace_id WHERE u.id=? AND m.workspace_id=? AND m.status='active' LIMIT 1")
        .get(a.user_id, a.workspace_id)
      for (const event of events) {
        const total = event.included + event.purchased
        const threshold =
          event.threshold_mode === "percent"
            ? Math.ceil((event.allowance * event.threshold_value) / 100)
            : event.threshold_value
        if (total > threshold) {
          if (a.low_sent || a.exhausted_sent) a.alert_episode++
          a.low_sent = 0
          a.exhausted_sent = 0
        } else if (details) {
          const kind = total === 0 ? "exhausted" : "low"
          const sent = kind === "low" ? a.low_sent : a.exhausted_sent
          if (!sent) {
            const admins = await db
              .prepare<{
                user_id: string
              }>("SELECT DISTINCT user_id FROM memberships WHERE workspace_id=? AND status='active' AND role IN ('admin','super_admin')")
              .all(a.workspace_id)
            const payload: CreditAlertPayload = {
              workspaceId: a.workspace_id,
              userName: details.user_name,
              companyName: details.company_name,
              included: event.included,
              purchased: event.purchased,
              total,
              allowance: event.allowance,
              resetAt: nextReset(new Date(event.month + "-01T00:00:00Z")),
              userId: a.user_id
            }
            for (const admin of admins) {
              const id = newId(),
                now = nowIso()
              const inserted = await db
                .prepare(
                  "INSERT INTO mca_credit_notifications (id,workspace_id,account_id,recipient_user_id,episode,kind,payload_cipher,created_at) VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(account_id,recipient_user_id,episode,kind) DO NOTHING RETURNING id"
                )
                .get(
                  id,
                  a.workspace_id,
                  a.id,
                  admin.user_id,
                  a.alert_episode,
                  kind,
                  seal(a.workspace_id, payload),
                  event.created_at
                )
              if (inserted)
                await db
                  .prepare(
                    "INSERT INTO mca_credit_alert_emails (id,state,next_attempt_at,updated_at) VALUES (?,'queued',?,?)"
                  )
                  .run(id, now, now)
            }
            if (kind === "low") a.low_sent = 1
            else a.exhausted_sent = 1
          }
        }
        if (event.id)
          await db
            .prepare(
              "UPDATE mca_credit_balance_events SET processed_at=? WHERE id=?"
            )
            .run(nowIso(), event.id)
      }
      await db
        .prepare(
          "UPDATE mca_credit_accounts SET alert_dirty=CASE WHEN EXISTS(SELECT 1 FROM mca_credit_balance_events WHERE account_id=? AND processed_at IS NULL) THEN 1 ELSE 0 END,alert_episode=?,low_sent=?,exhausted_sent=? WHERE id=?"
        )
        .run(a.id, a.alert_episode, a.low_sent, a.exhausted_sent, a.id)
    })
}
export async function listCreditNotifications(
  workspaceId: string,
  userId: string
) {
  const rows = await getDatabase()
    .prepare<{
      id: string
      kind: string
      payload_cipher: string
      created_at: string
      read_at: string | null
      email_state: string
    }>(
      "SELECT n.*,e.state email_state FROM mca_credit_notifications n LEFT JOIN mca_credit_alert_emails e ON e.id=n.id WHERE n.workspace_id=? AND n.recipient_user_id=? ORDER BY n.created_at DESC,n.id DESC LIMIT 50"
    )
    .all(workspaceId, userId)
  const count = await getDatabase()
    .prepare<{
      count: number
    }>("SELECT count(*)::int count FROM mca_credit_notifications WHERE workspace_id=? AND recipient_user_id=? AND read_at IS NULL")
    .get(workspaceId, userId)
  return {
    unread: count?.count ?? 0,
    notifications: rows.map((r) => ({
      id: r.id,
      kind: r.kind,
      createdAt: r.created_at,
      readAt: r.read_at,
      emailState: r.email_state,
      ...unseal<CreditAlertPayload>(workspaceId, r.payload_cipher)
    }))
  }
}
export async function markCreditNotificationRead(
  workspaceId: string,
  userId: string,
  id: string
) {
  await getDatabase()
    .prepare(
      "UPDATE mca_credit_notifications SET read_at=COALESCE(read_at,?) WHERE id=? AND workspace_id=? AND recipient_user_id=?"
    )
    .run(nowIso(), id, workspaceId, userId)
}
async function currentAdmin(workspaceId: string, userId: string) {
  const r = await getDatabase()
    .prepare<{
      email: string
      clerk_user_id: string | null
      clerk_organization_id: string | null
    }>(
      "SELECT u.email,u.clerk_user_id,w.clerk_organization_id FROM memberships m JOIN users u ON u.id=m.user_id JOIN workspaces w ON w.id=m.workspace_id WHERE m.workspace_id=? AND m.user_id=? AND m.status='active' AND m.role IN ('admin','super_admin') LIMIT 1"
    )
    .get(workspaceId, userId)
  if (!r?.clerk_user_id || !r.clerk_organization_id) return null
  const client = getClerkClient()
  const user = await client.users.getUser(r.clerk_user_id)
  if (user.banned || user.locked) return null
  const members = await client.organizations.getOrganizationMembershipList({
    organizationId: r.clerk_organization_id,
    userId: [r.clerk_user_id],
    limit: 1
  })
  const email = user.emailAddresses.find(
    (e) =>
      e.id === user.primaryEmailAddressId &&
      e.verification?.status === "verified"
  )
  return members.data.length && email ? email.emailAddress : null
}
export async function deliverCreditAlerts(
  workspaceId?: string,
  options: {
    verifyRecipient?: typeof currentAdmin
    send?: typeof deliverEmail
  } = {}
) {
  // A process interrupted after claiming may have sent. Never automatically retry its uncertain delivery.
  await getDatabase()
    .prepare(
      "UPDATE mca_credit_alert_emails SET state='uncertain',error_code='delivery_interrupted' WHERE state='sending' AND updated_at<?"
    )
    .run(new Date(Date.now() - 120000).toISOString())
  const rows = await getDatabase()
    .prepare<{
      id: string
      workspace_id: string
      recipient_user_id: string
      kind: string
      payload_cipher: string
    }>(
      "SELECT n.* FROM mca_credit_notifications n JOIN mca_credit_alert_emails e ON e.id=n.id WHERE e.state IN ('queued','retry') AND e.next_attempt_at<=?" +
        (workspaceId ? " AND n.workspace_id=?" : "") +
        " ORDER BY n.created_at LIMIT 20"
    )
    .all(nowIso(), ...(workspaceId ? [workspaceId] : []))
  for (const n of rows) {
    if (!process.env.MCA_EMAIL_WEBHOOK_URL && !options.send) continue
    const claim = await getDatabase()
      .prepare<{
        attempts: number
      }>("UPDATE mca_credit_alert_emails SET state='sending',attempts=attempts+1,updated_at=? WHERE id=? AND state IN ('queued','retry') RETURNING attempts")
      .get(nowIso(), n.id)
    if (!claim) continue
    let dispatched = false
    try {
      // Local access is checked even when tests inject the remote identity verifier.
      const local = await getDatabase()
        .prepare(
          "SELECT id FROM memberships WHERE workspace_id=? AND user_id=? AND status='active' AND role IN ('admin','super_admin')"
        )
        .get(n.workspace_id, n.recipient_user_id)
      const email = local
        ? await (options.verifyRecipient ?? currentAdmin)(
            n.workspace_id,
            n.recipient_user_id
          )
        : null
      if (!email) {
        await getDatabase()
          .prepare(
            "UPDATE mca_credit_alert_emails SET state='skipped',updated_at=? WHERE id=?"
          )
          .run(nowIso(), n.id)
        continue
      }
      const payload = unseal<CreditAlertPayload>(
        n.workspace_id,
        n.payload_cipher
      )
      const origin = process.env.MCA_APP_ORIGIN
      if (!origin)
        throw new AppError(
          503,
          "email_origin_missing",
          "Configure the app origin for account email links."
        )
      dispatched = true
      const result = await (options.send ?? deliverEmail)(
        {
          recipient: email,
          template: "ai_credit_alert",
          actionUrl: new URL(
            `/assistant/credits?workspace=${encodeURIComponent(n.workspace_id)}&user=${encodeURIComponent(payload.userId)}`,
            origin
          ).toString(),
          expiresAt: payload.resetAt,
          data: { ...payload, kind: n.kind }
        },
        { correlationId: n.id }
      )
      await getDatabase()
        .prepare(
          "UPDATE mca_credit_alert_emails SET state=?,updated_at=?,error_code=NULL WHERE id=?"
        )
        .run(result.delivery, nowIso(), n.id)
    } catch (e) {
      const knownRejected =
        e instanceof AppError && e.code === "email_delivery_failed"
      const retry = (!dispatched || knownRejected) && claim.attempts < 3
      await getDatabase()
        .prepare(
          "UPDATE mca_credit_alert_emails SET state=?,updated_at=?,next_attempt_at=?,error_code=? WHERE id=?"
        )
        .run(
          retry
            ? "retry"
            : dispatched && !knownRejected
              ? "uncertain"
              : "failed",
          nowIso(),
          new Date(Date.now() + 60000 * claim.attempts).toISOString(),
          dispatched ? "email_delivery_error" : "recipient_verification_failed",
          n.id
        )
    }
  }
}
export async function maintainCreditAlerts(workspaceId?: string) {
  // Called after responses and by the dedicated worker. Business results never depend on delivery.
  await processCreditAlerts(workspaceId)
  await deliverCreditAlerts(workspaceId)
}
