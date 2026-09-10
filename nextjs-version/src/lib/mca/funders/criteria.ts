import "server-only"

import { AppError } from "../errors"
import { newId, nowIso, recordAuditEvent, withImmediateTransaction } from "../db"
import { canManageWorkspace } from "../policy"
import type { DealActor } from "../deals/schema"
import {
  CRITERIA_OPERATORS,
  CRITERIA_UNITS,
  type CriteriaOperator,
  type CriteriaUnit,
  type EligibilityRule,
  type IndustryAlias,
} from "./contracts"
import { getFunder } from "./directory"
import { findFunderByIdForUpdate, toFunderRecord } from "./directory-repository"
import {
  deleteAliasRecord,
  findAliasById,
  findAliasByName,
  findAliasByNaics,
  insertAliasRecord,
  listAliasRecords,
  listCriteriaRules,
  replaceCriteriaRules,
  updateAliasRecord,
} from "./criteria-repository"

export const CRITERIA_FIELDS = [
  "revenue",
  "fico",
  "time_in_business",
  "positions",
  "requested_amount",
  "term",
  "average_daily_balance",
  "deposit_count",
  "nsf",
  "negative_days",
  "default_status",
  "entity",
  "state",
  "industry",
] as const
export type CriteriaField = (typeof CRITERIA_FIELDS)[number]

const REVENUE_ANNUAL = new Set(["usd_annual", "yearly", "annual"])
const REVENUE_MONTHLY = new Set(["usd_monthly", "monthly"])

export interface RevenueThresholdInput {
  value: number
  from: string
  to: string
}

export interface EligibilityRuleInput {
  id?: string
  field: string
  operator: string
  unit: string
  value?: string | number | string[] | boolean | null
  sourceText?: string
  unspecified?: boolean
}

export interface IndustryAliasInput {
  id?: string
  alias: string
  naics?: string | null
  normalizedIndustry: string
}

export interface FunderCriteria {
  funderId: string
  criteriaVersion: number
  publishedAt: string | null
  rules: EligibilityRule[]
}

export interface IndustryResolution {
  input: string
  normalizedIndustry: string
  naics?: string
  alias?: IndustryAlias
}

function assertManage(actor: DealActor): void {
  if (!actor.role || !canManageWorkspace(actor.role)) {
    throw new AppError(403, "permission_denied", "You do not have permission to perform this action.")
  }
}

function invalid(field: string, message: string): never {
  throw new AppError(422, "validation_failed", "Review the highlighted fields.", { [field]: [message] })
}

function conflict(message: string, field = "rules"): never {
  throw new AppError(422, "criteria_conflict", "These rules contradict each other and cannot be published.", { [field]: [message] })
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : ""
}

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Error && ((error as Error & { code?: string }).code === "23505" || /unique/i.test(error.message))
}

export function convertRevenueThreshold(input: RevenueThresholdInput): number {
  if (typeof input?.value !== "number" || !Number.isFinite(input.value)) {
    invalid("value", "Enter a numeric revenue threshold.")
  }
  const from = canonicalizeRevenueUnit(input.from)
  const to = canonicalizeRevenueUnit(input.to)
  if (!from || !to) invalid("unit", "Revenue conversion requires a yearly or monthly unit.")
  if (from === to) return input.value
  if (from === "usd_annual" && to === "usd_monthly") return input.value / 12
  return input.value * 12
}

function canonicalizeRevenueUnit(unit: string): "usd_annual" | "usd_monthly" | undefined {
  const normalized = text(unit).toLowerCase()
  if (REVENUE_ANNUAL.has(normalized)) return "usd_annual"
  if (REVENUE_MONTHLY.has(normalized)) return "usd_monthly"
  return undefined
}

function monthlyRevenueValue(rule: EligibilityRule): number | undefined {
  if (rule.field !== "revenue" || rule.unspecified || typeof rule.value !== "number" || !Number.isFinite(rule.value)) return undefined
  const unit = canonicalizeRevenueUnit(rule.unit)
  if (!unit) return undefined
  return convertRevenueThreshold({ value: rule.value, from: unit, to: "usd_monthly" })
}

function numericValue(rule: EligibilityRule): number | undefined {
  if (rule.unspecified || typeof rule.value !== "number" || !Number.isFinite(rule.value)) return undefined
  return rule.value
}

function assertNoConflicts(rules: EligibilityRule[]): void {
  const grouped = new Map<string, { mins: number[]; maxes: number[] }>()
  const revenueMins: number[] = []
  const revenueMaxes: number[] = []
  for (const [index, rule] of rules.entries()) {
    if (rule.unspecified || (rule.operator !== "min" && rule.operator !== "max")) continue
    const amount = numericValue(rule)
    if (amount === undefined) continue
    const key = `${rule.field}::${rule.unit}`
    const bucket = grouped.get(key) ?? { mins: [], maxes: [] }
    if (rule.operator === "min") bucket.mins.push(amount)
    else bucket.maxes.push(amount)
    grouped.set(key, bucket)
    const monthly = monthlyRevenueValue(rule)
    if (monthly === undefined) continue
    if (rule.operator === "min") revenueMins.push(monthly)
    else revenueMaxes.push(monthly)
    if (revenueMins.length && revenueMaxes.length && Math.max(...revenueMins) > Math.min(...revenueMaxes)) {
      conflict("Yearly and monthly revenue limits contradict each other after conversion.", `rules.${index}`)
    }
  }
  for (const [key, bucket] of grouped) {
    if (!bucket.mins.length || !bucket.maxes.length) continue
    if (Math.max(...bucket.mins) > Math.min(...bucket.maxes)) {
      conflict(`Minimum cannot exceed maximum for ${key.replace("::", " ")}.`)
    }
  }
}

function normalizeValue(input: EligibilityRuleInput, index: number, operator: CriteriaOperator, unspecified: boolean): EligibilityRule["value"] {
  if (unspecified) return null
  const field = `rules.${index}.value`
  if (operator === "min" || operator === "max") {
    if (typeof input.value !== "number" || !Number.isFinite(input.value)) invalid(field, "Enter a numeric threshold.")
    return input.value
  }
  if (operator === "in" || operator === "not_in") {
    if (!Array.isArray(input.value) || input.value.length === 0) invalid(field, "Provide at least one value.")
    const items = input.value.map((entry, itemIndex) => {
      const next = text(entry)
      if (!next) invalid(`${field}.${itemIndex}`, "Each list value must be present.")
      return next
    })
    return [...new Set(items)]
  }
  if (typeof input.value === "boolean") return input.value
  if (typeof input.value === "number" && Number.isFinite(input.value)) return input.value
  const next = text(input.value)
  if (!next) invalid(field, "Enter a value for this rule.")
  if (next === "true" || next === "false") return next === "true"
  const numeric = Number(next)
  return Number.isFinite(numeric) && next.trim() !== "" && !/^0+\d/.test(next) && next === String(numeric) ? numeric : next
}

function normalizeRule(input: EligibilityRuleInput, index: number, funderId: string): EligibilityRule {
  const prefix = `rules.${index}`
  const field = text(input.field)
  if (!CRITERIA_FIELDS.includes(field as CriteriaField)) invalid(`${prefix}.field`, "Choose a supported eligibility field.")
  const operator = text(input.operator)
  if (!CRITERIA_OPERATORS.includes(operator as CriteriaOperator)) invalid(`${prefix}.operator`, "Choose min, max, equals, in, or not in.")
  const unit = text(input.unit)
  if (!CRITERIA_UNITS.includes(unit as CriteriaUnit)) invalid(`${prefix}.unit`, "Choose a supported unit.")
  const unspecified = input.unspecified === true
  const sourceText = text(input.sourceText) || undefined
  if (sourceText && sourceText.length > 500) invalid(`${prefix}.sourceText`, "Use at most 500 characters.")
  return {
    id: text(input.id) || newId(),
    funderId,
    field,
    operator: operator as CriteriaOperator,
    unit: unspecified && !unit ? "unspecified" : unit as CriteriaUnit,
    value: normalizeValue(input, index, operator as CriteriaOperator, unspecified),
    sourceText,
    unspecified,
  }
}

function fingerprint(rules: EligibilityRule[]): string {
  return JSON.stringify([...rules].map((rule) => ({
    field: rule.field,
    operator: rule.operator,
    unit: rule.unit,
    value: rule.value,
    unspecified: rule.unspecified,
    sourceText: rule.sourceText ?? "",
  })).sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right))))
}

export async function listFunderCriteria(actor: DealActor, funderId: string): Promise<FunderCriteria> {
  const funder = await getFunder(actor, funderId)
  const stored = await listCriteriaRules(actor.workspaceId, funder.id)
  return {
    funderId: funder.id,
    criteriaVersion: funder.criteriaVersion,
    publishedAt: stored.publishedAt,
    rules: stored.rules,
  }
}

export async function publishFunderCriteria(actor: DealActor, funderId: string, rulesInput: EligibilityRuleInput[]): Promise<FunderCriteria> {
  assertManage(actor)
  if (!Array.isArray(rulesInput)) invalid("rules", "Provide a list of eligibility rules.")
  if (rulesInput.length > 200) invalid("rules", "Use at most 200 rules.")
  return withImmediateTransaction(async (database) => {
    const storedFunder = await findFunderByIdForUpdate(database, actor.workspaceId, funderId)
    if (!storedFunder) throw new AppError(404, "funder_not_found", "The requested funder was not found.")
    const funder = toFunderRecord(storedFunder)
    const rules = rulesInput.map((rule, index) => normalizeRule(rule, index, funder.id))
    assertNoConflicts(rules)
    const stored = await listCriteriaRules(actor.workspaceId, funder.id)
    const nextFingerprint = fingerprint(rules)
    const unchanged = stored.fingerprint === nextFingerprint
    const now = nowIso()
    const criteriaVersion = unchanged ? funder.criteriaVersion : funder.criteriaVersion + 1
    await replaceCriteriaRules({
      workspaceId: actor.workspaceId,
      funderId: funder.id,
      rules,
      fingerprint: nextFingerprint,
      publishedAt: unchanged ? stored.publishedAt ?? now : now,
      criteriaVersion,
      bumpVersion: !unchanged,
    })
    if (!unchanged) {
      await recordAuditEvent({
        context: actor,
        action: "funder.criteria_published",
        resourceType: "funder",
        resourceId: funder.id,
        metadata: { criteriaVersion, ruleCount: rules.length },
        correlationId: actor.correlationId,
      })
    }
    return {
      funderId: funder.id,
      criteriaVersion,
      publishedAt: unchanged ? stored.publishedAt ?? now : now,
      rules,
    }
  })
}

export async function listIndustryAliases(actor: DealActor): Promise<IndustryAlias[]> {
  return listAliasRecords(actor.workspaceId)
}

export async function getIndustryAlias(actor: DealActor, id: string): Promise<IndustryAlias> {
  const current = await findAliasById(actor.workspaceId, id)
  if (!current) throw new AppError(404, "alias_not_found", "The requested industry alias was not found.")
  return current
}

export async function upsertIndustryAlias(actor: DealActor, input: IndustryAliasInput): Promise<IndustryAlias> {
  assertManage(actor)
  const alias = text(input.alias)
  if (!alias) invalid("alias", "Enter an industry alias.")
  if (alias.length > 120) invalid("alias", "Use at most 120 characters.")
  const normalizedIndustry = text(input.normalizedIndustry)
  if (!normalizedIndustry) invalid("normalizedIndustry", "Enter the normalized industry name.")
  if (normalizedIndustry.length > 120) invalid("normalizedIndustry", "Use at most 120 characters.")
  const naics = input.naics === undefined ? undefined : text(input.naics) || undefined
  if (naics && !/^\d{2,6}$/.test(naics)) invalid("naics", "Enter a 2–6 digit NAICS code.")
  const now = nowIso()
  const existing = text(input.id) ? await findAliasById(actor.workspaceId, text(input.id)) : await findAliasByName(actor.workspaceId, alias)
  if (text(input.id) && !existing) throw new AppError(404, "alias_not_found", "The requested industry alias was not found.")
  try {
    const saved = existing
      ? await updateAliasRecord({
        id: existing.id,
        workspaceId: actor.workspaceId,
        alias,
        naics: input.naics === undefined ? existing.naics : naics,
        normalizedIndustry,
        updatedAt: now,
      })
      : await insertAliasRecord({
        id: newId(),
        workspaceId: actor.workspaceId,
        alias,
        naics,
        normalizedIndustry,
        createdAt: now,
        updatedAt: now,
      })
    await recordAuditEvent({
      context: actor,
      action: existing ? "funder.industry_alias_updated" : "funder.industry_alias_created",
      resourceType: "industry_alias",
      resourceId: saved.id,
      metadata: { alias: saved.alias, naics: saved.naics ?? null },
      correlationId: actor.correlationId,
    })
    return saved
  } catch (error) {
    if (isUniqueViolation(error)) throw new AppError(422, "alias_conflict", "An alias with that name already exists in this workspace.", { alias: ["Choose a different alias."] })
    throw error
  }
}

export async function deleteIndustryAlias(actor: DealActor, id: string): Promise<void> {
  assertManage(actor)
  const current = await findAliasById(actor.workspaceId, id)
  if (!current) throw new AppError(404, "alias_not_found", "The requested industry alias was not found.")
  await deleteAliasRecord(actor.workspaceId, id)
  await recordAuditEvent({
    context: actor,
    action: "funder.industry_alias_deleted",
    resourceType: "industry_alias",
    resourceId: id,
    metadata: { alias: current.alias },
    correlationId: actor.correlationId,
  })
}

export async function resolveIndustry(actor: DealActor, raw: string): Promise<IndustryResolution> {
  const input = text(raw)
  if (!input) return { input: "", normalizedIndustry: "" }
  const byAlias = await findAliasByName(actor.workspaceId, input)
  const byNaics = byAlias ?? (/^\d{2,6}$/.test(input) ? await findAliasByNaics(actor.workspaceId, input) : undefined)
  const match = byAlias ?? byNaics
  if (!match) return { input, normalizedIndustry: input }
  return { input, normalizedIndustry: match.normalizedIndustry, naics: match.naics, alias: match }
}
