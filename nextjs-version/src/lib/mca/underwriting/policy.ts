import "server-only"

export const POLICY_VERSION = 2

export const SCORE_FIT_DISCLAIMER = "Scores describe funder fit, not approval odds."

export const HARD_DQ_FIELDS = [
  "state",
  "entity",
  "industry",
  "default_status",
  "nsf",
  "negative_days",
  "positions",
  "time_in_business",
  "fico",
  "revenue",
  "average_daily_balance",
  "requested_amount",
  "term",
  "deposit_count",
] as const

export type HardDqField = (typeof HARD_DQ_FIELDS)[number]

/** Grades eligible for auto-select (C+). D and F never auto-select. */
export const AUTO_SELECT_GRADES = ["A", "B", "C"] as const

export type AutoSelectGrade = (typeof AUTO_SELECT_GRADES)[number]

export const SOFT_WEIGHT_REVENUE_FIT = 30
export const SOFT_WEIGHT_ADB = 15
export const SOFT_WEIGHT_NSF = 15
export const SOFT_WEIGHT_POSITIONS = 10
export const SOFT_WEIGHT_REQUESTED_AMOUNT = 15
export const SOFT_WEIGHT_FICO = 15

export const GRADE_A_MIN = 90
export const GRADE_B_MIN = 80
export const GRADE_C_MIN = 70
export const GRADE_D_MIN = 60

export const REVENUE_FIT_MULTIPLIER = 2
export const SOFT_FICO_SPAN = 150
export const DEFAULT_REVENUE_SCALE = 20_000
export const DEFAULT_ADB_SCALE = 10_000
export const DEFAULT_NSF_SCALE = 8
export const DEFAULT_POSITION_SCALE = 4
export const DEFAULT_FICO_FLOOR = 500
export const DEFAULT_TOP_N = 5
