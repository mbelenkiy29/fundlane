import "server-only"
import type { DealActor } from "../deals/schema"
import { includedMonths, resolveUnderwritingWindow } from "./aggregates"
import { estimateDeal, type DealEstimatesResponse, type EstimateAssumptions } from "./estimates"
import { getLenderFit } from "./lender-fit"
import { getDealStatementUnderwriting } from "./statements"

export function dealEstimatesEnabled(): boolean {
  return process.env.MCA_DEAL_ESTIMATES_ENABLED === "true"
}

/** Read only. Lender fit enforces deal access; estimates cover matched lenders only and are never stored. */
export async function getDealEstimates(actor: DealActor, dealId: string, assumptions: EstimateAssumptions): Promise<DealEstimatesResponse> {
  const fit = await getLenderFit(actor, dealId)
  const { months, positions } = await getDealStatementUnderwriting(actor, dealId)
  const window = await resolveUnderwritingWindow(actor.workspaceId)
  return estimateDeal({
    asOf: fit.asOf,
    months: includedMonths(months, window).map((month) => ({ period: month.period, deposits: month.deposits.unknown ? null : month.deposits.value, warnings: month.warnings })),
    positions: positions.filter((position) => position.status !== "dismissed"),
    lenders: fit.lenders.filter((lender) => lender.status === "matched").map((lender) => ({ funderId: lender.funderId, name: lender.name, rules: lender.criteria.rules })),
    assumptions,
  })
}
