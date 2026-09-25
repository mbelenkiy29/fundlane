export type SubmissionSource = "automated" | "legacy" | "manual"
export const SUBMISSION_BUSINESS_STATUSES = [
  "funded",
  "withdrawn",
  "offer_received",
  "rejected",
  "under_review",
  "pending",
] as const
export type SubmissionBusinessStatus = (typeof SUBMISSION_BUSINESS_STATUSES)[number]
export const SUBMISSION_BUSINESS_STATUS_LABELS: Record<SubmissionBusinessStatus, string> = {
  funded: "Funded",
  withdrawn: "Withdrawn",
  offer_received: "Offer Received",
  rejected: "Rejected",
  under_review: "Under Review",
  pending: "Pending",
}
const FAILED_DELIVERY = new Set(["failed", "skipped", "blocked_duplicate", "preflight_failed", "errored"])
const LIVE_DELIVERY = new Set(["sent", "sending", "queued", "pending_portal"])
const DECLINED_RESPONSE = new Set(["declined", "decline", "rejected"])
const FUNDED_DEAL = new Set(["funded", "renewed"])
const WITHDRAWN_DEAL = new Set(["closed"])
export interface SubmissionRow {
  id: string
  source: SubmissionSource
  dealId: string
  displayId: string
  business: string
  funderId: string | null
  funder: string
  reps: Array<{ id: string; name: string }>
  originatorId: string | null
  originatorName: string | null
  requestedAmount: number | null
  amountHidden: boolean
  dealStatus: string
  delivery: string
  response: string
  route: string | null
  submittedAt: string | null
  updatedAt: string | null
}
export interface SubmissionDetail extends SubmissionRow {
  attempts: Array<{
    id: string
    state: string
    transport: string
    createdAt: string
    guidance: string | null
  }>
  guidance: string | null
}
export interface DashboardResult {
  rows: SubmissionRow[]
  deals: SubmissionDealRow[]
  total: number
  page: number
  pageSize: number
  choices: {
    delivery: string[]
    response: string[]
    funders: Array<{ id: string; name: string }>
    reps: Array<{ id: string; name: string }>
  }
}
export interface SubmissionDealFacts {
  funded: boolean
  fundedAmountCents: number | null
  fundedFunder: string | null
  offerFunders: string[]
}
export interface SubmissionDealRow {
  dealId: string
  displayId: string
  business: string
  amountRequested: number | null
  amountHidden: boolean
  lenders: Array<{
    recordId: string
    funderId: string | null
    name: string
    delivery: string
    response: string
  }>
  status: SubmissionBusinessStatus
  submittedAt: string | null
  outcome: string
  recordId: string
}
export function submissionLabel(value: string): string {
  return value === "unknown"
    ? "Not recorded"
    : value
        .split("_")
        .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
        .join(" ")
}
export function submissionGuidance(state: string): string | null {
  if (state === "preflight_failed")
    return "Required information or submission setup is incomplete. Open the deal’s Submissions tab to review requirements before submitting again."
  if (state === "failed")
    return "Delivery failed. Open the deal’s Submissions tab to review the error and retry after correcting it."
  if (state === "blocked_duplicate")
    return "A recent submission of this deal to this funder is blocked for 2 minutes, and again for 24 hours unless someone who can submit provides an explicit override."
  if (state === "pending_portal")
    return "Complete this submission in the funder portal using the deal’s manual portal tools."
  if (state === "skipped")
    return "This destination was skipped. Review the deal before submitting again."
  return null
}
export function dealSubmissionHref(
  dealId: string,
  tab: "submissions" | "offers" = "submissions"
): string {
  return `/deals?deal=${encodeURIComponent(dealId)}&tab=${tab}`
}
function matchesSubmissionFilters(row: SubmissionRow, params: URLSearchParams): boolean {
  const q = params.get("q")?.trim().toLowerCase() ?? ""
  if (q && !`${row.business} ${row.displayId} ${row.funder}`.toLowerCase().includes(q)) return false
  if (params.get("delivery") && row.delivery !== params.get("delivery")) return false
  if (params.get("response") && row.response !== params.get("response")) return false
  if (params.get("funder") && (row.funderId ?? `name:${row.funder}`) !== params.get("funder")) return false
  if (params.get("rep") && !row.reps.some((rep) => rep.id === params.get("rep"))) return false
  if (params.get("from") && (!row.submittedAt || row.submittedAt.slice(0, 10) < params.get("from")!)) return false
  if (params.get("to") && (!row.submittedAt || row.submittedAt.slice(0, 10) > params.get("to")!)) return false
  return true
}

function dashboardChoices(rows: SubmissionRow[]): DashboardResult["choices"] {
  return {
    delivery: [...new Set(rows.map((row) => row.delivery))].sort(),
    response: [...new Set(rows.map((row) => row.response))].sort(),
    funders: [
      ...new Map(
        rows.map((row) => [
          row.funderId ?? `name:${row.funder}`,
          { id: row.funderId ?? `name:${row.funder}`, name: row.funder },
        ])
      ).values(),
    ].sort((a, b) => a.name.localeCompare(b.name)),
    reps: [
      ...new Map(rows.flatMap((row) => row.reps).map((rep) => [rep.id, rep])).values(),
    ].sort((a, b) => a.name.localeCompare(b.name)),
  }
}

export function filterSubmissionRows(
  rows: SubmissionRow[],
  params: URLSearchParams
): DashboardResult {
  const filtered = rows
    .filter((row) => matchesSubmissionFilters(row, params))
    .sort(
      (a, b) =>
        (b.submittedAt ?? "").localeCompare(a.submittedAt ?? "") ||
        a.id.localeCompare(b.id)
    )
  const page = Math.min(
    Number(params.get("page") || 1),
    Math.max(1, Math.ceil(filtered.length / 25))
  )
  const pageRows = filtered.slice((page - 1) * 25, page * 25)
  return {
    rows: pageRows,
    deals: groupSubmissionDeals(pageRows),
    total: filtered.length,
    page,
    pageSize: 25,
    choices: dashboardChoices(rows),
  }
}

export function pageSubmissionDeals(
  rows: SubmissionRow[],
  params: URLSearchParams,
  factsByDeal: Map<string, SubmissionDealFacts> = new Map()
): DashboardResult {
  const filtered = rows
    .filter((row) => matchesSubmissionFilters(row, params))
    .sort(
      (a, b) =>
        (b.submittedAt ?? "").localeCompare(a.submittedAt ?? "") ||
        a.id.localeCompare(b.id)
    )
  const grouped = groupSubmissionDeals(filtered, factsByDeal)
  const page = Math.min(Number(params.get("page") || 1), Math.max(1, Math.ceil(grouped.length / 25) || 1))
  const pageDeals = grouped.slice((page - 1) * 25, page * 25)
  return {
    rows: filtered,
    deals: pageDeals,
    total: grouped.length,
    page,
    pageSize: 25,
    choices: dashboardChoices(rows),
  }
}

export function isCountedSubmission(row: SubmissionRow): boolean {
  return Boolean(row.submittedAt) && !FAILED_DELIVERY.has(row.delivery)
}

export function deriveSubmissionBusinessStatus(
  row: Pick<SubmissionDealRow, "lenders"> & {
    dealStatus: string
    funded: boolean
    offerFunders: string[]
  }
): SubmissionBusinessStatus {
  if (row.funded || FUNDED_DEAL.has(row.dealStatus)) return "funded"
  if (WITHDRAWN_DEAL.has(row.dealStatus)) return "withdrawn"
  if (row.offerFunders.length) return "offer_received"
  const live = row.lenders.filter((lender) => LIVE_DELIVERY.has(lender.delivery))
  const declined = row.lenders.filter((lender) => DECLINED_RESPONSE.has(lender.response))
  if (live.length && row.offerFunders.length === 0) return "under_review"
  if (row.lenders.length && declined.length === row.lenders.length) return "rejected"
  if (live.length) return "under_review"
  return "pending"
}

export function deriveSubmissionOutcome(input: {
  status: SubmissionBusinessStatus
  fundedAmountCents: number | null
  fundedFunder: string | null
  offerFunders: string[]
  lenders: SubmissionDealRow["lenders"]
}): string {
  if (input.status === "funded") {
    const funder = input.fundedFunder ? ` with ${input.fundedFunder}` : ""
    if (input.fundedAmountCents != null) {
      const amount = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(input.fundedAmountCents / 100)
      return `Funded ${amount}${funder}`
    }
    return `Funded${funder}`
  }
  if (input.status === "offer_received") {
    if (input.offerFunders.length === 1) return `Offer from ${input.offerFunders[0]}`
    return `${input.offerFunders.length} offers`
  }
  if (input.status === "rejected") {
    const names = [...new Set(input.lenders.map((lender) => lender.name))]
    return names.length ? `Declined by ${names.join(", ")}` : "Declined"
  }
  if (input.status === "withdrawn") return "Deal closed"
  const waiting = input.lenders.find((lender) => LIVE_DELIVERY.has(lender.delivery))
  if (input.status === "under_review" && waiting) return `Waiting on ${waiting.name}`
  if (input.status === "pending") return "Not yet sent"
  return "In progress"
}

export function groupSubmissionDeals(
  rows: SubmissionRow[],
  factsByDeal: Map<string, SubmissionDealFacts> = new Map()
): SubmissionDealRow[] {
  const groups = new Map<string, SubmissionRow[]>()
  for (const row of rows) {
    const current = groups.get(row.dealId) ?? []
    current.push(row)
    groups.set(row.dealId, current)
  }
  const deals: SubmissionDealRow[] = []
  for (const [dealId, group] of groups) {
    const sorted = [...group].sort(
      (a, b) =>
        (b.submittedAt ?? "").localeCompare(a.submittedAt ?? "") ||
        a.id.localeCompare(b.id)
    )
    const latest = sorted[0]!
    const facts = factsByDeal.get(dealId)
    const lenders = sorted.map((row) => ({
      recordId: row.id,
      funderId: row.funderId,
      name: row.funder,
      delivery: row.delivery,
      response: row.response,
    }))
    const offerFunders = facts?.offerFunders ?? []
    const status = deriveSubmissionBusinessStatus({
      lenders,
      dealStatus: latest.dealStatus,
      funded: Boolean(facts?.funded),
      offerFunders,
    })
    const submittedAt = [...sorted]
      .filter((row) => isCountedSubmission(row))
      .map((row) => row.submittedAt)
      .sort()[0] ?? latest.submittedAt
    deals.push({
      dealId,
      displayId: latest.displayId,
      business: latest.business,
      amountRequested: latest.amountHidden ? null : latest.requestedAmount,
      amountHidden: latest.amountHidden,
      lenders,
      status,
      submittedAt,
      outcome: deriveSubmissionOutcome({
        status,
        fundedAmountCents: latest.amountHidden ? null : facts?.fundedAmountCents ?? null,
        fundedFunder: facts?.fundedFunder ?? null,
        offerFunders,
        lenders,
      }),
      recordId: latest.id,
    })
  }
  return deals.sort(
    (a, b) =>
      (b.submittedAt ?? "").localeCompare(a.submittedAt ?? "") ||
      a.dealId.localeCompare(b.dealId)
  )
}
