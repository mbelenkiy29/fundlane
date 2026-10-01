import "server-only"
import { membershipProfileNameSql } from "../membership-profile"

import { AppError } from "../errors"
import { getDatabase, newId, nowIso, parseJson, recordAuditEvent, withImmediateTransaction, type DbExecutor } from "../db"
import type { DealActor } from "../deals/schema"
import { calculateSplitSnapshot, type SplitSnapshot } from "./calculations"
import type {
  DistributionSchedule,
  DistributionScheduleStatus,
  ReverseConsolidation,
  ReverseConsolidationWorkspace,
  ScheduledInstallment,
  ScheduledInstallmentStatus,
} from "./contracts"
import { assertCents, type BasisPointAllocation } from "./money"

const CALENDAR_DATE = /^(\d{4})-(\d{2})-(\d{2})$/
const NO_TRANSFER = "Expected weekly distributions are accounting rows only; no bank transfer is initiated."

export interface CreateReverseConsolidationInput {
  dealId: string
  referencedAdvanceIds: string[]
  startDate: string
  installmentCount: number
  installmentCents: number
  splitTemplateId: string
  splitTemplateVersion: number
  idempotencyKey: string
}

export interface CreateReverseConsolidationResult {
  consolidation: ReverseConsolidation
  schedule: DistributionSchedule
  created: boolean
}

export interface RunDistributionSchedulesInput {
  nowIso?: string
  scheduleId?: string
}

export interface RunDistributionSchedulesResult {
  inserted: number
  skipped: number
}

export interface AmendDistributionScheduleInput {
  startDate: string
  installmentCount: number
  installmentCents: number
  splitTemplateId: string
  splitTemplateVersion: number
  reason?: string
}

export interface ExceptOccurrenceInput {
  occurrenceDate: string
  recipientMembershipId?: string
}

export interface MarkInstallmentPaidInput {
  installmentId?: string
  occurrenceDate?: string
  recipientMembershipId?: string
  paidAt?: string
}

type ConsolidationRow = {
  id: string
  deal_id: string
  referenced_advance_ids_json: string
  schedule_id: string
  created_at: string
}

type ScheduleRow = {
  id: string
  workspace_id: string
  reverse_consolidation_id: string
  deal_id: string
  status: DistributionScheduleStatus
  active_version: number
  start_date: string
  installment_count: number
  installment_cents: number
  split_template_id: string
  split_template_version: number
  created_at: string
  updated_at: string
}

type VersionRow = {
  start_date: string
  installment_count: number
  installment_cents: number
  split_template_id: string
  split_template_version: number
  allocation_json: string
}

type InstallmentRow = {
  id: string
  schedule_id: string
  schedule_version: number
  occurrence_date: string
  recipient_membership_id: string
  recipient_name: string | null
  amount_cents: number
  percentage_basis_points: number
  status: ScheduledInstallmentStatus
  paid_at: string | null
  snapshot_json: string
}

type LockedSchedule = {
  id: string
  reverse_consolidation_id: string
  status: DistributionScheduleStatus
  active_version: number
  start_date: string
  installment_count: number
  installment_cents: number
  split_template_id: string
  split_template_version: number
  created_at: string
  updated_at: string
  deal_id: string
}

function uniqueIds(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))].sort()
}

function sameIds(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

function calendarDateUtcNoon(value: string, field: string): Date {
  const match = CALENDAR_DATE.exec(value)
  if (!match) {
    throw new AppError(400, "validation_failed", "Dates must use YYYY-MM-DD.", { [field]: ["Use YYYY-MM-DD"] })
  }
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const utc = new Date(Date.UTC(year, month - 1, day, 12, 0, 0))
  if (utc.getUTCFullYear() !== year || utc.getUTCMonth() !== month - 1 || utc.getUTCDate() !== day) {
    throw new AppError(400, "validation_failed", "Dates must use a real calendar day.", { [field]: ["Invalid calendar date"] })
  }
  return utc
}

function addCalendarDays(startDate: string, days: number): string {
  const utc = calendarDateUtcNoon(startDate, "startDate")
  utc.setUTCDate(utc.getUTCDate() + days)
  return utc.toISOString().slice(0, 10)
}

function assertMondayStart(startDate: string): string {
  const utc = calendarDateUtcNoon(startDate, "startDate")
  if (utc.getUTCDay() !== 1) {
    throw new AppError(400, "validation_failed", "Weekly distributions must start on a Monday.", { startDate: ["Must be a Monday"] })
  }
  return startDate
}

export function weeklyOccurrenceDates(startDate: string, installmentCount: number): string[] {
  assertMondayStart(startDate)
  assertInstallmentCount(installmentCount)
  return Array.from({ length: installmentCount }, (_, index) => addCalendarDays(startDate, 7 * index))
}

function assertInstallmentCount(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new AppError(400, "validation_failed", "Installment count must be a positive integer.", { installmentCount: ["Must be a positive integer"] })
  }
  return value
}

function assertInstallmentCents(value: number): number {
  try {
    assertCents(value, "installmentCents")
  } catch (error) {
    if (error instanceof TypeError) {
      throw new AppError(400, "validation_failed", error.message, { installmentCents: [error.message] })
    }
    throw error
  }
  if (value <= 0) {
    throw new AppError(400, "validation_failed", "Installment amount must be a positive integer number of cents.", { installmentCents: ["Must be greater than zero"] })
  }
  return value
}

function splitSnapshot(baseCents: number, allocations: readonly BasisPointAllocation[]): SplitSnapshot {
  try {
    return calculateSplitSnapshot(baseCents, allocations)
  } catch (error) {
    if (error instanceof TypeError) throw new AppError(400, "validation_failed", error.message)
    throw error
  }
}

function consolidationFrom(row: ConsolidationRow): ReverseConsolidation {
  return {
    id: row.id,
    dealId: row.deal_id,
    referencedAdvanceIds: parseJson<string[]>(row.referenced_advance_ids_json, []),
    scheduleId: row.schedule_id,
    createdAt: row.created_at,
  }
}

function scheduleFrom(row: ScheduleRow): DistributionSchedule {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    reverseConsolidationId: row.reverse_consolidation_id,
    dealId: row.deal_id,
    status: row.status,
    version: Number(row.active_version),
    startDate: row.start_date,
    installmentCount: Number(row.installment_count),
    installmentCents: Number(row.installment_cents),
    splitTemplateId: row.split_template_id,
    splitTemplateVersion: Number(row.split_template_version),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function installmentFrom(row: InstallmentRow): ScheduledInstallment {
  return {
    id: row.id,
    scheduleId: row.schedule_id,
    scheduleVersion: Number(row.schedule_version),
    occurrenceDate: row.occurrence_date,
    recipientMembershipId: row.recipient_membership_id,
    recipientName: row.recipient_name?.trim() || "Unknown recipient",
    amountCents: Number(row.amount_cents),
    percentageBasisPoints: Number(row.percentage_basis_points),
    status: row.status,
    paidAt: row.paid_at,
    snapshot: parseJson(row.snapshot_json, null),
  }
}

function scheduleSelect(alias = "s"): string {
  return `${alias}.id, ${alias}.workspace_id, ${alias}.reverse_consolidation_id, c.deal_id, ${alias}.status, ${alias}.active_version,
    ${alias}.start_date, ${alias}.installment_count, ${alias}.installment_cents, ${alias}.split_template_id, ${alias}.split_template_version,
    ${alias}.created_at, ${alias}.updated_at`
}

async function loadSchedule(database: DbExecutor, workspaceId: string, scheduleId: string): Promise<DistributionSchedule> {
  const row = await database.prepare<ScheduleRow>(`SELECT ${scheduleSelect("s")}
    FROM mca_distribution_schedules s
    JOIN mca_reverse_consolidations c ON c.workspace_id=s.workspace_id AND c.id=s.reverse_consolidation_id
    WHERE s.workspace_id=? AND s.id=?`).get(workspaceId, scheduleId)
  if (!row) throw new AppError(404, "schedule_not_found", "The requested distribution schedule was not found.")
  return scheduleFrom(row)
}

async function listInstallments(database: DbExecutor, workspaceId: string, scheduleId?: string): Promise<ScheduledInstallment[]> {
  const rows = await database.prepare<InstallmentRow>(`SELECT i.id, i.schedule_id, i.schedule_version, i.occurrence_date, i.recipient_membership_id,
      COALESCE(${membershipProfileNameSql}, 'Unknown recipient') recipient_name, i.amount_cents, i.percentage_basis_points, i.status, i.paid_at, i.snapshot_json
    FROM mca_scheduled_installments i
    LEFT JOIN memberships m ON m.workspace_id=i.workspace_id AND m.id=i.recipient_membership_id
    LEFT JOIN users u ON u.id=m.user_id
    WHERE i.workspace_id=? AND (?::text IS NULL OR i.schedule_id=?)
    ORDER BY i.occurrence_date, i.schedule_version, COALESCE(${membershipProfileNameSql}, i.recipient_membership_id), i.id`)
    .all(workspaceId, scheduleId ?? null, scheduleId ?? null)
  return rows.map(installmentFrom)
}

async function lockSchedule(database: DbExecutor, workspaceId: string, scheduleId: string): Promise<LockedSchedule> {
  const row = await database.prepare<LockedSchedule>(`SELECT s.id, s.reverse_consolidation_id, s.status, s.active_version, s.start_date,
      s.installment_count, s.installment_cents, s.split_template_id, s.split_template_version, s.created_at, s.updated_at, c.deal_id
    FROM mca_distribution_schedules s
    JOIN mca_reverse_consolidations c ON c.workspace_id=s.workspace_id AND c.id=s.reverse_consolidation_id
    WHERE s.workspace_id=? AND s.id=? FOR UPDATE OF s`).get(workspaceId, scheduleId)
  if (!row) throw new AppError(404, "schedule_not_found", "The requested distribution schedule was not found.")
  return row
}

async function loadSplitAllocations(
  database: DbExecutor,
  workspaceId: string,
  templateId: string,
  version: number,
): Promise<BasisPointAllocation[]> {
  const row = await database.prepare<{ allocation_json: string }>(`SELECT allocation_json FROM mca_split_template_versions
    WHERE workspace_id=? AND template_id=? AND version=?`).get(workspaceId, templateId, version)
  if (!row) throw new AppError(404, "split_template_not_found", "The requested split template version was not found.")
  const allocations = parseJson<BasisPointAllocation[]>(row.allocation_json, [])
  splitSnapshot(0, allocations)
  const recipientIds = uniqueIds(allocations.map((item) => item.recipientMembershipId))
  const recipients = await database.prepare<{ id: string }>(`SELECT id FROM memberships WHERE workspace_id=? AND status='active' AND id=ANY(?::text[])`)
    .all(workspaceId, recipientIds)
  if (recipients.length !== recipientIds.length) {
    throw new AppError(422, "invalid_recipient", "Every split recipient must be an active workspace member.")
  }
  return allocations
}

async function materializeVersion(
  database: DbExecutor,
  input: {
    workspaceId: string
    scheduleId: string
    version: number
    startDate: string
    installmentCount: number
    installmentCents: number
    allocations: readonly BasisPointAllocation[]
    skipPaidPairs?: boolean
    timestamp: string
  },
): Promise<RunDistributionSchedulesResult> {
  const snapshot = splitSnapshot(input.installmentCents, input.allocations)
  const dates = weeklyOccurrenceDates(input.startDate, input.installmentCount)
  const paidPairs = new Set<string>()
  if (input.skipPaidPairs) {
    const paid = await database.prepare<{ occurrence_date: string; recipient_membership_id: string }>(`SELECT occurrence_date, recipient_membership_id
      FROM mca_scheduled_installments WHERE workspace_id=? AND schedule_id=? AND status='paid'`).all(input.workspaceId, input.scheduleId)
    for (const row of paid) paidPairs.add(`${row.occurrence_date}:${row.recipient_membership_id}`)
  }
  let inserted = 0
  let skipped = 0
  for (const occurrenceDate of dates) {
    for (const allocation of snapshot.allocations) {
      if (paidPairs.has(`${occurrenceDate}:${allocation.recipientMembershipId}`)) {
        skipped += 1
        continue
      }
      const idempotencyKey = `${input.version}:${occurrenceDate}:${allocation.recipientMembershipId}`
      const row = await database.prepare<{ id: string }>(`INSERT INTO mca_scheduled_installments
        (id, workspace_id, schedule_id, schedule_version, occurrence_date, recipient_membership_id, amount_cents,
         percentage_basis_points, status, paid_at, snapshot_json, idempotency_key, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'expected', NULL, ?, ?, ?, ?)
        ON CONFLICT (workspace_id, schedule_id, schedule_version, occurrence_date, recipient_membership_id) DO NOTHING
        RETURNING id`).get(
        newId(), input.workspaceId, input.scheduleId, input.version, occurrenceDate, allocation.recipientMembershipId,
        allocation.amountCents, allocation.percentageBasisPoints, JSON.stringify({ ...snapshot, occurrenceDate, noBankTransfer: true }),
        idempotencyKey, input.timestamp, input.timestamp,
      )
      if (row) inserted += 1
      else skipped += 1
    }
  }
  return { inserted, skipped }
}

async function insertScheduleVersion(
  database: DbExecutor,
  input: {
    workspaceId: string
    scheduleId: string
    version: number
    startDate: string
    installmentCount: number
    installmentCents: number
    splitTemplateId: string
    splitTemplateVersion: number
    allocations: readonly BasisPointAllocation[]
    reason: string | null
    actorUserId: string | null
    timestamp: string
  },
) {
  await database.prepare(`INSERT INTO mca_distribution_schedule_versions
    (id, workspace_id, schedule_id, version, start_date, installment_count, installment_cents, split_template_id,
     split_template_version, allocation_json, reason, created_by_user_id, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    newId(), input.workspaceId, input.scheduleId, input.version, input.startDate, input.installmentCount,
    input.installmentCents, input.splitTemplateId, input.splitTemplateVersion, JSON.stringify(input.allocations),
    input.reason, input.actorUserId, input.timestamp,
  )
}

function validateTerms(input: {
  startDate: string
  installmentCount: number
  installmentCents: number
  splitTemplateId: string
  splitTemplateVersion: number
}) {
  if (!input.splitTemplateId?.trim()) throw new AppError(400, "validation_failed", "A split template is required.", { splitTemplateId: ["Required"] })
  if (!Number.isSafeInteger(input.splitTemplateVersion) || input.splitTemplateVersion <= 0) {
    throw new AppError(400, "validation_failed", "A split template version is required.", { splitTemplateVersion: ["Must be a positive integer"] })
  }
  return {
    startDate: assertMondayStart(input.startDate),
    installmentCount: assertInstallmentCount(input.installmentCount),
    installmentCents: assertInstallmentCents(input.installmentCents),
    splitTemplateId: input.splitTemplateId.trim(),
    splitTemplateVersion: input.splitTemplateVersion,
  }
}

async function replayConsolidation(
  database: DbExecutor,
  actor: DealActor,
  existing: ConsolidationRow,
  input: CreateReverseConsolidationInput,
  advanceIds: string[],
): Promise<CreateReverseConsolidationResult> {
  const version = await database.prepare<VersionRow>(`SELECT start_date, installment_count, installment_cents, split_template_id,
      split_template_version, allocation_json FROM mca_distribution_schedule_versions
    WHERE workspace_id=? AND schedule_id=? AND version=1`).get(actor.workspaceId, existing.schedule_id)
  const storedIds = uniqueIds(parseJson<string[]>(existing.referenced_advance_ids_json, []))
  if (!version
    || existing.deal_id !== input.dealId
    || !sameIds(storedIds, advanceIds)
    || version.start_date !== input.startDate
    || Number(version.installment_count) !== input.installmentCount
    || Number(version.installment_cents) !== input.installmentCents
    || version.split_template_id !== input.splitTemplateId
    || Number(version.split_template_version) !== input.splitTemplateVersion) {
    throw new AppError(409, "idempotency_conflict", "That retry key already identifies a different reverse consolidation.")
  }
  return {
    consolidation: consolidationFrom(existing),
    schedule: await loadSchedule(database, actor.workspaceId, existing.schedule_id),
    created: false,
  }
}

export async function createReverseConsolidation(
  actor: DealActor,
  input: CreateReverseConsolidationInput,
): Promise<CreateReverseConsolidationResult> {
  if (!input.idempotencyKey?.trim()) {
    throw new AppError(400, "validation_failed", "An idempotency key is required.", { idempotencyKey: ["Required"] })
  }
  if (!input.dealId?.trim()) throw new AppError(400, "validation_failed", "A deal is required.", { dealId: ["Required"] })
  const advanceIds = uniqueIds(input.referencedAdvanceIds ?? [])
  if (advanceIds.length === 0) {
    throw new AppError(400, "validation_failed", "Reference at least one advance on the deal.", { referencedAdvanceIds: ["Required"] })
  }
  const terms = validateTerms(input)
  return withImmediateTransaction(async (database) => {
    const deal = await database.prepare<{ id: string }>(`SELECT id FROM deals WHERE workspace_id=? AND id=? FOR UPDATE`)
      .get(actor.workspaceId, input.dealId)
    if (!deal) throw new AppError(404, "deal_not_found", "The requested deal was not found.")
    const advances = await database.prepare<{ id: string; deal_id: string; status: string }>(`SELECT id, deal_id, status FROM mca_advances
      WHERE workspace_id=? AND id=ANY(?::text[]) FOR UPDATE`).all(actor.workspaceId, advanceIds)
    if (advances.length !== advanceIds.length) throw new AppError(404, "advance_not_found", "Every referenced advance must exist in this workspace.")
    if (advances.some((row) => row.deal_id !== input.dealId)) {
      throw new AppError(422, "advance_deal_mismatch", "Referenced advances must belong to the same deal.")
    }
    if (advances.some((row) => row.status === "reversed")) {
      throw new AppError(409, "advance_reversed", "A reversed advance cannot be referenced by a reverse consolidation.")
    }
    const allocations = await loadSplitAllocations(database, actor.workspaceId, terms.splitTemplateId, terms.splitTemplateVersion)
    splitSnapshot(terms.installmentCents, allocations)
    const existing = await database.prepare<ConsolidationRow>(`SELECT id, deal_id, referenced_advance_ids_json, schedule_id, created_at
      FROM mca_reverse_consolidations WHERE workspace_id=? AND idempotency_key=? FOR UPDATE`)
      .get(actor.workspaceId, input.idempotencyKey.trim())
    if (existing) return replayConsolidation(database, actor, existing, { ...input, ...terms }, advanceIds)

    const timestamp = nowIso()
    const consolidationId = newId()
    const scheduleId = newId()
    const inserted = await database.prepare<ConsolidationRow>(`INSERT INTO mca_reverse_consolidations
      (id, workspace_id, deal_id, referenced_advance_ids_json, schedule_id, idempotency_key, created_by_user_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (workspace_id, idempotency_key) DO NOTHING
      RETURNING id, deal_id, referenced_advance_ids_json, schedule_id, created_at`).get(
      consolidationId, actor.workspaceId, input.dealId, JSON.stringify(advanceIds), scheduleId,
      input.idempotencyKey.trim(), actor.userId, timestamp,
    )
    if (!inserted) {
      const replay = await database.prepare<ConsolidationRow>(`SELECT id, deal_id, referenced_advance_ids_json, schedule_id, created_at
        FROM mca_reverse_consolidations WHERE workspace_id=? AND idempotency_key=?`)
        .get(actor.workspaceId, input.idempotencyKey.trim())
      if (!replay) throw new AppError(409, "idempotency_conflict", "That retry key already identifies a different reverse consolidation.")
      return replayConsolidation(database, actor, replay, { ...input, ...terms }, advanceIds)
    }
    await database.prepare(`INSERT INTO mca_distribution_schedules
      (id, workspace_id, reverse_consolidation_id, status, active_version, start_date, installment_count, installment_cents,
       split_template_id, split_template_version, created_at, updated_at)
      VALUES (?, ?, ?, 'active', 1, ?, ?, ?, ?, ?, ?, ?)`).run(
      scheduleId, actor.workspaceId, consolidationId, terms.startDate, terms.installmentCount, terms.installmentCents,
      terms.splitTemplateId, terms.splitTemplateVersion, timestamp, timestamp,
    )
    await insertScheduleVersion(database, {
      workspaceId: actor.workspaceId, scheduleId, version: 1, ...terms, allocations,
      reason: "created", actorUserId: actor.userId, timestamp,
    })
    await recordAuditEvent({
      context: actor, action: "accounting.reverse_consolidation.created", resourceType: "reverse_consolidation",
      resourceId: consolidationId, correlationId: actor.correlationId,
      metadata: { scheduleId, dealId: input.dealId, referencedAdvanceCount: advanceIds.length, noBankTransfer: true },
      executor: database,
    })
    return {
      consolidation: consolidationFrom(inserted),
      schedule: await loadSchedule(database, actor.workspaceId, scheduleId),
      created: true,
    }
  })
}

export async function listReverseConsolidations(actor: DealActor): Promise<ReverseConsolidationWorkspace> {
  const database = getDatabase()
  const consolidations = await database.prepare<ConsolidationRow>(`SELECT id, deal_id, referenced_advance_ids_json, schedule_id, created_at
    FROM mca_reverse_consolidations WHERE workspace_id=? ORDER BY created_at DESC, id`).all(actor.workspaceId)
  const schedules = await database.prepare<ScheduleRow>(`SELECT ${scheduleSelect("s")}
    FROM mca_distribution_schedules s
    JOIN mca_reverse_consolidations c ON c.workspace_id=s.workspace_id AND c.id=s.reverse_consolidation_id
    WHERE s.workspace_id=? ORDER BY s.created_at DESC, s.id`).all(actor.workspaceId)
  return {
    consolidations: consolidations.map(consolidationFrom),
    schedules: schedules.map(scheduleFrom),
    installments: await listInstallments(database, actor.workspaceId),
  }
}

export async function runDistributionSchedules(
  actor: DealActor,
  input: RunDistributionSchedulesInput = {},
): Promise<RunDistributionSchedulesResult> {
  return withImmediateTransaction(async (database) => {
    if (input.scheduleId) await lockSchedule(database, actor.workspaceId, input.scheduleId)
    const schedules = await database.prepare<{
      id: string
      active_version: number
      start_date: string
      installment_count: number
      installment_cents: number
      allocation_json: string
    }>(`SELECT s.id, s.active_version, v.start_date, v.installment_count, v.installment_cents, v.allocation_json
      FROM mca_distribution_schedules s
      JOIN mca_distribution_schedule_versions v
        ON v.workspace_id=s.workspace_id AND v.schedule_id=s.id AND v.version=s.active_version
      WHERE s.workspace_id=? AND s.status='active' AND (?::text IS NULL OR s.id=?)
      ORDER BY s.id FOR UPDATE OF s`).all(actor.workspaceId, input.scheduleId ?? null, input.scheduleId ?? null)
    const timestamp = nowIso()
    let inserted = 0
    let skipped = 0
    for (const schedule of schedules) {
      const allocations = parseJson<BasisPointAllocation[]>(schedule.allocation_json, [])
      const result = await materializeVersion(database, {
        workspaceId: actor.workspaceId,
        scheduleId: schedule.id,
        version: Number(schedule.active_version),
        startDate: schedule.start_date,
        installmentCount: Number(schedule.installment_count),
        installmentCents: Number(schedule.installment_cents),
        allocations,
        timestamp,
      })
      inserted += result.inserted
      skipped += result.skipped
    }
    await recordAuditEvent({
      context: actor, action: "accounting.schedule.run", resourceType: "distribution_schedule",
      resourceId: input.scheduleId ?? actor.workspaceId, correlationId: actor.correlationId,
      metadata: { inserted, skipped, scheduleId: input.scheduleId ?? null, nowIso: input.nowIso ?? null, noBankTransfer: true },
      executor: database,
    })
    return { inserted, skipped }
  })
}

export async function pauseDistributionSchedule(actor: DealActor, scheduleId: string): Promise<DistributionSchedule> {
  return withImmediateTransaction(async (database) => {
    const current = await lockSchedule(database, actor.workspaceId, scheduleId)
    if (current.status === "cancelled") throw new AppError(409, "schedule_cancelled", "A cancelled schedule cannot be paused.")
    if (current.status !== "paused") {
      await database.prepare(`UPDATE mca_distribution_schedules SET status='paused', updated_at=? WHERE workspace_id=? AND id=?`)
        .run(nowIso(), actor.workspaceId, scheduleId)
      await recordAuditEvent({
        context: actor, action: "accounting.schedule.paused", resourceType: "distribution_schedule",
        resourceId: scheduleId, correlationId: actor.correlationId, metadata: { noBankTransfer: true }, executor: database,
      })
    }
    return loadSchedule(database, actor.workspaceId, scheduleId)
  })
}

export async function cancelDistributionSchedule(actor: DealActor, scheduleId: string): Promise<DistributionSchedule> {
  return withImmediateTransaction(async (database) => {
    const current = await lockSchedule(database, actor.workspaceId, scheduleId)
    const timestamp = nowIso()
    if (current.status !== "cancelled") {
      await database.prepare(`UPDATE mca_distribution_schedules SET status='cancelled', updated_at=? WHERE workspace_id=? AND id=?`)
        .run(timestamp, actor.workspaceId, scheduleId)
      await database.prepare(`UPDATE mca_scheduled_installments SET status='void', updated_at=?
        WHERE workspace_id=? AND schedule_id=? AND status='expected'`).run(timestamp, actor.workspaceId, scheduleId)
      await recordAuditEvent({
        context: actor, action: "accounting.schedule.cancelled", resourceType: "distribution_schedule",
        resourceId: scheduleId, correlationId: actor.correlationId, metadata: { noBankTransfer: true }, executor: database,
      })
    }
    return loadSchedule(database, actor.workspaceId, scheduleId)
  })
}

export async function amendDistributionSchedule(
  actor: DealActor,
  scheduleId: string,
  input: AmendDistributionScheduleInput,
): Promise<DistributionSchedule> {
  const terms = validateTerms(input)
  return withImmediateTransaction(async (database) => {
    const current = await lockSchedule(database, actor.workspaceId, scheduleId)
    if (current.status === "cancelled") throw new AppError(409, "schedule_cancelled", "A cancelled schedule cannot be amended.")
    const allocations = await loadSplitAllocations(database, actor.workspaceId, terms.splitTemplateId, terms.splitTemplateVersion)
    const timestamp = nowIso()
    const nextVersion = Number(current.active_version) + 1
    await database.prepare(`UPDATE mca_scheduled_installments SET status='void', updated_at=?
      WHERE workspace_id=? AND schedule_id=? AND schedule_version=? AND status='expected'`)
      .run(timestamp, actor.workspaceId, scheduleId, current.active_version)
    await insertScheduleVersion(database, {
      workspaceId: actor.workspaceId, scheduleId, version: nextVersion, ...terms, allocations,
      reason: input.reason?.trim() || "amended", actorUserId: actor.userId, timestamp,
    })
    await database.prepare(`UPDATE mca_distribution_schedules
      SET active_version=?, start_date=?, installment_count=?, installment_cents=?, split_template_id=?, split_template_version=?, updated_at=?
      WHERE workspace_id=? AND id=?`).run(
      nextVersion, terms.startDate, terms.installmentCount, terms.installmentCents, terms.splitTemplateId,
      terms.splitTemplateVersion, timestamp, actor.workspaceId, scheduleId,
    )
    await materializeVersion(database, {
      workspaceId: actor.workspaceId, scheduleId, version: nextVersion, ...terms, allocations, skipPaidPairs: true, timestamp,
    })
    await recordAuditEvent({
      context: actor, action: "accounting.schedule.amended", resourceType: "distribution_schedule",
      resourceId: scheduleId, correlationId: actor.correlationId,
      metadata: { version: nextVersion, noBankTransfer: true }, executor: database,
    })
    return loadSchedule(database, actor.workspaceId, scheduleId)
  })
}

export async function exceptOccurrence(
  actor: DealActor,
  scheduleId: string,
  input: ExceptOccurrenceInput,
): Promise<ScheduledInstallment[]> {
  calendarDateUtcNoon(input.occurrenceDate, "occurrenceDate")
  return withImmediateTransaction(async (database) => {
    const current = await lockSchedule(database, actor.workspaceId, scheduleId)
    if (current.status === "cancelled") throw new AppError(409, "schedule_cancelled", "A cancelled schedule cannot record exceptions.")
    const timestamp = nowIso()
    const rows = await database.prepare<InstallmentRow>(`SELECT i.id, i.schedule_id, i.schedule_version, i.occurrence_date, i.recipient_membership_id,
        COALESCE(${membershipProfileNameSql}, 'Unknown recipient') recipient_name, i.amount_cents, i.percentage_basis_points, i.status, i.paid_at, i.snapshot_json
      FROM mca_scheduled_installments i
      LEFT JOIN memberships m ON m.workspace_id=i.workspace_id AND m.id=i.recipient_membership_id
      LEFT JOIN users u ON u.id=m.user_id
      WHERE i.workspace_id=? AND i.schedule_id=? AND i.schedule_version=? AND i.occurrence_date=?
        AND (?::text IS NULL OR i.recipient_membership_id=?)
      FOR UPDATE OF i`).all(
      actor.workspaceId, scheduleId, current.active_version, input.occurrenceDate,
      input.recipientMembershipId ?? null, input.recipientMembershipId ?? null,
    )
    if (rows.length === 0) throw new AppError(404, "occurrence_not_found", "No installment exists for that occurrence.")
    if (rows.some((row) => row.status === "paid")) {
      throw new AppError(409, "paid_installment_immutable", "Paid installment history cannot be voided.")
    }
    await database.prepare(`UPDATE mca_scheduled_installments SET status='void', updated_at=?
      WHERE workspace_id=? AND schedule_id=? AND schedule_version=? AND occurrence_date=? AND status='expected'
        AND (?::text IS NULL OR recipient_membership_id=?)`).run(
      timestamp, actor.workspaceId, scheduleId, current.active_version, input.occurrenceDate,
      input.recipientMembershipId ?? null, input.recipientMembershipId ?? null,
    )
    await recordAuditEvent({
      context: actor, action: "accounting.schedule.excepted", resourceType: "distribution_schedule",
      resourceId: scheduleId, correlationId: actor.correlationId,
      metadata: { occurrenceDate: input.occurrenceDate, recipientMembershipId: input.recipientMembershipId ?? null, noBankTransfer: true },
      executor: database,
    })
    return listInstallments(database, actor.workspaceId, scheduleId)
  })
}

export async function markInstallmentPaid(
  actor: DealActor,
  scheduleId: string,
  input: MarkInstallmentPaidInput,
): Promise<ScheduledInstallment> {
  if (!input.installmentId && !(input.occurrenceDate && input.recipientMembershipId)) {
    throw new AppError(400, "validation_failed", "Choose an installment or an occurrence date and recipient.")
  }
  if (input.occurrenceDate) calendarDateUtcNoon(input.occurrenceDate, "occurrenceDate")
  return withImmediateTransaction(async (database) => {
    await lockSchedule(database, actor.workspaceId, scheduleId)
    const row = input.installmentId
      ? await database.prepare<InstallmentRow>(`SELECT i.id, i.schedule_id, i.schedule_version, i.occurrence_date, i.recipient_membership_id,
            COALESCE(${membershipProfileNameSql}, 'Unknown recipient') recipient_name, i.amount_cents, i.percentage_basis_points, i.status, i.paid_at, i.snapshot_json
          FROM mca_scheduled_installments i
          LEFT JOIN memberships m ON m.workspace_id=i.workspace_id AND m.id=i.recipient_membership_id
          LEFT JOIN users u ON u.id=m.user_id
          WHERE i.workspace_id=? AND i.schedule_id=? AND i.id=? FOR UPDATE OF i`).get(actor.workspaceId, scheduleId, input.installmentId)
      : await database.prepare<InstallmentRow>(`SELECT i.id, i.schedule_id, i.schedule_version, i.occurrence_date, i.recipient_membership_id,
            COALESCE(${membershipProfileNameSql}, 'Unknown recipient') recipient_name, i.amount_cents, i.percentage_basis_points, i.status, i.paid_at, i.snapshot_json
          FROM mca_scheduled_installments i
          LEFT JOIN memberships m ON m.workspace_id=i.workspace_id AND m.id=i.recipient_membership_id
          LEFT JOIN users u ON u.id=m.user_id
          WHERE i.workspace_id=? AND i.schedule_id=? AND i.occurrence_date=? AND i.recipient_membership_id=?
            AND i.status<>'void' ORDER BY i.schedule_version DESC, i.id FOR UPDATE OF i`)
        .get(actor.workspaceId, scheduleId, input.occurrenceDate!, input.recipientMembershipId!)
    if (!row) throw new AppError(404, "installment_not_found", "The requested installment was not found.")
    if (row.status === "void") throw new AppError(409, "void_installment_immutable", "A void installment cannot be marked paid.")
    if (row.status === "paid") return installmentFrom(row)
    const timestamp = nowIso()
    const paidAt = input.paidAt?.trim() || timestamp
    await database.prepare(`UPDATE mca_scheduled_installments SET status='paid', paid_at=?, updated_at=?
      WHERE workspace_id=? AND id=? AND status='expected'`).run(paidAt, timestamp, actor.workspaceId, row.id)
    await recordAuditEvent({
      context: actor, action: "accounting.schedule.installment.paid", resourceType: "scheduled_installment",
      resourceId: row.id, correlationId: actor.correlationId,
      metadata: { scheduleId, occurrenceDate: row.occurrence_date, noBankTransfer: true }, executor: database,
    })
    const saved = await database.prepare<InstallmentRow>(`SELECT i.id, i.schedule_id, i.schedule_version, i.occurrence_date, i.recipient_membership_id,
        COALESCE(${membershipProfileNameSql}, 'Unknown recipient') recipient_name, i.amount_cents, i.percentage_basis_points, i.status, i.paid_at, i.snapshot_json
      FROM mca_scheduled_installments i
      LEFT JOIN memberships m ON m.workspace_id=i.workspace_id AND m.id=i.recipient_membership_id
      LEFT JOIN users u ON u.id=m.user_id
      WHERE i.workspace_id=? AND i.id=?`).get(actor.workspaceId, row.id)
    if (!saved) throw new AppError(404, "installment_not_found", "The requested installment was not found.")
    return installmentFrom(saved)
  })
}

export const SCHEDULE_NO_TRANSFER_NOTICE = NO_TRANSFER
