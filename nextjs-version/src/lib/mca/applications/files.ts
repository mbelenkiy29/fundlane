import "server-only"

import { createHash } from "node:crypto"
import { AppError } from "../errors"
import { getDatabase, newId, nowIso, withTransaction } from "../db"
import { documentScanner } from "../documents/scanner"
import { documentStorage } from "../documents/storage"
import type { DocumentCategory, DocumentProcessingState } from "../documents/contracts"
import type { ApplicationSession } from "./contracts"
import { getApplicationSession, requireActiveInvitation } from "./draft"

const MAX_BYTES = 25 * 1024 * 1024
const ALLOWED = new Set(["application/pdf", "image/png", "image/jpeg"])
const CATEGORIES = new Set(["statement", "application", "driver_license", "voided_check"])

function filenameOf(value: string): string {
  const cleaned = value.normalize("NFKC").replace(/[\\/\0\r\n]/g, "_").replace(/\s+/g, " ").trim()
  if (!cleaned || cleaned === "." || cleaned === "..") throw new AppError(422, "invalid_filename", "Choose a valid filename.")
  return cleaned.slice(0, 180)
}

function mimeMatches(mimeType: string, bytes: Uint8Array): boolean {
  if (mimeType === "application/pdf") return bytes.length >= 5 && Buffer.from(bytes.subarray(0, 5)).toString("ascii") === "%PDF-"
  if (mimeType === "image/png") return bytes.length >= 8 && Buffer.from(bytes.subarray(0, 8)).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  if (mimeType === "image/jpeg") return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
  return false
}

function scanState(status: string): DocumentProcessingState {
  if (status === "clean") return "ready"
  if (status === "infected") return "quarantined"
  if (status === "unavailable") return "pending_scan"
  return "scan_failed"
}

export async function stageInvitationFile(input: {
  token: string
  idempotencyKey: string
  category: string
  filename: string
  mimeType: string
  bytes: Uint8Array
}): Promise<ApplicationSession> {
  const row = await requireActiveInvitation(input.token)
  if (row.provider !== "fundlane") throw new AppError(409, "form_not_native", "This invitation uses a connected form and cannot upload files here.")
  if (!input.idempotencyKey?.trim() || input.idempotencyKey.length > 160) throw new AppError(422, "invalid_idempotency_key", "Provide a stable idempotency key.")
  if (!CATEGORIES.has(input.category)) throw new AppError(422, "invalid_category", "Choose a statement, application, ID, or voided check.")
  if (!ALLOWED.has(input.mimeType)) throw new AppError(415, "unsupported_document_type", "Upload a PDF, PNG, or JPEG document.")
  if (!input.bytes.byteLength || input.bytes.byteLength > MAX_BYTES) throw new AppError(413, "document_size_invalid", "Documents must be between 1 byte and 25 MB.")
  if (!mimeMatches(input.mimeType, input.bytes)) throw new AppError(422, "document_content_mismatch", "The file contents do not match the declared PDF or image type.")
  const filename = filenameOf(input.filename)
  const checksum = createHash("sha256").update(input.bytes).digest("hex")
  const existing = await getDatabase().prepare<{ id: string; checksum: string; category: string }>(
    "SELECT id,checksum,category FROM mca_application_invitation_files WHERE invitation_id=? AND idempotency_key=?",
  ).get(row.id, input.idempotencyKey)
  if (existing) {
    if (existing.checksum !== checksum || existing.category !== input.category) {
      throw new AppError(409, "idempotency_conflict", "That upload key was already used for a different file.")
    }
    return getApplicationSession(input.token)
  }
  const scan = await documentScanner().scan(input.bytes, filename)
  const processingState = scanState(scan.status)
  const id = newId()
  const storageKey = `invitations/${row.workspace_id}/${row.id}/${id}`
  await documentStorage().putImmutable(storageKey, input.bytes)
  const at = nowIso()
  await withTransaction(async () => {
    await getDatabase().prepare(`INSERT INTO mca_application_invitation_files
      (id,invitation_id,workspace_id,category,filename,mime_type,byte_length,checksum,storage_key,processing_state,idempotency_key,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      id, row.id, row.workspace_id, input.category, filename, input.mimeType, input.bytes.byteLength, checksum, storageKey, processingState, input.idempotencyKey, at,
    )
    await getDatabase().prepare("UPDATE mca_application_invitations SET last_activity_at=? WHERE workspace_id=? AND id=?").run(at, row.workspace_id, row.id)
    await getDatabase().prepare("INSERT INTO mca_application_invitation_events(invitation_id,workspace_id,kind,occurred_at) VALUES (?,?,?,?) ON CONFLICT(invitation_id,kind) DO NOTHING")
      .run(row.id, row.workspace_id, "uploaded", at)
  })
  if (processingState === "quarantined") throw new AppError(422, "file_quarantined", "This file could not be accepted. Upload a different document.")
  return getApplicationSession(input.token)
}

export async function invitationFileBytes(workspaceId: string, invitationId: string, fileId: string): Promise<{ filename: string; mimeType: string; category: DocumentCategory; bytes: Uint8Array; processingState: string }> {
  const row = await getDatabase().prepare<{
    filename: string; mime_type: string; category: DocumentCategory; storage_key: string; processing_state: string
  }>("SELECT filename,mime_type,category,storage_key,processing_state FROM mca_application_invitation_files WHERE workspace_id=? AND invitation_id=? AND id=?").get(workspaceId, invitationId, fileId)
  if (!row) throw new AppError(404, "file_not_found", "The uploaded file was not found.")
  return { filename: row.filename, mimeType: row.mime_type, category: row.category, processingState: row.processing_state, bytes: await documentStorage().get(row.storage_key) }
}
