import "server-only"
import { z } from "zod"
import { getDeal, listDeals } from "../deals/service"
import { DEAL_STATUSES, type DealDetail, type DealListItem } from "../deals/schema"
import { getDealScores } from "../underwriting/scoring"
import { rememberDeals, ownedThread } from "./store"
import type { AssistantContext } from "./chatkit-context"

const filters = z.object({ search: z.string().max(200).optional(), statuses: z.array(z.enum(DEAL_STATUSES)).max(20).optional() }).strict()
export const toolRequest = z.discriminatedUnion("name", [
  z.object({ name: z.literal("search_deals"), threadId: z.string().min(1).max(128), args: filters }),
  z.object({ name: z.literal("summarize_pipeline"), threadId: z.string().min(1).max(128), args: filters }),
  z.object({ name: z.literal("get_deal"), threadId: z.string().min(1).max(128), args: z.object({ dealId: z.string().min(1).max(128) }).strict() }),
  z.object({ name: z.literal("get_underwriting"), threadId: z.string().min(1).max(128), args: z.object({ dealId: z.string().min(1).max(128) }).strict() }),
])
export function safeDeal(deal: DealListItem | DealDetail, financials: boolean) {
  return { id: deal.id, displayId: deal.displayId, legalName: deal.legalName?.slice(0, 200), status: deal.status,
    updatedAt: deal.updatedAt, sourceUrl: `/deals?deal=${encodeURIComponent(deal.id)}`,
    ...(financials ? { requestedAmount: deal.requestedAmount, monthlyRevenue: deal.monthlyRevenue } : {}) }
}
export async function runTool(c: AssistantContext, input: z.infer<typeof toolRequest>) {
  await ownedThread(c, input.threadId)
  const retrievedAt = new Date().toISOString()
  if (input.name === "search_deals" || input.name === "summarize_pipeline") {
    const result = await listDeals(c.actor, input.args)
    const referenced = input.name === "search_deals" ? result.deals.slice(0, 20) : result.deals
    await rememberDeals(c, input.threadId, result.deals.map(deal => deal.id))
    if (input.name === "search_deals") return { retrievedAt, total: result.total, truncated: result.total > 20, deals: referenced.map(deal => safeDeal(deal, c.financials)) }
    const counts = Object.fromEntries(DEAL_STATUSES.map(status => [status, result.deals.filter(deal => deal.status === status).length]))
    return { retrievedAt, sourceUrl: "/deals", total: result.total, counts,
      ...(c.financials ? { requestedAmountTotal: result.deals.reduce((sum, deal) => sum + (deal.requestedAmount ?? 0), 0) } : {}) }
  }
  const deal = await getDeal(c.actor, input.args.dealId)
  await rememberDeals(c, input.threadId, [deal.id])
  if (input.name === "get_deal") return { retrievedAt, deal: safeDeal(deal, c.financials) }
  const result = await getDealScores(c.actor, deal.id)
  return { retrievedAt, deal: safeDeal(deal, c.financials), status: result.snapshot ? (result.stale ? "stale" : "available") : "not_analyzed",
    disclaimer: result.disclaimer, snapshotId: result.snapshot?.id, analyzedAt: result.snapshot?.createdAt,
    staleReasons: result.staleReasons.slice(0, 10), scores: result.snapshot?.scores.slice(0, 10).map(score => ({
      funderId: score.funderId, funderName: result.funders.find(funder => funder.id === score.funderId)?.legalName?.slice(0, 200),
      rank: score.rank, score: score.score, grade: score.grade, eligible: score.eligible,
      // Detailed rules can include financial values; do not expose them to restricted users.
      reasons: score.reasons.slice(0, 15).map(reason => ({ ruleId: reason.ruleId, result: reason.result, ...(c.financials ? { detail: reason.detail.slice(0, 500) } : {}) })),
    })) ?? [] }
}
