import "server-only"

import { assertTrustedMutation, requireWorkspaceAccess } from "../auth"
import { hashOpaqueToken } from "../crypto"
import { getDatabase, newId, nowIso, parseJson, recordAuditEvent } from "../db"
import { actorForDeals, getDeal, getDealForDocument } from "../deals/service"
import type { DealActor, DealRecord } from "../deals/schema"
import { AppError } from "../errors"
import { requestCorrelationId } from "../http"
import type { ApiKeyScope, AuthContext } from "../types"
import { convertRevenueThreshold, listFunderCriteria, resolveIndustry } from "../funders/criteria"
import { getFunder, listFunders } from "../funders/directory"
import type { EligibilityRule, FunderRecord } from "../funders/contracts"
import type { CompletenessResult, ExistingPositionCandidate, FunderScore, MetricEvidence, StatementMonthRecord, UnderwritingAggregate } from "./contracts"
import { getCompleteness } from "./completeness"
import {
  DEFAULT_ADB_SCALE,
  DEFAULT_FICO_FLOOR,
  DEFAULT_NSF_SCALE,
  DEFAULT_POSITION_SCALE,
  DEFAULT_REVENUE_SCALE,
  DEFAULT_TOP_N,
  GRADE_A_MIN,
  GRADE_B_MIN,
  GRADE_C_MIN,
  GRADE_D_MIN,
  HARD_DQ_FIELDS,
  POLICY_VERSION,
  REVENUE_FIT_MULTIPLIER,
  SCORE_FIT_DISCLAIMER,
  SOFT_FICO_SPAN,
  SOFT_WEIGHT_ADB,
  SOFT_WEIGHT_FICO,
  SOFT_WEIGHT_NSF,
  SOFT_WEIGHT_POSITIONS,
  SOFT_WEIGHT_REQUESTED_AMOUNT,
  SOFT_WEIGHT_REVENUE_FIT,
} from "./policy"
import { listChecks } from "../datamerch/repository"
import { getUnderwritingAggregate, listExistingPositions, listStatementMonths } from "./statements"
import {
  findLatestScoreSnapshot,
  insertScoreSnapshot,
  toAnalysisSnapshot,
  type StoredScoreSnapshot,
} from "./snapshot-repository"

export { POLICY_VERSION, SCORE_FIT_DISCLAIMER }

/** Confirmed position labels and DataMerch categories that set defaultFlag. */
export const DEFAULT_FLAG_PATTERN = /\bdefaults?\b|\bdefaulted\b|\bslow[\s_-]?pay\b/i

export type DefaultFlagDataMerchCheck = {
  status: string
  merchants?: Array<{ records?: Array<{ category?: string | null } | null> | null } | null> | null
}

export interface ScoreDealResult {
  snapshot: ReturnType<typeof toAnalysisSnapshot>
  stale: false
  staleReasons: string[]
  disclaimer: string
  autoSelectableFunderIds: string[]
  funders: Array<{ id: string; legalName: string; nickname?: string; active: boolean }>
}

export interface DealScores {
  snapshot: ReturnType<typeof toAnalysisSnapshot> | null
  stale: boolean
  staleReasons: string[]
  disclaimer: string
  autoSelectableFunderIds: string[]
  funders: Array<{ id: string; legalName: string; nickname?: string; active: boolean }>
}

export interface ScoringInputs {
  dealId: string
  dealVersion: number
  state?: string
  entity?: string
  industry?: string
  naics?: string
  defaultFlag: boolean
  tibMonths?: number
  fico?: number
  requestedAmount?: number
  termMonths?: number
  monthlyRevenue?: number
  revenueUnknown: boolean
  averageDailyBalance?: number
  adbUnknown: boolean
  nsfCount?: number
  nsfUnknown: boolean
  negativeDays?: number
  negativeUnknown: boolean
  depositCount?: number
  depositUnknown: boolean
  worstMonthNsf?: number
  positionCount: number
  proposedPositionCount: number
  availableMonthlyRevenue?: number
  availableUnknown: boolean
  dataAge?: string
}

type Reason = FunderScore["reasons"][number]
type Grade = FunderScore["grade"]

function isThenable(value: unknown): value is Promise<unknown> {
  return Boolean(value) && typeof (value as { then?: unknown }).then === "function"
}

async function resolved<T>(value: T | Promise<T>): Promise<T> {
  return isThenable(value) ? await value as T : value
}

async function actorFromContext(context: AuthContext, request: Request): Promise<DealActor> {
  try {
    return { ...await actorForDeals(context), correlationId: requestCorrelationId(request) }
  } catch {
    return {
      workspaceId: context.workspaceId,
      userId: context.userId,
      membershipId: context.membershipId,
      role: context.role,
      managedMembershipIds: [],
      activeMembershipIds: [],
      source: context.authType === "api_key" ? "api_key" : "user",
      correlationId: requestCorrelationId(request),
    }
  }
}

export async function requireScoreActor(request: Request, mode: "read" | "write"): Promise<DealActor> {
  if (mode === "write") assertTrustedMutation(request)
  const required = mode === "read" ? "deals:read" : "deals:write"
  const authorization = request.headers.get("authorization")
  if (authorization?.startsWith("Bearer mca_")) {
    const row = await getDatabase().prepare<{ id: string; workspace_id: string; scopes: string; expires_at: string | null }>(
      `SELECT id, workspace_id, scopes, expires_at FROM api_keys WHERE secret_hash = ? AND revoked_at IS NULL`,
    ).get(hashOpaqueToken(authorization.slice(7)))
    if (!row || (row.expires_at && String(row.expires_at) <= nowIso())) {
      throw new AppError(401, "authentication_required", "Sign in to continue.")
    }
    const scopes = parseJson<ApiKeyScope[]>(row.scopes, [])
    if (!scopes.includes(required)) throw new AppError(403, "scope_required", "The API key does not have the required scope.")
    return actorFromContext({
      authType: "api_key",
      userId: null,
      membershipId: null,
      workspaceId: String(row.workspace_id),
      role: null,
      scopes,
      sessionId: null,
    }, request)
  }
  const auth = await resolved(requireWorkspaceAccess(request, { scopes: [required] }))
  if (!auth || typeof auth !== "object" || !("workspaceId" in auth) || typeof auth.workspaceId !== "string") {
    throw new AppError(401, "authentication_required", "Sign in to continue.")
  }
  if (auth.authType === "api_key" && !auth.scopes.includes(required)) {
    throw new AppError(403, "scope_required", "The API key does not have the required scope.")
  }
  return actorFromContext(auth, request)
}

export function autoSelectableFunderIds(scores: FunderScore[]): string[] {
  return [...scores]
    .filter((score) => score.eligible && score.grade !== "DQ")
    .sort((left, right) => left.rank - right.rank || left.funderId.localeCompare(right.funderId))
    .map((score) => score.funderId)
}

export function gradeFromScore(score: number, eligible: boolean): Grade {
  if (!eligible) return "DQ"
  if (score >= GRADE_A_MIN) return "A"
  if (score >= GRADE_B_MIN) return "B"
  if (score >= GRADE_C_MIN) return "C"
  if (score >= GRADE_D_MIN) return "D"
  return "F"
}

function clamp(value: number, min: number, max: number): number {
  if (value < min) return min
  if (value > max) return max
  return value
}

function intScore(numerator: number, denominator: number): number {
  if (!(denominator > 0) || !Number.isFinite(numerator) || !Number.isFinite(denominator)) return 0
  return clamp(Math.round((numerator / denominator) * 100), 0, 100)
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : ""
}

function normalizeState(value: string): string {
  return value.trim().toUpperCase()
}

function normalizeEntity(value: string): string {
  const key = value.trim().toLowerCase().replace(/[\s-]+/g, "_")
  if (key === "corp" || key === "c_corp" || key === "c_corporation") return "corporation"
  if (key === "s_corp") return "s_corporation"
  return key
}

function metricNumber(metric?: MetricEvidence | null): { value?: number; unknown: boolean } {
  if (!metric) return { unknown: true }
  if (metric.unknown || metric.value == null || !Number.isFinite(metric.value)) return { unknown: true }
  return { value: metric.value, unknown: false }
}

function monthsBetween(startDate: string, asOf: string): number | undefined {
  const start = Date.parse(startDate.length === 10 ? `${startDate}T00:00:00.000Z` : startDate)
  const end = Date.parse(asOf)
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return undefined
  const from = new Date(start)
  const to = new Date(end)
  return (to.getUTCFullYear() - from.getUTCFullYear()) * 12 + (to.getUTCMonth() - from.getUTCMonth())
}

function listValues(value: EligibilityRule["value"]): string[] {
  if (Array.isArray(value)) return value.map((entry) => text(entry)).filter(Boolean)
  if (typeof value === "string" && value.trim()) return [value.trim()]
  if (typeof value === "number" && Number.isFinite(value)) return [String(value)]
  if (typeof value === "boolean") return [value ? "true" : "false"]
  return []
}

function monthlyRevenueLimit(rule: EligibilityRule): number | undefined {
  if (rule.unspecified || typeof rule.value !== "number" || !Number.isFinite(rule.value)) return undefined
  const unit = text(rule.unit).toLowerCase()
  if (unit === "usd_annual" || unit === "yearly" || unit === "annual") {
    return convertRevenueThreshold({ value: rule.value, from: "usd_annual", to: "usd_monthly" })
  }
  if (unit === "usd_monthly" || unit === "monthly" || unit === "usd") return rule.value
  return rule.value
}

function tibMonthsRequired(rule: EligibilityRule): number | undefined {
  if (rule.unspecified || typeof rule.value !== "number" || !Number.isFinite(rule.value)) return undefined
  const unit = text(rule.unit).toLowerCase()
  if (unit === "years" || unit === "year") return rule.value * 12
  return rule.value
}

function specifiedRules(rules: EligibilityRule[], field: string): EligibilityRule[] {
  return rules.filter((rule) => rule.field === field && !rule.unspecified)
}

function compareUnknown(rule: EligibilityRule, detail: string): Reason {
  return { ruleId: `hard.${rule.field}`, result: "unknown", detail }
}

function comparePass(rule: EligibilityRule, detail: string): Reason {
  return { ruleId: `hard.${rule.field}`, result: "pass", detail }
}

function compareFail(rule: EligibilityRule, detail: string): Reason {
  return { ruleId: `hard.${rule.field}`, result: "fail", detail }
}

function evaluateNumeric(rule: EligibilityRule, actual: number, label: string, rendered: string): Reason {
  const threshold = rule.field === "revenue" ? monthlyRevenueLimit(rule) : rule.field === "time_in_business" ? tibMonthsRequired(rule) : typeof rule.value === "number" ? rule.value : undefined
  if (threshold == null || !Number.isFinite(threshold)) return compareUnknown(rule, `${label} limit is unspecified.`)
  if (rule.operator === "min") {
    return actual >= threshold
      ? comparePass(rule, `${label} ${rendered} meets the minimum ${threshold}.`)
      : compareFail(rule, `${label} ${rendered} is below the minimum ${threshold}.`)
  }
  if (rule.operator === "max") {
    return actual <= threshold
      ? comparePass(rule, `${label} ${rendered} is within the maximum ${threshold}.`)
      : compareFail(rule, `${label} ${rendered} exceeds the maximum ${threshold}.`)
  }
  if (rule.operator === "eq") {
    return actual === threshold
      ? comparePass(rule, `${label} ${rendered} equals ${threshold}.`)
      : compareFail(rule, `${label} ${rendered} does not equal ${threshold}.`)
  }
  return compareUnknown(rule, `${label} cannot be evaluated with operator ${rule.operator}.`)
}

function membership(actual: string, items: string[], contains: boolean): boolean {
  const present = items.includes(actual)
  return contains ? present : !present
}

async function normalizeIndustryValue(actor: DealActor, raw: string): Promise<{ name: string; naics?: string }> {
  const input = text(raw)
  if (!input) return { name: "" }
  try {
    const industry = await resolved(resolveIndustry(actor, input))
    return { name: text(industry.normalizedIndustry) || input, naics: industry.naics }
  } catch {
    return { name: input, naics: /^\d{2,6}$/.test(input) ? input : undefined }
  }
}

async function evaluateListRule(actor: DealActor, rule: EligibilityRule, actual: { state?: string; entity?: string; industry?: string; naics?: string }, missing: boolean): Promise<Reason> {
  if (missing) return compareUnknown(rule, `Deal ${rule.field.split("_").join(" ")} is missing, so this restriction cannot pass.`)
  const items = listValues(rule.value)
  if (items.length === 0) return compareUnknown(rule, `Funder ${rule.field.split("_").join(" ")} list is empty.`)
  const contains = rule.operator !== "not_in"
  if (rule.field === "state") {
    const value = normalizeState(actual.state ?? "")
    const allowed = items.map(normalizeState)
    const ok = membership(value, allowed, contains)
    return ok
      ? comparePass(rule, `State ${value} ${contains ? "is in" : "is not in"} ${allowed.join(", ")}.`)
      : compareFail(rule, `State ${value} ${contains ? "is not in" : "is in"} ${allowed.join(", ")}.`)
  }
  if (rule.field === "entity") {
    const value = normalizeEntity(actual.entity ?? "")
    const allowed = items.map(normalizeEntity)
    const ok = membership(value, allowed, contains)
    return ok
      ? comparePass(rule, `Entity ${value} ${contains ? "is in" : "is not in"} ${allowed.join(", ")}.`)
      : compareFail(rule, `Entity ${value} ${contains ? "is not in" : "is in"} ${allowed.join(", ")}.`)
  }
  const dealIndustry = await normalizeIndustryValue(actor, actual.industry ?? actual.naics ?? "")
  const funderItems = await Promise.all(items.map((item) => normalizeIndustryValue(actor, item)))
  const names = new Set(funderItems.map((item) => item.name.toLowerCase()).filter(Boolean))
  const codes = new Set(funderItems.map((item) => item.naics).filter((code): code is string => Boolean(code)))
  const matched = names.has(dealIndustry.name.toLowerCase()) || Boolean(dealIndustry.naics && codes.has(dealIndustry.naics)) || Boolean(actual.naics && codes.has(actual.naics))
  const ok = contains ? matched : !matched
  return ok
    ? comparePass(rule, `Industry ${dealIndustry.name || actual.naics || "unknown"} ${contains ? "is allowed" : "is not restricted"}.`)
    : compareFail(rule, `Industry ${dealIndustry.name || actual.naics || "unknown"} ${contains ? "is not allowed" : "is restricted"}.`)
}

function evaluateDefault(rule: EligibilityRule, defaultFlag: boolean): Reason {
  const expected = rule.value === true || rule.value === "true" || rule.value === 1
  const actual = defaultFlag
  if (rule.operator === "eq") {
    return actual === expected
      ? comparePass(rule, expected ? "Merchant is in default as required." : "Merchant is not in default.")
      : compareFail(rule, expected ? "Merchant is not in default." : "Merchant default flag disqualifies this funder.")
  }
  if (rule.operator === "not_in" || rule.operator === "in") {
    const items = listValues(rule.value).map((item) => item === "true" || item === "1")
    const matched = items.includes(actual)
    const ok = rule.operator === "in" ? matched : !matched
    return ok ? comparePass(rule, "Default status matches the funder rule.") : compareFail(rule, "Default status does not match the funder rule.")
  }
  return compareUnknown(rule, "Default status cannot be evaluated.")
}

async function evaluateHardRules(actor: DealActor, inputs: ScoringInputs, rules: EligibilityRule[]): Promise<Reason[]> {
  const reasons: Reason[] = []
  for (const field of HARD_DQ_FIELDS) {
    for (const rule of specifiedRules(rules, field)) {
      if (field === "state") {
        reasons.push(await evaluateListRule(actor, rule, inputs, !inputs.state))
        continue
      }
      if (field === "entity") {
        reasons.push(await evaluateListRule(actor, rule, inputs, !inputs.entity))
        continue
      }
      if (field === "industry") {
        reasons.push(await evaluateListRule(actor, rule, inputs, !inputs.industry && !inputs.naics))
        continue
      }
      if (field === "default_status") {
        reasons.push(evaluateDefault(rule, inputs.defaultFlag))
        continue
      }
      if (field === "nsf") {
        reasons.push(inputs.nsfUnknown || inputs.nsfCount == null
          ? compareUnknown(rule, "NSF count is unknown, so the funder's NSF maximum cannot pass.")
          : evaluateNumeric(rule, inputs.nsfCount, "NSF count", String(inputs.nsfCount)))
        continue
      }
      if (field === "negative_days") {
        reasons.push(inputs.negativeUnknown || inputs.negativeDays == null
          ? compareUnknown(rule, "Negative days are unknown, so the funder's negative-day maximum cannot pass.")
          : evaluateNumeric(rule, inputs.negativeDays, "Negative days", String(inputs.negativeDays)))
        continue
      }
      if (field === "positions") {
        reasons.push(evaluateNumeric(rule, inputs.positionCount, "Existing positions", String(inputs.positionCount)))
        continue
      }
      if (field === "time_in_business") {
        reasons.push(inputs.tibMonths == null
          ? compareUnknown(rule, "Time in business is unknown, so the funder's minimum cannot pass.")
          : evaluateNumeric(rule, inputs.tibMonths, "Time in business (months)", String(inputs.tibMonths)))
        continue
      }
      if (field === "fico") {
        reasons.push(inputs.fico == null
          ? compareUnknown(rule, "FICO is unknown, so the funder's minimum cannot pass.")
          : evaluateNumeric(rule, inputs.fico, "FICO", String(inputs.fico)))
        continue
      }
      if (field === "revenue") {
        reasons.push(inputs.revenueUnknown || inputs.monthlyRevenue == null
          ? compareUnknown(rule, "Monthly revenue is unknown, so the funder's minimum cannot pass.")
          : evaluateNumeric(rule, inputs.monthlyRevenue, "Monthly revenue", String(inputs.monthlyRevenue)))
        continue
      }
    }
  }
  return reasons
}

function ruleNumber(rules: EligibilityRule[], field: string, operator: EligibilityRule["operator"]): number | undefined {
  const rule = specifiedRules(rules, field).find((item) => item.operator === operator)
  if (!rule) return undefined
  if (field === "revenue") return monthlyRevenueLimit(rule)
  return typeof rule.value === "number" && Number.isFinite(rule.value) ? rule.value : undefined
}

function softReasonsAndScore(inputs: ScoringInputs, rules: EligibilityRule[]): { score: number; reasons: Reason[] } {
  const reasons: Reason[] = []
  const minRevenue = ruleNumber(rules, "revenue", "min")
  const minAdb = ruleNumber(rules, "average_daily_balance", "min")
  const maxNsf = ruleNumber(rules, "nsf", "max")
  const maxPositions = ruleNumber(rules, "positions", "max")
  const maxRequested = ruleNumber(rules, "requested_amount", "max")
  const minFico = ruleNumber(rules, "fico", "min")

  const revenueAvailable = inputs.availableUnknown ? undefined : inputs.availableMonthlyRevenue ?? inputs.monthlyRevenue
  let revenue = 0
  if (revenueAvailable == null) {
    reasons.push({ ruleId: "soft.revenue_fit", result: "unknown", detail: "Available monthly revenue is unknown, so revenue fit contributes 0." })
  } else {
    const scale = minRevenue && minRevenue > 0 ? minRevenue * REVENUE_FIT_MULTIPLIER : DEFAULT_REVENUE_SCALE
    revenue = intScore(revenueAvailable, scale)
    reasons.push({ ruleId: "soft.revenue_fit", result: "pass", detail: `Available monthly revenue ${revenueAvailable} scores ${revenue} against scale ${scale}.` })
  }

  let adb = 0
  if (inputs.adbUnknown || inputs.averageDailyBalance == null) {
    reasons.push({ ruleId: "soft.adb", result: "unknown", detail: "Average daily balance is unknown, so ADB fit contributes 0." })
  } else {
    const scale = minAdb && minAdb > 0 ? minAdb : DEFAULT_ADB_SCALE
    adb = Math.min(100, intScore(inputs.averageDailyBalance, scale))
    reasons.push({ ruleId: "soft.adb", result: "pass", detail: `ADB ${inputs.averageDailyBalance} scores ${adb} against ${scale}.` })
  }

  let nsf = 0
  if (inputs.nsfUnknown || inputs.nsfCount == null) {
    reasons.push({ ruleId: "soft.nsf", result: "unknown", detail: "NSF count is unknown, so NSF fit contributes 0." })
  } else {
    const scale = maxNsf && maxNsf > 0 ? maxNsf : DEFAULT_NSF_SCALE
    nsf = intScore(Math.max(0, scale - inputs.nsfCount), scale)
    reasons.push({ ruleId: "soft.nsf", result: "pass", detail: `NSF count ${inputs.nsfCount} scores ${nsf} against maximum ${scale}.` })
  }

  let positions = 0
  {
    const scale = maxPositions && maxPositions > 0 ? maxPositions : DEFAULT_POSITION_SCALE
    positions = intScore(Math.max(0, scale - inputs.positionCount), scale)
    reasons.push({ ruleId: "soft.positions", result: "pass", detail: `Position count ${inputs.positionCount} scores ${positions} against maximum ${scale}.` })
  }

  let requested = 0
  if (inputs.requestedAmount == null) {
    reasons.push({ ruleId: "soft.requested_amount", result: "unknown", detail: "Requested amount is unknown, so amount fit contributes 0." })
  } else {
    const scale = maxRequested && maxRequested > 0
      ? maxRequested
      : Math.max(inputs.requestedAmount, (revenueAvailable ?? DEFAULT_REVENUE_SCALE) * 12)
    requested = intScore(Math.max(0, scale - inputs.requestedAmount), scale)
    reasons.push({ ruleId: "soft.requested_amount", result: "pass", detail: `Requested amount ${inputs.requestedAmount} scores ${requested} against ${scale}.` })
  }

  let fico = 0
  if (inputs.fico == null) {
    reasons.push({ ruleId: "soft.fico", result: "unknown", detail: "FICO is unknown, so FICO fit contributes 0." })
  } else {
    const floor = minFico && minFico > 0 ? minFico : DEFAULT_FICO_FLOOR
    const over = Math.max(0, inputs.fico - floor)
    fico = clamp(50 + Math.min(50, Math.round((over * 50) / SOFT_FICO_SPAN)), 0, 100)
    reasons.push({ ruleId: "soft.fico", result: "pass", detail: `FICO ${inputs.fico} scores ${fico} against floor ${floor}.` })
  }

  const weighted = (
    revenue * SOFT_WEIGHT_REVENUE_FIT
    + adb * SOFT_WEIGHT_ADB
    + nsf * SOFT_WEIGHT_NSF
    + positions * SOFT_WEIGHT_POSITIONS
    + requested * SOFT_WEIGHT_REQUESTED_AMOUNT
    + fico * SOFT_WEIGHT_FICO
  ) / 100
  return { score: clamp(Math.round(weighted), 0, 100), reasons }
}

export async function evaluateFunderScore(actor: DealActor, inputs: ScoringInputs, funder: FunderRecord, rules: EligibilityRule[]): Promise<FunderScore> {
  if (!funder.active) {
    return {
      funderId: funder.id,
      rank: 0,
      score: 0,
      grade: "DQ",
      eligible: false,
      reasons: [{ ruleId: "funder.active", result: "fail", detail: "Inactive funders cannot be selected." }],
      ...(inputs.dataAge ? { dataAge: inputs.dataAge } : {}),
    }
  }
  const hard = await evaluateHardRules(actor, inputs, rules)
  const blocked = hard.some((reason) => reason.result !== "pass")
  if (blocked) {
    return {
      funderId: funder.id,
      rank: 0,
      score: 0,
      grade: "DQ",
      eligible: false,
      reasons: hard,
      ...(inputs.dataAge ? { dataAge: inputs.dataAge } : {}),
    }
  }
  const soft = softReasonsAndScore(inputs, rules)
  return {
    funderId: funder.id,
    rank: 0,
    score: soft.score,
    grade: gradeFromScore(soft.score, true),
    eligible: true,
    reasons: [...hard, ...soft.reasons],
    ...(inputs.dataAge ? { dataAge: inputs.dataAge } : {}),
  }
}

export function rankScores(scores: FunderScore[]): FunderScore[] {
  const eligible = scores.filter((score) => score.eligible).sort((left, right) => right.score - left.score || left.funderId.localeCompare(right.funderId))
  const disqualified = scores.filter((score) => !score.eligible).sort((left, right) => left.funderId.localeCompare(right.funderId))
  return [...eligible, ...disqualified].map((score, index) => ({ ...score, rank: index + 1 }))
}

function criteriaFingerprint(versions: Record<string, number>): string {
  return JSON.stringify(Object.entries(versions).sort(([left], [right]) => left.localeCompare(right)))
}

function snapshotFingerprint(snapshot: Pick<StoredScoreSnapshot, "policyVersion" | "underwritingVersion" | "completenessVersion" | "dealVersion" | "criteriaVersions" | "scores" | "aggregateComputedAt">): string {
  return JSON.stringify({
    policyVersion: snapshot.policyVersion,
    underwritingVersion: snapshot.underwritingVersion,
    completenessVersion: snapshot.completenessVersion,
    dealVersion: snapshot.dealVersion,
    aggregateComputedAt: snapshot.aggregateComputedAt,
    criteriaVersions: criteriaFingerprint(snapshot.criteriaVersions),
    scores: snapshot.scores,
  })
}

function staleReasonsFor(
  snapshot: StoredScoreSnapshot | undefined,
  input: { policyVersion: number; underwritingVersion: number; completenessVersion: number; dealVersion: number; criteriaVersions: Record<string, number>; aggregateComputedAt: string },
): string[] {
  if (!snapshot) return []
  const reasons: string[] = []
  if (snapshot.stale) reasons.push("snapshot marked stale")
  if (snapshot.policyVersion !== input.policyVersion) reasons.push("policy version changed")
  if (snapshot.underwritingVersion !== input.underwritingVersion) reasons.push("underwriting version changed")
  if (snapshot.aggregateComputedAt !== input.aggregateComputedAt) reasons.push("underwriting aggregate changed")
  if (snapshot.completenessVersion !== input.completenessVersion) reasons.push("completeness version changed")
  if (snapshot.dealVersion !== input.dealVersion) reasons.push("deal version changed")
  if (criteriaFingerprint(snapshot.criteriaVersions) !== criteriaFingerprint(input.criteriaVersions)) reasons.push("funder criteria version changed")
  return reasons
}

async function loadFunders(actor: DealActor): Promise<FunderRecord[]> {
  try {
    const rows = await resolved(listFunders(actor))
    if (Array.isArray(rows) && rows.every((row) => row && typeof row.id === "string")) return rows
  } catch { /* directory still expects synchronous SQLite exec during migration */ }
  try {
    const rows = await getDatabase().prepare<{
      id: string; workspace_id: string; legal_name: string; nickname: string | null; website: string | null
      domains: string; products: string; active: number | boolean; contacts: string; routes: string
      criteria_version: number; profile_version: number; created_at: string; updated_at: string
    }>(`SELECT * FROM mca_funders WHERE workspace_id = ? AND active = TRUE ORDER BY lower(legal_name), created_at`).all(actor.workspaceId)
    return rows.map((row) => ({
      id: String(row.id),
      workspaceId: String(row.workspace_id),
      legalName: String(row.legal_name),
      ...(row.nickname ? { nickname: String(row.nickname) } : {}),
      ...(row.website ? { website: String(row.website) } : {}),
      domains: parseJson<string[]>(row.domains, []),
      products: parseJson<string[]>(row.products, []),
      active: Boolean(row.active),
      contacts: parseJson(row.contacts, []),
      routes: parseJson(row.routes, []),
      criteriaVersion: Number(row.criteria_version),
      profileVersion: Number(row.profile_version),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    }))
  } catch {
    return []
  }
}

async function loadFunder(actor: DealActor, id: string): Promise<FunderRecord | undefined> {
  try {
    return await resolved(getFunder(actor, id))
  } catch {
    return (await loadFunders(actor)).find((funder) => funder.id === id)
  }
}

async function loadCriteria(actor: DealActor, funder: FunderRecord): Promise<EligibilityRule[]> {
  try {
    const listed = await resolved(listFunderCriteria(actor, funder.id))
    if (listed && Array.isArray(listed.rules)) return listed.rules
  } catch { /* criteria repository still expects synchronous SQLite exec */ }
  try {
    const rows = await getDatabase().prepare<{
      id: string; funder_id: string; field: string; operator: string; unit: string
      value_json: string | null; source_text: string | null; unspecified: number | boolean
    }>(`SELECT * FROM mca_funder_criteria WHERE workspace_id = ? AND funder_id = ? ORDER BY position ASC`).all(actor.workspaceId, funder.id)
    return rows.map((row) => {
      const unspecified = Boolean(row.unspecified)
      return {
        id: String(row.id),
        funderId: String(row.funder_id),
        field: String(row.field),
        operator: row.operator as EligibilityRule["operator"],
        unit: row.unit as EligibilityRule["unit"],
        value: unspecified ? null : parseJson<EligibilityRule["value"]>(row.value_json, null),
        ...(row.source_text ? { sourceText: String(row.source_text) } : {}),
        unspecified,
      }
    })
  } catch {
    return []
  }
}

async function loadAggregate(actor: DealActor, dealId: string): Promise<UnderwritingAggregate | null> {
  try {
    const value = await resolved(getUnderwritingAggregate(actor, dealId))
    if (value && typeof value === "object" && "version" in value) return value
  } catch { /* statement repository still expects synchronous SQLite exec */ }
  try {
    const row = await getDatabase().prepare<{
      deal_id: string; version: number; monthly_revenue: string; average_daily_balance: string
      nsf_count: string; negative_days: string; deposit_count: string; worst_month_nsf: string; warnings_json: string
      position_count: number; stale: number | boolean; computed_at: string
    }>(`SELECT * FROM mca_underwriting_aggregates WHERE workspace_id = ? AND deal_id = ?`).get(actor.workspaceId, dealId)
    if (!row) return null
    const metric = (raw: string): MetricEvidence => parseJson<MetricEvidence>(raw, { value: null, unknown: true, confidence: 0 })
    return {
      dealId: String(row.deal_id),
      version: Number(row.version),
      monthlyRevenue: metric(row.monthly_revenue),
      averageDailyBalance: metric(row.average_daily_balance),
      nsfCount: metric(row.nsf_count),
      negativeDays: metric(row.negative_days),
      depositCount: metric(row.deposit_count ?? '{"value":null,"unknown":true,"confidence":0}'),
      worstMonthNsf: metric(row.worst_month_nsf ?? '{"value":null,"unknown":true,"confidence":0}'),
      warnings: parseJson<string[]>(row.warnings_json ?? "[]", []),
      positionCount: Number(row.position_count),
      stale: Boolean(row.stale),
      computedAt: String(row.computed_at),
    }
  } catch {
    return null
  }
}

async function loadMonths(actor: DealActor, dealId: string): Promise<StatementMonthRecord[]> {
  try {
    const rows = await resolved(listStatementMonths(actor, dealId))
    if (Array.isArray(rows)) return rows
  } catch { /* ignore */ }
  return []
}

async function loadPositions(actor: DealActor, dealId: string): Promise<ExistingPositionCandidate[]> {
  try {
    const rows = await resolved(listExistingPositions(actor, dealId))
    if (Array.isArray(rows)) return rows
  } catch { /* ignore */ }
  return []
}

async function loadCompletenessVersion(actor: DealActor, dealId: string): Promise<number> {
  try {
    const result = await resolved(getCompleteness(actor, dealId) as CompletenessResult | null | Promise<CompletenessResult | null>)
    if (result && typeof result.version === "number") return result.version
  } catch { /* ignore */ }
  try {
    const row = await getDatabase().prepare<{ version: number }>(
      `SELECT version FROM mca_completeness_results WHERE workspace_id = ? AND deal_id = ? ORDER BY version DESC LIMIT 1`,
    ).get(actor.workspaceId, dealId)
    return row ? Number(row.version) : 0
  } catch {
    return 0
  }
}

export function resolveDefaultFlag(
  positions: Array<Pick<ExistingPositionCandidate, "status" | "label">>,
  latestDataMerchCheck?: DefaultFlagDataMerchCheck | null,
): boolean {
  for (const position of positions) {
    if (position.status === "confirmed" && DEFAULT_FLAG_PATTERN.test(position.label)) return true
  }
  if (!latestDataMerchCheck || latestDataMerchCheck.status !== "records") return false
  for (const merchant of latestDataMerchCheck.merchants ?? []) {
    for (const record of merchant?.records ?? []) {
      if (typeof record?.category === "string" && DEFAULT_FLAG_PATTERN.test(record.category)) return true
    }
  }
  return false
}

async function loadLatestDataMerchCheck(workspaceId: string, dealId: string): Promise<DefaultFlagDataMerchCheck | null> {
  try {
    const checks = await listChecks(workspaceId, dealId)
    return checks[0] ?? null
  } catch {
    return null
  }
}

export function buildScoringInputs(
  deal: DealRecord,
  aggregate: UnderwritingAggregate | null,
  months: StatementMonthRecord[],
  positions: ExistingPositionCandidate[],
  latestDataMerchCheck?: DefaultFlagDataMerchCheck | null,
): ScoringInputs {
  const asOf = aggregate?.computedAt ?? deal.updatedAt
  const revenue = metricNumber(aggregate?.monthlyRevenue)
  const adb = metricNumber(aggregate?.averageDailyBalance)
  const nsf = metricNumber(aggregate?.nsfCount)
  const negative = metricNumber(aggregate?.negativeDays)
  const deposit = metricNumber(aggregate?.depositCount)
  const worstMonthNsf = metricNumber(aggregate?.worstMonthNsf)
  const payments = positions
    .filter((position) => position.status !== "dismissed")
    .reduce((sum, position) => sum + (typeof position.estimatedPayment === "number" && Number.isFinite(position.estimatedPayment) ? position.estimatedPayment : 0), 0)
  const availableUnknown = revenue.unknown || positions.some((position) => position.status !== "dismissed" && (position.estimatedPayment == null || !Number.isFinite(position.estimatedPayment)))
  const periods = [...months].map((month) => month.period).filter((period) => /^\d{4}-(0[1-9]|1[0-2])$/.test(period)).sort()
  const latestPeriod = periods[periods.length - 1]
  return {
    dealId: deal.id,
    dealVersion: deal.version,
    ...(deal.address?.state ? { state: deal.address.state } : {}),
    ...(deal.entityType ? { entity: deal.entityType } : {}),
    ...(deal.industry ? { industry: deal.industry } : {}),
    ...(deal.naicsCode ? { naics: deal.naicsCode } : {}),
    defaultFlag: resolveDefaultFlag(positions, latestDataMerchCheck),
    ...(deal.startDate ? { tibMonths: monthsBetween(deal.startDate, asOf) } : {}),
    ...(deal.ficoScore != null ? { fico: deal.ficoScore } : {}),
    ...(deal.requestedAmount != null ? { requestedAmount: deal.requestedAmount } : {}),
    ...(deal.requestedTermMonths != null ? { termMonths: deal.requestedTermMonths } : {}),
    ...(revenue.value != null ? { monthlyRevenue: revenue.value } : {}),
    revenueUnknown: !aggregate || revenue.unknown,
    ...(adb.value != null ? { averageDailyBalance: adb.value } : {}),
    adbUnknown: !aggregate || adb.unknown,
    ...(nsf.value != null ? { nsfCount: nsf.value } : {}),
    nsfUnknown: !aggregate || nsf.unknown,
    ...(negative.value != null ? { negativeDays: negative.value } : {}),
    negativeUnknown: !aggregate || negative.unknown,
    ...(deposit.value != null ? { depositCount: deposit.value } : {}),
    depositUnknown: !aggregate || deposit.unknown,
    ...(worstMonthNsf.value != null ? { worstMonthNsf: worstMonthNsf.value } : {}),
    positionCount: aggregate?.positionCount ?? positions.filter((position) => position.status === "confirmed").length,
    proposedPositionCount: positions.filter((position) => position.status === "proposed").length,
    ...(revenue.value != null ? { availableMonthlyRevenue: Math.max(0, revenue.value - payments) } : {}),
    availableUnknown: !aggregate || availableUnknown,
    ...(latestPeriod || aggregate?.computedAt ? { dataAge: latestPeriod ?? aggregate?.computedAt } : {}),
  }
}

function funderSummaries(funders: FunderRecord[]): DealScores["funders"] {
  return funders.map((funder) => ({
    id: funder.id,
    legalName: funder.legalName,
    ...(funder.nickname ? { nickname: funder.nickname } : {}),
    active: funder.active,
  }))
}

async function currentVersions(actor: DealActor, deal: DealRecord, funders: FunderRecord[], aggregate: UnderwritingAggregate | null) {
  const completenessVersion = await loadCompletenessVersion(actor, deal.id)
  const criteriaVersions = Object.fromEntries(funders.map((funder) => [funder.id, funder.criteriaVersion]))
  return {
    policyVersion: POLICY_VERSION,
    underwritingVersion: aggregate?.version ?? 0,
    completenessVersion,
    dealVersion: deal.version,
    criteriaVersions,
    aggregateComputedAt: aggregate?.computedAt ?? "",
  }
}

export async function getDealScores(actor: DealActor, dealId: string): Promise<DealScores> {
  const deal = await getDealForDocument(actor, dealId)
  await getDeal(actor, dealId)
  const funders = await loadFunders(actor)
  const aggregate = await loadAggregate(actor, deal.id)
  const snapshot = await findLatestScoreSnapshot(actor.workspaceId, deal.id)
  const versions = await currentVersions(actor, deal, funders, aggregate)
  const reasons = staleReasonsFor(snapshot, versions)
  const stale = Boolean(snapshot) && reasons.length > 0
  const scores = snapshot && !stale ? snapshot.scores : snapshot?.scores ?? []
  return {
    snapshot: snapshot ? toAnalysisSnapshot(snapshot) : null,
    stale,
    staleReasons: reasons,
    disclaimer: SCORE_FIT_DISCLAIMER,
    autoSelectableFunderIds: stale ? [] : autoSelectableFunderIds(scores),
    funders: funderSummaries(funders),
  }
}

export async function scoreDeal(actor: DealActor, dealId: string, options?: { mode?: StoredScoreSnapshot["mode"]; topN?: number }): Promise<ScoreDealResult> {
  const deal = await getDealForDocument(actor, dealId)
  await getDeal(actor, dealId)
  const funders = await loadFunders(actor)
  const aggregate = await loadAggregate(actor, deal.id)
  const months = await loadMonths(actor, deal.id)
  const positions = await loadPositions(actor, deal.id)
  const latestDataMerchCheck = await loadLatestDataMerchCheck(actor.workspaceId, deal.id)
  const inputs = buildScoringInputs(deal, aggregate, months, positions, latestDataMerchCheck)
  const versions = await currentVersions(actor, deal, funders, aggregate)
  const previous = await findLatestScoreSnapshot(actor.workspaceId, deal.id)
  const reasons = staleReasonsFor(previous, versions)

  const evaluated: FunderScore[] = []
  for (const funder of funders) {
    const record = await loadFunder(actor, funder.id) ?? funder
    const rules = await loadCriteria(actor, record)
    evaluated.push(await evaluateFunderScore(actor, inputs, record, rules))
  }
  const scores = rankScores(evaluated)
  const next: StoredScoreSnapshot = {
    id: newId(),
    workspaceId: actor.workspaceId,
    dealId: deal.id,
    policyVersion: versions.policyVersion,
    underwritingVersion: versions.underwritingVersion,
    completenessVersion: versions.completenessVersion,
    dealVersion: versions.dealVersion,
    criteriaVersions: versions.criteriaVersions,
    mode: options?.mode ?? "analyze_only",
    topN: options?.topN ?? DEFAULT_TOP_N,
    scores,
    stale: false,
    aggregateComputedAt: versions.aggregateComputedAt,
    createdAt: nowIso(),
  }

  if (previous && reasons.length === 0 && snapshotFingerprint(previous) === snapshotFingerprint(next)) {
    return {
      snapshot: toAnalysisSnapshot(previous),
      stale: false,
      staleReasons: [],
      disclaimer: SCORE_FIT_DISCLAIMER,
      autoSelectableFunderIds: autoSelectableFunderIds(previous.scores),
      funders: funderSummaries(funders),
    }
  }

  const saved = await insertScoreSnapshot(next)
  await recordAuditEvent({
    context: actor,
    action: "underwriting.scored",
    resourceType: "deal",
    resourceId: deal.id,
    metadata: {
      snapshotId: saved.id,
      policyVersion: saved.policyVersion,
      underwritingVersion: saved.underwritingVersion,
      funderCount: scores.length,
      eligibleCount: autoSelectableFunderIds(scores).length,
    },
    correlationId: actor.correlationId,
  })
  return {
    snapshot: toAnalysisSnapshot(saved),
    stale: false,
    staleReasons: [],
    disclaimer: SCORE_FIT_DISCLAIMER,
    autoSelectableFunderIds: autoSelectableFunderIds(saved.scores),
    funders: funderSummaries(funders),
  }
}
