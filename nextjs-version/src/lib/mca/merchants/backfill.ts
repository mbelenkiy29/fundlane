import "server-only"

import { decryptSensitive } from "../crypto"
import type { MerchantBackfillResult } from "./contracts"
import { einLookupHash, identityLookupHash } from "./lookup-hash"
import {
  countMerchants,
  listDealOwnerRows,
  listWorkspaceDealRows,
  loadDealIdentity,
  persistDealEinLookupHash,
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
  return { dealCount: rows.length, merchantCount: await countMerchants(options.workspaceId) }
}
