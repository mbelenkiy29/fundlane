import type { DealActor } from "../deals/schema"

export type UnderwritingActor = DealActor

export const STATEMENT_ACCOUNT_KINDS = ["checking", "savings", "credit_card", "loan", "unsupported"] as const
export type StatementAccountKind = (typeof STATEMENT_ACCOUNT_KINDS)[number]

export interface MetricEvidence {
  value: number | null
  unknown: boolean
  page?: number
  text?: string
  confidence: number
}

export interface StatementMonthRecord {
  id: string
  dealId: string
  documentId: string
  accountKind: StatementAccountKind
  period: string
  accountSuffix?: string
  deposits: MetricEvidence
  depositCount: MetricEvidence
  averageDailyBalance: MetricEvidence
  nsfCount: MetricEvidence
  negativeDays: MetricEvidence
  nsfDates: string[]
  negativeDates: string[]
  endingBalance: MetricEvidence
  warnings: string[]
  duplicateOfId?: string
  extractionVersion: number
  corrected: boolean
  correctionReason?: string
  correctedByUserId?: string
  correctedAt?: string
}

export interface ExistingPositionCandidate {
  id: string
  dealId: string
  label: string
  estimatedPayment?: number
  evidence: string
  status: "proposed" | "confirmed" | "dismissed"
}

export interface UnderwritingAggregate {
  dealId: string
  version: number
  monthlyRevenue: MetricEvidence
  averageDailyBalance: MetricEvidence
  nsfCount: MetricEvidence
  negativeDays: MetricEvidence
  depositCount: MetricEvidence
  worstMonthNsf: MetricEvidence
  warnings: string[]
  positionCount: number
  stale: boolean
  computedAt: string
}

export interface CompletenessFinding {
  code: string
  message: string
  documentId?: string
  period?: string
}

export interface CompletenessResult {
  dealId: string
  ready: boolean
  version: number
  ruleSnapshot: string
  findings: CompletenessFinding[]
  checkedAt: string
}

export const ANALYSIS_MODES = ["analyze_only", "review_first", "automatic_send"] as const
export type AnalysisMode = (typeof ANALYSIS_MODES)[number]

export interface FunderScore {
  funderId: string
  rank: number
  score: number
  grade: "A" | "B" | "C" | "D" | "F" | "DQ"
  eligible: boolean
  reasons: Array<{ ruleId: string; result: "pass" | "fail" | "unknown"; detail: string }>
  dataAge?: string
}

export interface AnalysisSnapshot {
  id: string
  dealId: string
  policyVersion: number
  underwritingVersion: number
  completenessVersion: number
  mode: AnalysisMode
  topN: number
  scores: FunderScore[]
  createdAt: string
}

export interface AnalysisRun {
  id: string
  snapshotId: string
  mode: AnalysisMode
  state: "scored" | "review_pending" | "approved" | "blocked" | "queued" | "submission_unavailable"
  selectedFunderIds: string[]
  reason: string
}
