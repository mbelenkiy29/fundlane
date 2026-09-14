import "server-only"

import { z } from "zod"
import { getDatabase } from "../db"
import type { DealActor } from "../deals/schema"
import { AppError } from "../errors"
import { calendarDateInTimeZone, conversionRate, dateInInclusiveRange, getRepFunnelReport } from "../reports/rep-funnel"
import { getWorkspaceSettings } from "../workspaces"
import { OUTREACH_METRICS, type OutreachMetric, type OutreachReport, type OutreachRow } from "./contracts"
import { listApplicationInvitations } from "./service"

export async function getApplicationOutreachReport(actor: DealActor, search = new URLSearchParams(), asOf = new Date().toISOString()): Promise<OutreachReport> {
  if (actor.source !== "user" || !["admin", "super_admin"].includes(actor.role ?? "")) throw new AppError(403, "permission_denied", "Only administrators can view employee performance.")
  const timezone = (await getWorkspaceSettings(actor.workspaceId)).timezone
  const today = calendarDateInTimeZone(asOf, timezone)
  const from = search.get("from") || new Date(Date.parse(`${today}T12:00:00Z`) - 29 * 86400000).toISOString().slice(0, 10)
  const to = search.get("to") || today
  if (!z.iso.date().safeParse(from).success || !z.iso.date().safeParse(to).success || from > to || to > today) throw new AppError(422, "invalid_period", "Choose a valid date range ending today or earlier.")
  const employees = await getDatabase().prepare<{ id: string; name: string }>("SELECT m.id,u.name FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.workspace_id=? ORDER BY u.name,m.id").all(actor.workspaceId)
  const membershipId = search.get("membershipId") || undefined
  if (membershipId && !employees.some(employee => employee.id === membershipId)) throw new AppError(422, "invalid_employee", "Choose an employee in this company.")
  // Use the existing outcome facts, but join through immutable acquisition attribution, never current assignments.
  const [all, funnel] = await Promise.all([listApplicationInvitations(actor), getRepFunnelReport(actor, { basis: "cohort" }, asOf)])
  const financialsVisible = funnel.permission.companyTotalsVisible
  const outcomeMaps = {
    submitted: new Map(funnel.drilldown.submitted.map(deal => [deal.dealId, deal])),
    approved: new Map(funnel.drilldown.approved.map(deal => [deal.dealId, deal])),
    funded: new Map(funnel.drilldown.funded.map(deal => [deal.dealId, deal])),
  }
  const invitations: OutreachReport["invitations"] = all
    .filter(row => row.createdAt <= asOf && dateInInclusiveRange(calendarDateInTimeZone(row.createdAt, timezone), from, to) && (!membershipId || row.membershipId === membershipId))
    .map(row => {
      const stages: OutreachMetric[] = ["created"]
      const observed = (at: string | null) => Boolean(at && at <= asOf)
      if (observed(row.sentAt)) stages.push("emailed")
      if (observed(row.openedAt)) stages.push("opened")
      if (observed(row.startedAt)) stages.push("started")
      if (observed(row.submittedAt)) stages.push("received")
      if (observed(row.openedAt) && !observed(row.submittedAt)) stages.push("incomplete")
      for (const stage of ["submitted", "approved", "funded"] as const) {
        const deal = row.dealId ? outcomeMaps[stage].get(row.dealId) : undefined
        if (deal && (!deal.occurredOn || deal.occurredOn <= today)) stages.push(stage)
      }
      return { ...row, stages, fundedAmountCents: financialsVisible && row.dealId ? outcomeMaps.funded.get(row.dealId)?.amountCents ?? null : null }
    })
  function aggregate(rows: typeof invitations, id: string | null, name: string): OutreachRow {
    const counts = Object.fromEntries(OUTREACH_METRICS.map(metric => [metric, metric === "submitted" || metric === "approved" || metric === "funded"
      ? new Set(rows.filter(row => row.dealId && row.stages.includes(metric)).map(row => row.dealId)).size
      : rows.filter(row => row.stages.includes(metric)).length])) as OutreachRow["counts"]
    const funded = [...new Map(rows.filter(row => row.dealId && row.stages.includes("funded")).map(row => [row.dealId, row])).values()]
    return { membershipId: id, name, counts,
      fundedAmountCents: financialsVisible ? funded.reduce((sum, row) => sum + (row.fundedAmountCents ?? 0), 0) : null,
      unknownFundedAmountCount: financialsVisible ? funded.filter(row => row.fundedAmountCents == null).length : 0,
      conversions: {
        emailedToOpened: conversionRate(rows.filter(row => row.stages.includes("emailed") && row.stages.includes("opened")).length, counts.emailed),
        openedToReceived: conversionRate(rows.filter(row => row.stages.includes("opened") && row.stages.includes("received")).length, counts.opened),
        receivedToFunded: conversionRate(rows.filter(row => row.stages.includes("received") && row.stages.includes("funded")).length, counts.received),
      },
    }
  }
  return { period: { from, to, timezone, asOf }, employees, financialsVisible, invitations,
    totals: aggregate(invitations, null, "Company total"),
    reps: employees.filter(employee => !membershipId || employee.id === membershipId).map(employee => aggregate(invitations.filter(row => row.membershipId === employee.id), employee.id, employee.name)),
  }
}
