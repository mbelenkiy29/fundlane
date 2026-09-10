import type { DealListItem, DealStatus } from "./schema"

export function inclusiveUtcDateBounds(from?: string, to?: string): { from?: string; toExclusive?: string } {
  const result: { from?: string; toExclusive?: string } = {}
  if (from) result.from = `${from}T00:00:00.000Z`
  if (to) {
    const exclusive = new Date(`${to}T00:00:00.000Z`)
    exclusive.setUTCDate(exclusive.getUTCDate() + 1)
    result.toExclusive = exclusive.toISOString()
  }
  return result
}

export function reconcilePipelineCounts(deals: readonly Pick<DealListItem, "status">[]): Partial<Record<DealStatus, number>> {
  const counts: Partial<Record<DealStatus, number>> = {}
  deals.forEach((deal) => { counts[deal.status] = (counts[deal.status] ?? 0) + 1 })
  return counts
}
