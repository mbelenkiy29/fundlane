import "server-only"

/** Selected Data Merch contract: GET /v2/merchants with Bearer auth and query `q`. */
export const DATAMERCH_MERCHANTS_URL = "https://api.datamerch.com/v2/merchants"

export interface DataMerchRecordPayload {
  category?: string
  notes?: string
  funder?: string
  created_at?: string
  date?: string
}

export interface DataMerchMerchantPayload {
  id?: string
  name?: string
  ein?: string
  risk_level?: string
  records?: DataMerchRecordPayload[]
}

export type DataMerchLookupFailureKind = "credential_expired" | "unauthorized" | "unreachable" | "invalid_response"

export type DataMerchLookupResult =
  | { ok: true; merchants: DataMerchMerchantPayload[]; recordCount: number }
  | { ok: false; kind: DataMerchLookupFailureKind; status?: number }

export type DataMerchFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

let fetchOverride: DataMerchFetch | undefined

export function setDataMerchFetchForTests(fetchImpl?: DataMerchFetch): void {
  fetchOverride = fetchImpl
}

function http(): DataMerchFetch {
  return fetchOverride ?? globalThis.fetch
}

function asMerchants(value: unknown): DataMerchMerchantPayload[] {
  if (!value || typeof value !== "object") return []
  const merchants = (value as { merchants?: unknown }).merchants
  if (!Array.isArray(merchants)) {
    const records = (value as { records?: unknown }).records
    if (Array.isArray(records)) return [{ records: records as DataMerchRecordPayload[] }]
    return []
  }
  return merchants.filter((item): item is DataMerchMerchantPayload => Boolean(item) && typeof item === "object")
}

function countRecords(merchants: DataMerchMerchantPayload[]): number {
  return merchants.reduce((sum, merchant) => {
    if (Array.isArray(merchant.records)) return sum + merchant.records.length
    return sum + 1
  }, 0)
}

/**
 * Maps GET https://api.datamerch.com/v2/merchants into a workspace-safe result.
 * Live credentials remain an external gate; tests inject fixture HTTP.
 */
export async function lookupMerchants(input: { credential: string; query: string }): Promise<DataMerchLookupResult> {
  const url = new URL(DATAMERCH_MERCHANTS_URL)
  url.searchParams.set("q", input.query)
  try {
    const response = await http()(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${input.credential}`,
        Accept: "application/json",
        "Content-Type": "application/json",
      },
    })
    if (response.status === 401) return { ok: false, kind: "credential_expired", status: 401 }
    if (response.status === 403) return { ok: false, kind: "unauthorized", status: 403 }
    if (!response.ok) return { ok: false, kind: "unreachable", status: response.status }
    const payload: unknown = await response.json().catch(() => null)
    const merchants = asMerchants(payload)
    return { ok: true, merchants, recordCount: countRecords(merchants) }
  } catch {
    return { ok: false, kind: "unreachable" }
  }
}
