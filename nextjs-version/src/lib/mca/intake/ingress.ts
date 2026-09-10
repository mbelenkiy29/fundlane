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
  updateIntake,
} from "./repository"
import { ingestApplication, scheduleAttachment } from "./service"

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

function parsePayload(rawBody: string): unknown {
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
    normalized = normalizeProviderPayload(input.provider, parsePayload(input.rawBody), integration)
  } catch (error) {
    if (error instanceof AppError && error.status !== 202) await rejectToReview(actor, integration.id, input.provider, input.rawBody, error)
    throw error
  }

  let membershipId: string | undefined
  if (normalized.attributionToken) {
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
  const application = membershipId
    ? { ...normalized.application, assignments: [{ membershipId, kind: "originator" as const, isPrimary: true }] }
    : normalized.application
  const result = await ingestApplication(actor, {
    schemaVersion: 1,
    provider: input.provider,
    eventId: normalized.eventId,
    application,
    sourceReference: normalized.sourceReference,
    initialStatus: integration.initialStatus,
  })
  await associateIntakeIntegration(integration.workspaceId, result.intakeId, integration.id)
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
  const current = await findIntake(integration.workspaceId, result.intakeId)
  return current ? { intakeId: current.intakeId, dealId: current.dealId, created: result.created, state: current.state, warnings: current.warnings } : result
}
