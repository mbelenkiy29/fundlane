export const LEAD_SOURCE_KINDS = ["spreadsheet", "drive"] as const
export type LeadSourceKind = (typeof LEAD_SOURCE_KINDS)[number]

export const PURCHASE_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/
export const ACQUISITION_CORRELATION_PATTERN = /^[A-Za-z0-9._:-]{1,160}$/

export interface LeadProvider {
  id: string
  workspaceId: string
  name: string
  kind: LeadSourceKind
  active: boolean
  createdAt: string
  batchCount: number
}

export interface PurchaseBatch {
  id: string
  workspaceId: string
  sourceId: string
  sourceName: string
  name: string
  purchasedOn: string | null
  /** Integer cents. Null means missing cost; 0 is a real zero. */
  costCents: number | null
  inactive: boolean
  createdAt: string
  dealCount: number
}

export interface DealAcquisitionEvent {
  id: string
  workspaceId: string
  dealId: string
  sourceId: string | null
  batchId: string | null
  costCents: number | null
  purchasedOn: string | null
  actorUserId: string | null
  correlationId: string
  createdAt: string
}

export interface UnassignedDeal {
  id: string
  displayId: string
  legalName: string
  status: string
  createdAt: string
}

export interface LeadWorkspaceSnapshot {
  providers: LeadProvider[]
  batches: PurchaseBatch[]
  unassignedDeals: UnassignedDeal[]
  selectable: { providerIds: string[]; batchIds: string[] }
  canEditCost: boolean
  canManage: boolean
}

export interface PurchasedPackageCommitResult {
  runId: string
  state: "completed" | "cancelled" | "failed"
  created: number
  skipped: number
  failed: number
  attachedDealIds: string[]
  acquisitionEventIds: string[]
  resultsCsv: string
}

export function isPurchaseDate(value: string): boolean {
  if (!PURCHASE_DATE_PATTERN.test(value)) return false
  const [year, month, day] = value.split("-").map(Number)
  const date = new Date(Date.UTC(year, month - 1, day))
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
}

export function parsePurchaseCostInput(raw: string): { ok: true; costCents: number | null } | { ok: false; message: string } {
  const trimmed = raw.trim()
  if (!trimmed) return { ok: true, costCents: null }
  const normalized = trimmed.replace(/[$,\s]/g, "")
  if (!/^(0|[1-9]\d*)(?:\.\d{1,2})?$/.test(normalized)) {
    return { ok: false, message: "Enter dollars with at most two decimals, or leave blank if cost is unknown." }
  }
  const [whole, fraction = ""] = normalized.split(".")
  const costCents = Number(whole) * 100 + Number(fraction.padEnd(2, "0"))
  if (!Number.isSafeInteger(costCents) || costCents < 0) {
    return { ok: false, message: "Purchase cost must be a non-negative dollar amount." }
  }
  return { ok: true, costCents }
}

export function formatPurchaseCost(costCents: number | null): string {
  if (costCents === null) return "Not set"
  const sign = costCents < 0 ? "-" : ""
  const absolute = Math.abs(costCents)
  return `${sign}$${Math.floor(absolute / 100).toLocaleString("en-US")}.${String(absolute % 100).padStart(2, "0")}`
}

export function acquisitionCorrelationKey(kind: "import" | "intake" | "manual", stableId: string): string {
  return `acq:${kind}:${stableId}`
}
