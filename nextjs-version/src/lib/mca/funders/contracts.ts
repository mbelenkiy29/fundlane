import type { DealActor } from "../deals/schema"

export type FunderActor = DealActor

export const FUNDER_ROUTE_KINDS = ["email", "api", "manual_portal", "custom_webhook"] as const
export type FunderRouteKind = (typeof FUNDER_ROUTE_KINDS)[number]

export const CRITERIA_OPERATORS = ["min", "max", "eq", "in", "not_in"] as const
export type CriteriaOperator = (typeof CRITERIA_OPERATORS)[number]

export const CRITERIA_UNITS = [
  "usd_monthly",
  "usd_annual",
  "usd",
  "count",
  "days",
  "months",
  "years",
  "fico",
  "percent",
  "naics",
  "state",
  "entity",
  "boolean",
  "unspecified",
] as const
export type CriteriaUnit = (typeof CRITERIA_UNITS)[number]

export interface FunderContact {
  id: string
  name?: string
  email?: string
  phone?: string
  role?: string
}

export interface FunderRoute {
  id: string
  kind: FunderRouteKind
  label: string
  destination: string
  documentExceptions: string[]
  active: boolean
}

export interface FunderRecord {
  id: string
  workspaceId: string
  legalName: string
  nickname?: string
  website?: string
  domains: string[]
  products: string[]
  active: boolean
  contacts: FunderContact[]
  routes: FunderRoute[]
  criteriaVersion: number
  profileVersion: number
  createdAt: string
  updatedAt: string
}

export interface FunderGroup {
  id: string
  workspaceId: string
  name: string
  funderIds: string[]
  createdAt: string
  updatedAt: string
}

export interface EligibilityRule {
  id: string
  funderId: string
  field: string
  operator: CriteriaOperator
  unit: CriteriaUnit
  value: string | number | string[] | boolean | null
  sourceText?: string
  unspecified: boolean
}

export interface IndustryAlias {
  id: string
  workspaceId: string
  alias: string
  naics?: string
  normalizedIndustry: string
}

export interface CriteriaScanProposal {
  id: string
  funderId: string
  documentId: string
  version: number
  rules: EligibilityRule[]
  warnings: string[]
  evidence: Record<string, { confidence: number; page?: number; text?: string; unknown?: boolean }>
  provider: string
  requestId?: string
  status: "proposed" | "accepted" | "rejected"
}
