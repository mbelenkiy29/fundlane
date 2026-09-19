import "server-only"

import { createHash } from "node:crypto"
import { einLookupHash } from "../merchants/lookup-hash"

export function submissionMerchantIdentityKey(input: {
  workspaceId: string
  ein?: string | null
  merchantId?: string | null
  dealId: string
}): string {
  const hash = einLookupHash(input.workspaceId, input.ein)
  if (hash) return `ein:${hash}`
  const merchantId = input.merchantId?.trim()
  if (merchantId) return `merchant:${merchantId}`
  return `deal:${input.dealId}`
}

export function packageFingerprint(checksums: string[]): string {
  const unique = [...new Set(checksums.filter((value) => Boolean(value)))].sort()
  return createHash("sha256").update(unique.join("\0")).digest("hex")
}
