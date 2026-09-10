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
