import "server-only"

import type { DealActor } from "../deals/schema"
import { taskUploadFile } from "../documents/direct-uploads"
import { documentScanner, scannerFailure } from "../documents/scanner"
import { AppError } from "../errors"
import { previewSpreadsheetImport, previewCsvUpdate } from "../imports/service"
import { previewArchiveMatches, applyArchiveMatches } from "../imports/archive-service"
import { previewPurchasedPackage } from "../leads/service"
import { parseHistoricalSpreadsheet } from "../historical/parser"
import { previewHistoricalImport } from "../historical/service"
import { uploadAndScanFunderCriteria } from "../funders/criteria-scan"
import { getWorkspaceSettings } from "../workspaces"
import type { MultipartTaskInput } from "./contracts"
import { ownedConversation } from "../assistant/repository"
import { storeFile } from "../assistant/files"
import { filesEnabled } from "../assistant/experience-contracts"

export async function processMultipartTask(actor: DealActor, input: MultipartTaskInput): Promise<unknown> {
  if (input.endpoint === "/api/mca/assistant/files") {
    if (!filesEnabled()) throw new AppError(503, "files_disabled", "File processing is currently unavailable.")
    if (actor.source !== "user" || input.files.length !== 1) throw new AppError(403, "permission_denied", "Upload one file to an authorized conversation.")
    const conversation = await ownedConversation(actor, input.fields.conversationId ?? "")
    const file = await taskUploadFile(actor, input.files[0].uploadId, input.endpoint)
    return { file: await storeFile(actor, conversation, file.filename, Buffer.from(file.bytes)) }
  }
  if (actor.source !== "user" || !["admin", "super_admin"].includes(actor.role ?? "")) throw new AppError(403, "permission_denied", "Administrator access is required.")
  const settings = await getWorkspaceSettings(actor.workspaceId)
  if ((input.endpoint === "/api/mca/historical/preview" && !settings.pageVisibility.deals) || (input.endpoint === "/api/mca/leads/packages/preview" && !settings.pageVisibility.integrations && !settings.pageVisibility.deals)) throw new AppError(403, "page_disabled", "This workflow is disabled for this workspace.")
  const files = []
  for (const reference of input.files) {
    const file = await taskUploadFile(actor, reference.uploadId, input.endpoint)
    const scan = await documentScanner().scan(file.bytes, file.filename)
    if (scan.status === "infected") throw new AppError(422, "file_quarantined", "Security scanning rejected this file.")
    if (scan.status !== "clean") throw scannerFailure(scan.evidence, "Security scanning must succeed before this file can be processed.")
    files.push({ ...file, field: reference.field })
  }
  const fields = input.fields
  const json = <T,>(name: string, fallback: T): T => fields[name] ? JSON.parse(fields[name]) as T : fallback
  const file = files.find((item) => item.field === "file")
  const base = { sourceId: fields.sourceId ?? "", batchId: fields.batchId ?? "", filename: file?.filename ?? "", bytes: file?.bytes ?? new Uint8Array(), mapping: json<Record<string, string> | undefined>("mapping", undefined) }
  switch (input.endpoint) {
    case "/api/mca/imports/preview": return previewSpreadsheetImport(actor, { ...base, originatorMapping: json("originatorMapping", {}), assignmentPool: json("assignmentPool", []), useAiMapping: fields.useAiMapping === "true" })
    case "/api/mca/imports/update/preview": return previewCsvUpdate(actor, base)
    case "/api/mca/leads/packages/preview": return previewPurchasedPackage(actor, base)
    case "/api/mca/historical/preview": return previewHistoricalImport(actor, { sourceId: base.sourceId, batchId: base.batchId, rows: parseHistoricalSpreadsheet(base) })
    case "/api/mca/imports/archives/preview": return previewArchiveMatches(actor, { runId: fields.runId ?? "", archives: files.filter((item) => item.field === "archives") })
    case "/api/mca/imports/archives/apply": return applyArchiveMatches(actor, { runId: fields.runId ?? "", archives: files.filter((item) => item.field === "archives"), confirmations: json("confirmations", []) })
    case "/api/mca/funders/scan": {
      if (!file) throw new AppError(422, "file_required", "Choose a criteria sheet.")
      return uploadAndScanFunderCriteria(actor, { ...file, funderId: fields.funderId ?? "", dealId: fields.dealId || undefined, idempotencyKey: fields.idempotencyKey ?? input.files[0].uploadId })
    }
  }
}
