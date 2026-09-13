import { RequestError, requestJson } from "@/lib/mca/client"
import type { MerchantAttachPayload, MerchantLookupResult, MerchantMatch } from "@/lib/mca/merchants/contracts"

export function last4Owners(owners: Array<{ identityLast4?: string }>): Array<{ identityLast4: string }> {
  return owners
    .map((owner) => ({ identityLast4: owner.identityLast4?.replace(/\D/g, "") }))
    .filter((owner): owner is { identityLast4: string } => owner.identityLast4?.length === 4)
}

export async function lookupMerchantMatches(input: { ein?: string; owners?: Array<{ identityLast4?: string }> }): Promise<MerchantMatch[]> {
  const ein = input.ein?.trim() || undefined
  const owners = last4Owners(input.owners ?? [])
  if (!ein && !owners.length) return []
  const result = await requestJson<MerchantLookupResult>("/api/mca/merchants/lookup", {
    method: "POST",
    body: JSON.stringify({ ein, owners: owners.length ? owners : undefined }),
  })
  return result.matches
}

export async function loadAttachPayload(merchantId: string): Promise<MerchantAttachPayload> {
  return requestJson<MerchantAttachPayload>(`/api/mca/merchants/${encodeURIComponent(merchantId)}`)
}

export function merchantMatchesFromError(error: unknown): MerchantMatch[] {
  if (error instanceof RequestError && error.status === 409 && error.code === "merchant_exists" && Array.isArray(error.matches)) {
    return error.matches as MerchantMatch[]
  }
  return []
}
