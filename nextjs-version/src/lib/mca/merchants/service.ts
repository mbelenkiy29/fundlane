import "server-only"

import { AppError } from "../errors"
import { canActorAccessDeal } from "../deals/access-policy"
import type { DealActor, DealWriteInput } from "../deals/schema"
import {
  findMerchantById,
  listDealAccessByIds,
  listDealIdsByEinHash,
  listDealIdsByLast4Hashes,
  listDocumentSummariesForDeals,
  listMerchantDealAccess,
  listMerchantIdsByEinHash,
  listMerchantIdsByLast4Hashes,
  listMerchantsByIds,
  loadDealIdentity,
  upsertMerchantFromDeal,
  type MerchantDealIdentity,
  type MerchantRow,
} from "./repository"
import type { MerchantAttachPayload, MerchantLookupQuery, MerchantLookupResult, MerchantMatch } from "./contracts"
import { einLookupHash, identityLookupHash } from "./lookup-hash"
import { normalizeEin } from "./normalize"

export { upsertMerchantFromDeal }
export type { MerchantDealIdentity }

function maskEmail(value?: string): string | undefined {
  if (!value) return undefined
  const [name, domain] = value.split("@")
  return domain ? `${name.slice(0, 1)}•••@${domain}` : "••••"
}

function actorSeesUnassigned(actor: DealActor): boolean {
  return actor.source === "api_key" || actor.role === "admin" || actor.role === "super_admin"
}

function visibleDealsFor(actor: DealActor, deals: Awaited<ReturnType<typeof listMerchantDealAccess>>) {
  return deals.filter((deal) => canActorAccessDeal(actor, { workspaceId: actor.workspaceId, assignments: deal.assignments }))
}

function matchFrom(merchant: MerchantRow, kind: MerchantMatch["match"], deals: Awaited<ReturnType<typeof listMerchantDealAccess>>): MerchantMatch {
  const latest = deals[0]
  return {
    merchantId: merchant.id,
    legalName: merchant.legalName?.trim() || "Untitled merchant",
    dbaName: merchant.dbaName,
    match: kind,
    dealCount: deals.length,
    latestDealId: latest?.dealId,
    contactName: merchant.contactName,
    contactEmail: maskEmail(merchant.contactEmail),
  }
}

async function merchantIdsFromVisibleDeals(actor: DealActor, dealIds: string[]): Promise<string[]> {
  const ids: string[] = []
  for (const deal of await listDealAccessByIds(actor.workspaceId, dealIds)) {
    if (!canActorAccessDeal(actor, { workspaceId: actor.workspaceId, assignments: deal.assignments })) continue
    if (deal.merchantId) {
      ids.push(deal.merchantId)
      continue
    }
    const identity = await loadDealIdentity(actor.workspaceId, deal.dealId)
    if (!identity) continue
    ids.push(await upsertMerchantFromDeal(identity))
  }
  return ids
}

export async function lookupMerchants(actor: DealActor, query: MerchantLookupQuery): Promise<MerchantLookupResult> {
  const normalizedEin = normalizeEin(query.ein)
  const einHash = einLookupHash(actor.workspaceId, query.ein)
  const last4Hashes = [...new Set(
    (query.owners ?? []).map((owner) => identityLookupHash(actor.workspaceId, owner.identityLast4)).filter((hash): hash is string => Boolean(hash)),
  )]

  const einMerchantIds = new Set<string>()
  const last4MerchantIds = new Set<string>()

  if (einHash) {
    for (const merchantId of await listMerchantIdsByEinHash(actor.workspaceId, einHash)) einMerchantIds.add(merchantId)
    for (const merchantId of await merchantIdsFromVisibleDeals(actor, await listDealIdsByEinHash(actor.workspaceId, einHash))) {
      einMerchantIds.add(merchantId)
    }
  }
  if (last4Hashes.length) {
    for (const merchantId of await listMerchantIdsByLast4Hashes(actor.workspaceId, last4Hashes)) last4MerchantIds.add(merchantId)
    for (const merchantId of await merchantIdsFromVisibleDeals(actor, await listDealIdsByLast4Hashes(actor.workspaceId, last4Hashes))) {
      last4MerchantIds.add(merchantId)
    }
  }

  const merchantIds = [...new Set([...einMerchantIds, ...last4MerchantIds])]
  const merchants = await listMerchantsByIds(actor.workspaceId, merchantIds)
  const accessRows = await listMerchantDealAccess(actor.workspaceId, merchantIds)
  const access = new Map<string, typeof accessRows>()
  for (const row of accessRows) {
    const list = access.get(row.merchantId) ?? []
    list.push(row)
    access.set(row.merchantId, list)
  }

  const matches: MerchantMatch[] = []
  for (const merchant of merchants) {
    const deals = visibleDealsFor(actor, access.get(merchant.id) ?? [])
    if (!deals.length && !actorSeesUnassigned(actor)) continue
    const kind = einMerchantIds.has(merchant.id) ? "ein" : "identity_last4"
    matches.push(matchFrom(merchant, kind, deals))
  }
  matches.sort((left, right) => {
    if (left.match !== right.match) return left.match === "ein" ? -1 : 1
    return (right.dealCount - left.dealCount) || left.legalName.localeCompare(right.legalName)
  })
  return { normalizedEin, matches }
}

export async function getAttachPayload(actor: DealActor, merchantId: string): Promise<MerchantAttachPayload> {
  const merchant = await findMerchantById(actor.workspaceId, merchantId)
  if (!merchant) throw new AppError(404, "merchant_not_found", "The requested merchant was not found.")
  const visibleDeals = visibleDealsFor(actor, await listMerchantDealAccess(actor.workspaceId, [merchantId]))
  if (!visibleDeals.length && !actorSeesUnassigned(actor)) {
    throw new AppError(404, "merchant_not_found", "The requested merchant was not found.")
  }
  const fields: DealWriteInput = {
    legalName: merchant.legalName,
    dbaName: merchant.dbaName,
    ein: merchant.ein,
    address: merchant.address,
    contactName: merchant.contactName,
    contactEmail: merchant.contactEmail,
    contactPhone: merchant.contactPhone,
    owners: merchant.owners,
  }
  return {
    merchantId: merchant.id,
    fields,
    documentSummaries: await listDocumentSummariesForDeals(actor.workspaceId, visibleDeals.map((deal) => deal.dealId)),
  }
}
