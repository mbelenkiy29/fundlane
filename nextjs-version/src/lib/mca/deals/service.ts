import "server-only"

import { AppError } from "../errors"
import { newId, nowIso, recordAuditEvent } from "../db"
import { isActionAllowed } from "../policy"
import type { AuthContext } from "../types"
import { getWorkspaceSettings } from "../workspaces"
import { canTransition, transitionGuidance } from "./pipeline"
import { canActorAccessDeal, normalizePrimaryAssignments, permittedAssignmentIds } from "./access-policy"
import { reconcilePipelineCounts } from "./filters"
import {
  activeMembershipIds,
  DealVersionConflictError,
  findDealById,
  findDealByIdempotencyKey,
  insertDeal,
  insertNote,
  listDealIndexRecords,
  managedMembershipIds,
  updateDeal,
} from "./repository"
import type { DealTransactionCheckpoint } from "./repository"
import type {
  CreateDealInput,
  DealActivity,
  DealActor,
  DealAssignment,
  DealConflict,
  DealDetail,
  DealFilters,
  DealListItem,
  DealListResponse,
  DealOwner,
  DealOwnerInput,
  DealRecord,
  DealWriteInput,
  DealSource,
  FieldSource,
  ProtectedDealOwner,
  TransitionDealInput,
  UpdateDealInput,
} from "./schema"
import { submissionMissingFields, validateDealInput } from "./validation"
import { DEAL_STATUS_LABELS } from "./schema"
import { getAttachPayload, merchantCreateWarnings, resolveForceDuplicateAttach } from "../merchants/service"

function maskEmail(value?: string): string | undefined {
  if (!value) return undefined
  const [name, domain] = value.split("@")
  return domain ? `${name.slice(0, 1)}•••@${domain}` : "••••"
}

function maskPhone(value?: string): string | undefined {
  if (!value) return undefined
  const digits = value.replace(/\D/g, "")
  return digits ? `••• ••• ••${digits.slice(-2)}` : "••••"
}

function protectOwner(owner: DealOwner): ProtectedDealOwner {
  return {
    id: owner.id,
    firstName: owner.firstName,
    lastName: owner.lastName,
    ownershipPercent: owner.ownershipPercent,
    isPrimary: owner.isPrimary,
    dateOfBirth: owner.dateOfBirth ? "••••-••-••" : undefined,
    identityLast4: owner.identityLast4 ? "••••" : undefined,
    email: maskEmail(owner.email),
    phone: maskPhone(owner.phone),
  }
}

function maskEin(value?: string): string | undefined {
  if (!value) return undefined
  return `••-••••${value.replace(/\D/g, "").slice(-3)}`
}

export function toDealDetail(record: DealRecord): DealDetail {
  return { ...record, ein: maskEin(record.ein), owners: record.owners.map(protectOwner), idempotencyKey: undefined }
}

export function toDealListItem(record: Pick<DealRecord, "id" | "displayId" | "legalName" | "dbaName" | "status" | "pipelineVersion" | "requestedAmount" | "monthlyRevenue" | "draftState" | "missingRequiredFields" | "assignments" | "submissions" | "version" | "createdAt" | "updatedAt">): DealListItem {
  return {
    id: record.id,
    displayId: record.displayId,
    legalName: record.legalName?.trim() || "Untitled draft",
    dbaName: record.dbaName,
    status: record.status,
    pipelineVersion: record.pipelineVersion,
    requestedAmount: record.requestedAmount,
    monthlyRevenue: record.monthlyRevenue,
    draftState: record.draftState,
    missingRequiredFields: record.missingRequiredFields,
    assignments: record.assignments,
    funderNames: [...new Set(record.submissions.map((item) => item.funderName))],
    version: record.version,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  }
}

export async function actorForDeals(context: AuthContext): Promise<DealActor> {
  const allActive = await activeMembershipIds(context.workspaceId)
  const managed = context.membershipId && context.role === "manager"
    ? await managedMembershipIds(context.workspaceId, context.membershipId)
    : []
  return {
    ...context,
    managedMembershipIds: managed,
    activeMembershipIds: allActive,
    source: context.authType === "api_key" ? "api_key" : "user",
    correlationId: newId(),
  }
}

function assertVisible(actor: DealActor, record: DealRecord | undefined): DealRecord {
  if (!record || !canActorAccessDeal(actor, record)) {
    throw new AppError(404, "deal_not_found", "The requested deal was not found.")
  }
  return record
}

function buildAssignments(
  requested: CreateDealInput["assignments"] | UpdateDealInput["assignments"],
  previous: DealAssignment[],
  actor: DealActor,
  now: string,
): DealAssignment[] {
  if (!requested) return previous
  const allowed = permittedAssignmentIds(actor)
  for (const item of requested) {
    if (!actor.activeMembershipIds.includes(item.membershipId)) {
      throw new AppError(422, "inactive_assignee", "Assignments must reference active members in this workspace.", { assignments: ["Choose an active workspace member."] })
    }
    const unchanged = previous.some((old) => old.membershipId === item.membershipId && old.kind === item.kind)
    if (!unchanged && !allowed.has(item.membershipId)) {
      throw new AppError(403, "assignment_not_allowed", "You cannot assign this deal to that workspace member.")
    }
  }
  const built = requested.map((item) => {
    const existing = previous.find((old) => old.membershipId === item.membershipId && old.kind === item.kind)
    return {
      id: existing?.id ?? newId(),
      membershipId: item.membershipId,
      kind: item.kind,
      isPrimary: Boolean(item.isPrimary),
      assignedAt: existing?.assignedAt ?? now,
      assignedByUserId: existing?.assignedByUserId ?? actor.userId,
    }
  })
  return normalizePrimaryAssignments(built)
}

function mergeOwners(previous: DealOwner[], input?: DealOwnerInput[]): DealOwner[] {
  if (!input) return previous
  return input.map((owner, index) => {
    const prior = owner.id ? previous.find((item) => item.id === owner.id) : undefined
    return {
      ...prior,
      ...owner,
      id: prior?.id ?? newId(),
      isPrimary: owner.isPrimary ?? prior?.isPrimary ?? index === 0,
      dateOfBirth: owner.dateOfBirth?.includes("•") ? prior?.dateOfBirth : owner.dateOfBirth ?? prior?.dateOfBirth,
      identityLast4: owner.identityLast4?.includes("•") ? prior?.identityLast4 : owner.identityLast4 ?? prior?.identityLast4,
      email: owner.email?.includes("•") ? prior?.email : owner.email ?? prior?.email,
      phone: owner.phone?.includes("•") ? prior?.phone : owner.phone ?? prior?.phone,
    }
  })
}

function changedFieldNames(input: CreateDealInput | UpdateDealInput): string[] {
  const allowed = new Set([
    "legalName", "dbaName", "ein", "entityType", "address", "contactName", "contactEmail", "contactPhone",
    "startDate", "industry", "naicsCode", "monthlyRevenue", "ficoScore", "fundingPurpose", "requestedAmount",
    "requestedTermMonths", "owners", "assignments",
  ])
  return Object.keys(input).filter((key) => allowed.has(key))
}

function updatedSources(record: DealRecord | undefined, input: CreateDealInput | UpdateDealInput, actor: DealActor, now: string): Record<string, FieldSource> {
  const result = { ...(record?.fieldSources ?? {}) }
  const source: DealSource = input.fieldSource ?? (actor.source === "api_key" ? "api" : "manual")
  for (const key of changedFieldNames(input)) result[key] = { source, actorUserId: actor.userId, capturedAt: now, correlationId: actor.correlationId }
  return result
}

function activity(actor: DealActor, action: DealActivity["action"], summary: string, version: number, now: string, status?: { from: DealRecord["status"]; to: DealRecord["status"] }): DealActivity {
  return {
    id: newId(), action, actorUserId: actor.userId, source: actor.source === "api_key" ? "api" : "manual",
    summary, version, createdAt: now, correlationId: actor.correlationId,
    fromStatus: status?.from, toStatus: status?.to,
  }
}

function assertValid(input: CreateDealInput | UpdateDealInput): void {
  const fieldErrors = validateDealInput(input)
  if (Object.keys(fieldErrors).length) throw new AppError(422, "validation_failed", "Review the highlighted deal fields.", fieldErrors)
}

function mergeOmittedWriteFields(input: CreateDealInput, fields: DealWriteInput): CreateDealInput {
  return {
    ...input,
    legalName: input.legalName ?? fields.legalName,
    dbaName: input.dbaName ?? fields.dbaName,
    ein: input.ein ?? fields.ein,
    entityType: input.entityType ?? fields.entityType,
    address: input.address ?? fields.address,
    contactName: input.contactName ?? fields.contactName,
    contactEmail: input.contactEmail ?? fields.contactEmail,
    contactPhone: input.contactPhone ?? fields.contactPhone,
    startDate: input.startDate ?? fields.startDate,
    industry: input.industry ?? fields.industry,
    naicsCode: input.naicsCode ?? fields.naicsCode,
    monthlyRevenue: input.monthlyRevenue ?? fields.monthlyRevenue,
    ficoScore: input.ficoScore ?? fields.ficoScore,
    fundingPurpose: input.fundingPurpose ?? fields.fundingPurpose,
    requestedAmount: input.requestedAmount ?? fields.requestedAmount,
    requestedTermMonths: input.requestedTermMonths ?? fields.requestedTermMonths,
    owners: input.owners ?? fields.owners,
  }
}

export async function listDeals(actor: DealActor, filters: DealFilters): Promise<DealListResponse> {
  await (await import("../company-access")).assertCompanyOperational(actor.workspaceId)
  const visible = (await listDealIndexRecords(actor.workspaceId, filters)).filter((record) => canActorAccessDeal(actor, record))
  const deals = visible.map(toDealListItem)
  const counts = reconcilePipelineCounts(deals)
  return { deals, counts, total: deals.length, filters }
}

export async function exportDeals(actor: DealActor, filters: DealFilters): Promise<string> {
  const rows = (await listDeals(actor, filters)).deals
  const escape = (value: string | number | undefined): string => {
    const raw = value === undefined ? "" : String(value)
    const text = typeof value === "string" && /^[=+@\-\t\r]/.test(raw) ? `'${raw}` : raw
    return /[",\r\n]/.test(text) ? `"${text.split('"').join('""')}"` : text
  }
  return [
    ["Deal ID", "Legal name", "DBA name", "Status", "Requested amount", "Monthly revenue", "Created at"],
    ...rows.map((deal) => [
      deal.displayId,
      deal.legalName,
      deal.dbaName,
      DEAL_STATUS_LABELS[deal.status],
      deal.requestedAmount,
      deal.monthlyRevenue,
      deal.createdAt,
    ]),
  ].map((row) => row.map(escape).join(",")).join("\r\n")
}

export async function getDeal(actor: DealActor, id: string): Promise<DealDetail> {
  await (await import("../company-access")).assertCompanyOperational(actor.workspaceId)
  return toDealDetail(assertVisible(actor, await findDealById(actor.workspaceId, id)))
}

/**
 * Server-only access to the unmasked deal record for document generation and
 * reconciliation. Callers must keep the returned financial and source data on
 * the server; browser-facing routes should continue to use `getDeal`.
 */
export async function getDealForDocument(actor: DealActor, id: string): Promise<DealRecord> {
  await (await import("../company-access")).assertCompanyOperational(actor.workspaceId)
  return assertVisible(actor, await findDealById(actor.workspaceId, id))
}

export async function createDeal(actor: DealActor, input: CreateDealInput, transactionCheckpoint?: DealTransactionCheckpoint): Promise<{ deal: DealDetail; created: boolean; warnings: string[] }> {
  await (await import("../company-access")).assertCompanyOperational(actor.workspaceId)
  const configuredActions = (await getWorkspaceSettings(actor.workspaceId)).actionVisibility
  const createAllowed = actor.role ? isActionAllowed(actor.role, "createDeal", configuredActions) : configuredActions.createDeal
  if (!createAllowed) throw new AppError(403, "action_disabled", "Creating deals is disabled for this workspace.")
  if (!input.idempotencyKey?.trim() || input.idempotencyKey.length > 128) {
    throw new AppError(422, "validation_failed", "An idempotency key is required and must be at most 128 characters.", { idempotencyKey: ["Provide a stable retry key."] })
  }
  if (!transactionCheckpoint) {
    const retried = await findDealByIdempotencyKey(actor.workspaceId, input.idempotencyKey)
    if (retried) return { deal: toDealDetail(assertVisible(actor, retried)), created: false, warnings: [] }
  }
  let attachMerchantId = input.attachMerchantId?.trim() || undefined
  const forcedAttachId = await resolveForceDuplicateAttach(actor, {
    ein: input.ein,
    forceDuplicate: input.forceDuplicate,
    attachMerchantId,
  })
  if (forcedAttachId) attachMerchantId = forcedAttachId
  if (attachMerchantId) {
    const attached = await getAttachPayload(actor, attachMerchantId)
    input = mergeOmittedWriteFields(input, attached.fields)
  }
  assertValid(input)
  const warnings = await merchantCreateWarnings(actor, {
    ein: input.ein,
    owners: input.owners,
    attachMerchantId,
  })
  const now = nowIso()
  const owners = mergeOwners([], input.owners)
  const defaultAssignments = !input.assignments && actor.membershipId
    ? [{ membershipId: actor.membershipId, kind: "originator" as const, isPrimary: true }]
    : input.assignments
  const assignments = buildAssignments(defaultAssignments, [], actor, now)
  const base = {
    legalName: input.legalName, dbaName: input.dbaName, ein: input.ein, entityType: input.entityType,
    address: input.address, contactName: input.contactName, contactEmail: input.contactEmail, contactPhone: input.contactPhone,
    startDate: input.startDate, industry: input.industry, naicsCode: input.naicsCode, monthlyRevenue: input.monthlyRevenue,
    ficoScore: input.ficoScore, fundingPurpose: input.fundingPurpose, requestedAmount: input.requestedAmount,
    requestedTermMonths: input.requestedTermMonths,
  }
  const id = newId()
  const record: DealRecord = {
    id, workspaceId: actor.workspaceId, merchantId: attachMerchantId, displayId: `MCA-${id.slice(0, 8).toUpperCase()}`, ...base,
    status: "lead" as const, pipelineVersion: 1 as const, draftState: "partial" as const, missingRequiredFields: [],
    owners, assignments, notes: [], activity: [], submissions: [], offers: [],
    fieldSources: updatedSources(undefined, input, actor, now), idempotencyKey: input.idempotencyKey,
    version: 1, createdAt: now, updatedAt: now,
  }
  record.missingRequiredFields = submissionMissingFields(record)
  record.draftState = record.missingRequiredFields.length ? "partial" : "submission_ready"
  record.activity = [activity(actor, "created", "Deal draft created", 1, now)]
  const saved = await insertDeal(record, transactionCheckpoint)
  const visible = assertVisible(actor, saved.record)
  if (saved.inserted) {
    await recordAuditEvent({ context: actor, action: "deal.created", resourceType: "deal", resourceId: visible.id, metadata: { version: 1, draftState: visible.draftState }, correlationId: actor.correlationId })
    if (forcedAttachId) {
      await recordAuditEvent({
        context: actor,
        action: "merchant.force_attach",
        resourceType: "merchant",
        resourceId: forcedAttachId,
        metadata: { dealId: visible.id, idempotencyKey: input.idempotencyKey },
        correlationId: actor.correlationId,
      })
    }
  }
  return { deal: toDealDetail(visible), created: saved.inserted, warnings }
}

export async function updateDealRecord(actor: DealActor, id: string, input: UpdateDealInput): Promise<DealDetail> {
  assertValid(input)
  const current = assertVisible(actor, await findDealById(actor.workspaceId, id))
  const now = nowIso()
  const owners = mergeOwners(current.owners, input.owners)
  const assignments = buildAssignments(input.assignments, current.assignments, actor, now)
  const changed = changedFieldNames(input)
  const merged: DealRecord = {
    ...current,
    ...Object.fromEntries(changed.filter((key) => !["owners", "assignments"].includes(key)).map((key) => [key, input[key as keyof UpdateDealInput]])),
    owners,
    assignments,
    fieldSources: updatedSources(current, input, actor, now),
    version: current.version + 1,
    updatedAt: now,
  }
  merged.missingRequiredFields = submissionMissingFields(merged)
  merged.draftState = merged.missingRequiredFields.length ? "partial" : "submission_ready"
  const saved = await updateDeal(merged, input.expectedVersion, activity(actor, input.assignments ? "assigned" : "updated", `Updated fields: ${changed.join(", ") || "none"}`, merged.version, now))
  await recordAuditEvent({ context: actor, action: "deal.updated", resourceType: "deal", resourceId: id, metadata: { version: saved.version, fields: changed }, correlationId: actor.correlationId })
  if (input.assignments) {
    await (await import("../comms/workflow-events")).emitDealAssignedWebhook(actor, id)
  }
  return toDealDetail(saved)
}

/** Applies import field and status changes in one version-checked database write. */
export async function applyBulkDealUpdate(actor: DealActor, id: string, input: { expectedVersion: number; changes: DealWriteInput; status?: DealRecord["status"]; reason: string; transactionCheckpoint?: DealTransactionCheckpoint }): Promise<DealDetail> {
  const updateInput = { ...input.changes, expectedVersion: input.expectedVersion } as UpdateDealInput
  assertValid(updateInput)
  const current = assertVisible(actor, await findDealById(actor.workspaceId, id))
  const now = nowIso()
  const owners = mergeOwners(current.owners, updateInput.owners)
  const assignments = buildAssignments(updateInput.assignments, current.assignments, actor, now)
  const changed = changedFieldNames(updateInput)
  const nextStatus = input.status ?? current.status
  if (nextStatus !== current.status && !canTransition(current.status, nextStatus)) {
    throw new AppError(422, "transition_not_allowed", transitionGuidance(current.status, nextStatus), { status: [transitionGuidance(current.status, nextStatus)] })
  }
  const merged: DealRecord = {
    ...current,
    ...Object.fromEntries(changed.filter((key) => !["owners", "assignments"].includes(key)).map((key) => [key, updateInput[key as keyof UpdateDealInput]])),
    owners,
    assignments,
    status: nextStatus,
    fieldSources: updatedSources(current, updateInput, actor, now),
    version: current.version + 1,
    updatedAt: now,
  }
  merged.missingRequiredFields = submissionMissingFields(merged)
  merged.draftState = merged.missingRequiredFields.length ? "partial" : "submission_ready"
  if (["ready_to_submit", "submitted"].includes(nextStatus) && merged.missingRequiredFields.length) {
    throw new AppError(422, "submission_fields_missing", "Complete the required application fields before moving this deal forward.", { missingRequiredFields: merged.missingRequiredFields })
  }
  const statusChanged = nextStatus !== current.status
  const summary = statusChanged ? `Status changed: ${current.status} → ${nextStatus}. ${input.reason}` : `Bulk update: ${changed.join(", ") || "no fields"}`
  const saved = await updateDeal(merged, input.expectedVersion, activity(actor, statusChanged ? "status_changed" : updateInput.assignments ? "assigned" : "updated", summary, merged.version, now, statusChanged ? { from: current.status, to: nextStatus } : undefined), input.transactionCheckpoint)
  await recordAuditEvent({ context: actor, action: "deal.bulk_updated", resourceType: "deal", resourceId: id, metadata: { version: saved.version, fields: changed, fromStatus: current.status, toStatus: nextStatus }, correlationId: actor.correlationId })
  if (statusChanged) {
    await (await import("../comms/workflow-events")).emitDealStatusUpdatedWebhook(actor, {
      dealId: id,
      fromStatus: current.status,
      toStatus: nextStatus,
    })
  } else if (updateInput.assignments) {
    await (await import("../comms/workflow-events")).emitDealAssignedWebhook(actor, id)
  }
  return toDealDetail(saved)
}

export async function transitionDeal(actor: DealActor, id: string, input: TransitionDealInput): Promise<{ deal: DealDetail; sideEffects: { advanceCreated: false; commissionCreated: false } }> {
  const current = assertVisible(actor, await findDealById(actor.workspaceId, id))
  if (!canTransition(current.status, input.status)) throw new AppError(422, "transition_not_allowed", transitionGuidance(current.status, input.status), { status: [transitionGuidance(current.status, input.status)] })
  if (["ready_to_submit", "submitted"].includes(input.status) && current.missingRequiredFields.length) {
    throw new AppError(422, "submission_fields_missing", "Complete the required application fields before moving this deal forward.", { missingRequiredFields: current.missingRequiredFields })
  }
  const now = nowIso()
  const next: DealRecord = { ...current, status: input.status, version: current.version + 1, updatedAt: now }
  const summary = input.reason?.trim() ? `Status changed: ${current.status} → ${input.status}. ${input.reason.trim()}` : `Status changed: ${current.status} → ${input.status}`
  const saved = await updateDeal(next, input.expectedVersion, activity(actor, "status_changed", summary, next.version, now, { from: current.status, to: input.status }))
  await recordAuditEvent({ context: actor, action: "deal.status_changed", resourceType: "deal", resourceId: id, metadata: { from: current.status, to: input.status, version: saved.version }, correlationId: actor.correlationId })
  await (await import("../comms/workflow-events")).emitDealStatusUpdatedWebhook(actor, {
    dealId: id,
    fromStatus: current.status,
    toStatus: input.status,
  })
  return { deal: toDealDetail(saved), sideEffects: { advanceCreated: false, commissionCreated: false } }
}

export async function addDealNote(actor: DealActor, id: string, input: { body: string; expectedVersion: number }): Promise<DealDetail> {
  const current = assertVisible(actor, await findDealById(actor.workspaceId, id))
  const body = input.body?.trim()
  if (!body || body.length > 5_000) throw new AppError(422, "validation_failed", "Note must contain 1 to 5,000 characters.", { body: ["Enter a note of at most 5,000 characters."] })
  const now = nowIso()
  const version = current.version + 1
  const note = { id: newId(), body, actorUserId: actor.userId, createdAt: now }
  const saved = await insertNote(actor.workspaceId, id, note, activity(actor, "note_added", "Internal note added", version, now), input.expectedVersion, now)
  await recordAuditEvent({ context: actor, action: "deal.note_added", resourceType: "deal", resourceId: id, metadata: { version }, correlationId: actor.correlationId })
  return toDealDetail(saved)
}

export function conflictBody(error: DealVersionConflictError, attemptedFields: string[]): DealConflict {
  return {
    code: "version_conflict",
    message: "This deal was updated by someone else. Compare your unsaved changes with the current record, then reload or retry.",
    current: toDealDetail(error.current),
    expectedVersion: error.expectedVersion,
    attemptedFields,
  }
}

export { DealVersionConflictError }
export { canActorAccessDeal }
