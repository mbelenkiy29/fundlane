const STAGES = ["created", "submitted", "approved", "funded"] as const

export function isTeamProfitReportEmpty(report: {
  company: { stages: Record<(typeof STAGES)[number], { dealCount: number }>; distributions: { count?: number } }
  evidence: { length: number }
  otherOperatingCosts: { knownCents?: number; unknownCount?: number }
}): boolean {
  const noDeals = STAGES.every((stage) => report.company.stages[stage].dealCount === 0)
  const noEvidence = report.evidence.length === 0
  const noDistributions = (report.company.distributions.count ?? 0) === 0
  const noOperatingCosts =
    (report.otherOperatingCosts.knownCents ?? 0) === 0 &&
    (report.otherOperatingCosts.unknownCount ?? 0) === 0
  return noDeals && noEvidence && noDistributions && noOperatingCosts
}
