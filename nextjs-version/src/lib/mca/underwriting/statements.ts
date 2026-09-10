import "server-only"

import { assertTrustedMutation, requireWorkspaceAccess } from "../auth"
import { newId, nowIso, recordAuditEvent } from "../db"
import { actorForDeals, getDealForDocument } from "../deals/service"
import type { DealActor } from "../deals/schema"
import { listDocuments, getDocumentContent } from "../documents/service"
import { requestCorrelationId } from "../http"
import type { ExistingPositionCandidate, MetricEvidence, StatementAccountKind, StatementMonthRecord, UnderwritingAggregate } from "./contracts"
import {
  normalizeMetric,
  setStatementExtractionProviderForTests,
  statementExtractionProvider,
  type StatementExtraction,
} from "./statement-extraction"
import {
  getAggregateRecord,
  listMonthRecords,
  listPositionRecords,
  persistStatementAnalysis,
  toAggregateSummary,
  toMonthSummary,
  toPositionSummary,
  withUnderwritingDealLock,
  type ExistingPositionRow,
  type StatementMonthRow,
  type UnderwritingAggregateRow,
} from "./statement-repository"

export { setStatementExtractionProviderForTests }

const PERIOD = /^\d{4}-(0[1-9]|1[0-2])$/
const UNKNOWN_METRIC: MetricEvidence = { value: null, unknown: true, confidence: 0 }

export interface StatementUnderwritingResult {
  months: StatementMonthRecord[]
  positions: ExistingPositionCandidate[]
  aggregate: UnderwritingAggregate
}

export async function requireStatementActor(request: Request, mode: "read" | "write"): Promise<DealActor> {
  if (mode === "write") assertTrustedMutation(request)
  const auth = await requireWorkspaceAccess(request, { scopes: [mode === "read" ? "deals:read" : "deals:write"] })
  return { ...await actorForDeals(auth), correlationId: requestCorrelationId(request) }
}

export async function listStatementMonths(actor: DealActor, dealId: string): Promise<StatementMonthRecord[]> {
  await getDealForDocument(actor, dealId)
  return (await listMonthRecords(actor.workspaceId, dealId)).map(toMonthSummary)
}

export async function listExistingPositions(actor: DealActor, dealId: string): Promise<ExistingPositionCandidate[]> {
  await getDealForDocument(actor, dealId)
  return (await listPositionRecords(actor.workspaceId, dealId)).map(toPositionSummary)
}

export async function getUnderwritingAggregate(actor: DealActor, dealId: string): Promise<UnderwritingAggregate | null> {
  await getDealForDocument(actor, dealId)
  const row = await getAggregateRecord(actor.workspaceId, dealId)
  return row ? toAggregateSummary(row) : null
}

export async function getDealStatementUnderwriting(actor: DealActor, dealId: string): Promise<{ months: StatementMonthRecord[]; positions: ExistingPositionCandidate[]; aggregate: UnderwritingAggregate | null }> {
  await getDealForDocument(actor, dealId)
  const [aggregate, months, positions] = await Promise.all([
    getAggregateRecord(actor.workspaceId, dealId),
    listMonthRecords(actor.workspaceId, dealId),
    listPositionRecords(actor.workspaceId, dealId),
  ])
  return {
    months: months.map(toMonthSummary),
    positions: positions.map(toPositionSummary),
    aggregate: aggregate ? toAggregateSummary(aggregate) : null,
  }
}

function accountSuffix(value?: string): string | undefined {
  const digits = (value ?? "").replace(/\D/g, "").slice(-4)
  return digits || undefined
}

function periodValue(value?: string): string {
  return PERIOD.test(value ?? "") ? value! : "unknown"
}

function accountKind(value: string): StatementAccountKind {
  return value === "checking" ? "checking" : "unsupported"
}

function fingerprintFor(documentIds: string[]): string {
  return [...documentIds].sort().join(",")
}

function uniqueCheckingMonths(months: StatementMonthRecord[]): StatementMonthRecord[] {
  return months.filter((month) => month.accountKind === "checking" && !month.duplicateOfId)
}

function averagePeriodTotals(months: StatementMonthRecord[], pick: (month: StatementMonthRecord) => MetricEvidence, text: string): MetricEvidence {
  if (months.length === 0) return { ...UNKNOWN_METRIC, text }
  const byPeriod = new Map<string, StatementMonthRecord[]>()
  for (const month of months) {
    const group = byPeriod.get(month.period) ?? []
    group.push(month)
    byPeriod.set(month.period, group)
  }
  const totals: Array<{ value: number; confidence: number }> = []
  for (const group of byPeriod.values()) {
    let sum = 0
    let confidence = 1
    for (const month of group) {
      const metric = pick(month)
      if (metric.unknown || metric.value == null || !Number.isFinite(metric.value)) return { ...UNKNOWN_METRIC, text }
      sum += metric.value
      confidence = Math.min(confidence, metric.confidence)
    }
    totals.push({ value: sum, confidence })
  }
  return {
    value: totals.reduce((sum, item) => sum + item.value, 0) / totals.length,
    unknown: false,
    confidence: totals.reduce((sum, item) => sum + item.confidence, 0) / totals.length,
    text,
  }
}

function sumMetrics(months: StatementMonthRecord[], pick: (month: StatementMonthRecord) => MetricEvidence, text: string): MetricEvidence {
  if (months.length === 0) return { ...UNKNOWN_METRIC, text }
  let sum = 0
  let confidence = 1
  for (const month of months) {
    const metric = pick(month)
    if (metric.unknown || metric.value == null || !Number.isFinite(metric.value)) return { ...UNKNOWN_METRIC, text }
    sum += metric.value
    confidence = Math.min(confidence, metric.confidence)
  }
  return { value: sum, unknown: false, confidence, text }
}

function isDuplicateOf(canonical: StatementMonthRecord, candidate: StatementMonthRecord): boolean {
  if (canonical.period !== candidate.period) return false
  const left = accountSuffix(canonical.accountSuffix) ?? ""
  const right = accountSuffix(candidate.accountSuffix) ?? ""
  if (left && right) return left === right
  if (left !== right) return false
  const deposits = canonical.deposits
  const other = candidate.deposits
  if (deposits.unknown || other.unknown || deposits.value == null || other.value == null) return false
  return deposits.value === other.value
}

function markDuplicates(months: StatementMonthRow[], documentCreatedAt: Map<string, string>): StatementMonthRow[] {
  const ordered = [...months].sort((left, right) => {
    const byDocument = (documentCreatedAt.get(left.documentId) ?? left.createdAt).localeCompare(documentCreatedAt.get(right.documentId) ?? right.createdAt)
    return byDocument || left.id.localeCompare(right.id)
  })
  const canonicals: StatementMonthRow[] = []
  return ordered.map((month) => {
    const match = canonicals.find((canonical) => isDuplicateOf(canonical, month))
    if (match) return { ...month, duplicateOfId: match.id }
    const next = { ...month }
    delete next.duplicateOfId
    canonicals.push(next)
    return next
  })
}

function computeAggregate(dealId: string, months: StatementMonthRecord[], positions: ExistingPositionCandidate[], version: number, computedAt: string): UnderwritingAggregate {
  const unique = uniqueCheckingMonths(months)
  return {
    dealId,
    version,
    monthlyRevenue: averagePeriodTotals(unique, (month) => month.deposits, "Average of unique checking months' deposits; accounts in the same period are summed first."),
    averageDailyBalance: averagePeriodTotals(unique, (month) => month.averageDailyBalance, "Average of unique checking months' ADB; accounts in the same period are summed first."),
    nsfCount: sumMetrics(unique, (month) => month.nsfCount, "Sum of NSF counts from unique checking statements."),
    negativeDays: sumMetrics(unique, (month) => month.negativeDays, "Sum of negative days from unique checking statements."),
    positionCount: positions.length,
    stale: false,
    computedAt,
  }
}

function monthFromExtraction(input: {
  id: string
  dealId: string
  documentId: string
  extraction: StatementExtraction
  extractionVersion: number
  createdAt: string
  updatedAt: string
}): Omit<StatementMonthRow, "workspaceId" | "dealId"> {
  return {
    id: input.id,
    documentId: input.documentId,
    accountKind: accountKind(input.extraction.accountKind),
    period: periodValue(input.extraction.period),
    ...(accountSuffix(input.extraction.accountSuffix) ? { accountSuffix: accountSuffix(input.extraction.accountSuffix) } : {}),
    deposits: normalizeMetric(input.extraction.deposits),
    depositCount: normalizeMetric(input.extraction.depositCount),
    averageDailyBalance: normalizeMetric(input.extraction.averageDailyBalance),
    nsfCount: normalizeMetric(input.extraction.nsfCount),
    negativeDays: normalizeMetric(input.extraction.negativeDays),
    endingBalance: normalizeMetric(input.extraction.endingBalance),
    extractionVersion: input.extractionVersion,
    corrected: false,
    originalExtraction: JSON.stringify(input.extraction),
    createdAt: input.createdAt,
    updatedAt: input.updatedAt,
  }
}

function mergePositions(existing: ExistingPositionRow[], incoming: Array<{ documentId: string; label: string; estimatedPayment?: number; evidence: string }>, now: string): Array<Omit<ExistingPositionRow, "workspaceId" | "dealId">> {
  const byLabel = new Map<string, ExistingPositionRow>()
  for (const position of existing) byLabel.set(position.label.trim().toLowerCase(), position)
  const merged = new Map<string, Omit<ExistingPositionRow, "workspaceId" | "dealId">>()
  for (const position of existing) {
    merged.set(position.id, {
      id: position.id, documentId: position.documentId, label: position.label, estimatedPayment: position.estimatedPayment,
      evidence: position.evidence, status: position.status, createdAt: position.createdAt, updatedAt: position.updatedAt,
    })
  }
  for (const candidate of incoming) {
    const key = candidate.label.trim().toLowerCase()
    if (!key) continue
    const prior = byLabel.get(key)
    if (prior) {
      merged.set(prior.id, {
        id: prior.id, documentId: prior.documentId ?? candidate.documentId, label: prior.label,
        estimatedPayment: prior.status === "proposed" ? candidate.estimatedPayment : prior.estimatedPayment,
        evidence: prior.status === "proposed" ? candidate.evidence : prior.evidence,
        status: prior.status, createdAt: prior.createdAt, updatedAt: now,
      })
      continue
    }
    const id = newId()
    const created: Omit<ExistingPositionRow, "workspaceId" | "dealId"> = {
      id, documentId: candidate.documentId, label: candidate.label.trim(), estimatedPayment: candidate.estimatedPayment,
      evidence: candidate.evidence, status: "proposed", createdAt: now, updatedAt: now,
    }
    byLabel.set(key, { ...created, workspaceId: "", dealId: "" })
    merged.set(id, created)
  }
  return [...merged.values()]
}

export async function analyzeDealStatements(
  actor: DealActor,
  dealId: string,
  options?: { replaceReviewed?: boolean },
): Promise<StatementUnderwritingResult> {
  await getDealForDocument(actor, dealId)
  const documents = (await listDocuments(actor, dealId))
    .filter((document) => document.category === "statement" && document.processingState === "clean")
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id))
  const fingerprint = fingerprintFor(documents.map((document) => document.id))
  const replaceReviewed = Boolean(options?.replaceReviewed)
  const existingMonths = await listMonthRecords(actor.workspaceId, dealId)
  const monthByDocument = new Map(existingMonths.map((month) => [month.documentId, month]))
  const missing = documents.filter((document) => replaceReviewed || !monthByDocument.has(document.id))

  const extracted: Array<{ documentId: string; createdAt: string; extraction: StatementExtraction }> = []
  if (missing.length > 0) {
    const provider = statementExtractionProvider()
    for (const document of missing) {
      const content = await getDocumentContent(actor, document.id)
      extracted.push({
        documentId: document.id,
        createdAt: document.createdAt,
        extraction: await provider.extractStatement(actor, {
          filename: document.originalFilename, mimeType: document.mimeType, bytes: content.bytes, sourceReference: `${document.id}:v${document.version}`,
        }),
      })
    }
  }
  const extractedByDocument = new Map(extracted.map((item) => [item.documentId, item]))

  return withUnderwritingDealLock(actor.workspaceId, dealId, async () => {
    const lockedMonths = await listMonthRecords(actor.workspaceId, dealId)
    const lockedPositions = await listPositionRecords(actor.workspaceId, dealId)
    const lockedAggregate = await getAggregateRecord(actor.workspaceId, dealId)
    const keepIds = new Set(documents.map((document) => document.id))
    const reextractIds = new Set(documents.filter((document) => {
      const month = lockedMonths.find((candidate) => candidate.documentId === document.id)
      return !month || (replaceReviewed && month.corrected)
    }).map((document) => document.id))
    const unchanged = reextractIds.size === 0
      && lockedMonths.every((month) => keepIds.has(month.documentId))
      && lockedAggregate?.sourceFingerprint === fingerprint

    if (unchanged && lockedAggregate) {
      return {
        months: lockedMonths.map(toMonthSummary),
        positions: lockedPositions.map(toPositionSummary),
        aggregate: toAggregateSummary(lockedAggregate),
      }
    }

    for (const documentId of reextractIds) {
      if (!extractedByDocument.has(documentId)) {
        throw new Error("Statement extraction changed while waiting for the underwriting lock")
      }
    }

    const now = nowIso()
    const retained = lockedMonths
      .filter((month) => keepIds.has(month.documentId) && !reextractIds.has(month.documentId))
      .map((month) => {
        const { workspaceId: _workspaceId, dealId: _dealId, ...rest } = month
        void _workspaceId; void _dealId
        return rest
      })
    const created = [...reextractIds].map((documentId) => {
      const item = extractedByDocument.get(documentId)!
      const prior = lockedMonths.find((month) => month.documentId === documentId)
      return monthFromExtraction({
        id: prior?.id ?? newId(),
        dealId,
        documentId,
        extraction: item.extraction,
        extractionVersion: (prior?.extractionVersion ?? 0) + 1,
        createdAt: prior?.createdAt ?? now,
        updatedAt: now,
      })
    })
    const documentCreatedAt = new Map(documents.map((document) => [document.id, document.createdAt]))
    const months = markDuplicates([...retained, ...created].map((month) => ({ ...month, workspaceId: actor.workspaceId, dealId })), documentCreatedAt)
      .map((month) => {
        const { workspaceId: _workspaceId, dealId: _dealId, ...rest } = month
        void _workspaceId; void _dealId
        return { ...rest, updatedAt: now }
      })
    const incomingPositions = months.flatMap((month) => {
      const original = JSON.parse(month.originalExtraction || "{}") as Partial<StatementExtraction>
      return (original.positions ?? []).map((position) => ({ documentId: month.documentId, ...position }))
    })
    const positions = mergePositions(
      lockedPositions.filter((position) => !position.documentId || keepIds.has(position.documentId) || position.status !== "proposed"),
      incomingPositions,
      now,
    )
    const summaries = months.map((month) => toMonthSummary({ ...month, workspaceId: actor.workspaceId, dealId }))
    const positionSummaries = positions.map((position) => toPositionSummary({ ...position, workspaceId: actor.workspaceId, dealId }))
    const aggregate: UnderwritingAggregateRow = {
      workspaceId: actor.workspaceId,
      ...computeAggregate(dealId, summaries, positionSummaries, (lockedAggregate?.version ?? 0) + 1, now),
      sourceFingerprint: fingerprint,
    }
    const persisted = await persistStatementAnalysis({
      workspaceId: actor.workspaceId,
      dealId,
      keepDocumentIds: documents.map((document) => document.id),
      months,
      positions,
      aggregate,
      replaceReviewed,
    })
    await recordAuditEvent({
      context: actor,
      action: "underwriting.statements_analyzed",
      resourceType: "deal",
      resourceId: dealId,
      metadata: {
        version: persisted.aggregate.version,
        documentCount: documents.length,
        monthCount: persisted.months.length,
        duplicateCount: persisted.months.filter((month) => month.duplicateOfId).length,
        positionCount: persisted.positions.length,
        extractedCount: extracted.length,
      },
      correlationId: actor.correlationId,
    })
    return {
      months: persisted.months.map(toMonthSummary),
      positions: persisted.positions.map(toPositionSummary),
      aggregate: toAggregateSummary(persisted.aggregate),
    }
  })
}
