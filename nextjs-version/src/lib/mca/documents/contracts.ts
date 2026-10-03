import type { DealActor, DealWriteInput } from "../deals/schema"

export const DOCUMENT_CATEGORIES = [
  "statement",
  "application",
  "api_application",
  "driver_license",
  "voided_check",
  "closing_document",
  "other_stip",
] as const

export type DocumentCategory = (typeof DOCUMENT_CATEGORIES)[number]

export const DOCUMENT_PROCESSING_STATES = [
  "pending_upload",
  "ready",
  "upload_failed",
  "pending_scan",
  "clean",
  "quarantined",
  "scan_failed",
] as const

export type DocumentProcessingState = (typeof DOCUMENT_PROCESSING_STATES)[number]

export interface UploadDocumentInput {
  dealId: string
  idempotencyKey: string
  filename: string
  mimeType: string
  bytes: Uint8Array
  category: DocumentCategory
  source: string
  sourceReference?: string
}

export interface DocumentSummary {
  id: string
  dealId: string
  workspaceId: string
  originalFilename: string
  displayFilename: string
  mimeType: string
  byteLength: number
  checksum: string
  category: DocumentCategory
  version: number
  createdAt: string
  processingState: DocumentProcessingState
  /** Present (true) only for an available file that the scan bypass let through without a virus scan. */
  scanBypassed?: true
}

/** The bypass scanner's name. Files it accepted keep this provider until a real scanner rescans them. */
export const NOT_SCANNED_PROVIDER = "not_scanned"

/** True when stored scan data shows the file was accepted by the scan bypass, not cleared by a real scanner. */
export function wasScanBypassed(provider: string | null | undefined, evidence: Record<string, unknown> | null | undefined): boolean {
  return provider === NOT_SCANNED_PROVIDER || evidence?.scanBypassed === true
}

export type DocumentActor = DealActor

export interface ApplicationExtraction {
  version: number
  fields: DealWriteInput
  evidence: Record<string, { confidence: number; page?: number; text?: string; unknown?: boolean }>
  warnings: string[]
  provider: string
  requestId?: string
}

export interface ExtractionFileInput {
  filename: string
  mimeType: string
  bytes: Uint8Array
  sourceReference: string
}

export interface FieldMappingSuggestion {
  mapping: Record<string, string>
  confidence: Record<string, number>
  warnings: string[]
  provider: string
}

export interface StatementMetadataExtraction {
  bankLabel?: { value: string; confidence: number; text?: string; page?: number }
  statementMonth?: { value: string; confidence: number; text?: string; page?: number }
  accountSuffix?: { value: string; confidence: number; text?: string; page?: number }
  warnings: string[]
  provider: string
  requestId?: string
}

/** Available bytes, either validated on upload or previously malware-scanned. */
export function isDocumentReady(state: string): boolean {
  return state === "ready" || state === "clean"
}
