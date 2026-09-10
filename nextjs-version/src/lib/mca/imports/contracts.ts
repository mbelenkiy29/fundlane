import type { DealStatus, DealWriteInput } from "../deals/schema"

export const IMPORT_FORMATS = ["csv", "tsv", "xlsx", "xls"] as const
export type ImportFormat = (typeof IMPORT_FORMATS)[number]

export const IMPORTABLE_FIELDS = [
  "legalName", "dbaName", "ein", "entityType", "contactName", "contactEmail", "contactPhone",
  "startDate", "industry", "naicsCode", "monthlyRevenue", "ficoScore", "fundingPurpose", "requestedAmount",
  "address.line1", "address.line2", "address.city", "address.state", "address.postalCode", "originatorMembershipId",
] as const
export type ImportableField = (typeof IMPORTABLE_FIELDS)[number]

export interface ImportSource { id: string; workspaceId: string; name: string; kind: "spreadsheet" | "drive"; active: boolean; createdAt: string }
export interface LeadBatch { id: string; workspaceId: string; sourceId: string; name: string; createdAt: string }
export interface MappingProfile { id: string; workspaceId: string; name: string; mapping: Record<string, ImportableField>; originatorMapping: Record<string, string>; createdAt: string; updatedAt: string }

export interface ParsedSpreadsheet {
  format: ImportFormat
  encoding: string
  sheetName: string
  headerRow: number
  headers: string[]
  rows: string[][]
  warnings: string[]
}

export interface ImportRowPreview {
  id: string
  rowNumber: number
  application: DealWriteInput
  sourceValues: Record<string, string>
  assignmentMembershipId: string | null
  errors: string[]
  warnings: string[]
  duplicateDealIds: string[]
  /** Raw external rep label/ID, retained encrypted until an admin resolves it. */
  originatorSourceValue: string | null
  /** Duplicates require an explicit create/skip decision before commit. */
  duplicateDecision: "create" | "skip" | null
}

export interface ImportPreview {
  runId: string
  workspaceId: string
  sourceId: string
  batchId: string
  filename: string
  format: ImportFormat
  state: "preview" | "committing" | "completed" | "cancelled" | "failed"
  previewRevision: number
  mapping: Record<string, ImportableField>
  mappingConfidence: Record<string, number>
  mappingProvider: string
  mappingWarnings: string[]
  assignmentPool: string[]
  rows: ImportRowPreview[]
  createdAt: string
}

export interface ImportCommitResult {
  runId: string
  state: "completed" | "cancelled" | "failed"
  created: number
  skipped: number
  failed: number
  resultsCsv: string
}

export interface UpdateRowPreview {
  id: string
  rowNumber: number
  dealId: string
  expectedVersion: number
  before: Record<string, unknown>
  /** Explicit clears are persisted as null and converted to undefined at the deal boundary. */
  changes: Record<string, unknown>
  status?: DealStatus
  clearFields: string[]
  errors: string[]
}

export interface UpdatePreview {
  runId: string
  previewRevision: number
  state: "preview" | "committing" | "completed" | "cancelled" | "failed"
  mapping: Record<string, string>
  headers: string[]
  rows: UpdateRowPreview[]
}

export const ARCHIVE_CATEGORIES = ["statement", "application", "api_application", "driver_license", "voided_check", "closing_document", "other_stip"] as const
export type ArchiveCategory = (typeof ARCHIVE_CATEGORIES)[number]
export interface ArchiveEntryPreview {
  archiveName: string
  path: string
  normalizedFolder: string
  byteLength: number
  category: ArchiveCategory
  candidateRowIds: string[]
  state: "exact" | "ambiguous" | "unmatched"
}

export interface DriveFileResult {
  id: string
  name: string
  mimeType: string
  size: number | null
  md5Checksum: string | null
  canDownload: boolean
  state: "listed" | "downloaded" | "denied" | "removed" | "too_large" | "unsupported"
  message?: string
}
