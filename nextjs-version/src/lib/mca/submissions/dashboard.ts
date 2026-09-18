import "server-only"
import { getDatabase } from "../db"
import { canActorAccessDeal } from "../deals/access-policy"
import type { DealActor, DealAssignment } from "../deals/schema"
import { AppError } from "../errors"
import {
  pageSubmissionDeals,
  submissionGuidance,
  type SubmissionDealFacts,
  type SubmissionRow,
  type SubmissionDetail,
} from "./dashboard-view"
import { isActionAllowed } from "../policy"
import { getWorkspaceSettings } from "../workspaces"

type RecordRow = {
  id: string
  source: SubmissionRow["source"]
  deal_id: string
  funder_id: string | null
  funder: string
  delivery: string
  response: string
  route: string | null
  submitted_at: string | null
  updated_at: string | null
}
export function validateDashboardParams(params: URLSearchParams) {
  if (
    params.has("page") &&
    (!/^[1-9]\d*$/.test(params.get("page")!) ||
      !Number.isSafeInteger(Number(params.get("page"))))
  )
    throw new AppError(
      422,
      "invalid_filter",
      "Page must be a positive integer."
    )
  for (const field of ["from", "to"]) {
    const date = params.get(field)
    if (
      date &&
      (!/^\d{4}-\d{2}-\d{2}$/.test(date) ||
        Number.isNaN(Date.parse(date)) ||
        new Date(date).toISOString().slice(0, 10) !== date)
    )
      throw new AppError(
        422,
        "invalid_filter",
        "Dates must be valid YYYY-MM-DD dates."
      )
  }
  if (
    params.get("from") &&
    params.get("to") &&
    params.get("from")! > params.get("to")!
  )
    throw new AppError(
      422,
      "invalid_filter",
      "The start date must precede the end date."
    )
  for (const key of ["q", "funder", "rep", "delivery", "response"])
    if ((params.get(key)?.length ?? 0) > 250)
      throw new AppError(422, "invalid_filter", "Filter values are too long.")
}
async function visibleRows(actor: DealActor): Promise<SubmissionRow[]> {
  const database = getDatabase()
  // Read only roster fields; do not hydrate/decrypt owners, documents or financial records.
  const [dealRows, assignments] = await Promise.all([
    database
      .prepare<{
        id: string
        displayId: string
        legalName: string
        requestedAmount: number | string | null
        status: string
      }>(`SELECT id, display_id AS "displayId", COALESCE(NULLIF(legal_name,''),'Untitled draft') AS "legalName", requested_amount AS "requestedAmount", status FROM deals WHERE workspace_id=?`)
      .all(actor.workspaceId),
    database
      .prepare<
        DealAssignment & { dealId: string }
      >(`SELECT id, deal_id AS "dealId", membership_id AS "membershipId", kind, is_primary AS "isPrimary", assigned_at AS "assignedAt", assigned_by_user_id AS "assignedByUserId" FROM deal_assignments WHERE workspace_id=?`)
      .all(actor.workspaceId),
  ])
  const assignmentsByDeal = new Map<string, DealAssignment[]>()
  for (const assignment of assignments)
    assignmentsByDeal.set(assignment.dealId, [
      ...(assignmentsByDeal.get(assignment.dealId) ?? []),
      assignment,
    ])
  const deals = dealRows
    .map((deal) => ({
      ...deal,
      workspaceId: actor.workspaceId,
      assignments: assignmentsByDeal.get(deal.id) ?? [],
    }))
    .filter((deal) => canActorAccessDeal(actor, deal))
  if (!deals.length) return []
  const visible = new Map(deals.map((deal) => [deal.id, deal]))
  const records = await database
    .prepare<RecordRow>(
      `
    SELECT j.id, 'automated' AS source, j.deal_id, j.funder_id, j.display_funder_name AS funder,
      j.state AS delivery, COALESCE((SELECT s.status FROM deal_submissions s WHERE s.workspace_id=j.workspace_id AND s.job_id=j.id AND s.deal_id=j.deal_id ORDER BY s.id LIMIT 1), 'unknown') AS response,
      j.route_kind AS route, j.created_at AS submitted_at, j.updated_at
    FROM mca_submission_jobs j WHERE j.workspace_id=?
    UNION ALL
    SELECT s.id, 'legacy', s.deal_id, s.funder_id, s.funder_name, 'unknown', s.status, s.route_kind, NULL, NULL
    FROM deal_submissions s WHERE s.workspace_id=? AND NOT EXISTS (SELECT 1 FROM mca_submission_jobs j WHERE j.workspace_id=s.workspace_id AND j.id=s.job_id AND j.deal_id=s.deal_id)
  `
    )
    .all(actor.workspaceId, actor.workspaceId)
  if (
    actor.source === "user" &&
    ["admin", "super_admin"].includes(actor.role ?? "")
  ) {
    records.push(
      ...(await database
        .prepare<RecordRow>(
          `SELECT id, 'manual' AS source, deal_id, funder_id, funder_name AS funder, 'unknown' AS delivery, state AS response, NULL AS route, historical_at AS submitted_at, updated_at FROM mca_manual_submissions WHERE workspace_id=?`
        )
        .all(actor.workspaceId))
    )
  }
  const names = new Map(
    (
      await database
        .prepare<{
          id: string
          name: string
        }>("SELECT m.id, u.name FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.workspace_id=?")
        .all(actor.workspaceId)
    ).map((row) => [row.id, row.name])
  )
  return records.flatMap((record) => {
    const deal = visible.get(record.deal_id)
    if (!deal) return []
    const originator =
      deal.assignments.find((assignment) => assignment.kind === "originator" && assignment.isPrimary) ??
      deal.assignments.find((assignment) => assignment.kind === "originator")
    // Transport cache states are not funder responses. Never infer an approval from a successful send.
    const response = [
      "sent",
      "queued",
      "sending",
      "errored",
      "failed",
      "skipped",
      "preflight_failed",
      "pending_portal",
      "blocked_duplicate",
    ].includes(record.response)
      ? "unknown"
      : record.response
    return [
      {
        id: `${record.source}:${record.id}`,
        source: record.source,
        dealId: deal.id,
        displayId: deal.displayId,
        business: deal.legalName,
        funderId: record.funder_id,
        funder: record.funder,
        reps: deal.assignments.map((a) => ({
          id: a.membershipId,
          name: names.get(a.membershipId) ?? "Former member",
        })),
        originatorId: originator?.membershipId ?? null,
        originatorName: originator ? names.get(originator.membershipId) ?? "Former member" : null,
        requestedAmount:
          deal.requestedAmount == null || deal.requestedAmount === ""
            ? null
            : Number(deal.requestedAmount),
        amountHidden: false,
        dealStatus: deal.status,
        delivery:
          record.source === "legacy" &&
          [
            "sent",
            "queued",
            "sending",
            "failed",
            "skipped",
            "errored",
          ].includes(record.response)
            ? record.response
            : record.delivery,
        response,
        route: record.route,
        submittedAt: record.submitted_at,
        updatedAt: record.updated_at,
      },
    ]
  })
}
async function dealFacts(actor: DealActor, dealIds: string[]): Promise<Map<string, SubmissionDealFacts>> {
  const facts = new Map<string, SubmissionDealFacts>()
  if (!dealIds.length) return facts
  const database = getDatabase()
  const placeholders = dealIds.map(() => "?").join(",")
  const [offers, fundings] = await Promise.all([
    database
      .prepare<{ dealId: string; funderName: string }>(
        `SELECT deal_id AS "dealId", funder_name AS "funderName" FROM mca_offers WHERE workspace_id=? AND deal_id IN (${placeholders})`
      )
      .all(actor.workspaceId, ...dealIds),
    database
      .prepare<{ dealId: string; amountCents: number; funderName: string | null }>(
        `SELECT f.deal_id AS "dealId", f.amount_cents AS "amountCents", o.funder_name AS "funderName"
         FROM mca_funding_events f
         LEFT JOIN mca_offers o ON o.workspace_id=f.workspace_id AND o.id=f.offer_id
         WHERE f.workspace_id=? AND f.state='committed' AND f.deal_id IN (${placeholders})`
      )
      .all(actor.workspaceId, ...dealIds),
  ])
  for (const id of dealIds) facts.set(id, { funded: false, fundedAmountCents: null, fundedFunder: null, offerFunders: [] })
  for (const offer of offers) {
    const current = facts.get(offer.dealId) ?? { funded: false, fundedAmountCents: null, fundedFunder: null, offerFunders: [] }
    if (offer.funderName && !current.offerFunders.includes(offer.funderName)) current.offerFunders.push(offer.funderName)
    facts.set(offer.dealId, current)
  }
  for (const funding of fundings) {
    const current = facts.get(funding.dealId) ?? { funded: false, fundedAmountCents: null, fundedFunder: null, offerFunders: [] }
    current.funded = true
    current.fundedAmountCents = (current.fundedAmountCents ?? 0) + (Number(funding.amountCents) || 0)
    current.fundedFunder = funding.funderName ?? current.fundedFunder
    facts.set(funding.dealId, current)
  }
  return facts
}

export async function listSubmissionDashboard(
  actor: DealActor,
  params: URLSearchParams
) {
  validateDashboardParams(params)
  const rows = await visibleRows(actor)
  const settings = await getWorkspaceSettings(actor.workspaceId)
  const amountHidden = !Boolean(actor.role && isActionAllowed(actor.role, "viewCompanyFinancials", settings.actionVisibility))
  for (const row of rows) {
    row.amountHidden = amountHidden
    if (amountHidden) row.requestedAmount = null
  }
  const facts = await dealFacts(actor, [...new Set(rows.map((row) => row.dealId))])
  if (amountHidden) {
    for (const fact of facts.values()) {
      fact.fundedAmountCents = null
    }
  }
  return pageSubmissionDeals(rows, params, facts)
}

export async function listVisibleSubmissionRows(actor: DealActor): Promise<SubmissionRow[]> {
  return visibleRows(actor)
}
export async function getSubmissionDashboardDetail(
  actor: DealActor,
  id: string
): Promise<SubmissionDetail> {
  const row = (await visibleRows(actor)).find((row) => row.id === id)
  if (!row)
    throw new AppError(
      404,
      "submission_not_found",
      "This submission is unavailable or you no longer have access to it."
    )
  const attempts =
    row.source === "automated"
      ? await getDatabase()
          .prepare<{
            id: string
            state: string
            transport: string
            createdAt: string
          }>(`SELECT id, state, transport, created_at AS "createdAt" FROM mca_submission_attempts WHERE workspace_id=? AND job_id=? ORDER BY created_at, id`)
          .all(actor.workspaceId, id.slice("automated:".length))
      : []
  // Return no raw provider payload, financial terms, sender credentials, or merchant document contents.
  return {
    ...row,
    guidance: submissionGuidance(row.delivery),
    attempts: attempts.map((attempt) => ({
      ...attempt,
      guidance: submissionGuidance(attempt.state),
    })),
  }
}
