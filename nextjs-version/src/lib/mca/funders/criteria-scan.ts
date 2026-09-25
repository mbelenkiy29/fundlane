import "server-only"

import { createHash } from "node:crypto"
import { isDocumentReady } from "../documents/contracts"

import { z } from "zod"
import { assertTrustedMutation, requireWorkspaceAccess } from "../auth"
import { getDatabase, newId, nowIso, recordAuditEvent, withImmediateTransaction } from "../db"
import { actorForDeals } from "../deals/service"
import type { DealActor } from "../deals/schema"
import type { DocumentSummary, ExtractionFileInput } from "../documents/contracts"
import { getDocumentContent, listDocuments, MAX_DOCUMENT_BYTES, storeDocument } from "../documents/service"
import { documentScanner } from "../documents/scanner"
import { AppError } from "../errors"
import { requestCorrelationId } from "../http"
import { canManageWorkspace } from "../policy"
import {
  CRITERIA_FIELDS,
  convertRevenueThreshold,
  listFunderCriteria,
  publishFunderCriteria,
  resolveIndustry,
  type EligibilityRuleInput,
  type FunderCriteria,
} from "./criteria"
import {
  CRITERIA_OPERATORS,
  CRITERIA_UNITS,
  type CriteriaOperator,
  type CriteriaScanProposal,
  type CriteriaUnit,
  type EligibilityRule,
  type FunderContact,
} from "./contracts"
import { getFunder } from "./directory"
import { findFunderByIdForUpdate, toFunderRecord } from "./directory-repository"
import {
  findLaterActiveAcceptedScan,
  findProposedScanForDocument,
  findScanById,
  findScanByIdForUpdate,
  insertScanRecord,
  listScanRecords,
  nextScanVersion,
  updateScanDecision,
  type AmbiguousRange,
  type StoredCriteriaScan,
} from "./scan-repository"

const ALLOWED_MIME_TYPES = new Set(["application/pdf", "image/png", "image/jpeg"])
const SENTINEL_ABS = 999_999

export interface CriteriaExtractedRule {
  field: string
  operator: CriteriaOperator
  unit: CriteriaUnit
  value: EligibilityRule["value"]
  sourceText?: string
  unspecified: boolean
  ambiguous?: boolean
  rangeText?: string
  confidence: number
  page?: number
  text?: string
  unknown?: boolean
}

export interface CriteriaExtraction {
  rules: CriteriaExtractedRule[]
  contacts?: Array<{ name?: string; email?: string; phone?: string; role?: string }>
  warnings: string[]
  provider: string
  requestId?: string
}

export interface CriteriaScanProvider {
  readonly name: string
  extractCriteria(actor: DealActor, input: ExtractionFileInput): Promise<CriteriaExtraction>
}

export interface CriteriaScanReview extends CriteriaScanProposal {
  previousRules: EligibilityRule[]
  currentRules: EligibilityRule[]
  contacts: FunderContact[]
  contactsPreserved: true
  ambiguousRanges: AmbiguousRange[]
  rolledBackAt?: string
  acceptedAt?: string
  rejectedAt?: string
  criteriaVersion: number
}

export interface CriteriaScanAcceptResult {
  proposal: CriteriaScanReview
  criteria: FunderCriteria
  contacts: FunderContact[]
}

function assertManage(actor: DealActor): void {
  if (!actor.role || !canManageWorkspace(actor.role)) {
    throw new AppError(403, "permission_denied", "You do not have permission to perform this action.")
  }
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : ""
}

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Error && /UNIQUE constraint failed|duplicate key value/i.test(error.message)
}

async function loadFunder(actor: DealActor, id: string) {
  return await getFunder(actor, id)
}

async function loadCriteria(actor: DealActor, funderId: string) {
  return await listFunderCriteria(actor, funderId)
}

async function publishCriteria(actor: DealActor, funderId: string, rules: EligibilityRuleInput[]) {
  return await publishFunderCriteria(actor, funderId, rules)
}

function isSentinel(value: unknown): boolean {
  return typeof value === "number" && Number.isFinite(value) && Math.abs(value) >= SENTINEL_ABS
}

function asNumber(value: EligibilityRule["value"]): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function asList(value: EligibilityRule["value"]): string[] {
  return Array.isArray(value) ? value.map((item) => String(item)) : typeof value === "string" && value ? [value] : []
}

function sameItems(left: string[], right: string[]): boolean {
  if (left.length !== right.length) return false
  const rightSet = new Set(right.map((item) => item.toLowerCase()))
  return left.every((item) => rightSet.has(item.toLowerCase()))
}

function monthlyAmount(rule: { field: string; unit: string; value: EligibilityRule["value"]; unspecified: boolean }): number | undefined {
  const amount = asNumber(rule.value)
  if (rule.unspecified || amount === undefined || rule.field !== "revenue") return amount
  const unit = rule.unit === "usd_annual" || rule.unit === "usd_monthly" ? rule.unit : undefined
  if (!unit) return amount
  return convertRevenueThreshold({ value: amount, from: unit, to: "usd_monthly" })
}

function extractedBroader(current: EligibilityRule, extracted: EligibilityRule): boolean {
  if (current.unspecified || extracted.unspecified) return false
  if (current.operator === "min") {
    const currentValue = current.field === "revenue" ? monthlyAmount(current) : asNumber(current.value)
    const extractedValue = extracted.field === "revenue" ? monthlyAmount(extracted) : asNumber(extracted.value)
    return currentValue !== undefined && extractedValue !== undefined && extractedValue < currentValue
  }
  if (current.operator === "max") {
    const currentValue = current.field === "revenue" ? monthlyAmount(current) : asNumber(current.value)
    const extractedValue = extracted.field === "revenue" ? monthlyAmount(extracted) : asNumber(extracted.value)
    return currentValue !== undefined && extractedValue !== undefined && extractedValue > currentValue
  }
  if (current.operator === "in") {
    const currentItems = asList(current.value)
    return asList(extracted.value).some((item) => !currentItems.some((entry) => entry.toLowerCase() === item.toLowerCase()))
  }
  if (current.operator === "not_in") {
    const extractedItems = asList(extracted.value)
    return asList(current.value).some((item) => !extractedItems.some((entry) => entry.toLowerCase() === item.toLowerCase()))
  }
  return JSON.stringify(current.value) !== JSON.stringify(extracted.value)
}

function stricterOrEqual(current: EligibilityRule, extracted: EligibilityRule): EligibilityRule {
  if (current.operator === "in") {
    const currentItems = asList(current.value)
    const intersection = asList(extracted.value).filter((item) => currentItems.some((entry) => entry.toLowerCase() === item.toLowerCase()))
    return { ...extracted, id: current.id, value: intersection.length ? [...new Set(intersection)] : current.value }
  }
  if (current.operator === "not_in") {
    const merged = [...asList(current.value)]
    for (const item of asList(extracted.value)) {
      if (!merged.some((entry) => entry.toLowerCase() === item.toLowerCase())) merged.push(item)
    }
    return { ...extracted, id: current.id, value: merged, unspecified: false }
  }
  return { ...extracted, id: current.id }
}

function evidenceKey(field: string, operator: string): string {
  return `${field}:${operator}`
}

async function normalizeExtracted(actor: DealActor, extracted: CriteriaExtractedRule, funderId: string): Promise<{ rule: EligibilityRule; warning?: string; ambiguous?: AmbiguousRange; evidence: CriteriaScanProposal["evidence"][string] }> {
  const field = text(extracted.field)
  const operator = text(extracted.operator) as CriteriaOperator
  const unit = text(extracted.unit) as CriteriaUnit
  const sourceText = text(extracted.sourceText) || undefined
  const rangeText = text(extracted.rangeText) || sourceText
  const ambiguous = extracted.ambiguous === true || Boolean(text(extracted.rangeText))
  const sentinel = isSentinel(extracted.value)
  const unspecified = extracted.unspecified === true || extracted.unknown === true || extracted.value == null || sentinel || ambiguous || !CRITERIA_FIELDS.includes(field as typeof CRITERIA_FIELDS[number])
  let value: EligibilityRule["value"] = unspecified ? null : extracted.value
  let nextUnit: CriteriaUnit = CRITERIA_UNITS.includes(unit) ? unit : "unspecified"
  if (!unspecified && field === "revenue" && nextUnit === "usd_annual" && typeof value === "number") {
    value = convertRevenueThreshold({ value, from: "usd_annual", to: "usd_monthly" })
    nextUnit = "usd_monthly"
  }
  if (!unspecified && (operator === "in" || operator === "not_in")) {
    const items = asList(value)
    value = field === "industry"
      ? [...new Set(await Promise.all(items.map(async (item) => (await resolveIndustry(actor, item)).normalizedIndustry || item)))]
      : [...new Set(items)]
  }
  const rule: EligibilityRule = {
    id: newId(),
    funderId,
    field: CRITERIA_FIELDS.includes(field as typeof CRITERIA_FIELDS[number]) ? field : "revenue",
    operator: CRITERIA_OPERATORS.includes(operator) ? operator : "min",
    unit: unspecified ? (CRITERIA_UNITS.includes(nextUnit) ? nextUnit : "unspecified") : nextUnit,
    value: unspecified ? null : value,
    sourceText,
    unspecified,
  }
  return {
    rule,
    warning: ambiguous ? `Ambiguous range for ${field}: ${rangeText || "review the source wording before publishing."}` : undefined,
    ambiguous: ambiguous ? { field: rule.field, rangeText: rangeText || sourceText || "ambiguous range" } : undefined,
    evidence: {
      confidence: extracted.confidence,
      ...(extracted.page ? { page: extracted.page } : {}),
      ...(extracted.text || sourceText ? { text: extracted.text || sourceText } : {}),
      ...(extracted.unknown || unspecified ? { unknown: true } : {}),
    },
  }
}

function mergeRules(current: EligibilityRule[], extracted: EligibilityRule[], warnings: string[]): EligibilityRule[] {
  const proposed = current.map((rule) => ({ ...rule }))
  const index = new Map(proposed.map((rule, offset) => [`${rule.field}::${rule.operator}`, offset]))
  for (const rule of extracted) {
    const key = `${rule.field}::${rule.operator}`
    const offset = index.get(key)
    if (offset === undefined) {
      proposed.push(rule)
      index.set(key, proposed.length - 1)
      continue
    }
    const existing = proposed[offset]
    if (rule.unspecified) continue
    if (existing.unspecified) {
      proposed[offset] = { ...rule, id: existing.id }
      continue
    }
    if (extractedBroader(existing, rule)) {
      warnings.push(`Extracted ${rule.field} ${rule.operator} ${String(rule.value)} would broaden the current ${existing.operator} ${String(existing.value)}. The current limit was kept.`)
      continue
    }
    if (existing.operator === "in" && !sameItems(asList(existing.value), asList(rule.value))) {
      proposed[offset] = stricterOrEqual(existing, rule)
      continue
    }
    if (existing.operator === "not_in" && !sameItems(asList(existing.value), asList(rule.value))) {
      proposed[offset] = stricterOrEqual(existing, rule)
      continue
    }
    proposed[offset] = { ...rule, id: existing.id }
  }
  return proposed
}

function toReview(record: StoredCriteriaScan, current: FunderCriteria, contacts: FunderContact[]): CriteriaScanReview {
  return {
    id: record.id,
    funderId: record.funderId,
    documentId: record.documentId,
    version: record.version,
    rules: record.rules,
    warnings: record.warnings,
    evidence: record.evidence,
    provider: record.provider,
    requestId: record.requestId,
    status: record.status,
    previousRules: record.previousRules,
    currentRules: current.rules,
    contacts,
    contactsPreserved: true,
    ambiguousRanges: record.ambiguousRanges,
    rolledBackAt: record.rolledBackAt,
    acceptedAt: record.acceptedAt,
    rejectedAt: record.rejectedAt,
    criteriaVersion: current.criteriaVersion,
  }
}

function unchangedContacts(before: FunderContact[], after: FunderContact[]): void {
  if (JSON.stringify(before) !== JSON.stringify(after)) {
    throw new AppError(409, "contacts_mutated", "A criteria scan cannot change funder contacts.")
  }
}

async function withLockedScan<T>(
  actor: DealActor,
  id: string,
  callback: (record: StoredCriteriaScan, funder: Awaited<ReturnType<typeof loadFunder>>) => Promise<T>,
): Promise<T> {
  const candidate = await findScanById(actor.workspaceId, id)
  if (!candidate) throw new AppError(404, "scan_not_found", "The requested criteria scan was not found.")
  return withImmediateTransaction(async (database) => {
    const storedFunder = await findFunderByIdForUpdate(database, actor.workspaceId, candidate.funderId)
    if (!storedFunder) throw new AppError(404, "funder_not_found", "The requested funder was not found.")
    const record = await findScanByIdForUpdate(database, actor.workspaceId, id)
    if (!record || record.funderId !== storedFunder.id) {
      throw new AppError(409, "scan_decision_conflict", "The criteria scan changed before the decision was saved.")
    }
    return callback(record, toFunderRecord(storedFunder))
  })
}

async function updateDecision(input: Parameters<typeof updateScanDecision>[0]): Promise<StoredCriteriaScan> {
  try {
    return await updateScanDecision(input)
  } catch (error) {
    if (error instanceof Error && error.message === "scan_decision_conflict") {
      throw new AppError(409, "scan_decision_conflict", "The criteria scan changed before the decision was saved.")
    }
    throw error
  }
}

export async function requireCriteriaScanActor(request: Request, mode: "read" | "write"): Promise<DealActor> {
  if (mode === "write") assertTrustedMutation(request)
  const auth = await requireWorkspaceAccess(request, mode === "write"
    ? { sessionOnly: true, roles: ["admin", "super_admin"] }
    : { scopes: ["deals:read"] })
  return { ...await actorForDeals(auth), correlationId: requestCorrelationId(request) }
}

export async function listCriteriaScanDocuments(actor: DealActor, dealId: string): Promise<DocumentSummary[]> {
  const documents = await listDocuments(actor, dealId)
  return documents.filter((document) => isDocumentReady(document.processingState) && ALLOWED_MIME_TYPES.has(document.mimeType))
}

export async function listCriteriaScans(actor: DealActor, funderId: string): Promise<CriteriaScanReview[]> {
  const funder = await loadFunder(actor, funderId)
  const current = await loadCriteria(actor, funder.id)
  return (await listScanRecords(actor.workspaceId, funder.id)).map((record) => toReview(record, current, funder.contacts))
}

export async function getCriteriaScan(actor: DealActor, id: string): Promise<CriteriaScanReview> {
  const record = await findScanById(actor.workspaceId, id)
  if (!record) throw new AppError(404, "scan_not_found", "The requested criteria scan was not found.")
  const funder = await loadFunder(actor, record.funderId)
  return toReview(record, await loadCriteria(actor, funder.id), funder.contacts)
}

async function proposeFromExtraction(
  actor: DealActor,
  funder: Awaited<ReturnType<typeof loadFunder>>,
  documentId: string,
  extraction: CriteriaExtraction,
): Promise<CriteriaScanReview> {
  const contacts = funder.contacts
  const existing = await findProposedScanForDocument(actor.workspaceId, funder.id, documentId)
  if (existing) return toReview(existing, await loadCriteria(actor, funder.id), contacts)
  const current = await loadCriteria(actor, funder.id)
  const warnings = [...extraction.warnings]
  const evidence: CriteriaScanProposal["evidence"] = {}
  const ambiguousRanges: AmbiguousRange[] = []
  const extractedRules: EligibilityRule[] = []
  for (const item of extraction.rules) {
    const normalized = await normalizeExtracted(actor, item, funder.id)
    extractedRules.push(normalized.rule)
    evidence[evidenceKey(normalized.rule.field, normalized.rule.operator)] = normalized.evidence
    if (normalized.warning) warnings.push(normalized.warning)
    if (normalized.ambiguous) ambiguousRanges.push(normalized.ambiguous)
  }
  const rules = mergeRules(current.rules, extractedRules, warnings)
  const now = nowIso()
  let record
  try {
    record = await insertScanRecord({
      id: newId(),
      workspaceId: actor.workspaceId,
      funderId: funder.id,
      documentId,
      version: await nextScanVersion(actor.workspaceId, funder.id),
      status: "proposed",
      rules,
      previousRules: current.rules,
      warnings: [...new Set(warnings)],
      evidence,
      ambiguousRanges,
      provider: extraction.provider,
      requestId: extraction.requestId,
      createdBy: actor.userId,
      createdAt: now,
      updatedAt: now,
    })
  } catch (error) {
    const replay = isUniqueViolation(error) ? await findProposedScanForDocument(actor.workspaceId, funder.id, documentId) : undefined
    if (!replay) throw error
    return toReview(replay, current, contacts)
  }
  unchangedContacts(contacts, (await loadFunder(actor, funder.id)).contacts)
  await recordAuditEvent({
    context: actor,
    action: "funder.criteria_scan_proposed",
    resourceType: "funder",
    resourceId: funder.id,
    metadata: { scanId: record.id, documentId, version: record.version, warningCount: record.warnings.length, ruleCount: record.rules.length, provider: record.provider, requestId: record.requestId ?? null },
    correlationId: actor.correlationId,
  })
  return toReview(record, current, contacts)
}

function mimeFromUpload(filename: string, mimeType: string): string {
  const provided = mimeType.trim().toLowerCase()
  if (ALLOWED_MIME_TYPES.has(provided)) return provided
  const extension = filename.toLowerCase().split(".").pop()
  if (extension === "pdf") return "application/pdf"
  if (extension === "png") return "image/png"
  if (extension === "jpg" || extension === "jpeg") return "image/jpeg"
  return provided
}

function matchesDeclaredType(mimeType: string, bytes: Uint8Array): boolean {
  if (mimeType === "application/pdf") return bytes.length >= 5 && Buffer.from(bytes.subarray(0, 5)).toString("ascii") === "%PDF-"
  if (mimeType === "image/png") return bytes.length >= 8 && Buffer.from(bytes.subarray(0, 8)).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  if (mimeType === "image/jpeg") return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
  return false
}

async function assertCleanCriteriaUpload(filename: string, mimeType: string, bytes: Uint8Array): Promise<void> {
  if (!bytes.byteLength || bytes.byteLength > MAX_DOCUMENT_BYTES) {
    throw new AppError(413, "document_size_invalid", `Documents must be between 1 byte and ${MAX_DOCUMENT_BYTES} bytes.`)
  }
  if (!matchesDeclaredType(mimeType, bytes)) {
    throw new AppError(422, "document_content_mismatch", "The file contents do not match the declared PDF or image type.")
  }
  const scan = await documentScanner().scan(bytes, filename)
  if (scan.status === "infected") throw new AppError(422, "file_quarantined", "Security scanning rejected this file.")
  if (scan.status !== "clean") throw new AppError(503, "scanner_unavailable", "Security scanning must succeed before this file can be processed.")
}

function inlineDocumentId(workspaceId: string, funderId: string, bytes: Uint8Array): string {
  return `inline:${createHash("sha256").update(workspaceId).update(funderId).update(bytes).digest("hex")}`
}

export async function scanFunderCriteria(actor: DealActor, input: { funderId: string; documentId: string }): Promise<CriteriaScanReview> {
  assertManage(actor)
  const funder = await loadFunder(actor, input.funderId)
  const existing = await findProposedScanForDocument(actor.workspaceId, funder.id, input.documentId)
  if (existing) return toReview(existing, await loadCriteria(actor, funder.id), funder.contacts)
  const { document, bytes } = await getDocumentContent(actor, input.documentId)
  if (!ALLOWED_MIME_TYPES.has(document.mimeType)) {
    throw new AppError(415, "unsupported_document_type", "Scan a clean PDF, PNG, or JPEG criteria sheet.")
  }
  await (await import("../company-access")).assertCompanyOperational(actor.workspaceId)
  const extraction = await criteriaScanProvider().extractCriteria(actor, {
    filename: document.originalFilename,
    mimeType: document.mimeType,
    bytes,
    sourceReference: `${document.id}:v${document.version}`,
  })
  return proposeFromExtraction(actor, funder, document.id, extraction)
}

export async function uploadAndScanFunderCriteria(actor: DealActor, input: {
  funderId: string
  dealId?: string
  idempotencyKey: string
  filename: string
  mimeType: string
  bytes: Uint8Array
}): Promise<CriteriaScanReview> {
  assertManage(actor)
  const funder = await loadFunder(actor, input.funderId)
  const mimeType = mimeFromUpload(input.filename, input.mimeType)
  if (!ALLOWED_MIME_TYPES.has(mimeType)) {
    throw new AppError(415, "unsupported_document_type", "Scan a clean PDF, PNG, or JPEG criteria sheet.")
  }
  if (!text(input.dealId)) await assertCleanCriteriaUpload(input.filename, mimeType, input.bytes)
  if (text(input.dealId)) {
    const document = await storeDocument(actor, {
      dealId: text(input.dealId),
      idempotencyKey: input.idempotencyKey,
      filename: input.filename,
      mimeType,
      bytes: input.bytes,
      category: "other_stip",
      source: "funder_criteria_scan",
    })
    return scanFunderCriteria(actor, { funderId: funder.id, documentId: document.id })
  }
  const documentId = inlineDocumentId(actor.workspaceId, funder.id, input.bytes)
  const existing = await findProposedScanForDocument(actor.workspaceId, funder.id, documentId)
  if (existing) return toReview(existing, await loadCriteria(actor, funder.id), funder.contacts)
  await (await import("../company-access")).assertCompanyOperational(actor.workspaceId)
  const extraction = await criteriaScanProvider().extractCriteria(actor, {
    filename: input.filename,
    mimeType,
    bytes: input.bytes,
    sourceReference: documentId,
  })
  return proposeFromExtraction(actor, funder, documentId, extraction)
}

export async function acceptCriteriaScan(actor: DealActor, id: string, rulesInput?: EligibilityRuleInput[]): Promise<CriteriaScanAcceptResult> {
  assertManage(actor)
  return withLockedScan(actor, id, async (record, funder) => {
    const contacts = funder.contacts
    if (record.status === "rejected") throw new AppError(409, "scan_rejected", "A rejected scan cannot be accepted.")
    if (record.status === "accepted") {
      const current = await loadCriteria(actor, funder.id)
      return { proposal: toReview(record, current, contacts), criteria: current, contacts }
    }
    const current = await loadCriteria(actor, funder.id)
    const published = await publishCriteria(actor, funder.id, rulesInput ?? record.rules)
    const now = nowIso()
    const updated = await updateDecision({
      workspaceId: actor.workspaceId,
      id: record.id,
      status: "accepted",
      rules: published.rules,
      previousRules: current.rules,
      acceptedAt: now,
      expectedStatus: "proposed",
      updatedAt: now,
    })
    const after = await loadFunder(actor, funder.id)
    unchangedContacts(contacts, after.contacts)
    await recordAuditEvent({
      context: actor,
      action: "funder.criteria_scan_accepted",
      resourceType: "funder",
      resourceId: funder.id,
      metadata: { scanId: record.id, documentId: record.documentId, version: record.version, criteriaVersion: published.criteriaVersion },
      correlationId: actor.correlationId,
    })
    return { proposal: toReview(updated, published, after.contacts), criteria: published, contacts: after.contacts }
  })
}

export async function rejectCriteriaScan(actor: DealActor, id: string): Promise<CriteriaScanReview> {
  assertManage(actor)
  return withLockedScan(actor, id, async (record, funder) => {
    if (record.status === "accepted") throw new AppError(409, "scan_accepted", "An accepted scan cannot be rejected. Roll it back instead.")
    if (record.status === "rejected") return toReview(record, await loadCriteria(actor, funder.id), funder.contacts)
    const now = nowIso()
    const updated = await updateDecision({
      workspaceId: actor.workspaceId,
      id: record.id,
      status: "rejected",
      rejectedAt: now,
      expectedStatus: "proposed",
      updatedAt: now,
    })
    unchangedContacts(funder.contacts, (await loadFunder(actor, funder.id)).contacts)
    await recordAuditEvent({
      context: actor,
      action: "funder.criteria_scan_rejected",
      resourceType: "funder",
      resourceId: funder.id,
      metadata: { scanId: record.id, documentId: record.documentId, version: record.version },
      correlationId: actor.correlationId,
    })
    return toReview(updated, await loadCriteria(actor, funder.id), funder.contacts)
  })
}

export async function rollbackCriteriaScan(actor: DealActor, id: string): Promise<CriteriaScanAcceptResult> {
  assertManage(actor)
  return withLockedScan(actor, id, async (record, funder) => {
    const contacts = funder.contacts
    if (record.status !== "accepted") throw new AppError(409, "scan_not_accepted", "Only an accepted scan can be rolled back.")
    if (record.rolledBackAt) {
      const current = await loadCriteria(actor, funder.id)
      return { proposal: toReview(record, current, contacts), criteria: current, contacts }
    }
    const newer = await findLaterActiveAcceptedScan(getDatabase(), actor.workspaceId, funder.id, record.version)
    if (newer) throw new AppError(409, "scan_superseded", "A newer accepted criteria scan must be rolled back first.")
    const published = await publishCriteria(actor, funder.id, record.previousRules)
    const now = nowIso()
    const updated = await updateDecision({
      workspaceId: actor.workspaceId,
      id: record.id,
      status: "accepted",
      rolledBackAt: now,
      expectedStatus: "accepted",
      expectedRolledBackAt: null,
      updatedAt: now,
    })
    const after = await loadFunder(actor, funder.id)
    unchangedContacts(contacts, after.contacts)
    await recordAuditEvent({
      context: actor,
      action: "funder.criteria_scan_rolled_back",
      resourceType: "funder",
      resourceId: funder.id,
      metadata: { scanId: record.id, documentId: record.documentId, version: record.version, criteriaVersion: published.criteriaVersion },
      correlationId: actor.correlationId,
    })
    return { proposal: toReview(updated, published, after.contacts), criteria: published, contacts: after.contacts }
  })
}

const extractedRuleSchema = z.object({
  field: z.enum(CRITERIA_FIELDS),
  operator: z.enum(CRITERIA_OPERATORS),
  unit: z.enum(CRITERIA_UNITS),
  valueNumber: z.number().nullable(),
  valueText: z.string().nullable(),
  valueBoolean: z.boolean().nullable(),
  valueList: z.array(z.string()),
  sourceText: z.string().nullable(),
  unspecified: z.boolean(),
  ambiguous: z.boolean(),
  rangeText: z.string().nullable(),
  confidence: z.number().min(0).max(1),
  page: z.number().int().positive().nullable(),
  text: z.string().nullable(),
  unknown: z.boolean(),
}).strict()

const extractionSchema = z.object({
  rules: z.array(extractedRuleSchema),
  contacts: z.array(z.object({
    name: z.string().nullable(),
    email: z.string().nullable(),
    phone: z.string().nullable(),
    role: z.string().nullable(),
  }).strict()),
  warnings: z.array(z.string()),
}).strict()

const stringOrNull = { type: ["string", "null"] }
const numberOrNull = { type: ["number", "null"] }
const criteriaJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["rules", "contacts", "warnings"],
  properties: {
    rules: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["field", "operator", "unit", "valueNumber", "valueText", "valueBoolean", "valueList", "sourceText", "unspecified", "ambiguous", "rangeText", "confidence", "page", "text", "unknown"],
        properties: {
          field: { type: "string", enum: [...CRITERIA_FIELDS] },
          operator: { type: "string", enum: [...CRITERIA_OPERATORS] },
          unit: { type: "string", enum: [...CRITERIA_UNITS] },
          valueNumber: numberOrNull,
          valueText: stringOrNull,
          valueBoolean: { type: ["boolean", "null"] },
          valueList: { type: "array", items: { type: "string" } },
          sourceText: stringOrNull,
          unspecified: { type: "boolean" },
          ambiguous: { type: "boolean" },
          rangeText: stringOrNull,
          confidence: { type: "number", minimum: 0, maximum: 1 },
          page: { type: ["integer", "null"] },
          text: stringOrNull,
          unknown: { type: "boolean" },
        },
      },
    },
    contacts: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["name", "email", "phone", "role"],
        properties: { name: stringOrNull, email: stringOrNull, phone: stringOrNull, role: stringOrNull },
      },
    },
    warnings: { type: "array", items: { type: "string" } },
  },
} as const

function fileData(input: ExtractionFileInput): string {
  return `data:${input.mimeType};base64,${Buffer.from(input.bytes).toString("base64")}`
}

function extractedValue(rule: z.infer<typeof extractedRuleSchema>): EligibilityRule["value"] {
  if (rule.unspecified || rule.unknown || rule.ambiguous) return null
  if (rule.operator === "in" || rule.operator === "not_in") return rule.valueList
  if (rule.valueBoolean !== null) return rule.valueBoolean
  if (rule.valueNumber !== null) return rule.valueNumber
  return rule.valueText
}

type RawResponse = { id?: string; error?: { message?: string }; output_text?: string; output?: Array<{ content?: Array<{ type?: string; text?: string }> }> }

export class OpenAiCriteriaScanProvider implements CriteriaScanProvider {
  readonly name = "openai-responses"
  constructor(private readonly apiKey: string, private readonly model: string, private readonly endpoint = "https://api.openai.com/v1/responses", private readonly timeoutMs = 45_000) {}

  private async call(input: unknown[]): Promise<{ json: unknown; requestId?: string }> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    let response: Response
    try {
      response = await fetch(this.endpoint, {
        method: "POST",
        headers: { authorization: `Bearer ${this.apiKey}`, "content-type": "application/json" },
        body: JSON.stringify({
          model: this.model,
          store: false,
          input,
          text: { format: { type: "json_schema", name: "mca_funder_criteria_scan", strict: true, schema: criteriaJsonSchema } },
        }),
        signal: controller.signal,
      })
    } catch (error) {
      if ((error as Error).name === "AbortError") throw new AppError(504, "provider_timeout", "Criteria scan timed out. Retry the extraction.")
      throw new AppError(503, "provider_unavailable", "Criteria scan could not be reached. Check the configured provider and retry.")
    } finally {
      clearTimeout(timer)
    }
    const requestId = response.headers.get("x-request-id") ?? undefined
    const body = await response.json().catch(() => ({})) as RawResponse
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) throw new AppError(503, "provider_authentication_failed", "Criteria scan credentials were rejected. Rotate OPENAI_API_KEY and retry.")
      throw new AppError(502, "provider_failed", body.error?.message?.slice(0, 300) || "Criteria scan could not process this request.")
    }
    const output = body.output_text ?? body.output?.flatMap((item) => item.content ?? []).find((item) => item.type === "output_text")?.text
    if (!output) throw new AppError(502, "provider_invalid_response", "Criteria scan returned no structured output. Retry or review the file manually.")
    try {
      return { json: JSON.parse(output), requestId: requestId ?? body.id }
    } catch {
      throw new AppError(502, "provider_invalid_response", "Criteria scan returned invalid structured output. Retry or review the file manually.")
    }
  }

  async extractCriteria(_actor: DealActor, input: ExtractionFileInput): Promise<CriteriaExtraction> {
    const prompt = [
      "Extract MCA funder eligibility criteria from this PDF or image.",
      "Return typed rules for revenue, FICO, time in business, positions, requested amount, term, ADB, deposit count, NSF, negative days, default status, entity, state, and industry.",
      "Preserve raw source wording in sourceText. Do not invent missing limits.",
      "If a limit is absent, use unspecified=true, unknown=true, and null values. Never use sentinel numbers such as 0, -1, 9999, or 9999999 for unspecified limits.",
      "If a range is ambiguous (for example FICO 600-650 without a clear min or max), set ambiguous=true, unspecified=true, and copy the range into rangeText. Do not pick the least-restrictive bound.",
      "Contacts may be extracted for review but must not be treated as authoritative over existing funder contacts.",
      "Evidence text is a short excerpt; page is the PDF page number when known.",
    ].join(" ")
    const result = await this.call([{ role: "user", content: [{ type: "input_text", text: prompt }, { type: "input_file", filename: input.filename, file_data: fileData(input) }] }])
    const parsed = extractionSchema.safeParse(result.json)
    if (!parsed.success) throw new AppError(502, "provider_schema_mismatch", "Criteria scan output did not match the eligibility schema. Retry or review manually.")
    return {
      rules: parsed.data.rules.map((item) => ({
        field: item.field,
        operator: item.operator,
        unit: item.unit,
        value: extractedValue(item),
        sourceText: item.sourceText ?? undefined,
        unspecified: item.unspecified || item.unknown || item.ambiguous,
        ambiguous: item.ambiguous,
        rangeText: item.rangeText ?? undefined,
        confidence: item.confidence,
        page: item.page ?? undefined,
        text: item.text ?? undefined,
        unknown: item.unknown,
      })),
      contacts: parsed.data.contacts.map((item) => ({
        name: item.name ?? undefined,
        email: item.email ?? undefined,
        phone: item.phone ?? undefined,
        role: item.role ?? undefined,
      })),
      warnings: parsed.data.warnings,
      provider: this.name,
      requestId: result.requestId,
    }
  }
}

let providerOverride: CriteriaScanProvider | undefined
export function setCriteriaScanProviderForTests(provider?: CriteriaScanProvider): void {
  providerOverride = provider
}

function configuredProvider(): CriteriaScanProvider {
  if (providerOverride) return providerOverride
  const provider = process.env.MCA_DOCUMENT_AI_PROVIDER
  if (!provider) throw new AppError(503, "provider_unavailable", "Configure MCA_DOCUMENT_AI_PROVIDER=openai, OPENAI_API_KEY, and MCA_DOCUMENT_AI_MODEL before scanning funder criteria.")
  if (provider !== "openai") throw new AppError(503, "provider_unavailable", `Unsupported criteria scan provider: ${provider}.`)
  if (!process.env.OPENAI_API_KEY) throw new AppError(503, "provider_unavailable", "Configure OPENAI_API_KEY before scanning funder criteria.")
  if (!process.env.MCA_DOCUMENT_AI_MODEL) throw new AppError(503, "provider_unavailable", "Configure MCA_DOCUMENT_AI_MODEL before scanning funder criteria.")
  return new OpenAiCriteriaScanProvider(process.env.OPENAI_API_KEY, process.env.MCA_DOCUMENT_AI_MODEL)
}

export function criteriaScanProvider(): CriteriaScanProvider {
  return configuredProvider()
}

export function criteriaScanStatus(): { configured: boolean; provider: string; action?: string } {
  if (providerOverride) return { configured: true, provider: providerOverride.name }
  const provider = process.env.MCA_DOCUMENT_AI_PROVIDER
  const configured = provider === "openai" && Boolean(process.env.OPENAI_API_KEY && process.env.MCA_DOCUMENT_AI_MODEL)
  return { configured, provider: provider ?? "unconfigured", ...(configured ? {} : { action: "Set MCA_DOCUMENT_AI_PROVIDER=openai, OPENAI_API_KEY, and MCA_DOCUMENT_AI_MODEL." }) }
}
