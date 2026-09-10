import "server-only"

import { AppError } from "../errors"
import { recordAuditEvent } from "../db"
import type { DealActor } from "../deals/schema"
import { extractStatementMetadata } from "./extraction"
import { getDocumentContent, getDocument, suggestStatementFilename } from "./service"
import { updateDocumentDisplayFilename } from "./repository"

export interface StatementFilenamePreview {
  documentId: string
  originalFilename: string
  currentFilename: string
  suggestedFilename: string
  candidates: {
    bankLabel?: { value: string; confidence: number; text?: string; page?: number }
    statementMonth?: { value: string; confidence: number; text?: string; page?: number }
    accountSuffix?: { value: string; confidence: number; text?: string; page?: number }
  }
  warnings: string[]
  uncertain: boolean
  provider: string
}

export async function previewStatementFilename(actor: DealActor, documentId: string): Promise<StatementFilenamePreview> {
  const { document, bytes } = await getDocumentContent(actor, documentId)
  if (document.category !== "statement") throw new AppError(422, "document_category_invalid", "Choose a bank statement document.")
  const metadata = await extractStatementMetadata(actor, { filename: document.originalFilename, mimeType: document.mimeType, bytes, sourceReference: `${document.id}:v${document.version}` })
  const candidates = { bankLabel: metadata.bankLabel, statementMonth: metadata.statementMonth, accountSuffix: metadata.accountSuffix }
  return {
    documentId: document.id, originalFilename: document.originalFilename, currentFilename: document.displayFilename,
    suggestedFilename: suggestStatementFilename({ documentId, bankLabel: metadata.bankLabel?.value, statementMonth: metadata.statementMonth?.value, accountSuffix: metadata.accountSuffix?.value }),
    candidates, warnings: metadata.warnings,
    uncertain: Object.values(candidates).some((item) => !item || item.confidence < 0.8), provider: metadata.provider,
  }
}

export async function applyStatementFilename(actor: DealActor, input: { documentId: string; bankLabel?: string; statementMonth?: string; accountSuffix?: string }): Promise<StatementFilenamePreview> {
  const document = await getDocument(actor, input.documentId)
  if (document.category !== "statement") throw new AppError(422, "document_category_invalid", "Choose a bank statement document.")
  const suffixDigits = input.accountSuffix?.replace(/\D/g, "")
  if (suffixDigits && suffixDigits.length > 4) throw new AppError(422, "account_suffix_invalid", "Use only the final four account digits.")
  const suggestedFilename = suggestStatementFilename({ documentId: document.id, bankLabel: input.bankLabel, statementMonth: input.statementMonth, accountSuffix: suffixDigits })
  await updateDocumentDisplayFilename(actor.workspaceId, document.id, suggestedFilename, new Date().toISOString())
  await recordAuditEvent({ context: actor, action: "statement.filename_applied", resourceType: "document", resourceId: document.id, metadata: { correctedByUser: true, bankProvided: Boolean(input.bankLabel), monthProvided: Boolean(input.statementMonth), accountSuffixIncluded: Boolean(suffixDigits) }, correlationId: actor.correlationId })
  return { documentId: document.id, originalFilename: document.originalFilename, currentFilename: suggestedFilename, suggestedFilename, candidates: {}, warnings: [], uncertain: !input.bankLabel || !input.statementMonth, provider: "manual-correction" }
}
