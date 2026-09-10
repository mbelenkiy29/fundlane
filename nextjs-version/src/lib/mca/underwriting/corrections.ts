import "server-only"

import { nowIso, recordAuditEvent } from "../db"
import { getDealForDocument } from "../deals/service"
import type { DealActor } from "../deals/schema"
import { AppError } from "../errors"
import type { ExistingPositionCandidate, MetricEvidence, StatementMonthRecord, UnderwritingAggregate } from "./contracts"
import { normalizeMetric } from "./statement-extraction"
import {
  getMonthRecordForUpdate,
  getPositionRecordForUpdate,
  listMonthRecords,
  listPositionRecords,
  originalMetricsFromExtraction,
  saveMonthCorrection,
  savePositionCorrection,
  saveRecomputedAggregate,
  toAggregateSummary,
  toMonthSummary,
  toPositionSummary,
  withUnderwritingDealLock,
  type ExistingPositionRow,
  type StatementMonthRow,
} from "./statement-repository"
import {
  analyzeDealStatements,
  getUnderwritingAggregate,
  listStatementMonths,
  requireStatementActor,
} from "./statements"

export { requireStatementActor as requireCorrectionActor }

const POSITION_STATUSES = new Set<ExistingPositionCandidate["status"]>(["proposed", "confirmed", "dismissed"])
const METRIC_FIELDS = ["deposits", "depositCount", "averageDailyBalance", "nsfCount", "negativeDays", "endingBalance"] as const
type MetricField = (typeof METRIC_FIELDS)[number]

export interface CorrectionMonthView extends StatementMonthRecord {
  original: ReturnType<typeof originalMetricsFromExtraction>
}

export interface CorrectionPositionView extends ExistingPositionCandidate {
  corrected: boolean
  correctionReason?: string
  correctedByUserId?: string
  correctedAt?: string
}

export interface DealCorrections {
  months: CorrectionMonthView[]
  positions: CorrectionPositionView[]
  aggregate: UnderwritingAggregate | null
}

export interface MonthCorrectionInput {
  dealId: string
  monthId: string
  reason: string
  deposits?: number | null
  depositCount?: number | null
  averageDailyBalance?: number | null
  nsfCount?: number | null
  negativeDays?: number | null
  endingBalance?: number | null
}

export interface PositionCorrectionInput {
  dealId: string
  positionId: string
  reason: string
  status: ExistingPositionCandidate["status"]
  estimatedPayment?: number | null
}

function requireReason(reason: string | undefined): string {
  const trimmed = reason?.trim() ?? ""
  if (!trimmed) {
    throw new AppError(422, "validation_failed", "A correction reason is required.", { reason: ["Enter a reason for this correction."] })
  }
  return trimmed
}

function requireMetricNumber(field: MetricField, value: unknown): number | null {
  if (value === null) return null
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new AppError(422, "validation_failed", "Corrected metrics must be finite numbers or null.", { [field]: ["Enter a finite number, or leave unknown as null."] })
  }
  return value
}

function correctedMetric(current: MetricEvidence, value: number | null | undefined): MetricEvidence {
  if (value === undefined) return current
  return normalizeMetric({
    value,
    unknown: value == null,
    confidence: 1,
    ...(current.page ? { page: current.page } : {}),
    ...(current.text ? { text: current.text } : {}),
  })
}

function toMonthView(row: StatementMonthRow): CorrectionMonthView {
  return { ...toMonthSummary(row), original: originalMetricsFromExtraction(row.originalExtraction) }
}

function toPositionView(row: ExistingPositionRow): CorrectionPositionView {
  return {
    ...toPositionSummary(row),
    corrected: Boolean(row.corrected),
    ...(row.correctionReason ? { correctionReason: row.correctionReason } : {}),
    ...(row.correctedByUserId ? { correctedByUserId: row.correctedByUserId } : {}),
    ...(row.correctedAt ? { correctedAt: row.correctedAt } : {}),
  }
}

export async function getDealCorrections(actor: DealActor, dealId: string): Promise<DealCorrections> {
  const [months, monthRecords, positionRecords, aggregate] = await Promise.all([
    listStatementMonths(actor, dealId),
    listMonthRecords(actor.workspaceId, dealId),
    listPositionRecords(actor.workspaceId, dealId),
    getUnderwritingAggregate(actor, dealId),
  ])
  const rows = new Map(monthRecords.map((row) => [row.id, row]))
  return {
    months: months.map((month) => {
      const row = rows.get(month.id)
      return { ...month, original: originalMetricsFromExtraction(row?.originalExtraction ?? "{}") }
    }),
    positions: positionRecords.map(toPositionView),
    aggregate,
  }
}

export async function correctStatementMonth(actor: DealActor, input: MonthCorrectionInput): Promise<{ month: CorrectionMonthView; aggregate: UnderwritingAggregate }> {
  await getDealForDocument(actor, input.dealId)
  const reason = requireReason(input.reason)
  const provided = METRIC_FIELDS.filter((field) => input[field] !== undefined)
  if (provided.length === 0) {
    throw new AppError(422, "validation_failed", "Correct at least one statement metric.", { deposits: ["Enter a metric to correct."] })
  }
  const values: Partial<Record<MetricField, number | null>> = {}
  for (const field of provided) values[field] = requireMetricNumber(field, input[field])
  const now = nowIso()
  const saved = await withUnderwritingDealLock(actor.workspaceId, input.dealId, async (database) => {
    const month = await getMonthRecordForUpdate(actor.workspaceId, input.monthId)
    if (!month || month.dealId !== input.dealId) throw new AppError(404, "month_not_found", "That statement month was not found.")
    const next = await saveMonthCorrection({
      workspaceId: actor.workspaceId,
      monthId: month.id,
      reason,
      now,
      actorUserId: actor.userId,
      deposits: correctedMetric(month.deposits, values.deposits),
      depositCount: correctedMetric(month.depositCount, values.depositCount),
      averageDailyBalance: correctedMetric(month.averageDailyBalance, values.averageDailyBalance),
      nsfCount: correctedMetric(month.nsfCount, values.nsfCount),
      negativeDays: correctedMetric(month.negativeDays, values.negativeDays),
      endingBalance: correctedMetric(month.endingBalance, values.endingBalance),
    })
    const aggregate = await saveRecomputedAggregate(actor.workspaceId, input.dealId, true, now)
    await recordAuditEvent({
      context: actor,
      action: "underwriting.statement_corrected",
      resourceType: "statement_month",
      resourceId: month.id,
      metadata: { dealId: input.dealId, fields: provided, reason },
      correlationId: actor.correlationId,
      executor: database,
    })
    return { month: toMonthView(next), aggregate }
  })
  return { month: saved.month, aggregate: toAggregateSummary(saved.aggregate) }
}

export async function correctExistingPosition(actor: DealActor, input: PositionCorrectionInput): Promise<{ position: CorrectionPositionView; aggregate: UnderwritingAggregate }> {
  await getDealForDocument(actor, input.dealId)
  const reason = requireReason(input.reason)
  if (!POSITION_STATUSES.has(input.status)) {
    throw new AppError(422, "validation_failed", "Position status must be proposed, confirmed, or dismissed.", { status: ["Choose proposed, confirmed, or dismissed."] })
  }
  if (input.estimatedPayment !== undefined && input.estimatedPayment !== null && (typeof input.estimatedPayment !== "number" || !Number.isFinite(input.estimatedPayment))) {
    throw new AppError(422, "validation_failed", "Estimated payment must be a finite number or null.", { estimatedPayment: ["Enter a finite number, or null if unknown."] })
  }
  const now = nowIso()
  const saved = await withUnderwritingDealLock(actor.workspaceId, input.dealId, async (database) => {
    const position = await getPositionRecordForUpdate(actor.workspaceId, input.positionId)
    if (!position || position.dealId !== input.dealId) throw new AppError(404, "position_not_found", "That existing position was not found.")
    const next = await savePositionCorrection({
      workspaceId: actor.workspaceId,
      positionId: position.id,
      status: input.status,
      reason,
      now,
      actorUserId: actor.userId,
      ...(input.estimatedPayment != null ? { estimatedPayment: input.estimatedPayment } : {}),
    })
    const aggregate = await saveRecomputedAggregate(actor.workspaceId, input.dealId, true, now)
    await recordAuditEvent({
      context: actor,
      action: "underwriting.position_corrected",
      resourceType: "existing_position",
      resourceId: position.id,
      metadata: { dealId: input.dealId, status: input.status, reason },
      correlationId: actor.correlationId,
      executor: database,
    })
    return { position: toPositionView(next), aggregate }
  })
  return { position: saved.position, aggregate: toAggregateSummary(saved.aggregate) }
}

export async function analyzeDealStatementsForCorrections(actor: DealActor, dealId: string, options?: { replaceReviewed?: boolean }): Promise<DealCorrections> {
  await getDealForDocument(actor, dealId)
  const replaceReviewed = Boolean(options?.replaceReviewed)
  await analyzeDealStatements(actor, dealId, { replaceReviewed })
  const result = await getDealCorrections(actor, dealId)
  await recordAuditEvent({
    context: actor,
    action: replaceReviewed ? "underwriting.corrections_replaced" : "underwriting.statements_analyzed",
    resourceType: "deal",
    resourceId: dealId,
    metadata: { replaceReviewed, reviewedMonthCount: result.months.filter((month) => month.corrected).length },
    correlationId: actor.correlationId,
  })
  return result
}
