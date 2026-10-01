import type { EligibilityRule } from "../funders/contracts"
import type { FunderScore } from "./contracts"

export type LenderFitStatus = NonNullable<FunderScore["fitStatus"]> | "unscored"
export interface LenderFitResponse {
  contractVersion: 1
  brokerSelectionRequired: true
  asOf: string
  snapshotId: string | null
  scoredAt: string | null
  policyVersion: number
  underwritingVersion: number
  stale: boolean
  staleReasons: string[]
  disclaimer: string
  lenders: Array<{
    funderId: string
    name: string
    active: boolean
    criteriaVersion: number
    status: LenderFitStatus
    score: number | null
    rank: number | null
    reasons: FunderScore["reasons"]
    criteria: { rules: EligibilityRule[] }
    missingData: string[]
  }>
}
