import "server-only"

import { hmacLookup } from "../crypto"
import { normalizeEin, normalizeIdentityLast4 } from "./normalize"

export function einLookupHash(workspaceId: string, ein: string | undefined | null): string | undefined {
  const normalized = normalizeEin(ein)
  return normalized ? hmacLookup("ein", workspaceId, normalized) : undefined
}

export function identityLookupHash(workspaceId: string, last4: string | undefined | null): string | undefined {
  const normalized = normalizeIdentityLast4(last4)
  return normalized ? hmacLookup("id4", workspaceId, normalized) : undefined
}
