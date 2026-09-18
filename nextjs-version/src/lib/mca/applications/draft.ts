import "server-only"

import { decryptSensitive, encryptSensitive } from "../crypto"
import { getDatabase, nowIso, withTransaction } from "../db"
import { AppError } from "../errors"
import { readRequiredStatementMonths } from "../underwriting/completeness-repository"
import type { ApplicationSession } from "./contracts"
import { dollarsToCents, emptyDraft, INVITE_TOKEN_PATTERN, isFunnelStep, sanitizeAnswers, type FunnelStepId, type InvitationDraft } from "./form-schema"
import { formBranding } from "./provision"
import { invitationActive, resolveApplicationInvitation, type InvitationRecord } from "./service"

function parseDraft(row: InvitationRecord): InvitationDraft {
  if (!row.draft_cipher) return emptyDraft()
  try {
    const parsed = JSON.parse(decryptSensitive(row.draft_cipher, row.workspace_id)) as InvitationDraft
    if (parsed?.schemaVersion !== 1) return emptyDraft()
    return {
      schemaVersion: 1,
      step: isFunnelStep(parsed.step) ? parsed.step : "welcome",
      answers: sanitizeAnswers(parsed.answers),
      updatedAt: parsed.updatedAt || nowIso(),
    }
  } catch {
    return emptyDraft()
  }
}

async function requireActiveInvitation(token: string): Promise<InvitationRecord> {
  if (!INVITE_TOKEN_PATTERN.test(token)) throw new AppError(410, "invitation_inactive", "This application link is expired, completed, or no longer active. Ask your representative for a new link.")
  const row = await resolveApplicationInvitation(token)
  if (!row || !invitationActive(row)) throw new AppError(410, "invitation_inactive", "This application link is expired, completed, or no longer active. Ask your representative for a new link.")
  return row
}

export async function listInvitationFiles(invitationId: string) {
  return getDatabase().prepare<{
    id: string; category: ApplicationSession["files"][number]["category"]; filename: string
    processing_state: string; byte_length: number; created_at: string
  }>("SELECT id,category,filename,processing_state,byte_length,created_at FROM mca_application_invitation_files WHERE invitation_id=? ORDER BY created_at,id").all(invitationId)
}

export async function getApplicationSession(token: string): Promise<ApplicationSession> {
  const row = await resolveApplicationInvitation(token)
  if (!row || (row.form_id !== row.current_form_id && !row.submitted_at)) {
    throw new AppError(410, "invitation_inactive", "This application link is expired, completed, or no longer active. Ask your representative for a new link.")
  }
  if (!row.submitted_at && !invitationActive(row)) {
    throw new AppError(410, "invitation_inactive", "This application link is expired, completed, or no longer active. Ask your representative for a new link.")
  }
  const draft = parseDraft(row)
  const files = await listInvitationFiles(row.id)
  const branding = await formBranding(row.workspace_id, row.integration_id)
  return {
    provider: row.provider,
    formId: row.form_id,
    clientName: row.client_name,
    employeeName: row.employee_name,
    contactEmail: decryptSensitive(row.email_cipher, row.workspace_id),
    submitted: Boolean(row.submitted_at),
    expiresAt: row.expires_at,
    step: draft.step,
    answers: { ...draft.answers, contactEmail: decryptSensitive(row.email_cipher, row.workspace_id), contactName: draft.answers.contactName },
    files: files.map(file => ({
      id: file.id, category: file.category, filename: file.filename,
      processingState: file.processing_state, byteLength: file.byte_length, createdAt: file.created_at,
    })),
    requiredStatementMonths: await readRequiredStatementMonths(row.workspace_id),
    branding,
  }
}

export async function saveApplicationDraft(token: string, step: string, answers: unknown): Promise<ApplicationSession> {
  const row = await requireActiveInvitation(token)
  if (row.provider !== "fundlane") throw new AppError(409, "form_not_native", "This invitation uses a connected form and cannot save progress here.")
  if (!isFunnelStep(step)) throw new AppError(422, "invalid_step", "Choose a valid application step.")
  const next: InvitationDraft = {
    schemaVersion: 1,
    step: step as FunnelStepId,
    answers: sanitizeAnswers(answers),
    updatedAt: nowIso(),
  }
  const cents = dollarsToCents(next.answers.requestedAmount)
  await withTransaction(async () => {
    await getDatabase().prepare(`UPDATE mca_application_invitations SET draft_cipher=?, last_step=?, last_activity_at=?,
      requested_amount_cents=COALESCE(?, requested_amount_cents), business_name=COALESCE(?, business_name)
      WHERE workspace_id=? AND id=?`).run(
      encryptSensitive(JSON.stringify(next), row.workspace_id), next.step, next.updatedAt, cents,
      next.answers.legalName ?? null, row.workspace_id, row.id,
    )
    await getDatabase().prepare("INSERT INTO mca_application_invitation_events(invitation_id,workspace_id,kind,occurred_at) VALUES (?,?,?,?) ON CONFLICT(invitation_id,kind) DO NOTHING")
      .run(row.id, row.workspace_id, "drafted", next.updatedAt)
  })
  return getApplicationSession(token)
}

export { parseDraft, requireActiveInvitation }
