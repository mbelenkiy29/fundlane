import type { DealFilters } from "../deals/schema"

export const EXPORT_KINDS = ["deals", "offers", "all_deals_owners", "funded_deals"] as const
export type ExportKind = (typeof EXPORT_KINDS)[number]

export const EXPORT_JOB_STATES = ["queued", "ready", "failed", "expired"] as const
export type ExportJobState = (typeof EXPORT_JOB_STATES)[number]

export const WORKSPACE_EXPORT_KINDS = ["all_deals_owners", "funded_deals"] as const
export type WorkspaceExportKind = (typeof WORKSPACE_EXPORT_KINDS)[number]

export const ROLE_SCOPED_EXPORT_KINDS = ["deals", "offers"] as const
export type RoleScopedExportKind = (typeof ROLE_SCOPED_EXPORT_KINDS)[number]

export const EXPORT_ASYNC_ROW_THRESHOLD = 250
export const EXPORT_DOWNLOAD_TTL_MS = 60 * 60 * 1000
export const EXPORT_CORRELATION_MAX = 128

export const EXPORT_KIND_LABELS: Record<ExportKind, string> = {
  deals: "Visible deals",
  offers: "Visible offers",
  all_deals_owners: "All deals and owners",
  funded_deals: "Funded deals",
}

export const PAYMENT_EXPORT_DENIED_KEYS = [
  "commissionCents",
  "commission",
  "feeCents",
  "buyRate",
  "splits",
  "splitsJson",
  "accountingRecordIds",
  "ledger",
  "paymentId",
  "receivedAmountCents",
  "distribution",
] as const

export interface ExportField {
  key: string
  header: string
  identifier?: boolean
}

export interface ExportFieldManifest {
  kind: ExportKind
  label: string
  description: string
  fields: readonly ExportField[]
  isPaymentExport: false
}

export interface ExportSnapshot {
  version: 1
  filters: DealFilters
  capturedAt: string
  rowKeys: string[]
  rows: Array<Record<string, string | number | null>>
  error?: { code: string; message: string }
}

export interface ExportJobView {
  id: string
  kind: ExportKind
  kindLabel: string
  state: ExportJobState
  rowCount: number | null
  checksum: string | null
  filename: string
  fieldManifest: ExportField[]
  isPaymentExport: false
  replayed: boolean
  createdAt: string
  updatedAt: string
  correlationId: string
  error?: { code: string; message: string }
}

export interface ExportDownload {
  url: string
  expiresAt: string
}

export interface ExportCapabilities {
  exportEnabled: boolean
  roleScoped: boolean
  workspace: boolean
  kinds: ExportKind[]
  isPaymentExport: false
  asyncThreshold: number
}

export interface CreateExportInput {
  kind: ExportKind
  filters?: DealFilters
  correlationId: string
  async?: boolean
  nowIso?: string
}

export interface MintExportDownloadInput {
  ttlMs?: number
  nowIso?: string
}

export const EXPORT_PANEL_COPY = {
  title: "CSV exports",
  description: "Download the deals and offers you can already see. Standard exports omit payments and ledger rows.",
  offersWorkspace: "This downloads every offer you can already see, not only the selected deal.",
  notPayment: "This is not a payment export.",
  loading: "Loading exports…",
  empty: "No export jobs yet. Choose a format to generate a CSV of the records you can see.",
  disabled: "Deal exports are disabled for this workspace.",
  workspaceOnly: "All-deals and funded-deals workspace exports are only available to admins.",
  queued: "Preparing a large export…",
  ready: "Export ready.",
  failed: "Export failed. Retry to resume the same job.",
  validation: "Review the highlighted export fields.",
  success: "CSV generated. Row count matches the query snapshot.",
  retry: "Retry",
  download: "Download CSV",
  deals: "Export visible deals",
  offers: "Export visible offers",
  allDealsOwners: "Export all deals and owners",
  fundedDeals: "Export funded deals",
} as const

export function isExportKind(value: unknown): value is ExportKind {
  return typeof value === "string" && (EXPORT_KINDS as readonly string[]).includes(value)
}

export function isWorkspaceExportKind(kind: ExportKind): kind is WorkspaceExportKind {
  return (WORKSPACE_EXPORT_KINDS as readonly string[]).includes(kind)
}

export function exportFilename(kind: ExportKind, capturedAt: string): string {
  const day = capturedAt.slice(0, 10) || "export"
  if (kind === "all_deals_owners") return `deals_export_${day}.csv`
  if (kind === "funded_deals") return `mca-funded-deals-${day}.csv`
  if (kind === "offers") return `mca-offers-${day}.csv`
  return `mca-deals-${day}.csv`
}
