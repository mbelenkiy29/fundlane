import "server-only"

import { decryptSensitive } from "../crypto"
import { getDatabase, newId, nowIso, withTransaction } from "../db"
import { actorForDeals } from "../deals/service"
import { assertEmailDeliveryConfigured } from "../email"
import { AppError } from "../errors"
import { enqueueBackgroundJob, type BackgroundJob } from "../jobs/queue"
import { invitationActive, invitationEmailEnabled as emailEnabled, invitationUrl, isVercelDeliveryAttempt, deliverInvitationEmail, type InvitationRecord } from "./service"

const CADENCE_MS = [2 * 3600_000, 24 * 3600_000, 72 * 3600_000]

function invitationEmailEnabled(): void {
  if (!emailEnabled()) {
    throw new AppError(503, "invitation_email_disabled", "Application emails are not enabled yet.")
  }
  assertEmailDeliveryConfigured()
}

function dueForReminder(row: { reminder_count: number; last_activity_at: string | null }, now: Date): boolean {
  if (!row.last_activity_at || row.reminder_count >= CADENCE_MS.length) return false
  const elapsed = now.getTime() - Date.parse(row.last_activity_at)
  return elapsed >= CADENCE_MS[row.reminder_count]
}

export async function scheduleDueInvitationReminders(origin: string, asOf = new Date()): Promise<number> {
  if (!origin) return 0
  try { invitationEmailEnabled() } catch { return 0 }
  const now = asOf.toISOString()
  const rows = await getDatabase().prepare<InvitationRecord & { reminder_count: number }>(
    `SELECT a.*, i.form_id AS current_form_id, i.display_name AS form_name, i.enabled, i.provider, u.name AS employee_name,
            m.status AS member_status, NULL AS intake_error
     FROM mca_application_invitations a
     JOIN intake_integrations i ON i.id=a.integration_id AND i.workspace_id=a.workspace_id
     JOIN memberships m ON m.id=a.membership_id AND m.workspace_id=a.workspace_id
     JOIN users u ON u.id=m.user_id
     WHERE a.submitted_at IS NULL AND a.revoked_at IS NULL AND a.expires_at>? AND a.last_activity_at IS NOT NULL
       AND a.reminder_count < 3 AND i.enabled=1 AND (a.started_at IS NOT NULL OR a.last_step IS NOT NULL)`,
  ).all(now)
  let queued = 0
  for (const row of rows) {
    if (!invitationActive(row) || !dueForReminder(row, asOf)) continue
    const operational = (await (await import("../company-access")).getCompanyAccess(row.workspace_id)).allowed
    const actor = await actorForDeals({
      authType: "api_key", workspaceId: row.workspace_id, userId: null, membershipId: null, role: null, scopes: [], sessionId: null,
    })
    const system = { ...actor, source: "system" as const }
    const requestKey = `reminder:${row.id}:${Number(row.reminder_count) + 1}`
    await withTransaction(async () => {
      const same = await getDatabase().prepare<{ job_id: string }>("SELECT job_id FROM mca_application_invitation_deliveries WHERE invitation_id=? AND request_key=?").get(row.id, requestKey)
      if (same) return
      const deliveryId = newId()
      await getDatabase().prepare("INSERT INTO mca_application_invitation_deliveries(id,invitation_id,workspace_id,request_key,purpose,created_at) VALUES (?,?,?,?,?,?)")
        .run(deliveryId, row.id, row.workspace_id, requestKey, "reminder", nowIso())
      const job = await enqueueBackgroundJob({ actor: system, kind: "application_invitation_reminder", resourceId: deliveryId, idempotencyKey: deliveryId, payload: { origin } })
      await getDatabase().prepare("UPDATE mca_application_invitation_deliveries SET job_id=? WHERE id=?").run(job.id, deliveryId)
      // Consume only the cadence identity, not an attempt or a successful-send
      // count. An overdue reminder observed during pause never catches up later.
      if (!operational) await getDatabase().prepare("UPDATE mca_background_jobs SET state='failed',error_code='company_paused',updated_at=? WHERE id=? AND state='queued'").run(nowIso(), job.id)
      queued++
    })
  }
  return queued
}

export async function processInvitationReminder(job: BackgroundJob): Promise<{ delivery: "sent" | "preview" | "skipped" }> {
  await (await import("../company-access")).assertCompanyOperational(job.workspace_id)
  const attempt = await getDatabase().prepare<{ invitation_id: string; delivery: "sent" | "preview" | null }>(
    "SELECT invitation_id,delivery FROM mca_application_invitation_deliveries WHERE workspace_id=? AND id=? AND job_id=?",
  ).get(job.workspace_id, job.resource_id, job.id)
  if (!attempt) throw new AppError(404, "delivery_not_found", "Invitation reminder not found.")
  if (attempt.delivery) return { delivery: attempt.delivery }
  if (isVercelDeliveryAttempt(job.result_json) && job.attempts > 1) throw new AppError(409, "delivery_uncertain", "The previous reminder may have reached the provider. Reconcile its correlation ID before retrying.")
  const row = await resolveApplicationInvitationFromId(job.workspace_id, attempt.invitation_id)
  const scheduledAt = row?.last_activity_at ? Date.parse(row.last_activity_at) + (CADENCE_MS[row.reminder_count] ?? 0) : NaN
  if (!row || !invitationActive(row) || row.submitted_at || !dueForReminder(row, new Date()) || !Number.isFinite(scheduledAt) || Date.now() - scheduledAt > 24 * 3600_000) {
    await getDatabase().prepare("UPDATE mca_application_invitation_deliveries SET delivery='preview',accepted_at=? WHERE workspace_id=? AND id=?")
      .run(nowIso(), job.workspace_id, job.resource_id)
    return { delivery: "skipped" }
  }
  invitationEmailEnabled()
  await (await import("../outbound-approval")).assertOutboundDispatch(job.workspace_id, new Date(scheduledAt).toISOString())
  const { origin } = JSON.parse(job.payload_json) as { origin: string }
  const result = await deliverInvitationEmail(job, {
    recipient: decryptSensitive(row.email_cipher, row.workspace_id),
    template: "application_invitation_reminder",
    actionUrl: invitationUrl(row, origin),
    expiresAt: row.expires_at,
    data: {
      clientName: row.client_name,
      employeeName: row.employee_name,
      formName: row.form_name,
      lastStep: row.last_step,
    },
  }, { correlationId: job.resource_id, workspaceId: job.workspace_id, approvedAt: job.created_at })
  await withTransaction(async () => {
    await getDatabase().prepare("UPDATE mca_application_invitation_deliveries SET delivery=?,accepted_at=? WHERE workspace_id=? AND id=?")
      .run(result.delivery, result.delivery === "sent" ? nowIso() : null, row.workspace_id, job.resource_id)
    await getDatabase().prepare("UPDATE mca_application_invitations SET reminder_count=reminder_count+1, reminded_at=? WHERE workspace_id=? AND id=?")
      .run(nowIso(), row.workspace_id, row.id)
    await getDatabase().prepare("INSERT INTO mca_application_invitation_events(invitation_id,workspace_id,kind,occurred_at) VALUES (?,?,?,?) ON CONFLICT(invitation_id,kind) DO NOTHING")
      .run(row.id, row.workspace_id, "reminded", nowIso())
  })
  return { delivery: result.delivery }
}

async function resolveApplicationInvitationFromId(workspaceId: string, id: string): Promise<InvitationRecord | undefined> {
  return getDatabase().prepare<InvitationRecord>(
    `SELECT a.*, i.form_id AS current_form_id, i.display_name AS form_name, i.enabled, i.provider, u.name AS employee_name,
            m.status AS member_status, NULL AS intake_error
     FROM mca_application_invitations a
     JOIN intake_integrations i ON i.id=a.integration_id AND i.workspace_id=a.workspace_id
     JOIN memberships m ON m.id=a.membership_id AND m.workspace_id=a.workspace_id
     JOIN users u ON u.id=m.user_id
     WHERE a.workspace_id=? AND a.id=?`,
  ).get(workspaceId, id)
}
