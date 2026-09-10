export type SubmissionSource = "automated" | "legacy" | "manual"
export interface SubmissionRow {
  id: string
  source: SubmissionSource
  dealId: string
  displayId: string
  business: string
  funderId: string | null
  funder: string
  reps: Array<{ id: string; name: string }>
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
    return "A recent submission blocked this attempt. Review the existing submission and retry eligibility in the deal."
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
export function filterSubmissionRows(
  rows: SubmissionRow[],
  params: URLSearchParams
): DashboardResult {
  const choices: DashboardResult["choices"] = {
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
      ...new Map(
        rows.flatMap((row) => row.reps).map((rep) => [rep.id, rep])
      ).values(),
    ].sort((a, b) => a.name.localeCompare(b.name)),
  }
  const q = params.get("q")?.trim().toLowerCase() ?? ""
  const filtered = rows
    .filter((row) => {
      if (
        q &&
        !`${row.business} ${row.displayId} ${row.funder}`
          .toLowerCase()
          .includes(q)
      )
        return false
      if (params.get("delivery") && row.delivery !== params.get("delivery"))
        return false
      if (params.get("response") && row.response !== params.get("response"))
        return false
      if (
        params.get("funder") &&
        (row.funderId ?? `name:${row.funder}`) !== params.get("funder")
      )
        return false
      if (
        params.get("rep") &&
        !row.reps.some((rep) => rep.id === params.get("rep"))
      )
        return false
      if (
        params.get("from") &&
        (!row.submittedAt || row.submittedAt.slice(0, 10) < params.get("from")!)
      )
        return false
      if (
        params.get("to") &&
        (!row.submittedAt || row.submittedAt.slice(0, 10) > params.get("to")!)
      )
        return false
      return true
    })
    .sort(
      (a, b) =>
        (b.submittedAt ?? "").localeCompare(a.submittedAt ?? "") ||
        a.id.localeCompare(b.id)
    )
  const page = Math.min(
    Number(params.get("page") || 1),
    Math.max(1, Math.ceil(filtered.length / 25))
  )
  return {
    rows: filtered.slice((page - 1) * 25, page * 25),
    total: filtered.length,
    page,
    pageSize: 25,
    choices,
  }
}
