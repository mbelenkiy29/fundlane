import "server-only"

import { AppError } from "../errors"
import { canActorAccessDeal } from "../deals/access-policy"
import type { DealActor, DealAssignment, DealWriteInput } from "../deals/schema"
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
  workspaceEinExists,
  type MerchantDealIdentity,
  type MerchantRow,
} from "./repository"
import type { MerchantAttachPayload, MerchantLookupQuery, MerchantLookupResult, MerchantMatch } from "./contracts"
import { einLookupHash, identityLookupHash } from "./lookup-hash"
import { normalizeEin } from "./normalize"

export { upsertMerchantFromDeal }
export type { MerchantDealIdentity }

export class MerchantExistsError extends AppError {
  constructor(public readonly matches: MerchantMatch[]) {
    super(409, "merchant_exists", "This business already exists.", undefined, { matches })
    this.name = "MerchantExistsError"
  }
}

function maskEmail(value?: string): string | undefined {
  if (!value) return undefined
  const [name, domain] = value.split("@")
  return domain ? `${name.slice(0, 1)}•••@${domain}` : "••••"
}

function actorSeesUnassigned(actor: DealActor): boolean {
  return actor.source === "api_key" || actor.role === "admin" || actor.role === "super_admin"
}

function asDealAssignments(assignments: Array<Pick<DealAssignment, "membershipId" | "kind">>): DealAssignment[] {
  return assignments.map((item) => ({
    id: "",
    membershipId: item.membershipId,
    kind: item.kind,
    isPrimary: false,
    assignedAt: "",
    assignedByUserId: null,
  }))
}

function visibleDealsFor(actor: DealActor, deals: Awaited<ReturnType<typeof listMerchantDealAccess>>) {
  return deals.filter((deal) => canActorAccessDeal(actor, { workspaceId: actor.workspaceId, assignments: asDealAssignments(deal.assignments) }))
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
    if (!canActorAccessDeal(actor, { workspaceId: actor.workspaceId, assignments: asDealAssignments(deal.assignments) })) continue
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

function assertAdminSessionForForceAttach(actor: DealActor): void {
  if (actor.source !== "user" || !["admin", "super_admin"].includes(actor.role ?? "")) {
    throw new AppError(403, "force_attach_permission_required", "Forcing an EIN attach requires a workspace administrator session.")
  }
}

/** Admin-only: resolve forceDuplicate to an existing merchant id (caller audits after success). */
export async function resolveForceDuplicateAttach(
  actor: DealActor,
  input: { ein?: string; forceDuplicate?: boolean; attachMerchantId?: string },
): Promise<string | undefined> {
  if (!input.forceDuplicate || input.attachMerchantId?.trim()) return undefined
  assertAdminSessionForForceAttach(actor)
  const visible = await lookupMerchants(actor, { ein: input.ein })
  return visible.matches.find((item) => item.match === "ein")?.merchantId
}

export async function merchantCreateWarnings(
  actor: DealActor,
  input: { ein?: string; owners?: Array<{ identityLast4?: string }>; attachMerchantId?: string },
): Promise<string[]> {
  if (input.attachMerchantId) return []
  const einHash = einLookupHash(actor.workspaceId, input.ein)
  if (einHash && await workspaceEinExists(actor.workspaceId, einHash)) {
    const visible = await lookupMerchants(actor, { ein: input.ein })
    throw new MerchantExistsError(visible.matches.filter((match) => match.match === "ein"))
  }
  const lookup = await lookupMerchants(actor, { owners: input.owners })
  return lookup.matches
    .filter((match) => match.match === "identity_last4")
    .map((match) => `This business already exists: ${match.legalName}`)
}
