import "server-only"

import { decryptSensitive } from "../crypto"
import type { MerchantBackfillResult } from "./contracts"
import { einLookupHash, identityLookupHash } from "./lookup-hash"
import {
  countMerchants,
  listDealOwnerRows,
  listMerchantOwnerRows,
  listWorkspaceDealRows,
  listWorkspaceMerchantRows,
  loadDealIdentity,
  persistDealEinLookupHash,
  persistMerchantEinLookupHash,
  persistMerchantOwnerIdentityLookupHash,
  persistOwnerIdentityLookupHash,
  upsertMerchantFromDeal,
} from "./repository"

function decrypt(value: unknown, workspaceId: string): string | undefined {
  return typeof value === "string" && value ? decryptSensitive(value, workspaceId) : undefined
}

export async function backfillMerchantHashes(options: { workspaceId?: string } = {}): Promise<MerchantBackfillResult> {
  const rows = await listWorkspaceDealRows(options.workspaceId)
  for (const row of rows) {
    const identity = await loadDealIdentity(String(row.workspace_id), String(row.id))
    if (!identity) continue
    await persistDealEinLookupHash(
      identity.workspaceId,
      identity.id,
      einLookupHash(identity.workspaceId, identity.ein) ?? null,
    )
    const owners = await listDealOwnerRows(identity.workspaceId, identity.id)
    for (const owner of owners) {
      await persistOwnerIdentityLookupHash(
        identity.workspaceId,
        String(owner.id),
        identityLookupHash(identity.workspaceId, decrypt(owner.identity_last4_cipher, identity.workspaceId)) ?? null,
      )
    }
    await upsertMerchantFromDeal(identity)
  }

  const merchants = await listWorkspaceMerchantRows(options.workspaceId)
  for (const merchant of merchants) {
    const workspaceId = String(merchant.workspace_id)
    const merchantId = String(merchant.id)
    await persistMerchantEinLookupHash(
      workspaceId,
      merchantId,
      einLookupHash(workspaceId, decrypt(merchant.ein_cipher, workspaceId)) ?? null,
    )
    const merchantOwners = await listMerchantOwnerRows(workspaceId, merchantId)
    for (const owner of merchantOwners) {
      await persistMerchantOwnerIdentityLookupHash(
        workspaceId,
        String(owner.id),
        identityLookupHash(workspaceId, decrypt(owner.identity_last4_cipher, workspaceId)) ?? null,
      )
    }
  }

  return { dealCount: rows.length, merchantCount: await countMerchants(options.workspaceId) }
}
