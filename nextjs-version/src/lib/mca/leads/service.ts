import "server-only"

import { AppError } from "../errors"
import { recordAuditEvent } from "../db"
import { canActorAccessDeal } from "../deals/access-policy"
import type { DealActor } from "../deals/schema"
import { getDealForDocument, listDeals } from "../deals/service"
import { ingestApplication } from "../intake/service"
import type { NormalizedIntakeInput } from "../intake/contracts"
import { commitSpreadsheetImport, createImportSource, createLeadBatch, previewSpreadsheetImport } from "../imports/service"
import type { ImportPreview } from "../imports/contracts"
import {
  ACQUISITION_CORRELATION_PATTERN,
  acquisitionCorrelationKey,
  isPurchaseDate,
  type DealAcquisitionEvent,
  type LeadProvider,
  type LeadSourceKind,
  type LeadWorkspaceSnapshot,
  type PurchaseBatch,
  type PurchasedPackageCommitResult,
  type UnassignedDeal,
} from "./contracts"
import {
  applyBatchPurchaseFields,
  findBatch,
  findBatchById,
  findBatchByName,
  findProvider,
  findProviderById,
  insertAcquisitionEvent,
  listAcquisitionHistory,
  listBatches,
  listImportRunCreatedDeals,
  listLatestAcquisitions,
  listProviders,
  updateProvider,
  withLeadsTransaction,
} from "./repository"

function requireAdmin(actor: DealActor): void {
  if (!actor.role || !["admin", "super_admin"].includes(actor.role)) {
    throw new AppError(403, "permission_denied", "Only workspace administrators can manage lead providers and purchase costs.")
  }
}

function requireCostAdmin(actor: DealActor): void {
  if (!actor.role || !["admin", "super_admin"].includes(actor.role)) {
    throw new AppError(403, "cost_permission_required", "Only workspace administrators can edit purchase cost.")
  }
}

function canEditCost(actor: DealActor): boolean {
  return actor.role === "admin" || actor.role === "super_admin"
}

function cleanName(value: string, label: string): string {
  const name = value.trim()
  if (!name || name.length > 120) {
    throw new AppError(422, "validation_failed", `${label} must contain 1 to 120 characters.`, { [label === "Source name" ? "name" : "name"]: ["Use 1 to 120 characters."] })
  }
  return name
}

function assertCostCents(value: number | null | undefined, field = "costCents"): number | null | undefined {
  if (value === undefined) return undefined
  if (value === null) return null
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new AppError(422, "validation_failed", "Purchase cost is integer cents. Use null when cost is missing; zero is a real zero.", { [field]: ["Must be a non-negative integer number of cents, or null."] })
  }
  return value
}

function assertPurchasedOn(value: string | null | undefined): string | null | undefined {
  if (value === undefined) return undefined
  if (value === null || value === "") return null
  if (!isPurchaseDate(value)) {
    throw new AppError(422, "validation_failed", "Purchase date must be a real calendar day as YYYY-MM-DD.", { purchasedOn: ["Use YYYY-MM-DD."] })
  }
  return value
}

function assertCorrelationId(value: string): string {
  const correlationId = value.trim()
  if (!ACQUISITION_CORRELATION_PATTERN.test(correlationId)) {
    throw new AppError(422, "validation_failed", "Provide a stable acquisition correlation id.", { correlationId: ["Use 1 to 160 letters, numbers, period, underscore, colon, or hyphen."] })
  }
  return correlationId
}

function uniqueViolation(error: unknown): boolean {
  if (!error || typeof error !== "object") return false
  const code = "code" in error ? String((error as { code: unknown }).code) : ""
  const cause = "cause" in error && error.cause && typeof error.cause === "object" && "code" in error.cause
    ? String((error.cause as { code: unknown }).code)
    : ""
  return code === "23505" || cause === "23505"
}

function sameAcquisitionPayload(event: DealAcquisitionEvent, expected: { dealId: string; sourceId: string | null; batchId: string | null; costCents: number | null; purchasedOn: string | null }): boolean {
  return event.dealId === expected.dealId
    && event.sourceId === expected.sourceId
    && event.batchId === expected.batchId
    && event.costCents === expected.costCents
    && event.purchasedOn === expected.purchasedOn
}

export async function assertWorkspaceProvider(actor: DealActor, sourceId: string): Promise<LeadProvider> {
  const source = await findProviderById(sourceId)
  if (!source) throw new AppError(404, "lead_source_not_found", "The selected source was not found.")
  if (source.workspaceId !== actor.workspaceId) {
    throw new AppError(422, "cross_workspace_source", "A source in another workspace cannot be selected.")
  }
  return source
}

export async function assertSelectableProvider(actor: DealActor, sourceId: string): Promise<LeadProvider> {
  const source = await assertWorkspaceProvider(actor, sourceId)
  if (!source.active) {
    throw new AppError(422, "inactive_lead_source", "Inactive sources cannot be selected for new deals.")
  }
  return source
}

export async function assertSelectableBatch(actor: DealActor, sourceId: string, batchId: string): Promise<{ source: LeadProvider; batch: PurchaseBatch }> {
  const source = await assertSelectableProvider(actor, sourceId)
  const batch = await findBatchById(batchId)
  if (!batch) throw new AppError(404, "lead_batch_not_found", "The selected purchase batch was not found.")
  if (batch.workspaceId !== actor.workspaceId) {
    throw new AppError(422, "cross_workspace_batch", "A purchase batch in another workspace cannot be selected.")
  }
  if (batch.sourceId !== source.id) {
    throw new AppError(422, "batch_source_mismatch", "Choose a purchase batch that belongs to the selected source.")
  }
  if (batch.inactive) {
    throw new AppError(422, "inactive_lead_batch", "Inactive batches cannot be selected for new deals.")
  }
  return { source, batch }
}

export async function listLeadWorkspace(actor: DealActor): Promise<LeadWorkspaceSnapshot> {
  requireAdmin(actor)
  const [providers, batches, listed, latest] = await Promise.all([
    listProviders(actor.workspaceId),
    listBatches(actor.workspaceId),
    listDeals(actor, {}),
    listLatestAcquisitions(actor.workspaceId),
  ])
  const assigned = new Set(latest.filter((event) => event.sourceId || event.batchId).map((event) => event.dealId))
  const unassignedDeals: UnassignedDeal[] = listed.deals
    .filter((deal) => !assigned.has(deal.id))
    .map((deal) => ({
      id: deal.id,
      displayId: deal.displayId,
      legalName: deal.legalName || deal.dbaName || deal.displayId,
      status: deal.status,
      createdAt: deal.createdAt,
    }))
  return {
    providers,
    batches,
    unassignedDeals,
    selectable: {
      providerIds: providers.filter((item) => item.active).map((item) => item.id),
      batchIds: batches.filter((item) => !item.inactive && providers.some((provider) => provider.id === item.sourceId && provider.active)).map((item) => item.id),
    },
    canEditCost: canEditCost(actor),
    canManage: true,
  }
}

export async function createLeadProvider(actor: DealActor, input: { name: string; kind?: LeadSourceKind }): Promise<LeadProvider> {
  requireAdmin(actor)
  const name = cleanName(input.name, "Source name")
  try {
    const created = await createImportSource(actor, { name, kind: input.kind ?? "spreadsheet" })
    const saved = await findProvider(actor.workspaceId, created.id)
    if (!saved) throw new AppError(500, "lead_source_missing", "The source was created but could not be reloaded.")
    return saved
  } catch (error) {
    if (uniqueViolation(error)) throw new AppError(409, "lead_source_exists", "A source with that name already exists in this workspace.", { name: ["Choose a different source name."] })
    throw error
  }
}

export async function updateLeadProvider(actor: DealActor, id: string, input: { name?: string; active?: boolean }): Promise<LeadProvider> {
  requireAdmin(actor)
  await assertWorkspaceProvider(actor, id)
  const name = input.name === undefined ? undefined : cleanName(input.name, "Source name")
  try {
    const saved = await updateProvider(actor.workspaceId, id, { ...(name !== undefined ? { name } : {}), ...(input.active !== undefined ? { active: input.active } : {}) })
    if (!saved) throw new AppError(404, "lead_source_not_found", "The selected source was not found.")
    await recordAuditEvent({
      context: actor,
      action: input.active === false ? "lead.source_deactivated" : "lead.source_updated",
      resourceType: "import_source",
      resourceId: saved.id,
      metadata: { active: saved.active },
      correlationId: actor.correlationId,
    })
    return saved
  } catch (error) {
    if (uniqueViolation(error)) throw new AppError(409, "lead_source_exists", "A source with that name already exists in this workspace.", { name: ["Choose a different source name."] })
    throw error
  }
}

export async function createPurchaseBatch(actor: DealActor, input: {
  sourceId: string
  name: string
  purchasedOn?: string | null
  costCents?: number | null
}): Promise<PurchaseBatch> {
  requireAdmin(actor)
  requireCostAdmin(actor)
  await assertSelectableProvider(actor, input.sourceId)
  const name = cleanName(input.name, "Batch name")
  const purchasedOn = assertPurchasedOn(input.purchasedOn ?? null) ?? null
  const costCents = assertCostCents(input.costCents ?? null) ?? null
  const existing = await findBatchByName(actor.workspaceId, input.sourceId, name)
  if (existing) {
    if (existing.purchasedOn === purchasedOn && existing.costCents === costCents) return existing
    throw new AppError(409, "lead_batch_exists", "A purchase batch with that name already exists for this source.", { name: ["Choose a different batch name."] })
  }
  try {
    const created = await createLeadBatch(actor, { sourceId: input.sourceId, name })
    const saved = await applyBatchPurchaseFields(actor.workspaceId, created.id, {
      name,
      purchasedOn,
      costCents,
      inactive: false,
    })
    if (!saved) throw new AppError(500, "lead_batch_missing", "The purchase batch was created but could not be reloaded.")
    await recordAuditEvent({
      context: actor,
      action: "lead.batch_created",
      resourceType: "lead_batch",
      resourceId: saved.id,
      metadata: { sourceId: saved.sourceId, costCents: saved.costCents, purchasedOn: saved.purchasedOn },
      correlationId: actor.correlationId,
    })
    return saved
  } catch (error) {
    if (uniqueViolation(error)) throw new AppError(409, "lead_batch_exists", "A purchase batch with that name already exists for this source.", { name: ["Choose a different batch name."] })
    throw error
  }
}

export async function updatePurchaseBatch(actor: DealActor, id: string, input: {
  name?: string
  purchasedOn?: string | null
  costCents?: number | null
  inactive?: boolean
}): Promise<PurchaseBatch> {
  requireAdmin(actor)
  const current = await findBatchById(id)
  if (!current) throw new AppError(404, "lead_batch_not_found", "The selected purchase batch was not found.")
  if (current.workspaceId !== actor.workspaceId) {
    throw new AppError(422, "cross_workspace_batch", "A purchase batch in another workspace cannot be selected.")
  }
  if (input.costCents !== undefined) requireCostAdmin(actor)
  const name = input.name === undefined ? current.name : cleanName(input.name, "Batch name")
  const purchasedOn = input.purchasedOn === undefined ? current.purchasedOn : assertPurchasedOn(input.purchasedOn) ?? null
  const costCents = input.costCents === undefined ? current.costCents : assertCostCents(input.costCents) ?? null
  const inactive = input.inactive ?? current.inactive
  try {
    const saved = await applyBatchPurchaseFields(actor.workspaceId, current.id, { name, purchasedOn, costCents, inactive })
    if (!saved) throw new AppError(404, "lead_batch_not_found", "The selected purchase batch was not found.")
    await recordAuditEvent({
      context: actor,
      action: "lead.batch_updated",
      resourceType: "lead_batch",
      resourceId: saved.id,
      metadata: { costChanged: input.costCents !== undefined, inactive: saved.inactive },
      correlationId: actor.correlationId,
    })
    return saved
  } catch (error) {
    if (uniqueViolation(error)) throw new AppError(409, "lead_batch_exists", "A purchase batch with that name already exists for this source.", { name: ["Choose a different batch name."] })
    throw error
  }
}

async function writeAcquisition(actor: DealActor, input: {
  dealId: string
  sourceId: string
  batchId: string
  correlationId: string
  costCents: number | null
  purchasedOn: string | null
}): Promise<{ event: DealAcquisitionEvent; inserted: boolean }> {
  const payload = {
    workspaceId: actor.workspaceId,
    dealId: input.dealId,
    sourceId: input.sourceId,
    batchId: input.batchId,
    costCents: input.costCents,
    purchasedOn: input.purchasedOn,
    actorUserId: actor.userId,
    correlationId: input.correlationId,
  }
  const written = await insertAcquisitionEvent(payload)
  if (!written.inserted && !sameAcquisitionPayload(written.event, payload)) {
    throw new AppError(409, "acquisition_idempotency_conflict", "That retry key already identifies a different acquisition event.")
  }
  if (written.inserted) {
    await recordAuditEvent({
      context: actor,
      action: "lead.acquisition_recorded",
      resourceType: "deal",
      resourceId: input.dealId,
      metadata: { sourceId: input.sourceId, batchId: input.batchId, eventId: written.event.id },
      correlationId: actor.correlationId,
    })
  }
  return written
}

export async function assignDealAcquisition(actor: DealActor, input: {
  dealId: string
  sourceId: string
  batchId: string
  correlationId: string
}): Promise<DealAcquisitionEvent> {
  requireAdmin(actor)
  const correlationId = assertCorrelationId(input.correlationId)
  const { source, batch } = await assertSelectableBatch(actor, input.sourceId, input.batchId)
  const deal = await getDealForDocument(actor, input.dealId)
  if (!canActorAccessDeal(actor, deal)) throw new AppError(404, "deal_not_found", "The requested deal was not found.")
  const written = await writeAcquisition(actor, {
    dealId: deal.id,
    sourceId: source.id,
    batchId: batch.id,
    correlationId,
    costCents: batch.costCents,
    purchasedOn: batch.purchasedOn,
  })
  return written.event
}

export async function attachImportRunAcquisitions(actor: DealActor, runId: string): Promise<DealAcquisitionEvent[]> {
  requireAdmin(actor)
  const created = await listImportRunCreatedDeals(actor.workspaceId, runId)
  if (!created.length) return []
  const batchIds = new Set(created.map((row) => row.batchId))
  const batches = new Map<string, PurchaseBatch>()
  for (const batchId of batchIds) {
    const batch = await findBatch(actor.workspaceId, batchId)
    if (!batch) throw new AppError(404, "lead_batch_not_found", "The import run refers to a purchase batch that is not in this workspace.")
    batches.set(batch.id, batch)
  }
  return withLeadsTransaction(async (database) => {
    const events: DealAcquisitionEvent[] = []
    for (const row of created) {
      const batch = batches.get(row.batchId)!
      const payload = {
        workspaceId: actor.workspaceId,
        dealId: row.dealId,
        sourceId: row.sourceId,
        batchId: row.batchId,
        costCents: batch.costCents,
        purchasedOn: batch.purchasedOn,
        actorUserId: actor.userId,
        correlationId: acquisitionCorrelationKey("import", `${runId}:${row.rowId}`),
      }
      const written = await insertAcquisitionEvent(payload, database)
      if (!written.inserted && !sameAcquisitionPayload(written.event, payload)) {
        throw new AppError(409, "acquisition_idempotency_conflict", "That retry key already identifies a different acquisition event.")
      }
      events.push(written.event)
    }
    await recordAuditEvent({
      context: actor,
      action: "lead.import_attached",
      resourceType: "import_run",
      resourceId: runId,
      metadata: { dealCount: events.length, batchIds: [...batchIds] },
      correlationId: actor.correlationId,
      executor: database,
    })
    return events
  })
}

export async function previewPurchasedPackage(actor: DealActor, input: {
  sourceId: string
  batchId: string
  filename: string
  bytes: Uint8Array
  mapping?: Record<string, string>
  assignmentPool?: string[]
}): Promise<ImportPreview> {
  requireAdmin(actor)
  await assertSelectableBatch(actor, input.sourceId, input.batchId)
  return previewSpreadsheetImport(actor, {
    sourceId: input.sourceId,
    batchId: input.batchId,
    filename: input.filename,
    bytes: input.bytes,
    mapping: input.mapping,
    assignmentPool: input.assignmentPool,
  })
}

export async function commitPurchasedPackage(actor: DealActor, input: { runId: string; expectedPreviewRevision: number }): Promise<PurchasedPackageCommitResult> {
  requireAdmin(actor)
  const committed = await commitSpreadsheetImport(actor, input)
  const attached = committed.state === "cancelled" ? [] : await attachImportRunAcquisitions(actor, input.runId)
  return {
    runId: committed.runId,
    state: committed.state,
    created: committed.created,
    skipped: committed.skipped,
    failed: committed.failed,
    attachedDealIds: attached.map((event) => event.dealId),
    acquisitionEventIds: attached.map((event) => event.id),
    resultsCsv: committed.resultsCsv,
  }
}

export async function ingestApplicationWithAcquisition(actor: DealActor, input: NormalizedIntakeInput, attribution: {
  sourceId: string
  batchId: string
}): Promise<{ intakeId: string; dealId: string | null; created: boolean; event: DealAcquisitionEvent | null }> {
  requireAdmin(actor)
  const { source, batch } = await assertSelectableBatch(actor, attribution.sourceId, attribution.batchId)
  const outcome = await ingestApplication(actor, input)
  if (!outcome.dealId) return { intakeId: outcome.intakeId, dealId: null, created: outcome.created, event: null }
  const event = await assignDealAcquisition(actor, {
    dealId: outcome.dealId,
    sourceId: source.id,
    batchId: batch.id,
    correlationId: acquisitionCorrelationKey("intake", outcome.intakeId),
  })
  return { intakeId: outcome.intakeId, dealId: outcome.dealId, created: outcome.created, event }
}

export async function latestAcquisitionForDeal(actor: DealActor, dealId: string): Promise<DealAcquisitionEvent | undefined> {
  await getDealForDocument(actor, dealId)
  const history = await listAcquisitionHistory(actor.workspaceId, dealId)
  return history.at(-1)
}

export async function listDealAcquisitionHistory(actor: DealActor, dealId: string): Promise<DealAcquisitionEvent[]> {
  await getDealForDocument(actor, dealId)
  return listAcquisitionHistory(actor.workspaceId, dealId)
}

export { listLatestAcquisitions }
