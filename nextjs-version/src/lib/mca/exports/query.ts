import "server-only"

import { getDatabase } from "../db"
import { canActorAccessDeal } from "../deals/access-policy"
import { inclusiveUtcDateBounds } from "../deals/filters"
import { listDealRecords } from "../deals/repository"
import { DEAL_STATUS_LABELS, type DealActor, type DealFilters, type DealOwner, type DealRecord } from "../deals/schema"
import { listOffers } from "../offers/repository"
import type { ExportKind, ExportSnapshot } from "./contracts"
import { OWNER_SLOT_COUNT, manifestFor } from "./manifests"

type Cell = string | number | null
type Row = Record<string, Cell>

function cell(value: string | number | undefined | null): Cell {
  if (value === undefined || value === null || value === "") return null
  return value
}

function ownerDisplayName(owners: DealOwner[]): Cell {
  const owner = sortedOwners(owners).find((item) => item.isPrimary) ?? sortedOwners(owners)[0]
  if (!owner) return null
  return cell([owner.firstName, owner.lastName].filter(Boolean).join(" ").trim())
}

function ids(values: string[]): Cell {
  return values.length ? values.join(";") : null
}

function membershipNames(workspaceId: string): Promise<Map<string, string>> {
  return getDatabase().prepare<{ id: string; name: string }>(
    `SELECT m.id, u.name FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.workspace_id = ?`,
  ).all(workspaceId).then((rows) => new Map(rows.map((row) => [row.id, row.name])))
}

function visibleDeals(actor: DealActor, filters: DealFilters): Promise<DealRecord[]> {
  return listDealRecords(actor.workspaceId, filters).then((records) => records.filter((record) => canActorAccessDeal(actor, record)))
}

function primaryOriginator(record: DealRecord): string | null {
  return record.assignments.find((item) => item.kind === "originator" && item.isPrimary)?.membershipId
    ?? record.assignments.find((item) => item.kind === "originator")?.membershipId
    ?? null
}

function sortedOwners(owners: DealOwner[]): DealOwner[] {
  return [...owners].sort((a, b) => Number(b.isPrimary) - Number(a.isPrimary) || a.id.localeCompare(b.id))
}

function ownerCells(owners: DealOwner[]): Row {
  const row: Row = {}
  const ordered = sortedOwners(owners).slice(0, OWNER_SLOT_COUNT)
  for (let index = 1; index <= OWNER_SLOT_COUNT; index += 1) {
    const owner = ordered[index - 1]
    row[`owner${index}FirstName`] = cell(owner?.firstName)
    row[`owner${index}LastName`] = cell(owner?.lastName)
    row[`owner${index}Email`] = cell(owner?.email)
    row[`owner${index}Phone`] = cell(owner?.phone)
    row[`owner${index}IdentityLast4`] = cell(owner?.identityLast4)
    row[`owner${index}DateOfBirth`] = cell(owner?.dateOfBirth)
    row[`owner${index}OwnershipPercent`] = owner?.ownershipPercent ?? null
    row[`owner${index}IsPrimary`] = owner ? (owner.isPrimary ? "yes" : "no") : null
  }
  return row
}

function isoInRange(value: string, from?: string, to?: string): boolean {
  const bounds = inclusiveUtcDateBounds(from, to)
  const stamp = value.length === 10 ? `${value}T00:00:00.000Z` : value
  if (bounds.from && stamp < bounds.from) return false
  if (bounds.toExclusive && stamp >= bounds.toExclusive) return false
  return true
}

function pick(manifestKind: ExportKind, row: Row): Row {
  const allowed = new Set(manifestFor(manifestKind).fields.map((field) => field.key))
  const next: Row = {}
  for (const [key, value] of Object.entries(row)) {
    if (allowed.has(key)) next[key] = value
  }
  return next
}

function dealStatusLabel(status: DealRecord["status"]): string {
  return DEAL_STATUS_LABELS[status]
}

async function snapshotDeals(actor: DealActor, filters: DealFilters): Promise<{ rowKeys: string[]; rows: Row[] }> {
  const deals = await visibleDeals(actor, filters)
  const rows = deals.map((deal) => pick("deals", {
    dealId: deal.id,
    displayId: deal.displayId,
    legalName: cell(deal.legalName),
    dbaName: cell(deal.dbaName),
    status: dealStatusLabel(deal.status),
    requestedAmount: deal.requestedAmount ?? null,
    monthlyRevenue: deal.monthlyRevenue ?? null,
    createdAt: deal.createdAt,
    updatedAt: deal.updatedAt,
    draftState: deal.draftState,
    funderNames: ids([...new Set(deal.submissions.map((item) => item.funderName))]),
    originatorMembershipIds: ids(deal.assignments.filter((item) => item.kind === "originator").map((item) => item.membershipId)),
    closerMembershipIds: ids(deal.assignments.filter((item) => item.kind === "closer").map((item) => item.membershipId)),
    contactName: cell(deal.contactName),
    contactEmail: cell(deal.contactEmail),
    contactPhone: cell(deal.contactPhone),
    primaryOwnerName: ownerDisplayName(deal.owners),
  }))
  return { rowKeys: deals.map((deal) => deal.id), rows }
}

async function snapshotOffers(actor: DealActor, filters: DealFilters): Promise<{ rowKeys: string[]; rows: Row[] }> {
  const deals = await visibleDeals(actor, filters)
  const byId = new Map(deals.map((deal) => [deal.id, deal]))
  const offers = (await Promise.all(deals.map((deal) => listOffers(actor.workspaceId, deal.id)))).flat()
  const rows: Row[] = []
  const rowKeys: string[] = []
  for (const offer of offers) {
    const deal = byId.get(offer.dealId)
    if (!deal) continue
    const revision = offer.revisions.find((item) => item.id === offer.currentRevisionId) ?? offer.revisions.at(-1)
    rowKeys.push(`${offer.dealId}:${offer.id}`)
    rows.push(pick("offers", {
      offerId: offer.id,
      dealId: offer.dealId,
      displayId: deal.displayId,
      legalName: cell(deal.legalName),
      funderName: offer.funderName,
      source: offer.source,
      amountCents: revision?.amountCents ?? null,
      factorRate: revision?.factorRate ?? null,
      termMonths: revision?.termMonths ?? null,
      paymentAmountCents: revision?.paymentAmountCents ?? null,
      paymentFrequency: cell(revision?.paymentFrequency),
      product: cell(revision?.product),
      revisionState: cell(revision?.state),
      selected: offer.selectedRevisionIds.includes(offer.currentRevisionId) ? "yes" : "no",
      createdAt: offer.createdAt,
    }))
  }
  return { rowKeys, rows }
}

async function snapshotAllDealsOwners(actor: DealActor, filters: DealFilters): Promise<{ rowKeys: string[]; rows: Row[] }> {
  const deals = await listDealRecords(actor.workspaceId, filters)
  const names = await membershipNames(actor.workspaceId)
  const rows = deals.map((deal) => {
    const originatorId = primaryOriginator(deal)
    return pick("all_deals_owners", {
      dealId: deal.id,
      displayId: deal.displayId,
      legalName: cell(deal.legalName),
      dbaName: cell(deal.dbaName),
      ein: cell(deal.ein),
      entityType: cell(deal.entityType),
      contactName: cell(deal.contactName),
      contactEmail: cell(deal.contactEmail),
      contactPhone: cell(deal.contactPhone),
      addressLine1: cell(deal.address?.line1),
      addressCity: cell(deal.address?.city),
      addressState: cell(deal.address?.state),
      addressPostalCode: cell(deal.address?.postalCode),
      monthlyRevenue: deal.monthlyRevenue ?? null,
      requestedAmount: deal.requestedAmount ?? null,
      status: dealStatusLabel(deal.status),
      createdAt: deal.createdAt,
      ficoScore: deal.ficoScore ?? null,
      fundingPurpose: cell(deal.fundingPurpose),
      industry: cell(deal.industry),
      naicsCode: cell(deal.naicsCode),
      startDate: cell(deal.startDate),
      primaryOriginatorMembershipId: originatorId,
      primaryOriginatorName: originatorId ? cell(names.get(originatorId)) : null,
      ownerCount: deal.owners.length,
      ...ownerCells(deal.owners),
    })
  })
  return { rowKeys: deals.map((deal) => deal.id), rows }
}

async function snapshotFundedDeals(actor: DealActor, filters: DealFilters): Promise<{ rowKeys: string[]; rows: Row[] }> {
  const dealFilters: DealFilters = { ...filters, createdFrom: undefined, createdTo: undefined }
  const deals = await listDealRecords(actor.workspaceId, dealFilters)
  const byId = new Map(deals.map((deal) => [deal.id, deal]))
  if (!deals.length) return { rowKeys: [], rows: [] }
  const placeholders = deals.map(() => "?").join(",")
  const events = await getDatabase().prepare<{
    id: string; deal_id: string; offer_id: string; advance_id: string; funded_at: string
    amount_cents: number; source: string; state: string; funder_name: string
  }>(`SELECT e.id, e.deal_id, e.offer_id, e.advance_id, e.funded_at, e.amount_cents, e.source, e.state, o.funder_name
      FROM mca_funding_events e
      JOIN mca_offers o ON o.workspace_id = e.workspace_id AND o.id = e.offer_id
      WHERE e.workspace_id = ? AND e.state = 'committed' AND e.deal_id IN (${placeholders})
      ORDER BY e.funded_at, e.id`).all(actor.workspaceId, ...deals.map((deal) => deal.id))
  const rowKeys: string[] = []
  const rows: Row[] = []
  for (const event of events) {
    if (!isoInRange(event.funded_at, filters.createdFrom, filters.createdTo)) continue
    const deal = byId.get(event.deal_id)
    if (!deal) continue
    rowKeys.push(event.id)
    rows.push(pick("funded_deals", {
      dealId: deal.id,
      displayId: deal.displayId,
      legalName: cell(deal.legalName),
      dbaName: cell(deal.dbaName),
      dealStatus: dealStatusLabel(deal.status),
      fundingEventId: event.id,
      offerId: event.offer_id,
      advanceId: event.advance_id,
      funderName: event.funder_name,
      fundedAt: event.funded_at,
      fundedAmountCents: Number(event.amount_cents),
      fundingSource: event.source,
      fundingState: event.state,
      primaryOriginatorMembershipId: primaryOriginator(deal),
    }))
  }
  return { rowKeys, rows }
}

export async function captureExportSnapshot(actor: DealActor, kind: ExportKind, filters: DealFilters, capturedAt: string): Promise<ExportSnapshot> {
  const captured = kind === "offers" ? await snapshotOffers(actor, filters)
    : kind === "all_deals_owners" ? await snapshotAllDealsOwners(actor, filters)
      : kind === "funded_deals" ? await snapshotFundedDeals(actor, filters)
        : await snapshotDeals(actor, filters)
  return { version: 1, filters, capturedAt, rowKeys: captured.rowKeys, rows: captured.rows }
}
