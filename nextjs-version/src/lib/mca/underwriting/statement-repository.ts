import "server-only"

import { getDatabase, nowIso, parseJson, withImmediateTransaction, type DbExecutor } from "../db"
import { computeUnderwritingAggregate, resolveUnderwritingWindow } from "./aggregates"
import type { ExistingPositionCandidate, MetricEvidence, StatementAccountKind, StatementMonthRecord, UnderwritingAggregate } from "./contracts"
import { normalizeIsoDates, normalizeMetric, normalizeWarnings } from "./statement-extraction"

export interface StatementMonthRow extends StatementMonthRecord {
  workspaceId: string
  originalExtraction: string
  createdAt: string
  updatedAt: string
}

export interface ExistingPositionRow extends ExistingPositionCandidate {
  workspaceId: string
  documentId?: string
  corrected?: boolean
  correctionReason?: string
  correctedByUserId?: string
  correctedAt?: string
  createdAt: string
  updatedAt: string
}

export interface UnderwritingAggregateRow extends UnderwritingAggregate {
  workspaceId: string
  sourceFingerprint: string
}

type MonthSqlRow = {
  id: string; workspace_id: string; deal_id: string; document_id: string; account_kind: string; period: string
  account_suffix: string | null; deposits: string; deposit_count: string; average_daily_balance: string
  nsf_count: string; negative_days: string; nsf_dates: string; negative_dates: string; ending_balance: string
  duplicate_of_id: string | null
  extraction_version: number; corrected: number; correction_reason: string | null; corrected_by_user_id: string | null
  corrected_at: string | null; original_extraction: string; created_at: string; updated_at: string
}

type PositionSqlRow = {
  id: string; workspace_id: string; deal_id: string; document_id: string | null; label: string
  estimated_payment: number | null; evidence: string; status: string
  corrected: number | null; correction_reason: string | null; corrected_by_user_id: string | null; corrected_at: string | null
  created_at: string; updated_at: string
}

type AggregateSqlRow = {
  workspace_id: string; deal_id: string; version: number; monthly_revenue: string; average_daily_balance: string
  nsf_count: string; negative_days: string; deposit_count: string; worst_month_nsf: string; warnings_json: string
  position_count: number; stale: number; source_fingerprint: string; computed_at: string
}

function db() { return getDatabase() }

export async function withUnderwritingDealLock<T>(
  workspaceId: string,
  dealId: string,
  operation: (database: DbExecutor) => Promise<T>,
): Promise<T> {
  return withImmediateTransaction(async (database) => {
    const deal = await database.prepare<{ id: string }>(
      "SELECT id FROM deals WHERE workspace_id = ? AND id = ? FOR UPDATE",
    ).get(workspaceId, dealId)
    if (!deal) throw new Error("Deal not found while acquiring underwriting lock")
    return operation(database)
  })
}

function metricFromJson(value: string): MetricEvidence {
  return normalizeMetric(parseJson<MetricEvidence>(value, { value: null, unknown: true, confidence: 0 }))
}

function fromMonthRow(row: MonthSqlRow): StatementMonthRow {
  const original = parseJson<{ warnings?: string[] }>(row.original_extraction, {})
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    dealId: row.deal_id,
    documentId: row.document_id,
    accountKind: row.account_kind as StatementAccountKind,
    period: row.period,
    ...(row.account_suffix ? { accountSuffix: row.account_suffix } : {}),
    deposits: metricFromJson(row.deposits),
    depositCount: metricFromJson(row.deposit_count),
    averageDailyBalance: metricFromJson(row.average_daily_balance),
    nsfCount: metricFromJson(row.nsf_count),
    negativeDays: metricFromJson(row.negative_days),
    nsfDates: normalizeIsoDates(parseJson<string[]>(row.nsf_dates, [])),
    negativeDates: normalizeIsoDates(parseJson<string[]>(row.negative_dates, [])),
    endingBalance: metricFromJson(row.ending_balance),
    warnings: normalizeWarnings(original.warnings),
    ...(row.duplicate_of_id ? { duplicateOfId: row.duplicate_of_id } : {}),
    extractionVersion: row.extraction_version,
    corrected: Boolean(row.corrected),
    ...(row.correction_reason ? { correctionReason: row.correction_reason } : {}),
    ...(row.corrected_by_user_id ? { correctedByUserId: row.corrected_by_user_id } : {}),
    ...(row.corrected_at ? { correctedAt: row.corrected_at } : {}),
    originalExtraction: row.original_extraction,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function fromPositionRow(row: PositionSqlRow): ExistingPositionRow {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    dealId: row.deal_id,
    ...(row.document_id ? { documentId: row.document_id } : {}),
    label: row.label,
    ...(row.estimated_payment != null ? { estimatedPayment: row.estimated_payment } : {}),
    evidence: row.evidence,
    status: row.status as ExistingPositionCandidate["status"],
    corrected: Boolean(row.corrected),
    ...(row.correction_reason ? { correctionReason: row.correction_reason } : {}),
    ...(row.corrected_by_user_id ? { correctedByUserId: row.corrected_by_user_id } : {}),
    ...(row.corrected_at ? { correctedAt: row.corrected_at } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function fromAggregateRow(row: AggregateSqlRow): UnderwritingAggregateRow {
  return {
    workspaceId: row.workspace_id,
    dealId: row.deal_id,
    version: row.version,
    monthlyRevenue: metricFromJson(row.monthly_revenue),
    averageDailyBalance: metricFromJson(row.average_daily_balance),
    nsfCount: metricFromJson(row.nsf_count),
    negativeDays: metricFromJson(row.negative_days),
    depositCount: metricFromJson(row.deposit_count),
    worstMonthNsf: metricFromJson(row.worst_month_nsf),
    warnings: normalizeWarnings(parseJson<string[]>(row.warnings_json, [])),
    positionCount: row.position_count,
    stale: Boolean(row.stale),
    sourceFingerprint: row.source_fingerprint,
    computedAt: row.computed_at,
  }
}

export function toMonthSummary(row: StatementMonthRow): StatementMonthRecord {
  const { workspaceId: _workspaceId, originalExtraction: _originalExtraction, createdAt: _createdAt, updatedAt: _updatedAt, ...month } = row
  void _workspaceId; void _originalExtraction; void _createdAt; void _updatedAt
  return month
}

export function toPositionSummary(row: ExistingPositionRow): ExistingPositionCandidate {
  const {
    workspaceId: _workspaceId, documentId: _documentId, createdAt: _createdAt, updatedAt: _updatedAt,
    corrected: _corrected, correctionReason: _correctionReason, correctedByUserId: _correctedByUserId, correctedAt: _correctedAt,
    ...position
  } = row
  void _workspaceId; void _documentId; void _createdAt; void _updatedAt
  void _corrected; void _correctionReason; void _correctedByUserId; void _correctedAt
  return position
}

export function toAggregateSummary(row: UnderwritingAggregateRow): UnderwritingAggregate {
  const { workspaceId: _workspaceId, sourceFingerprint: _sourceFingerprint, ...aggregate } = row
  void _workspaceId; void _sourceFingerprint
  return aggregate
}

export async function listMonthRecords(workspaceId: string, dealId: string): Promise<StatementMonthRow[]> {
  const rows = await db().prepare<MonthSqlRow>("SELECT * FROM mca_statement_months WHERE workspace_id = ? AND deal_id = ? ORDER BY period ASC, created_at ASC").all(workspaceId, dealId)
  return rows.map(fromMonthRow)
}

export async function listPositionRecords(workspaceId: string, dealId: string): Promise<ExistingPositionRow[]> {
  const rows = await db().prepare<PositionSqlRow>("SELECT * FROM mca_existing_positions WHERE workspace_id = ? AND deal_id = ? ORDER BY created_at ASC").all(workspaceId, dealId)
  return rows.map(fromPositionRow)
}

export async function getAggregateRecord(workspaceId: string, dealId: string): Promise<UnderwritingAggregateRow | undefined> {
  const row = await db().prepare<AggregateSqlRow>("SELECT * FROM mca_underwriting_aggregates WHERE workspace_id = ? AND deal_id = ?").get(workspaceId, dealId)
  return row ? fromAggregateRow(row) : undefined
}

export async function persistStatementAnalysis(input: {
  workspaceId: string
  dealId: string
  keepDocumentIds: string[]
  months: Array<Omit<StatementMonthRow, "workspaceId" | "dealId">>
  positions: Array<Omit<ExistingPositionRow, "workspaceId" | "dealId">>
  aggregate: Omit<UnderwritingAggregateRow, "workspaceId">
  replaceReviewed?: boolean
}): Promise<{ months: StatementMonthRow[]; positions: ExistingPositionRow[]; aggregate: UnderwritingAggregateRow }> {
  const replace = input.replaceReviewed ? 1 : 0
  return withImmediateTransaction(async (database) => {
    if (input.keepDocumentIds.length === 0) {
      await database.prepare("DELETE FROM mca_statement_months WHERE workspace_id = ? AND deal_id = ?").run(input.workspaceId, input.dealId)
      await database.prepare("DELETE FROM mca_existing_positions WHERE workspace_id = ? AND deal_id = ? AND status = 'proposed'").run(input.workspaceId, input.dealId)
    } else {
      const placeholders = input.keepDocumentIds.map(() => "?").join(",")
      await database.prepare(`DELETE FROM mca_statement_months WHERE workspace_id = ? AND deal_id = ? AND document_id NOT IN (${placeholders})`).run(input.workspaceId, input.dealId, ...input.keepDocumentIds)
      await database.prepare(`DELETE FROM mca_existing_positions WHERE workspace_id = ? AND deal_id = ? AND status = 'proposed' AND document_id IS NOT NULL AND document_id NOT IN (${placeholders})`).run(input.workspaceId, input.dealId, ...input.keepDocumentIds)
    }

    const monthSql = database.prepare(`INSERT INTO mca_statement_months (
      id, workspace_id, deal_id, document_id, account_kind, period, account_suffix, deposits, deposit_count,
      average_daily_balance, nsf_count, negative_days, nsf_dates, negative_dates, ending_balance, duplicate_of_id, extraction_version,
      corrected, correction_reason, corrected_by_user_id, corrected_at, original_extraction, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(workspace_id, document_id) DO UPDATE SET
      account_kind = CASE WHEN ${replace} = 0 AND mca_statement_months.corrected = 1 THEN mca_statement_months.account_kind ELSE excluded.account_kind END,
      period = CASE WHEN ${replace} = 0 AND mca_statement_months.corrected = 1 THEN mca_statement_months.period ELSE excluded.period END,
      account_suffix = CASE WHEN ${replace} = 0 AND mca_statement_months.corrected = 1 THEN mca_statement_months.account_suffix ELSE excluded.account_suffix END,
      deposits = CASE WHEN ${replace} = 0 AND mca_statement_months.corrected = 1 THEN mca_statement_months.deposits ELSE excluded.deposits END,
      deposit_count = CASE WHEN ${replace} = 0 AND mca_statement_months.corrected = 1 THEN mca_statement_months.deposit_count ELSE excluded.deposit_count END,
      average_daily_balance = CASE WHEN ${replace} = 0 AND mca_statement_months.corrected = 1 THEN mca_statement_months.average_daily_balance ELSE excluded.average_daily_balance END,
      nsf_count = CASE WHEN ${replace} = 0 AND mca_statement_months.corrected = 1 THEN mca_statement_months.nsf_count ELSE excluded.nsf_count END,
      negative_days = CASE WHEN ${replace} = 0 AND mca_statement_months.corrected = 1 THEN mca_statement_months.negative_days ELSE excluded.negative_days END,
      nsf_dates = CASE WHEN ${replace} = 0 AND mca_statement_months.corrected = 1 THEN mca_statement_months.nsf_dates ELSE excluded.nsf_dates END,
      negative_dates = CASE WHEN ${replace} = 0 AND mca_statement_months.corrected = 1 THEN mca_statement_months.negative_dates ELSE excluded.negative_dates END,
      ending_balance = CASE WHEN ${replace} = 0 AND mca_statement_months.corrected = 1 THEN mca_statement_months.ending_balance ELSE excluded.ending_balance END,
      duplicate_of_id = excluded.duplicate_of_id, extraction_version = excluded.extraction_version,
      original_extraction = CASE WHEN ${replace} = 1 THEN excluded.original_extraction WHEN mca_statement_months.original_extraction IS NOT NULL AND mca_statement_months.original_extraction != '{}' THEN mca_statement_months.original_extraction ELSE excluded.original_extraction END,
      corrected = CASE WHEN ${replace} = 1 THEN 0 ELSE mca_statement_months.corrected END,
      correction_reason = CASE WHEN ${replace} = 1 THEN NULL ELSE mca_statement_months.correction_reason END,
      corrected_by_user_id = CASE WHEN ${replace} = 1 THEN NULL ELSE mca_statement_months.corrected_by_user_id END,
      corrected_at = CASE WHEN ${replace} = 1 THEN NULL ELSE mca_statement_months.corrected_at END,
      updated_at = excluded.updated_at`)

    for (const month of input.months) {
      await monthSql.run(
        month.id, input.workspaceId, input.dealId, month.documentId, month.accountKind, month.period, month.accountSuffix ?? null,
        JSON.stringify(month.deposits), JSON.stringify(month.depositCount), JSON.stringify(month.averageDailyBalance),
        JSON.stringify(month.nsfCount), JSON.stringify(month.negativeDays),
        JSON.stringify(month.nsfDates), JSON.stringify(month.negativeDates), JSON.stringify(month.endingBalance),
        month.duplicateOfId ?? null, month.extractionVersion, month.corrected ? 1 : 0, month.correctionReason ?? null,
        month.correctedByUserId ?? null, month.correctedAt ?? null, month.originalExtraction, month.createdAt, month.updatedAt,
      )
    }

    const duplicateSql = database.prepare("UPDATE mca_statement_months SET duplicate_of_id = ?, updated_at = ? WHERE workspace_id = ? AND id = ?")
    for (const month of input.months) {
      await duplicateSql.run(month.duplicateOfId ?? null, month.updatedAt, input.workspaceId, month.id)
    }

    const positionSql = database.prepare(`INSERT INTO mca_existing_positions
      (id, workspace_id, deal_id, document_id, label, estimated_payment, evidence, status, corrected, correction_reason, corrected_by_user_id, corrected_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        document_id = excluded.document_id,
        estimated_payment = CASE WHEN ${replace} = 0 AND mca_existing_positions.status != 'proposed' THEN mca_existing_positions.estimated_payment ELSE excluded.estimated_payment END,
        evidence = CASE WHEN ${replace} = 0 AND mca_existing_positions.status != 'proposed' THEN mca_existing_positions.evidence ELSE excluded.evidence END,
        updated_at = excluded.updated_at`)
    for (const position of input.positions) {
      await positionSql.run(
        position.id, input.workspaceId, input.dealId, position.documentId ?? null, position.label,
        position.estimatedPayment ?? null, position.evidence, position.status, position.corrected ? 1 : 0,
        position.correctionReason ?? null, position.correctedByUserId ?? null, position.correctedAt ?? null,
        position.createdAt, position.updatedAt,
      )
    }

    await database.prepare(`INSERT INTO mca_underwriting_aggregates (
      workspace_id, deal_id, version, monthly_revenue, average_daily_balance, nsf_count, negative_days,
      deposit_count, worst_month_nsf, warnings_json, position_count, stale, source_fingerprint, computed_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(workspace_id, deal_id) DO UPDATE SET
      version = excluded.version, monthly_revenue = excluded.monthly_revenue, average_daily_balance = excluded.average_daily_balance,
      nsf_count = excluded.nsf_count, negative_days = excluded.negative_days,
      deposit_count = excluded.deposit_count, worst_month_nsf = excluded.worst_month_nsf, warnings_json = excluded.warnings_json,
      position_count = excluded.position_count,
      stale = excluded.stale, source_fingerprint = excluded.source_fingerprint, computed_at = excluded.computed_at`).run(
      input.workspaceId, input.dealId, input.aggregate.version, JSON.stringify(input.aggregate.monthlyRevenue),
      JSON.stringify(input.aggregate.averageDailyBalance), JSON.stringify(input.aggregate.nsfCount), JSON.stringify(input.aggregate.negativeDays),
      JSON.stringify(input.aggregate.depositCount), JSON.stringify(input.aggregate.worstMonthNsf), JSON.stringify(input.aggregate.warnings),
      input.aggregate.positionCount, input.aggregate.stale ? 1 : 0, input.aggregate.sourceFingerprint, input.aggregate.computedAt,
    )

    const months = await listMonthRecords(input.workspaceId, input.dealId)
    const positions = await listPositionRecords(input.workspaceId, input.dealId)
    const aggregate = await getAggregateRecord(input.workspaceId, input.dealId)
    if (!aggregate) throw new Error("Underwriting aggregate not found after persistence")
    return reconcileReviewedAggregate(
      input.workspaceId,
      input.dealId,
      { months, positions, aggregate },
      Boolean(input.replaceReviewed),
    )
  })
}

const UNKNOWN_METRIC: MetricEvidence = { value: null, unknown: true, confidence: 0 }

type OriginalMetrics = {
  deposits: MetricEvidence
  depositCount: MetricEvidence
  averageDailyBalance: MetricEvidence
  nsfCount: MetricEvidence
  negativeDays: MetricEvidence
  endingBalance: MetricEvidence
}

export function originalMetricsFromExtraction(json: string): OriginalMetrics {
  const parsed = parseJson<Partial<OriginalMetrics>>(json, {})
  return {
    deposits: normalizeMetric(parsed.deposits ?? UNKNOWN_METRIC),
    depositCount: normalizeMetric(parsed.depositCount ?? UNKNOWN_METRIC),
    averageDailyBalance: normalizeMetric(parsed.averageDailyBalance ?? UNKNOWN_METRIC),
    nsfCount: normalizeMetric(parsed.nsfCount ?? UNKNOWN_METRIC),
    negativeDays: normalizeMetric(parsed.negativeDays ?? UNKNOWN_METRIC),
    endingBalance: normalizeMetric(parsed.endingBalance ?? UNKNOWN_METRIC),
  }
}

export async function getMonthRecord(workspaceId: string, monthId: string): Promise<StatementMonthRow | undefined> {
  const row = await db().prepare<MonthSqlRow>("SELECT * FROM mca_statement_months WHERE workspace_id = ? AND id = ?").get(workspaceId, monthId)
  return row ? fromMonthRow(row) : undefined
}

export async function getMonthRecordForUpdate(workspaceId: string, monthId: string): Promise<StatementMonthRow | undefined> {
  const row = await db().prepare<MonthSqlRow>("SELECT * FROM mca_statement_months WHERE workspace_id = ? AND id = ? FOR UPDATE").get(workspaceId, monthId)
  return row ? fromMonthRow(row) : undefined
}

export async function getPositionRecord(workspaceId: string, positionId: string): Promise<ExistingPositionRow | undefined> {
  const row = await db().prepare<PositionSqlRow>("SELECT * FROM mca_existing_positions WHERE workspace_id = ? AND id = ?").get(workspaceId, positionId)
  return row ? fromPositionRow(row) : undefined
}

export async function getPositionRecordForUpdate(workspaceId: string, positionId: string): Promise<ExistingPositionRow | undefined> {
  const row = await db().prepare<PositionSqlRow>("SELECT * FROM mca_existing_positions WHERE workspace_id = ? AND id = ? FOR UPDATE").get(workspaceId, positionId)
  return row ? fromPositionRow(row) : undefined
}

export async function deleteCorrectedMonthRecords(workspaceId: string, dealId: string): Promise<number> {
  return Number((await db().prepare("DELETE FROM mca_statement_months WHERE workspace_id = ? AND deal_id = ? AND corrected = 1").run(workspaceId, dealId)).changes)
}

function metricsDiffer(left: MetricEvidence, right: MetricEvidence): boolean {
  return left.unknown !== right.unknown || left.value !== right.value
}

async function writeAggregateRow(row: UnderwritingAggregateRow): Promise<void> {
  await db().prepare(`INSERT INTO mca_underwriting_aggregates (
    workspace_id, deal_id, version, monthly_revenue, average_daily_balance, nsf_count, negative_days,
    deposit_count, worst_month_nsf, warnings_json, position_count, stale, source_fingerprint, computed_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(workspace_id, deal_id) DO UPDATE SET
    version = excluded.version, monthly_revenue = excluded.monthly_revenue, average_daily_balance = excluded.average_daily_balance,
    nsf_count = excluded.nsf_count, negative_days = excluded.negative_days,
    deposit_count = excluded.deposit_count, worst_month_nsf = excluded.worst_month_nsf, warnings_json = excluded.warnings_json,
    position_count = excluded.position_count,
    stale = excluded.stale, source_fingerprint = excluded.source_fingerprint, computed_at = excluded.computed_at`).run(
    row.workspaceId, row.dealId, row.version, JSON.stringify(row.monthlyRevenue), JSON.stringify(row.averageDailyBalance),
    JSON.stringify(row.nsfCount), JSON.stringify(row.negativeDays),
    JSON.stringify(row.depositCount), JSON.stringify(row.worstMonthNsf), JSON.stringify(row.warnings),
    row.positionCount, row.stale ? 1 : 0, row.sourceFingerprint, row.computedAt,
  )
}

export async function markAnalysisSnapshotsStale(workspaceId: string, dealId: string): Promise<void> {
  const allowed = new Set(["mca_analysis_snapshots", "mca_underwriting_snapshots", "mca_score_snapshots"])
  const tables = await db().prepare<{ table_name: string }>(`SELECT DISTINCT table_name
    FROM information_schema.columns
    WHERE table_schema = current_schema() AND column_name = 'stale'
      AND table_name IN ('mca_analysis_snapshots', 'mca_underwriting_snapshots', 'mca_score_snapshots')`).all()
  for (const table of tables) {
    if (!allowed.has(table.table_name)) continue
    await db().prepare(`UPDATE ${table.table_name} SET stale = 1 WHERE workspace_id = ? AND deal_id = ?`).run(workspaceId, dealId)
  }
}

export async function saveRecomputedAggregate(workspaceId: string, dealId: string, stale: boolean, computedAt = nowIso()): Promise<UnderwritingAggregateRow> {
  const existing = await getAggregateRecord(workspaceId, dealId)
  const months = await listMonthRecords(workspaceId, dealId)
  const positions = await listPositionRecords(workspaceId, dealId)
  const computed = computeUnderwritingAggregate({
    dealId,
    months: months.map(toMonthSummary),
    positions: positions.map(toPositionSummary),
    window: await resolveUnderwritingWindow(workspaceId),
    version: existing?.version ?? 1,
    computedAt,
  })
  const row: UnderwritingAggregateRow = {
    workspaceId,
    ...computed,
    stale,
    sourceFingerprint: existing?.sourceFingerprint ?? "",
  }
  await writeAggregateRow(row)
  await markAnalysisSnapshotsStale(workspaceId, dealId)
  const saved = await getAggregateRecord(workspaceId, dealId)
  if (!saved) throw new Error("Underwriting aggregate not found after recompute")
  return saved
}

async function reconcileReviewedAggregate(
  workspaceId: string,
  dealId: string,
  persisted: { months: StatementMonthRow[]; positions: ExistingPositionRow[]; aggregate: UnderwritingAggregateRow },
  replaceReviewed: boolean,
): Promise<{ months: StatementMonthRow[]; positions: ExistingPositionRow[]; aggregate: UnderwritingAggregateRow }> {
  if (replaceReviewed || !persisted.months.some((month) => month.corrected)) return persisted
  const recomputed = computeUnderwritingAggregate({
    dealId,
    months: persisted.months.map(toMonthSummary),
    positions: persisted.positions.map(toPositionSummary),
    window: await resolveUnderwritingWindow(workspaceId),
    version: persisted.aggregate.version,
    computedAt: persisted.aggregate.computedAt,
  })
  if (
    !metricsDiffer(recomputed.monthlyRevenue, persisted.aggregate.monthlyRevenue)
    && !metricsDiffer(recomputed.averageDailyBalance, persisted.aggregate.averageDailyBalance)
    && !metricsDiffer(recomputed.nsfCount, persisted.aggregate.nsfCount)
    && !metricsDiffer(recomputed.negativeDays, persisted.aggregate.negativeDays)
    && !metricsDiffer(recomputed.depositCount, persisted.aggregate.depositCount)
    && !metricsDiffer(recomputed.worstMonthNsf, persisted.aggregate.worstMonthNsf)
    && recomputed.positionCount === persisted.aggregate.positionCount
    && JSON.stringify(recomputed.warnings) === JSON.stringify(persisted.aggregate.warnings)
  ) {
    return persisted
  }
  await writeAggregateRow({
    ...persisted.aggregate,
    monthlyRevenue: recomputed.monthlyRevenue,
    averageDailyBalance: recomputed.averageDailyBalance,
    nsfCount: recomputed.nsfCount,
    negativeDays: recomputed.negativeDays,
    depositCount: recomputed.depositCount,
    worstMonthNsf: recomputed.worstMonthNsf,
    warnings: recomputed.warnings,
    positionCount: recomputed.positionCount,
    stale: true,
    computedAt: nowIso(),
  })
  await markAnalysisSnapshotsStale(workspaceId, dealId)
  const aggregate = await getAggregateRecord(workspaceId, dealId)
  if (!aggregate) throw new Error("Underwriting aggregate not found after reconciliation")
  return {
    months: persisted.months,
    positions: persisted.positions,
    aggregate,
  }
}

export async function saveMonthCorrection(input: {
  workspaceId: string
  monthId: string
  deposits: MetricEvidence
  depositCount: MetricEvidence
  averageDailyBalance: MetricEvidence
  nsfCount: MetricEvidence
  negativeDays: MetricEvidence
  endingBalance: MetricEvidence
  reason: string
  actorUserId?: string | null
  now: string
}): Promise<StatementMonthRow> {
  await db().prepare(`UPDATE mca_statement_months SET
    deposits = ?, deposit_count = ?, average_daily_balance = ?, nsf_count = ?, negative_days = ?, ending_balance = ?,
    corrected = 1, correction_reason = ?, corrected_by_user_id = ?, corrected_at = ?, updated_at = ?
    WHERE workspace_id = ? AND id = ?`).run(
    JSON.stringify(input.deposits), JSON.stringify(input.depositCount), JSON.stringify(input.averageDailyBalance),
    JSON.stringify(input.nsfCount), JSON.stringify(input.negativeDays), JSON.stringify(input.endingBalance),
    input.reason, input.actorUserId ?? null, input.now, input.now, input.workspaceId, input.monthId,
  )
  const saved = await getMonthRecord(input.workspaceId, input.monthId)
  if (!saved) throw new Error("Statement month not found after correction")
  return saved
}

export async function savePositionCorrection(input: {
  workspaceId: string
  positionId: string
  status: ExistingPositionCandidate["status"]
  estimatedPayment?: number
  reason: string
  actorUserId?: string | null
  now: string
}): Promise<ExistingPositionRow> {
  await db().prepare(`UPDATE mca_existing_positions SET
    status = ?, estimated_payment = COALESCE(?, estimated_payment),
    corrected = 1, correction_reason = ?, corrected_by_user_id = ?, corrected_at = ?, updated_at = ?
    WHERE workspace_id = ? AND id = ?`).run(
    input.status, input.estimatedPayment ?? null, input.reason, input.actorUserId ?? null, input.now, input.now, input.workspaceId, input.positionId,
  )
  const saved = await getPositionRecord(input.workspaceId, input.positionId)
  if (!saved) throw new Error("Existing position not found after correction")
  return saved
}
