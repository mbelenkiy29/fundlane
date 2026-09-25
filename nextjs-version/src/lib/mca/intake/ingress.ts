import "server-only"

import { createHash } from "node:crypto"
import { AppError } from "../errors"
import { hashOpaqueToken } from "../crypto"
import { actorForDeals } from "../deals/service"
import type { DealActor } from "../deals/schema"
import type { AuthContext } from "../types"
import type { IntakeResult, NormalizedIntakeInput } from "./contracts"
import { normalizeProviderPayload, verifyProviderAdmission } from "./providers"
import {
  associateIntakeIntegration,
  findIntake,
  findIntegrationByPublicId,
  reserveIntake,
  resolveAttributionToken,
  intakeDatabase,
  updateIntake,
} from "./repository"
import { ingestApplication, scheduleAttachment } from "./service"
import { withTransaction } from "../db"
import { claimInvitationSubmission, completeInvitationSubmission } from "../applications/service"

export const MAX_PROVIDER_BODY_BYTES = 1024 * 1024

export async function readProviderBody(request: Request): Promise<string> {
  const declared = request.headers.get("content-length")
  if (declared && Number(declared) > MAX_PROVIDER_BODY_BYTES) {
    throw new AppError(413, "provider_payload_too_large", "Webhook body must be at most 1 MiB.")
  }
  if (!request.body) return ""
  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > MAX_PROVIDER_BODY_BYTES) throw new AppError(413, "provider_payload_too_large", "Webhook body must be at most 1 MiB.")
      chunks.push(value)
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined)
    throw error
  } finally {
    reader.releaseLock()
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks))
  } catch {
    throw new AppError(400, "provider_payload_invalid", "Webhook body must use UTF-8 text.")
  }
}

async function actorForIntegration(workspaceId: string): Promise<DealActor> {
  const context: AuthContext = {
    authType: "api_key",
    userId: null,
    membershipId: null,
    workspaceId,
    role: null,
    scopes: ["intake:write"],
    sessionId: null,
  }
  return actorForDeals(context)
}

export async function parseProviderPayload(request: Request, provider: string, rawBody: string): Promise<unknown> {
  const contentType = request.headers.get("content-type") ?? ""
  if (provider === "jotform" && /^(multipart\/form-data|application\/x-www-form-urlencoded)\b/i.test(contentType)) {
    try {
      const form = await new Request(request.url, { method: "POST", headers: { "content-type": contentType }, body: rawBody }).formData()
      return Object.fromEntries([...form.entries()].filter(([, value]) => typeof value === "string"))
    } catch {
      throw new AppError(400, "provider_payload_invalid", "Jotform webhook form data is invalid.")
    }
  }
  try {
    return JSON.parse(rawBody)
  } catch {
    throw new AppError(400, "provider_payload_invalid", "Webhook body must be valid JSON.")
  }
}

async function rejectToReview(
  actor: DealActor,
  integrationId: string,
  provider: string,
  rawBody: string,
  error: AppError,
): Promise<never> {
  const parsed = (() => { try { return JSON.parse(rawBody) as Record<string, unknown> } catch { return {} } })()
  const candidate = parsed.webhookId ?? parsed.submissionID ?? parsed.submissionId ?? parsed.entryId ?? parsed.messageId
  const eventId = typeof candidate === "string" || typeof candidate === "number"
    ? String(candidate)
    : `review-${createHash("sha256").update(rawBody).digest("hex")}`
  const input: NormalizedIntakeInput = { schemaVersion: 1, provider, eventId, application: {}, sourceReference: `${provider}:review:${eventId}` }
  const checksum = createHash("sha256").update(rawBody).digest("hex")
  const reserved = await reserveIntake(actor.workspaceId, input, checksum, integrationId)
  if (reserved.record.payloadChecksum === checksum) {
    await updateIntake({
      workspaceId: actor.workspaceId,
      intakeId: reserved.record.intakeId,
      state: "error",
      errorCode: error.code,
      errorMessage: error.message,
      warnings: ["This delivery needs review before a deal can be created."],
    })
  }
  throw error
}

export async function ingestProviderDelivery(input: {
  provider: string
  integrationId: string
  request: Request
  rawBody: string
}): Promise<IntakeResult> {
  const integration = await findIntegrationByPublicId(input.integrationId, true)
  if (!integration || integration.provider !== input.provider) {
    throw new AppError(404, "integration_not_found", "The intake integration was not found.")
  }
  verifyProviderAdmission(input.request, input.rawBody, integration)
  const actor = await actorForIntegration(integration.workspaceId)
  let normalized
  try {
    normalized = normalizeProviderPayload(input.provider, await parseProviderPayload(input.request, input.provider, input.rawBody), integration)
  } catch (error) {
    if (error instanceof AppError && error.status !== 202) await rejectToReview(actor, integration.id, input.provider, input.rawBody, error)
    throw error
  }

  const process = async (): Promise<IntakeResult> => {
    const invitation = normalized.invitationToken !== undefined
      ? await claimInvitationSubmission(normalized.invitationToken, integration.workspaceId, integration.id, normalized.eventId)
      : undefined
    let membershipId: string | undefined = invitation?.membership_id
    if (normalized.attributionToken && !invitation) {
      const attribution = await resolveAttributionToken(hashOpaqueToken(normalized.attributionToken))
      if (!attribution || attribution.workspaceId !== integration.workspaceId || attribution.integrationId !== integration.id || attribution.formId !== integration.formId) {
        await rejectToReview(actor, integration.id, input.provider, input.rawBody, new AppError(422, "attribution_quarantined", "Rep attribution is invalid, revoked, or belongs to another form."))
      }
      membershipId = attribution?.membershipId
    }
    if (!membershipId && normalized.externalAssignee) {
      const mapped = integration.mapping[`rep:${normalized.externalAssignee}`]
      if (mapped && actor.activeMembershipIds.includes(mapped)) membershipId = mapped
    }
    if (!membershipId && integration.assignmentPool.length) {
      const eligible = integration.assignmentPool.filter((id) => actor.activeMembershipIds.includes(id))
      if (eligible.length) {
        const digest = createHash("sha256").update(normalized.eventId).digest()
        membershipId = eligible[digest.readUInt32BE(0) % eligible.length]
      }
    }
    const prior = await intakeDatabase().prepare<{ id: string }>("SELECT id FROM intake_events WHERE workspace_id=? AND event_namespace=? AND provider=? AND provider_event_id=?").get(integration.workspaceId, integration.id, input.provider, normalized.eventId)
    const priorRecord = prior ? await findIntake(integration.workspaceId, prior.id) : undefined
    const application = membershipId
      ? { ...normalized.application, assignments: [{ membershipId, kind: "originator" as const, isPrimary: true }] }
      : normalized.application
    const result = await ingestApplication(actor, {
      schemaVersion: 1,
      provider: input.provider,
      eventId: normalized.eventId,
      answers: normalized.answers,
      application: priorRecord?.dealId ? { ...application, assignments: priorRecord.application.assignments } : application,
      sourceReference: normalized.sourceReference,
      initialStatus: integration.initialStatus,
    }, undefined, integration.id)
    await associateIntakeIntegration(integration.workspaceId, result.intakeId, integration.id)
    if (invitation) await completeInvitationSubmission(invitation, result.intakeId, result.dealId)
    if (result.dealId) {
      for (const file of normalized.attachments) {
        await scheduleAttachment({
          actor,
          intakeId: result.intakeId,
          attachmentId: file.id,
          sourceUrl: file.url,
          filename: file.filename,
          mimeType: file.mimeType,
          category: file.category,
        })
      }
    }
    if (!membershipId && !priorRecord?.dealId) {
      const saved = await findIntake(integration.workspaceId, result.intakeId)
      if (saved) await updateIntake({ workspaceId: integration.workspaceId, intakeId: result.intakeId, state: saved.state, warnings: [...saved.warnings, "Assignment needed: no active rep is available. Open the deal to assign a rep."] })
    }
    const current = await findIntake(integration.workspaceId, result.intakeId)
    return current ? { intakeId: current.intakeId, dealId: current.dealId, created: result.created, state: current.state, warnings: current.warnings } : result
  }
  if (normalized.invitationToken === undefined) return process()
  try {
    return await withTransaction(process)
  } catch (error) {
    if (error instanceof AppError && error.code === "invitation_quarantined") await rejectToReview(actor, integration.id, input.provider, input.rawBody, error)
    throw error
  }
}
