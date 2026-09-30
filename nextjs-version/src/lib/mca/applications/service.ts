import "server-only"

import { requireMembershipAccess } from "../auth"
import { createOpaqueToken, decryptSensitive, encryptSensitive, hashOpaqueToken } from "../crypto"
import { getDatabase, newId, nowIso, recordAuditEvent, withTransaction } from "../db"
import { actorForDeals } from "../deals/service"
import type { DealActor } from "../deals/schema"
import { deliverEmail, assertEmailDeliveryConfigured, transactionalEmailReady, transactionalSystemEmailEnabled } from "../email"
import { AppError } from "../errors"
import { requestCorrelationId } from "../http"
import { enqueueBackgroundJob, type BackgroundJob } from "../jobs/queue"
import { effectivePageVisibility, isActionAllowed } from "../policy"
import { getWorkspaceSettings } from "../workspaces"
import { invitationInput, reconcileDeliveryInput, type ApplicationInvitation, type InvitationDelivery } from "./contracts"
import { emailSenderVerified } from "../intake/email-readiness"

export interface InvitationRecord {
  id: string; workspace_id: string; integration_id: string; membership_id: string; client_name: string
  email_cipher: string; token_cipher: string; token_hash: string; request_key: string
  created_at: string; expires_at: string; revoked_at: string | null; copied_at: string | null
  sent_at: string | null; opened_at: string | null; started_at: string | null; submitted_at: string | null
  submission_event_id: string | null; intake_id: string | null; deal_id: string | null
  form_id: string; current_form_id: string; form_name: string; employee_name: string; member_status: string; enabled: number
  intake_error: string | null; provider: string; draft_cipher: string | null; requested_amount_cents: number | null
  last_step: string | null; last_activity_at: string | null; reminder_count: number; reminded_at: string | null
  business_name: string | null
}
const selection = `SELECT a.*, i.form_id AS current_form_id, i.display_name AS form_name, i.enabled, i.provider, u.name AS employee_name,
  m.status AS member_status, e.error_message AS intake_error FROM mca_application_invitations a
  JOIN intake_integrations i ON i.id=a.integration_id AND i.workspace_id=a.workspace_id
  JOIN memberships m ON m.id=a.membership_id AND m.workspace_id=a.workspace_id
  JOIN users u ON u.id=m.user_id
  LEFT JOIN intake_events e ON e.id=a.intake_id AND e.workspace_id=a.workspace_id`
const admin = (actor: DealActor) => actor.role === "admin" || actor.role === "super_admin"
export function invitationRuntimeEnabled(): boolean {
  return process.env.MCA_JOB_RUNTIME === "vercel_cron" && process.env.MCA_INVITATION_JOB_RUNTIME === "vercel_cron"
}
function requiresDeliveryReconciliation(delivery: { state: string; delivery: string | null; attempts: number; error_code: string | null; result_json: string | null }): boolean {
  return delivery.state === "failed" && !delivery.delivery && isVercelDeliveryAttempt(delivery.result_json)
}
function invalidLink(): AppError { return new AppError(410, "invitation_inactive", "This application link is expired, completed, or no longer active. Ask your representative for a new link.") }

export async function assertApplicationAccess(actor: DealActor, write = false): Promise<void> {
  await (await import("../company-access")).assertCompanyOperational(actor.workspaceId)
  if (actor.source !== "user" || !actor.role || !actor.membershipId || !actor.userId) throw new AppError(403, "session_required", "Sign in to manage applications.")
  const member = await getDatabase().prepare<{ role: string }>("SELECT role FROM memberships WHERE workspace_id=? AND id=? AND user_id=? AND status='active'").get(actor.workspaceId, actor.membershipId, actor.userId)
  if (!member || member.role !== actor.role) throw new AppError(403, "membership_changed", "Your access changed. Refresh and try again.")
  const settings = await getWorkspaceSettings(actor.workspaceId)
  if (!effectivePageVisibility(actor.role, settings.pageVisibility, settings.featureFlags).deals || (write && !isActionAllowed(actor.role, "createDeal", settings.actionVisibility))) {
    throw new AppError(403, "applications_disabled", "Application access is disabled for your account.")
  }
}
export async function requireApplicationActor(request: Request, write = false): Promise<DealActor> {
  const actor = { ...await actorForDeals(await requireMembershipAccess(request)), correlationId: requestCorrelationId(request) }
  await assertApplicationAccess(actor, write)
  return actor
}
export async function availableApplicationForms(actor: DealActor) {
  await assertApplicationAccess(actor)
  const { ensureFundlaneForm } = await import("./provision")
  await ensureFundlaneForm(actor)
  return getDatabase().prepare<{ id: string; name: string; formId: string; provider: string }>(
    `SELECT id,display_name AS name,form_id AS "formId",provider FROM intake_integrations
     WHERE workspace_id=? AND enabled=1 AND form_id IS NOT NULL AND provider IN ('fundlane','jotform')
     ORDER BY CASE provider WHEN 'fundlane' THEN 0 ELSE 1 END, display_name`,
  ).all(actor.workspaceId)
}
export function invitationActive(row: InvitationRecord): boolean {
  return !row.revoked_at && row.member_status === "active" && row.enabled === 1 && row.form_id === row.current_form_id && row.expires_at > nowIso() && !row.submitted_at
}
export async function ownedInvitation(actor: DealActor, id: string, lock = false): Promise<InvitationRecord> {
  await assertApplicationAccess(actor)
  const row = await getDatabase().prepare<InvitationRecord>(`${selection} WHERE a.workspace_id=? AND a.id=?${lock ? " FOR UPDATE OF a" : ""}`).get(actor.workspaceId, id)
  if (!row || (!admin(actor) && row.membership_id !== actor.membershipId)) throw new AppError(404, "invitation_not_found", "Application invitation not found.")
  return row
}
export async function listApplicationInvitations(actor: DealActor): Promise<ApplicationInvitation[]> {
  await assertApplicationAccess(actor)
  const rows = await getDatabase().prepare<InvitationRecord>(`${selection} WHERE a.workspace_id=?${admin(actor) ? "" : " AND a.membership_id=?"} ORDER BY a.created_at DESC,a.id DESC`).all(actor.workspaceId, ...(admin(actor) ? [] : [actor.membershipId]))
  const deliveries = await getDatabase().prepare<{ invitation_id: string; id: string; purpose: string; created_at: string; accepted_at: string | null; delivery: InvitationDelivery["delivery"]; state: InvitationDelivery["state"]; error_code: string | null; attempts: number; result_json: string | null }>(`SELECT d.*, j.state, j.error_code, j.attempts, j.result_json FROM mca_application_invitation_deliveries d
    JOIN mca_application_invitations a ON a.id=d.invitation_id AND a.workspace_id=d.workspace_id
    JOIN mca_background_jobs j ON j.id=d.job_id AND j.workspace_id=d.workspace_id
    WHERE a.workspace_id=?${admin(actor) ? "" : " AND a.membership_id=?"} ORDER BY d.created_at DESC,d.id DESC`).all(actor.workspaceId, ...(admin(actor) ? [] : [actor.membershipId]))
  return rows.map(row => ({
    id: row.id, membershipId: row.membership_id, employeeName: row.employee_name, clientName: row.client_name,
    businessName: row.business_name || row.client_name,
    email: decryptSensitive(row.email_cipher, row.workspace_id), formName: row.form_name, provider: row.provider,
    createdAt: row.created_at, expiresAt: row.expires_at, revokedAt: row.revoked_at, copiedAt: row.copied_at, sentAt: row.sent_at,
    openedAt: row.opened_at, startedAt: row.started_at, submittedAt: row.submitted_at, active: invitationActive(row),
    requestedAmountCents: row.requested_amount_cents, lastStep: row.last_step, reminderCount: Number(row.reminder_count ?? 0),
    intakeId: row.intake_id, intakeError: row.intake_error, dealId: row.deal_id,
    deliveries: deliveries.filter(d => d.invitation_id === row.id).map(d => ({ id: d.id, createdAt: d.created_at, acceptedAt: d.accepted_at, delivery: d.delivery, state: d.delivery ? "complete" : d.state, errorCode: d.delivery ? null : d.error_code,
      requiresReconciliation: requiresDeliveryReconciliation(d),
      failedNotSent: d.state === "failed" && !d.delivery && isVercelClaim(d.result_json) && !isVercelDeliveryAttempt(d.result_json),
    })),
  }))
}
export async function createApplicationInvitation(actor: DealActor, input: unknown): Promise<{ id: string }> {
  await assertApplicationAccess(actor, true)
  const parsed = invitationInput.safeParse(input)
  if (!parsed.success) throw new AppError(422, "invalid_invitation", "Enter a client name, valid email, and application form.")
  const value = parsed.data
  const forms = await availableApplicationForms(actor)
  const form = forms.find(form => form.id === value.integrationId)
  if (!form) throw new AppError(422, "form_unavailable", "Choose an enabled application form for your company.")
  const token = createOpaqueToken(), id = newId(), createdAt = nowIso()
  const row = await getDatabase().prepare<InvitationRecord>(`INSERT INTO mca_application_invitations
    (id,workspace_id,integration_id,form_id,membership_id,client_name,email_cipher,token_hash,token_cipher,request_key,created_at,expires_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(workspace_id,membership_id,request_key) DO UPDATE SET request_key=EXCLUDED.request_key RETURNING *`)
    .get(id, actor.workspaceId, value.integrationId, form.formId, actor.membershipId, value.clientName, encryptSensitive(value.email, actor.workspaceId), hashOpaqueToken(token), encryptSensitive(token, actor.workspaceId), value.requestKey, createdAt, new Date(Date.parse(createdAt) + 30 * 86400000).toISOString())
  if (!row) throw new Error("invitation_insert_failed")
  if (row.client_name !== value.clientName || row.integration_id !== value.integrationId || decryptSensitive(row.email_cipher, row.workspace_id) !== value.email) throw new AppError(409, "invitation_conflict", "This request was already used for another invitation.")
  return { id: row.id }
}
export function invitationUrl(row: InvitationRecord, origin: string): string {
  const url = new URL(`/apply/${encodeURIComponent(row.form_id)}`, origin)
  url.searchParams.set("mca_invite", decryptSensitive(row.token_cipher, row.workspace_id))
  return url.toString()
}
export async function copyApplicationLink(actor: DealActor, id: string, origin: string): Promise<{ url: string }> {
  await assertApplicationAccess(actor, true)
  const row = await ownedInvitation(actor, id)
  if (!invitationActive(row)) throw invalidLink()
  await getDatabase().prepare("UPDATE mca_application_invitations SET copied_at=COALESCE(copied_at,?) WHERE workspace_id=? AND id=?").run(nowIso(), actor.workspaceId, id)
  return { url: invitationUrl(row, origin) }
}
export async function resolveApplicationInvitation(token: string): Promise<InvitationRecord | undefined> {
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return undefined
  return getDatabase().prepare<InvitationRecord>(`${selection} WHERE a.token_hash=?`).get(hashOpaqueToken(token))
}
export async function trackApplicationInvitation(token: string, kind: "opened" | "started"): Promise<void> {
  await withTransaction(async () => {
    const row = await resolveApplicationInvitation(token)
    if (!row || !invitationActive(row)) throw invalidLink()
    const at = nowIso()
    // First observation wins. A start implies an open even if the open request arrived late.
    for (const event of kind === "started" ? ["opened", "started"] as const : ["opened"] as const) {
      await getDatabase().prepare("INSERT INTO mca_application_invitation_events(invitation_id,workspace_id,kind,occurred_at) VALUES (?,?,?,?) ON CONFLICT(invitation_id,kind) DO NOTHING").run(row.id, row.workspace_id, event, at)
      const column = event === "opened" ? "opened_at" : "started_at"
      await getDatabase().prepare(`UPDATE mca_application_invitations SET ${column}=COALESCE(${column},?) WHERE workspace_id=? AND id=?`).run(at, row.workspace_id, row.id)
    }
  })
}
/** Called inside the same transaction as deal intake, so competing submissions cannot claim one invitation. */
export async function claimInvitationSubmission(token: string, workspaceId: string, integrationId: string, eventId: string): Promise<InvitationRecord> {
  const row = await resolveApplicationInvitation(token)
  if (!row || row.workspace_id !== workspaceId || row.integration_id !== integrationId) throw new AppError(422, "invitation_quarantined", "The invitation is invalid or belongs to another company or form.")
  const retry = row.submission_event_id === eventId
  if (!retry && !invitationActive(row)) throw new AppError(422, "invitation_quarantined", "The invitation expired, was revoked, or is no longer active.")
  const claimed = await getDatabase().prepare<{ id: string }>(`UPDATE mca_application_invitations SET submission_event_id=?
    WHERE workspace_id=? AND id=? AND (submission_event_id IS NULL OR submission_event_id=?) RETURNING id`).get(eventId, workspaceId, row.id, eventId)
  if (!claimed) throw new AppError(422, "invitation_quarantined", "This invitation already belongs to another application. Create a new invitation.")
  return row
}
export async function completeInvitationSubmission(row: InvitationRecord, intakeId: string, dealId: string | null): Promise<void> {
  await getDatabase().prepare(`UPDATE mca_application_invitations SET intake_id=?,deal_id=?,submitted_at=COALESCE(submitted_at,?) WHERE workspace_id=? AND id=?`)
    .run(intakeId, dealId, nowIso(), row.workspace_id, row.id)
}

export function invitationEmailEnabled(): boolean {
  return process.env.MCA_APPLICATION_INVITATION_EMAIL_ENABLED === "true" && emailSenderVerified()
    && ((Boolean(process.env.MCA_EMAIL_WEBHOOK_URL) && Boolean(process.env.MCA_EMAIL_WEBHOOK_TOKEN)) || (transactionalSystemEmailEnabled() && transactionalEmailReady()) || process.env.NODE_ENV !== "production")
}
function assertInvitationEmailEnabled(): void {
  if (!invitationEmailEnabled()) throw new AppError(503, "invitation_email_disabled", "Application emails need a verified sender and receiver. Ask an administrator to complete email setup, or copy the link.")
  assertEmailDeliveryConfigured()
}
export async function queueInvitationEmail(actor: DealActor, id: string, requestKey: string, origin: string): Promise<{ jobId: string }> {
  await assertApplicationAccess(actor, true)
  assertInvitationEmailEnabled()
  return withTransaction(async () => {
    const row = await ownedInvitation(actor, id, true)
    if (!invitationActive(row)) throw invalidLink()
    const prior = await getDatabase().prepare<{ id: string; job_id: string; state: string; delivery: string | null; attempts: number; error_code: string | null; result_json: string | null }>(`SELECT d.id,d.job_id,d.delivery,j.state,j.attempts,j.error_code,j.result_json FROM mca_application_invitation_deliveries d JOIN mca_background_jobs j ON j.id=d.job_id
      WHERE d.invitation_id=? ORDER BY d.created_at DESC,d.id DESC LIMIT 1`).get(id)
    if (prior && !prior.delivery && ["queued", "running"].includes(prior.state)) return { jobId: prior.job_id }
    if (prior?.state === "failed" && !prior.delivery) {
      if (isVercelDeliveryAttempt(prior.result_json)) {
        throw new AppError(409, "delivery_uncertain", "Reconcile the prior invitation delivery with the email provider before another send.")
      } else if (isVercelClaim(prior.result_json) || invitationRuntimeEnabled() && (prior.error_code === "outbound_review_required" || prior.error_code === "company_paused" && prior.attempts === 0)) {
        // A claimed Vercel job with no provider-attempt marker never reached the
        // provider. The freshness error is also raised before dispatch. A new job
        // carries fresh approval and a fresh 24-hour window.
      } else {
        await getDatabase().prepare("UPDATE mca_background_jobs SET state='queued',attempts=0,error_code=NULL,available_at=?,updated_at=?,actor_json=? WHERE id=? AND workspace_id=? AND state='failed'")
          .run(nowIso(), nowIso(), JSON.stringify(actor), prior.job_id, actor.workspaceId)
        return { jobId: prior.job_id }
      }
    }
    const same = await getDatabase().prepare<{ job_id: string }>("SELECT job_id FROM mca_application_invitation_deliveries WHERE invitation_id=? AND request_key=?").get(id, requestKey)
    if (same) return { jobId: same.job_id }
    const deliveryId = newId()
    await getDatabase().prepare("INSERT INTO mca_application_invitation_deliveries(id,invitation_id,workspace_id,request_key,purpose,created_at) VALUES (?,?,?,?,?,?)").run(deliveryId, id, actor.workspaceId, requestKey, "invite", nowIso())
    const job = await enqueueBackgroundJob({ actor, kind: "application_invitation_email", resourceId: deliveryId, idempotencyKey: deliveryId, payload: { origin } })
    await getDatabase().prepare("UPDATE mca_application_invitation_deliveries SET job_id=? WHERE id=?").run(job.id, deliveryId)
    return { jobId: job.id }
  })
}
export function isVercelDeliveryAttempt(resultJson: string | null): boolean {
  if (!resultJson) return false
  try { const value = JSON.parse(resultJson) as { deliveryRuntime?: string; providerAttempt?: boolean }; return value.deliveryRuntime === "vercel_cron" && value.providerAttempt !== false } catch { return false }
}
export function isVercelClaim(resultJson: string | null): boolean {
  if (!resultJson) return false
  try { return (JSON.parse(resultJson) as { deliveryRuntime?: string }).deliveryRuntime === "vercel_cron" } catch { return false }
}
export async function markVercelInvitationClaim(job: BackgroundJob): Promise<string | null> {
  if (!invitationRuntimeEnabled()) return job.result_json
  const saved = await getDatabase().prepare<{ result_json: string }>("UPDATE mca_background_jobs SET result_json=COALESCE(result_json,?) WHERE workspace_id=? AND id=? AND state='running' AND lease_token=? RETURNING result_json")
    .get(JSON.stringify({ deliveryRuntime: "vercel_cron", providerAttempt: false }), job.workspace_id, job.id, job.lease_token)
  if (!saved) throw new Error("background_job_lease_lost")
  return saved.result_json
}
export async function markVercelDeliveryAttempt(job: BackgroundJob): Promise<void> {
  if (!isVercelClaim(job.result_json) && !invitationRuntimeEnabled()) return
  const saved = await getDatabase().prepare("UPDATE mca_background_jobs SET result_json=? WHERE workspace_id=? AND id=? AND state='running' AND lease_token=?")
    .run(JSON.stringify({ deliveryRuntime: "vercel_cron", providerAttempt: true }), job.workspace_id, job.id, job.lease_token)
  if (!saved.changes) throw new Error("background_job_lease_lost")
}
export async function reconcileInvitationDelivery(actor: DealActor, invitationId: string, input: unknown): Promise<void> {
  await assertApplicationAccess(actor, true)
  if (!admin(actor)) throw new AppError(403, "admin_required", "An administrator must reconcile email delivery.")
  const parsed = reconcileDeliveryInput.safeParse(input)
  if (!parsed.success) throw new AppError(422, "invalid_reconciliation", "Choose a provider outcome and enter a receipt or lookup reference (at least 10 characters).")
  const { deliveryId, outcome, evidence } = parsed.data
  await withTransaction(async () => {
    const invitation = await ownedInvitation(actor, invitationId, true)
    const delivery = await getDatabase().prepare<{ job_id: string; purpose: string; state: string; delivery: string | null; attempts: number; error_code: string | null; result_json: string | null }>(`SELECT d.job_id,d.purpose,j.state,d.delivery,j.attempts,j.error_code,j.result_json FROM mca_application_invitation_deliveries d
      JOIN mca_background_jobs j ON j.id=d.job_id AND j.workspace_id=d.workspace_id
      WHERE d.workspace_id=? AND d.invitation_id=? AND d.id=? FOR UPDATE OF d,j`).get(actor.workspaceId, invitationId, deliveryId)
    if (!delivery || !requiresDeliveryReconciliation(delivery)) throw new AppError(409, "reconciliation_unavailable", "This delivery is not an uncertain failed send.")
    const latest = await getDatabase().prepare<{ id: string }>("SELECT id FROM mca_application_invitation_deliveries WHERE workspace_id=? AND invitation_id=? ORDER BY created_at DESC,id DESC LIMIT 1").get(actor.workspaceId, invitationId)
    if (latest?.id !== deliveryId) throw new AppError(409, "reconciliation_unavailable", "Review the latest delivery before reconciling another attempt.")
    if (outcome === "not_sent" && !invitationActive(invitation)) throw invalidLink()
    const at = nowIso()
    if (outcome === "accepted") {
      await getDatabase().prepare("UPDATE mca_application_invitation_deliveries SET delivery='sent',accepted_at=? WHERE workspace_id=? AND id=?").run(at, actor.workspaceId, deliveryId)
      if (delivery.purpose === "invite") await getDatabase().prepare("UPDATE mca_application_invitations SET sent_at=COALESCE(sent_at,?) WHERE workspace_id=? AND id=?").run(at, actor.workspaceId, invitationId)
      else {
        await getDatabase().prepare("UPDATE mca_application_invitations SET reminder_count=reminder_count+1,reminded_at=? WHERE workspace_id=? AND id=?").run(at, actor.workspaceId, invitationId)
        await getDatabase().prepare("INSERT INTO mca_application_invitation_events(invitation_id,workspace_id,kind,occurred_at) VALUES (?,?,?,?) ON CONFLICT(invitation_id,kind) DO NOTHING")
          .run(invitationId, actor.workspaceId, "reminded", at)
      }
      await getDatabase().prepare("UPDATE mca_background_jobs SET state='complete',result_json=?,error_code=NULL,updated_at=? WHERE workspace_id=? AND id=?")
        .run(JSON.stringify({ delivery: "sent", reconciled: true }), at, actor.workspaceId, delivery.job_id)
    } else {
      // Reuse the provider correlation/idempotency key. The current admin's approval
      // replaces the stale actor, while the delivery's original identity stays fixed.
      await getDatabase().prepare(`UPDATE mca_background_jobs SET state='queued',attempts=0,error_code=NULL,
        lease_token=NULL,lease_expires_at=NULL,available_at=?,created_at=?,updated_at=?,actor_json=? WHERE workspace_id=? AND id=?`)
        .run(at, at, at, JSON.stringify(actor), actor.workspaceId, delivery.job_id)
    }
    await recordAuditEvent({ context: actor, action: "application_invitation_delivery_reconciled", resourceType: "application_invitation_delivery", resourceId: deliveryId,
      metadata: { invitationId, jobId: delivery.job_id, purpose: delivery.purpose, outcome, evidence }, correlationId: actor.correlationId })
  })
}
export async function processInvitationEmail(actor: DealActor, job: BackgroundJob): Promise<{ delivery: "sent" | "preview" }> {
  await assertApplicationAccess(actor, true)
  const attempt = await getDatabase().prepare<{ invitation_id: string; delivery: "sent" | "preview" | null }>("SELECT invitation_id,delivery FROM mca_application_invitation_deliveries WHERE workspace_id=? AND id=? AND job_id=?").get(actor.workspaceId, job.resource_id, job.id)
  if (!attempt) throw new AppError(404, "delivery_not_found", "Invitation delivery not found.")
  if (attempt.delivery) return { delivery: attempt.delivery }
  if (isVercelDeliveryAttempt(job.result_json) && job.attempts > 1) throw new AppError(409, "delivery_uncertain", "The previous invitation send may have reached the provider. Reconcile its correlation ID before retrying.")
  const row = await ownedInvitation(actor, attempt.invitation_id)
  if (!invitationActive(row)) throw invalidLink()
  assertInvitationEmailEnabled()
  const { origin } = JSON.parse(job.payload_json) as { origin: string }
  await markVercelDeliveryAttempt(job)
  const result = await deliverEmail({ recipient: decryptSensitive(row.email_cipher, row.workspace_id), template: "application_invitation",
    actionUrl: invitationUrl(row, origin), expiresAt: row.expires_at,
    data: { clientName: row.client_name, employeeName: row.employee_name, formName: row.form_name } }, { correlationId: job.resource_id, workspaceId: actor.workspaceId, approvedAt: job.created_at })
  await withTransaction(async () => {
    await getDatabase().prepare("UPDATE mca_application_invitation_deliveries SET delivery=?,accepted_at=? WHERE workspace_id=? AND id=?").run(result.delivery, result.delivery === "sent" ? nowIso() : null, row.workspace_id, job.resource_id)
    if (result.delivery === "sent") await getDatabase().prepare("UPDATE mca_application_invitations SET sent_at=COALESCE(sent_at,?) WHERE workspace_id=? AND id=?").run(nowIso(), row.workspace_id, row.id)
  })
  return { delivery: result.delivery }
}
