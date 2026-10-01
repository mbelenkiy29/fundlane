import type { EligibilityRule, FunderRecord } from "../funders/contracts"
import { criteriaReadiness } from "../funders/criteria-readiness"
import type { FunderScore } from "./contracts"
import type { LenderFitResponse, LenderFitStatus } from "./lender-fit-contracts"
import { SCORE_FIT_DISCLAIMER } from "./policy"

export function projectLenderFit(input: {
  asOf: string
  funders: FunderRecord[]
  criteria: Record<string, EligibilityRule[]>
  scores: FunderScore[]
  snapshotId: string | null
  scoredAt: string | null
  stale: boolean
  staleReasons: string[]
  policyVersion: number
  underwritingVersion: number
}): LenderFitResponse {
  const lenders = input.funders.map((funder) => {
    const score = input.scores.find((item) => item.funderId === funder.id)
    const rules = input.criteria[funder.id] ?? []
    const readiness = criteriaReadiness(rules, input.asOf)
    let status: LenderFitStatus
    if (!funder.active) status = "inactive"
    else if (readiness.status === "stale_criteria") status = "stale_criteria"
    else if (!input.snapshotId || !score) status = "unscored"
    else if (input.stale || !score.fitStatus) status = "needs_review"
    else if (score.fitStatus === "inactive") status = "needs_review"
    else if (score.fitStatus === "excluded") status = "excluded"
    else if (readiness.status === "needs_review") status = "needs_review"
    else status = score.fitStatus
    const reasons = [...(score?.reasons ?? [])]
    for (const detail of readiness.reasons) reasons.push({ ruleId: "criteria.readiness", result: "unknown", detail })
    if (!funder.active) reasons.push({ ruleId: "funder.active", result: "fail", detail: "Lender is inactive; broker selection is unavailable." })
    if (input.stale) reasons.push({ ruleId: "snapshot.stale", result: "unknown", detail: `Snapshot needs recomputation: ${input.staleReasons.join("; ")}.` })
    if (score && !score.fitStatus) reasons.push({ ruleId: "snapshot.legacy", result: "unknown", detail: "Legacy scoring snapshot needs recomputation with current policy." })
    const current = !input.stale && status === "matched"
    return {
      funderId: funder.id, name: funder.nickname || funder.legalName, active: funder.active,
      criteriaVersion: funder.criteriaVersion, status,
      score: current ? score?.score ?? null : null, rank: current ? score?.rank ?? null : null,
      reasons, criteria: { rules }, missingData: [...readiness.missingData, ...(score?.reasons.filter((reason) => reason.result === "unknown").map((reason) => reason.ruleId) ?? [])],
    }
  }).sort((left, right) => (left.rank ?? Number.MAX_SAFE_INTEGER) - (right.rank ?? Number.MAX_SAFE_INTEGER) || left.funderId.localeCompare(right.funderId))
  return {
    contractVersion: 1, brokerSelectionRequired: true, asOf: input.asOf, snapshotId: input.snapshotId,
    scoredAt: input.scoredAt, policyVersion: input.policyVersion, underwritingVersion: input.underwritingVersion,
    stale: input.stale, staleReasons: input.staleReasons, disclaimer: SCORE_FIT_DISCLAIMER, lenders,
  }
}
