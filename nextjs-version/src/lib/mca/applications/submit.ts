import "server-only"

import { actorForDeals } from "../deals/service"
import type { AuthContext } from "../types"
import { AppError } from "../errors"
import { attachIntakeDocument, ingestApplication } from "../intake/service"
import { associateIntakeIntegration, getIntegration } from "../intake/repository"
import { generateApplicationPdf } from "../documents/pdf"
import { scheduleIntakeProcessing } from "../intake/processing"
import { readRequiredStatementMonths } from "../underwriting/completeness-repository"
import { isDocumentReady } from "../documents/contracts"
import { claimInvitationSubmission, completeInvitationSubmission } from "./service"
import { getApplicationSession, requireActiveInvitation } from "./draft"
import { invitationFileBytes } from "./files"
import { formBranding } from "./provision"
import { stepError, visibleSteps } from "./form-schema"
import type { ApplicationSession } from "./contracts"

async function integrationActor(workspaceId: string) {
  const context: AuthContext = {
    authType: "api_key",
    userId: null,
    membershipId: null,
    workspaceId,
    role: null,
    scopes: ["intake:write", "deals:write"],
    sessionId: null,
  }
  return actorForDeals(context)
}

export async function submitFundlaneApplication(token: string): Promise<ApplicationSession> {
  const row = await requireActiveInvitation(token)
  if (row.provider !== "fundlane") throw new AppError(409, "form_not_native", "This invitation uses a connected form. Submit it on that form.")
  const session = await getApplicationSession(token)
  const branding = await formBranding(row.workspace_id, row.integration_id)
  for (const step of visibleSteps(branding.optionalFields)) {
    if (step.id === "welcome" || step.id === "review" || step.id === "statements" || step.id === "extras") continue
    const message = stepError(step.id, session.answers, branding.optionalFields)
    if (message) throw new AppError(422, "application_incomplete", message)
  }
  const months = await readRequiredStatementMonths(row.workspace_id)
  const statements = session.files.filter(file => file.category === "statement" && isDocumentReady(file.processingState))
  if (statements.length < months) {
    throw new AppError(422, "statements_required", `Upload at least ${months} recent bank statements.`)
  }
  if (session.files.some(file => ["quarantined", "scan_failed", "upload_failed", "pending_scan", "pending_upload"].includes(file.processingState))) {
    throw new AppError(422, "file_not_ready", "Wait for each upload to finish, and replace any blocked files, before submitting.")
  }
  const integration = await getIntegration(row.workspace_id, row.integration_id)
  if (!integration?.enabled) throw new AppError(409, "form_unavailable", "This application form is no longer active.")
  const eventId = `fundlane:${row.id}`
  const actor = await integrationActor(row.workspace_id)
  const answers = {
    ...session.answers,
    contactEmail: session.contactEmail,
    fieldSource: "api" as const,
    assignments: [{ membershipId: row.membership_id, kind: "originator" as const, isPrimary: true }],
  }
  const result = await withClaim(token, row.workspace_id, row.integration_id, eventId, async () => {
    const created = await ingestApplication(actor, {
      schemaVersion: 1,
      provider: "fundlane",
      eventId,
      application: answers,
      sourceReference: `fundlane:invitation:${row.id}`,
      initialStatus: integration.initialStatus,
    }, undefined, integration.id)
    await associateIntakeIntegration(row.workspace_id, created.intakeId, integration.id)
    return created
  })
  if (!result.dealId) throw new AppError(500, "deal_creation_failed", "The application could not create a deal.")
  const scoped = { ...actor, source: "system" as const, intakeDealId: result.dealId }
  for (const file of session.files) {
    const stored = await invitationFileBytes(row.workspace_id, row.id, file.id)
    await attachIntakeDocument(scoped, {
      intakeId: result.intakeId,
      attachmentId: file.id,
      filename: stored.filename,
      mimeType: stored.mimeType,
      bytes: stored.bytes,
      category: stored.category,
    })
  }
  await generateApplicationPdf(scoped, {
    dealId: result.dealId,
    idempotencyKey: `fundlane-pdf:${row.id}`,
    contactMode: "real",
  })
  try { await scheduleIntakeProcessing(25) } catch { /* the document worker retries */ }
  return getApplicationSession(token)
}

async function withClaim<T>(token: string, workspaceId: string, integrationId: string, eventId: string, work: () => Promise<T>): Promise<T> {
  const { withTransaction } = await import("../db")
  return withTransaction(async () => {
    const invitation = await claimInvitationSubmission(token, workspaceId, integrationId, eventId)
    const created = await work() as T & { intakeId: string; dealId: string | null }
    await completeInvitationSubmission(invitation, created.intakeId, created.dealId)
    return created
  })
}
