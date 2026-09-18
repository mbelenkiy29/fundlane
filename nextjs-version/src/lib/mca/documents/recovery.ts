import "server-only"

import { getDatabase } from "../db"
import { AppError } from "../errors"
import type { DealActor } from "../deals/schema"
import { isDocumentReady } from "./contracts"
import { retryDocumentScan } from "./service"

/** Explicit maintenance operation; ordinary reads never change document state. */
export async function recoverWorkspaceDocuments(actor: DealActor, apply = false) {
  if (actor.source !== "system" || actor.role !== "admin") {
    throw new AppError(403, "recovery_forbidden", "Document recovery requires a system administrator.")
  }
  const result = { candidates: 0, recovered: 0, failed: [] as { id: string; code: string }[] }
  let cursor = ""
  while (true) {
    const rows = await getDatabase().prepare<{ id: string }>(`SELECT id FROM mca_documents
      WHERE workspace_id = ? AND id > ? AND processing_state IN ('pending_scan', 'scan_failed', 'pending_upload', 'upload_failed')
      ORDER BY id LIMIT 100`).all(actor.workspaceId, cursor)
    if (!rows.length) break
    for (const row of rows) {
      cursor = row.id
      result.candidates++
      if (!apply) continue
      try {
        const document = await retryDocumentScan(actor, row.id)
        if (isDocumentReady(document.processingState)) result.recovered++
        else result.failed.push({ id: row.id, code: "document_blocked" })
      } catch (error) {
        result.failed.push({ id: row.id, code: error instanceof AppError ? error.code : "recovery_failed" })
      }
    }
  }
  return result
}
