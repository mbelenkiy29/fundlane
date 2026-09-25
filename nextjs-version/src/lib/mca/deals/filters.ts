import { DEAL_STATUSES, type DealFilters, type DealListItem, type DealStatus } from "./schema"

export const DEAL_LIST_DATE_RE = /^\d{4}-\d{2}-\d{2}$/

export type DealListFilterFailure = {
  ok: false
  field: "status" | "from" | "to"
  message: string
}

export type DealListFilterParse = { ok: true; filters: DealFilters } | DealListFilterFailure

function readDate(value: string | null, field: "from" | "to"): string | undefined | DealListFilterFailure {
  const trimmed = value?.trim() || undefined
  if (!trimmed) return undefined
  if (!DEAL_LIST_DATE_RE.test(trimmed)) {
    return { ok: false, field, message: `${field} must use YYYY-MM-DD.` }
  }
  return trimmed
}

export function parseDealListFilters(
  search: Pick<URLSearchParams, "get" | "getAll">,
  mode: "reject" | "omit" = "omit",
): DealListFilterParse {
  const statuses = search.getAll("status").map((status) => status.trim()).filter(Boolean)
  const invalidStatus = statuses.find((status) => !DEAL_STATUSES.includes(status as DealStatus))
  if (invalidStatus) {
    if (mode === "reject") return { ok: false, field: "status", message: "One or more status filters are invalid." }
  }
  const createdFrom = readDate(search.get("from"), "from")
  if (createdFrom && typeof createdFrom === "object") {
    if (mode === "reject") return createdFrom
  }
  const createdTo = readDate(search.get("to"), "to")
  if (createdTo && typeof createdTo === "object") {
    if (mode === "reject") return createdTo
  }
  const validStatuses = statuses.filter((status): status is DealStatus => DEAL_STATUSES.includes(status as DealStatus))
  return {
    ok: true,
    filters: {
      search: search.get("q")?.trim() || undefined,
      statuses: validStatuses.length ? validStatuses : undefined,
      assignee: search.get("assignee")?.trim() || undefined,
      createdFrom: typeof createdFrom === "string" ? createdFrom : undefined,
      createdTo: typeof createdTo === "string" ? createdTo : undefined,
      funder: search.get("funder")?.trim() || undefined,
    },
  }
}

export function dealListQueryString(search: Pick<URLSearchParams, "get" | "getAll">): string {
  const parsed = parseDealListFilters(search, "omit")
  if (!parsed.ok) return ""
  const params = new URLSearchParams()
  if (parsed.filters.search) params.set("q", parsed.filters.search)
  for (const status of parsed.filters.statuses ?? []) params.append("status", status)
  if (parsed.filters.assignee) params.set("assignee", parsed.filters.assignee)
  if (parsed.filters.createdFrom) params.set("from", parsed.filters.createdFrom)
  if (parsed.filters.createdTo) params.set("to", parsed.filters.createdTo)
  if (parsed.filters.funder) params.set("funder", parsed.filters.funder)
  return params.toString()
}

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
