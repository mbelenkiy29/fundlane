import "server-only"
import { getDatabase } from "../db"
import type { DealActor } from "../deals/schema"
import { csvEscape } from "../exports/csv"
import type { ReportBasis, ReportFilters } from "./contracts"
import { calendarDateInTimeZone, dateInInclusiveRange, FUNNEL_STAGES, getRepFunnelReport } from "./rep-funnel"
import type { FunnelStage } from "./rep-funnel"
import type { PerformanceMoney, PerformanceMoneyRecord, PerformanceReport } from "./performance-contracts"

export const PERFORMANCE_DEFINITIONS = {
  leads: "Created deals (lead intake): unique deal IDs created in the selected local calendar window.",
  pipeline: "Current pipeline status for the creation-date cohort; this is a current snapshot, not historical pipeline.",
  stages: "Submitted and offered/approved evidence count unique deals once per stage. Dates use the first recorded stage event. Five lender submissions remain one deal.",
  basis: "Event compares activity in the local date window; its ratios can exceed 100%. Cohort selects created deals and observes recorded outcomes as of generation; numerator intersects denominator deal IDs. Zero denominator is N/A.",
  attribution: "Current originator/closer assignments receive full deal credit; company totals stay unique. Paid broker commissions filter by recipient membership. Assignments are not historical ownership.",
  fundedVolume: "Sum committed funding-event IDs, each on its own funded date (event) or created-deal cohort (cohort). Reversed/corrected events are excluded; this is a current restatement.",
  renewals: "Unique source advances with recorded renewal actions, dated eligible_at (event) or source-deal creation (cohort). Converted requires a valid linked renewed deal; conversion does not imply funding. No eligibility prediction.",
  estimatedCommission: "Recorded commission on an active selected revision for a deal with no committed funding, dated effective_at (event). Missing or ambiguous selections remain unknown; no commission policy is inferred.",
  recordedFundingCommission: "Recorded committed funding commission on funded_at; this contract figure is not a client revenue-recognition policy.",
  collectedCommission: "Current nonvoid commission-only payment received amounts, dated received_at; fees excluded. Later ledger corrections restate current totals, not historical cash movements.",
  paidBrokerCommission: "Paid recipient distributions on nonvoid commission payments, dated paid_at. Not company collected revenue or a bank-transfer claim. Do not add estimated, recorded, collected and paid figures together.",
  finance: "Company finance values and record identities require both payment-table and company-financial permissions. Restricted is not zero.",
} as const

export function conversionForDealIds(fromIds: string[], toIds: string[], basis: ReportBasis) {
  const from = new Set(fromIds)
  const to = new Set(toIds)
  const numerator = basis === "cohort" ? [...to].filter((id) => from.has(id)).length : to.size
  return { numerator, denominator: from.size, rate: from.size ? numerator / from.size : null }
}

function money(records: PerformanceMoneyRecord[], visible: boolean): PerformanceMoney {
  if (!visible) return { visible: false }
  const unique = [...new Map(records.map((row) => [row.recordId, row])).values()]
  return { visible: true, knownCents: unique.reduce((sum, row) => sum + (row.amountCents ?? 0), 0), unknownCount: unique.filter((row) => row.amountCents === null).length, count: unique.length, records: unique }
}

/** Read-only composition; accounting writers and calculation policy remain authoritative. */
export async function getPerformanceReport(actor: DealActor, filters: ReportFilters, generatedAt = new Date().toISOString()): Promise<PerformanceReport> {
  const funnel = await getRepFunnelReport(actor, filters, generatedAt)
  const timezone = funnel.period.timezone
  const financeVisible = funnel.permission.paymentsVisible && funnel.permission.companyTotalsVisible
  const db = getDatabase()
  const [deals, assignments, links, offers, funding, selections, renewals, payments, distributions] = await Promise.all([
    db.prepare<{ id: string; display_id: string; legal_name: string | null; status: string; created_at: string }>(`SELECT d.id,d.display_id,d.legal_name,d.status,COALESCE((SELECT MIN(a.created_at) FROM deal_activity a WHERE a.workspace_id=d.workspace_id AND a.deal_id=d.id AND a.action='created'),d.created_at) created_at FROM deals d WHERE d.workspace_id=?`).all(actor.workspaceId),
    db.prepare<{ deal_id: string; membership_id: string }>("SELECT deal_id,membership_id FROM deal_assignments WHERE workspace_id=? AND kind IN ('originator','closer')").all(actor.workspaceId),
    db.prepare<{ deal_id: string; source_id: string | null; batch_id: string | null }>(`SELECT deal_id,source_id,batch_id FROM mca_deal_acquisition_events WHERE workspace_id=? UNION SELECT ir.deal_id,r.source_id,r.batch_id FROM import_rows ir JOIN import_runs r ON r.workspace_id=ir.workspace_id AND r.id=ir.run_id WHERE ir.workspace_id=? AND ir.deal_id IS NOT NULL`).all(actor.workspaceId, actor.workspaceId),
    db.prepare<{ id: string; deal_id: string; funder_id: string | null }>(`SELECT id,deal_id,funder_id FROM mca_offers WHERE workspace_id=? UNION ALL SELECT id,deal_id,funder_id FROM deal_submissions WHERE workspace_id=? UNION ALL SELECT id,deal_id,funder_id FROM mca_manual_submissions WHERE workspace_id=? UNION ALL SELECT id,deal_id,funder_id FROM mca_submission_jobs WHERE workspace_id=?`).all(actor.workspaceId, actor.workspaceId, actor.workspaceId, actor.workspaceId),
    db.prepare<{ id: string; deal_id: string; offer_id: string; funded_at: string; reversed_at: string | null; state: string; amount_cents: number; commission_cents: number }>("SELECT id,deal_id,offer_id,funded_at,reversed_at,state,amount_cents,commission_cents FROM mca_funding_events WHERE workspace_id=?").all(actor.workspaceId),
    financeVisible ? db.prepare<{ deal_id: string; id: string; offer_id: string; commission_cents: number | null; effective_at: string; state: string; incomplete_fields_json: string; expires_at: string | null }>(`SELECT s.deal_id,r.id,r.offer_id,r.commission_cents,r.effective_at,r.state,r.incomplete_fields_json,r.expires_at FROM mca_offer_selections s JOIN mca_offers o ON o.workspace_id=s.workspace_id AND o.id=s.offer_id AND o.deal_id=s.deal_id JOIN mca_offer_revisions r ON r.workspace_id=s.workspace_id AND r.id=s.offer_revision_id AND r.offer_id=o.id WHERE s.workspace_id=? AND s.active=1`).all(actor.workspaceId) : [],
    db.prepare<{ id: string; source_advance_id: string; deal_id: string; renewed_deal_id: string | null; state: string; eligible_at: string }>(`SELECT r.id,r.source_advance_id,a.deal_id,d.id renewed_deal_id,r.state,r.eligible_at FROM mca_renewal_actions r JOIN mca_advances a ON a.workspace_id=r.workspace_id AND a.id=r.source_advance_id LEFT JOIN deals d ON d.workspace_id=r.workspace_id AND d.id=r.renewed_deal_id WHERE r.workspace_id=?`).all(actor.workspaceId),
    financeVisible ? db.prepare<{ id: string; deal_id: string; offer_id: string; received_amount_cents: number; received_at: string | null }>(`SELECT p.id,a.deal_id,a.offer_id,p.received_amount_cents,p.received_at FROM mca_accounting_payments p JOIN mca_advances a ON a.workspace_id=p.workspace_id AND a.id=p.advance_id WHERE p.workspace_id=? AND p.status<>'void' AND p.type='commission' AND (p.received_at IS NOT NULL OR p.received_amount_cents>0)`).all(actor.workspaceId) : [],
    financeVisible ? db.prepare<{ id: string; deal_id: string; offer_id: string; recipient_membership_id: string; amount_cents: number; paid_at: string | null }>(`SELECT d.id,a.deal_id,a.offer_id,d.recipient_membership_id,d.amount_cents,d.paid_at FROM mca_payment_distributions d JOIN mca_accounting_payments p ON p.workspace_id=d.workspace_id AND p.id=d.payment_id JOIN mca_advances a ON a.workspace_id=p.workspace_id AND a.id=p.advance_id WHERE d.workspace_id=? AND d.status='paid' AND p.status<>'void' AND p.type='commission'`).all(actor.workspaceId) : [],
  ])
  const byDeal = new Map(deals.map((row) => [row.id, row]))
  const offerById = new Map(offers.map((row) => [row.id, row]))
  const createdOn = (dealId: string) => calendarDateInTimeZone(byDeal.get(dealId)?.created_at ?? "", timezone)
  const dateIncluded = (dealId: string, at: string | null) => dateInInclusiveRange(filters.basis === "cohort" ? createdOn(dealId) : at ? calendarDateInTimeZone(at, timezone) : null, filters.from, filters.to)
  const matches = (dealId: string, recipient?: string) => {
    if (!byDeal.has(dealId)) return false
    if (filters.membershipIds?.length && !(recipient ? filters.membershipIds.includes(recipient) : assignments.some((row) => row.deal_id === dealId && filters.membershipIds!.includes(row.membership_id)))) return false
    if (filters.funderIds?.length && !offers.some((row) => row.deal_id === dealId && row.funder_id && filters.funderIds!.includes(row.funder_id))) return false
    if (filters.sourceIds?.length && !links.some((row) => row.deal_id === dealId && row.source_id && filters.sourceIds!.includes(row.source_id))) return false
    if (filters.batchIds?.length && !links.some((row) => row.deal_id === dealId && row.batch_id && filters.batchIds!.includes(row.batch_id))) return false
    return true
  }
  const matchesFunder = (offerId: string) => !filters.funderIds?.length || Boolean(offerById.get(offerId)?.funder_id && filters.funderIds.includes(offerById.get(offerId)!.funder_id!))
  const committed = funding.filter((row) => row.state === "committed")
  const includedFunding = committed.filter((row) => matches(row.deal_id) && matchesFunder(row.offer_id) && dateIncluded(row.deal_id, row.funded_at))
  const record = (id: string, dealId: string, at: string | null, amount: number | null): PerformanceMoneyRecord => ({ recordId: id, dealId, occurredOn: at ? calendarDateInTimeZone(at, timezone) : null, amountCents: amount === null ? null : Number(amount) })
  const reversed = funding.filter((row) => row.state !== "committed" && row.reversed_at && matches(row.deal_id) && matchesFunder(row.offer_id) && dateIncluded(row.deal_id, row.reversed_at))
  const selectedByDeal = new Map<string, typeof selections>()
  for (const row of selections) {
    if (!matches(row.deal_id) || !matchesFunder(row.offer_id) || !dateIncluded(row.deal_id, row.effective_at)) continue
    if (row.state !== "active" || (row.expires_at && row.expires_at <= generatedAt) || committed.some((item) => item.deal_id === row.deal_id)) continue
    selectedByDeal.set(row.deal_id, [...(selectedByDeal.get(row.deal_id) ?? []), row])
  }
  const estimates: PerformanceMoneyRecord[] = []
  for (const [dealId, rows] of selectedByDeal) {
    const row = rows[0]
    let incomplete = true
    try { const parsed: unknown = JSON.parse(row.incomplete_fields_json); incomplete = !Array.isArray(parsed) || parsed.includes("commissionCents") } catch { /* Corrupt source snapshot is unknown. */ }
    estimates.push(record(rows.length === 1 ? row.id : `ambiguous:${dealId}`, dealId, row.effective_at, rows.length === 1 && !incomplete ? row.commission_cents : null))
  }
  const stages = Object.fromEntries(FUNNEL_STAGES.map((stage) => [stage, { dealCount: funnel.drilldown[stage].length, deals: funnel.drilldown[stage].map((row) => ({ ...row, amountCents: financeVisible ? row.amountCents : null })) }])) as PerformanceReport["stages"]
  // Count committed events in-window, even when the deal's first funding was earlier.
  const fundedByDeal = new Map<string, typeof includedFunding>()
  for (const row of includedFunding) fundedByDeal.set(row.deal_id, [...(fundedByDeal.get(row.deal_id) ?? []), row])
  stages.funded = { dealCount: fundedByDeal.size, deals: [...fundedByDeal].map(([dealId, rows]) => ({ dealId, displayId: byDeal.get(dealId)?.display_id ?? dealId, legalName: byDeal.get(dealId)?.legal_name?.trim() || "Untitled draft", stage: "funded", occurredOn: calendarDateInTimeZone(rows.map((row) => row.funded_at).sort()[0], timezone), amountCents: financeVisible ? rows.reduce((sum, row) => sum + Number(row.amount_cents), 0) : null, attributedMembershipIds: [...new Set(assignments.filter((row) => row.deal_id === dealId).map((row) => row.membership_id))], shared: new Set(assignments.filter((row) => row.deal_id === dealId).map((row) => row.membership_id)).size > 1 })) }
  const pairs: Array<[FunnelStage, FunnelStage]> = [["created", "submitted"], ["submitted", "approved"], ["approved", "funded"], ["created", "funded"]]
  const pipelineDeals = deals.filter((row) => matches(row.id) && dateInInclusiveRange(createdOn(row.id), filters.from, filters.to)).map((row) => ({ dealId: row.id, status: row.status }))
  const pipelineCounts: Record<string, number> = {}
  for (const row of pipelineDeals) pipelineCounts[row.status] = (pipelineCounts[row.status] ?? 0) + 1
  const renewalRecords = renewals.filter((row) => matches(row.deal_id) && dateIncluded(row.deal_id, row.eligible_at)).map((row) => ({ sourceAdvanceId: row.source_advance_id, dealId: row.deal_id, renewedDealId: row.renewed_deal_id, state: row.state, eligibleOn: calendarDateInTimeZone(row.eligible_at, timezone) }))
  return {
    filters, generatedAt, timezone, period: funnel.period, permission: funnel.permission, attribution: funnel.attribution, definitions: PERFORMANCE_DEFINITIONS, stages,
    conversions: pairs.map(([from, to]) => ({ from, to, ...conversionForDealIds(stages[from].deals.map((row) => row.dealId), stages[to].deals.map((row) => row.dealId), filters.basis) })),
    pipeline: { basis: "created_cohort_current_status", counts: pipelineCounts, deals: pipelineDeals },
    renewals: { eligibleAdvanceCount: new Set(renewalRecords.map((row) => row.sourceAdvanceId)).size, convertedAdvanceCount: new Set(renewalRecords.filter((row) => row.state === "converted" && row.renewedDealId).map((row) => row.sourceAdvanceId)).size, records: renewalRecords },
    finance: {
      fundedVolume: money(includedFunding.map((row) => record(row.id, row.deal_id, row.funded_at, row.amount_cents)), financeVisible),
      reversedFunding: money(reversed.map((row) => record(row.id, row.deal_id, row.reversed_at, row.amount_cents)), financeVisible),
      estimatedCommission: money(estimates, financeVisible),
      recordedFundingCommission: money(includedFunding.map((row) => record(row.id, row.deal_id, row.funded_at, row.commission_cents)), financeVisible),
      collectedCommission: money(payments.filter((row) => matches(row.deal_id) && matchesFunder(row.offer_id) && dateIncluded(row.deal_id, row.received_at)).map((row) => record(row.id, row.deal_id, row.received_at, row.received_at ? row.received_amount_cents : null)), financeVisible),
      paidBrokerCommission: money(distributions.filter((row) => matches(row.deal_id, row.recipient_membership_id) && matchesFunder(row.offer_id) && dateIncluded(row.deal_id, row.paid_at)).map((row) => record(row.id, row.deal_id, row.paid_at, row.paid_at ? row.amount_cents : null)), financeVisible),
    },
  }
}

/** Exports the already-sanitized displayed snapshot; no second accounting query. */
export function performanceCsv(report: PerformanceReport): string {
  const rows: Array<Array<string | number | null>> = [["section", "metric", "record_id", "deal_id", "occurred_on", "count", "amount_cents", "unknown_count", "value"]]
  rows.push(["context", "basis", null, null, null, null, null, null, report.filters.basis], ["context", "timezone", null, null, null, null, null, null, report.timezone], ["context", "generated_at", null, null, null, null, null, null, report.generatedAt], ["context", "filters", null, null, null, null, null, null, JSON.stringify(report.filters)])
  for (const [key, definition] of Object.entries(report.definitions)) rows.push(["definition", key, null, null, null, null, null, null, definition])
  for (const [stage, metric] of Object.entries(report.stages)) {
    rows.push(["stage", stage, null, null, null, metric.dealCount, null, null, null])
    for (const row of metric.deals) rows.push(["stage_deal", stage, null, row.dealId, row.occurredOn, 1, row.amountCents, null, row.displayId])
  }
  for (const row of report.conversions) rows.push(["conversion", `${row.from}_to_${row.to}`, null, null, null, row.denominator, null, null, row.rate === null ? "N/A" : `${row.numerator}/${row.denominator}=${row.rate}`])
  for (const [status, count] of Object.entries(report.pipeline.counts)) rows.push(["pipeline", status, null, null, null, count, null, null, report.pipeline.basis])
  rows.push(["renewal", "recorded_eligible_advances", null, null, null, report.renewals.eligibleAdvanceCount, null, null, null], ["renewal", "converted_advances", null, null, null, report.renewals.convertedAdvanceCount, null, null, null])
  for (const [key, metric] of Object.entries(report.finance)) {
    rows.push(metric.visible ? ["finance", key, null, null, null, metric.count, metric.knownCents, metric.unknownCount, metric.unknownCount ? "Partial" : "Complete"] : ["finance", key, null, null, null, null, null, null, "Restricted"])
    if (metric.visible) for (const row of metric.records) rows.push(["finance_record", key, row.recordId, row.dealId, row.occurredOn, 1, row.amountCents, row.amountCents === null ? 1 : 0, null])
  }
  return rows.map((row) => row.map((value) => csvEscape(value)).join(",")).join("\r\n")
}
