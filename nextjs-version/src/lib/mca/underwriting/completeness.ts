import "server-only"

import { isDocumentReady } from "../documents/contracts"

import { createHash } from "node:crypto"
import { assertTrustedMutation, requireMembershipAccess, requireWorkspaceAccess } from "../auth"
import { newId, nowIso, recordAuditEvent } from "../db"
import { actorForDeals, getDealForDocument } from "../deals/service"
import type { DealActor } from "../deals/schema"
import { listDocumentRecords } from "../documents/repository"
import type { DocumentSummary } from "../documents/contracts"
import { AppError } from "../errors"
import { requestCorrelationId } from "../http"
import { getWorkspaceSettings } from "../workspaces"
import type { CompletenessFinding, CompletenessResult } from "./contracts"
import {
  DEFAULT_REQUIRED_STATEMENT_MONTHS,
  findLatestCompletenessResult,
  insertCompletenessResultAndEvent,
  listCheckingStatementMonths,
  listReadinessEventRecords,
  readRequiredStatementMonths,
  upsertRequiredStatementMonths,
  type ReadinessEventRecord,
} from "./completeness-repository"
import { closedLookbackMonths } from "./lookback"

const APPLICATION_CATEGORIES = new Set(["application", "api_application"])
const UNREADABLE_CATEGORIES = new Set(["application", "api_application", "statement", "driver_license", "voided_check"])
const UNREADABLE_STATES = new Set(["quarantined", "scan_failed", "upload_failed"])
const PERIOD_PATTERN = /\d{4}-(?:0[1-9]|1[0-2])/g
const VALID_PERIOD = /^\d{4}-(0[1-9]|1[0-2])$/

export type ReadinessEvent = ReadinessEventRecord

export async function requireCompletenessActor(request: Request, mode: "read" | "write"): Promise<DealActor> {
  if (mode === "write") assertTrustedMutation(request)
  const auth = await requireWorkspaceAccess(request, { scopes: [mode === "read" ? "deals:read" : "deals:write"] })
  return { ...await actorForDeals(auth), correlationId: requestCorrelationId(request) }
}

export async function requireCompletenessAdmin(request: Request): Promise<DealActor> {
  assertTrustedMutation(request)
  const auth = await requireMembershipAccess(request, ["admin", "super_admin"])
  return { ...await actorForDeals(auth), correlationId: requestCorrelationId(request) }
}

export async function getRequiredStatementMonths(actor: DealActor): Promise<number> {
  return readRequiredStatementMonths(actor.workspaceId)
}

export async function setRequiredStatementMonths(actor: DealActor, n: number): Promise<{ requiredStatementMonths: number }> {
  if (actor.role !== "admin" && actor.role !== "super_admin") {
    throw new AppError(403, "permission_denied", "Only workspace administrators can update completeness settings.")
  }
  if (!Number.isInteger(n) || n < 1 || n > 24) {
    throw new AppError(422, "validation_failed", "Required statement months must be an integer between 1 and 24.", {
      requiredStatementMonths: ["Enter a whole number from 1 to 24."],
    })
  }
  const now = nowIso()
  const requiredStatementMonths = await upsertRequiredStatementMonths(actor.workspaceId, n, actor.userId, now)
  await recordAuditEvent({
    context: actor,
    action: "completeness.settings_updated",
    resourceType: "workspace",
    resourceId: actor.workspaceId,
    metadata: { requiredStatementMonths },
    correlationId: actor.correlationId,
  })
  return { requiredStatementMonths }
}

export async function getCompleteness(actor: DealActor, dealId: string): Promise<CompletenessResult | null> {
  const deal = await getDealForDocument(actor, dealId)
  return (await findLatestCompletenessResult(deal.workspaceId, deal.id))?.result ?? null
}

export async function listReadinessEvents(actor: DealActor, dealId: string): Promise<ReadinessEvent[]> {
  const deal = await getDealForDocument(actor, dealId)
  return listReadinessEventRecords(deal.workspaceId, deal.id)
}

/** Server-internal current facts only; no cached results, readiness events, audit or automatic submission writes. */
export async function readCurrentCompleteness(workspaceId: string, dealId: string) {
  const documents = await listDocumentRecords(workspaceId, dealId)
  const requiredStatementMonths = await readRequiredStatementMonths(workspaceId)
  const settings = await getWorkspaceSettings(workspaceId)
  const timeZone = settings.timezone || "America/New_York"
  const lookback = closedLookbackMonths(requiredStatementMonths, timeZone)
  const statementMonths = await listCheckingStatementMonths(workspaceId, dealId)
  const findings = evaluateFindings(documents, lookback, statementMonths)
  return { findings, requiredStatementMonths, timeZone, lookback }
}

export async function checkCompleteness(actor: DealActor, dealId: string): Promise<CompletenessResult> {
  const deal = await getDealForDocument(actor, dealId)
  const { findings, requiredStatementMonths, timeZone, lookback } = await readCurrentCompleteness(deal.workspaceId, deal.id)
  const findingsFingerprint = fingerprint(findings)
  const previous = await findLatestCompletenessResult(deal.workspaceId, deal.id)
  if (previous && previous.findingsFingerprint === findingsFingerprint) return previous.result

  const now = nowIso()
  const result = await insertCompletenessResultAndEvent({
    resultId: newId(),
    eventId: newId(),
    workspaceId: deal.workspaceId,
    dealId: deal.id,
    ready: findings.length === 0,
    ruleSnapshot: JSON.stringify({
      requiredStatementMonths,
      lookbackMonths: lookback,
      timeZone,
      requireCleanApplication: true,
      requireDriverLicense: true,
      requireVoidedCheck: true,
      statementSource: "mca_statement_months",
      defaultRequiredStatementMonths: DEFAULT_REQUIRED_STATEMENT_MONTHS,
    }),
    findings,
    findingsFingerprint,
    checkedAt: now,
  })
  await recordAuditEvent({
    context: actor,
    action: "completeness.checked",
    resourceType: "deal",
    resourceId: deal.id,
    metadata: { version: result.version, ready: result.ready, findingCount: findings.length },
    correlationId: actor.correlationId,
  })
  if (result.ready && process.env.MCA_AUTO_SUBMIT_ENABLED === "true") await (await import("./auto-submit")).enqueueAutoSubmitIfEnabled(actor, deal.id, result.version, deal.version)
  return result
}

function parsePeriods(filename: string): string[] {
  return [...new Set(filename.match(PERIOD_PATTERN) ?? [])]
}

function filenamePeriod(document: DocumentSummary): { period?: string; mismatch: boolean } {
  const unique = [...new Set([...parsePeriods(document.displayFilename), ...parsePeriods(document.originalFilename)])]
  if (unique.length > 1) return { mismatch: true }
  if (unique.length === 1) return { period: unique[0], mismatch: false }
  return { mismatch: false }
}

function evaluateFindings(
  documents: DocumentSummary[],
  lookback: string[],
  statementMonths: Map<string, Array<{ period: string; accountKind: string }>>,
): CompletenessFinding[] {
  const findings: CompletenessFinding[] = []
  const covered = new Set<string>()
  const hasCleanApplication = documents.some((document) => APPLICATION_CATEGORIES.has(document.category) && isDocumentReady(document.processingState))
  if (!hasCleanApplication) {
    findings.push({ code: "missing_application", message: "Upload a merchant application." })
  }
  if (!documents.some((document) => document.category === "driver_license" && isDocumentReady(document.processingState))) {
    findings.push({ code: "missing_driver_license", message: "Upload a ready driver license." })
  }
  if (!documents.some((document) => document.category === "voided_check" && isDocumentReady(document.processingState))) {
    findings.push({ code: "missing_voided_check", message: "Upload a ready voided check." })
  }

  for (const document of documents) {
    if (UNREADABLE_CATEGORIES.has(document.category) && UNREADABLE_STATES.has(document.processingState)) {
      findings.push({
        code: "unreadable_document",
        message: "This document is blocked or its upload is incomplete and cannot be used for completeness.",
        documentId: document.id,
      })
    }
    if (document.category !== "statement") continue

    const extracted = statementMonths.get(document.id) ?? []
    const checking = extracted.filter((row) => row.accountKind === "checking")
    const validChecking = checking.filter((row) => VALID_PERIOD.test(row.period))
    const parsed = filenamePeriod(document)
    const ready = isDocumentReady(document.processingState)

    if (validChecking.length > 0) {
      if (parsed.mismatch || (parsed.period && !validChecking.some((row) => row.period === parsed.period))) {
        findings.push({
          code: "period_mismatch",
          message: "The statement filename period does not match the recorded statement month.",
          documentId: document.id,
          period: parsed.period ?? validChecking[0]?.period,
        })
      }
      if (ready) {
        for (const row of validChecking) covered.add(row.period)
      }
      continue
    }

    if (parsed.mismatch) {
      findings.push({
        code: "period_mismatch",
        message: "The statement display filename period does not match the original filename period.",
        documentId: document.id,
        period: parsePeriods(document.displayFilename)[0],
      })
    }

    if (ready && (extracted.length === 0 || checking.length > 0)) {
      findings.push({
        code: "unknown_statement_period",
        message: "The statement period could not be determined from extraction as YYYY-MM.",
        documentId: document.id,
      })
    }
  }

  for (const period of lookback) {
    if (covered.has(period)) continue
    findings.push({
      code: `missing_statement_${period}`,
      message: `Missing checking statement for ${period}.`,
      period,
    })
  }

  return findings.sort((left, right) => {
    const a = `${left.code}|${left.documentId ?? ""}|${left.period ?? ""}`
    const b = `${right.code}|${right.documentId ?? ""}|${right.period ?? ""}`
    return a.localeCompare(b)
  })
}

function fingerprint(findings: CompletenessFinding[]): string {
  const keys = findings.map((finding) => `${finding.code}|${finding.documentId ?? ""}|${finding.period ?? ""}`).sort()
  return createHash("sha256").update(keys.join("\n")).digest("hex")
}
