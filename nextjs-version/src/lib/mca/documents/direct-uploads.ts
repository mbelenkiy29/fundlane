import "server-only"

import { createHash } from "node:crypto"
import { encryptSensitive, decryptSensitive, hashOpaqueToken } from "../crypto"
import { getDatabase, newId, nowIso, withImmediateTransaction } from "../db"
import type { DealActor } from "../deals/schema"
import { getDealForDocument } from "../deals/service"
import { AppError } from "../errors"
import { merchantUploadBinding, uploadMerchantDocument } from "../closing/service"
import { backgroundJobView, currentJobActor, enqueueBackgroundJob, type BackgroundJob } from "../jobs/queue"
import { createApplicationDraft } from "./application-drafts"
import { DOCUMENT_CATEGORIES, type DocumentCategory } from "./contracts"
import { MAX_DOCUMENT_BYTES, storeDocument } from "./service"
import { quarantineBucket, storageClient, usesSupabaseStorage } from "./storage"
import { MULTIPART_TASK_ENDPOINTS } from "../jobs/contracts"

type UploadPurpose = "document" | "draft" | "merchant" | "task_file"
interface UploadRow {
  id: string; workspace_id: string; owner_key: string; purpose: UploadPurpose; idempotency_key: string; storage_key: string
  byte_length: number; checksum: string; mime_type: string; filename: string; payload_json: string; actor_json: string
  job_id: string | null; expires_at: string
}
export interface DirectUploadInput {
  purpose: UploadPurpose; idempotencyKey: string; filename: string; mimeType: string; byteLength: number; checksum: string
  dealId?: string; category?: DocumentCategory; source?: string; sourceReference?: string; merchantToken?: string; taskEndpoint?: string
}
type Principal = { actor: DealActor; ownerKey: string; merchant?: Awaited<ReturnType<typeof merchantUploadBinding>> }

export function validateDirectUpload(input: DirectUploadInput): void {
  if (!["document", "draft", "merchant", "task_file"].includes(input.purpose)) throw new AppError(422, "upload_purpose_invalid", "Choose a valid upload destination.")
  if (!input.idempotencyKey || input.idempotencyKey.length > 160) throw new AppError(422, "invalid_idempotency_key", "Provide a stable upload retry key.")
  if (!Number.isInteger(input.byteLength) || input.byteLength < 1 || input.byteLength > MAX_DOCUMENT_BYTES) throw new AppError(413, "document_size_invalid", "Documents must be between 1 byte and 25 MB.")
  if (!/^[a-f0-9]{64}$/.test(input.checksum)) throw new AppError(422, "checksum_invalid", "Provide the file's SHA-256 checksum.")
  if (input.purpose !== "task_file" && (!["application/pdf", "image/png", "image/jpeg"].includes(input.mimeType) || (input.purpose === "draft" && input.mimeType !== "application/pdf"))) throw new AppError(415, "unsupported_document_type", "Choose a supported PDF, PNG, or JPEG file.")
  if (input.purpose === "task_file" && (!(MULTIPART_TASK_ENDPOINTS as readonly string[]).includes(input.taskEndpoint ?? "") || !/\.(csv|tsv|xlsx|xls|zip|pdf|png|jpe?g|docx|pptx|txt|md)$/i.test(input.filename))) throw new AppError(415, "task_upload_invalid", "Choose a supported import file and destination.")
  if (!input.filename?.trim() || input.filename.length > 180 || /[\0\r\n]/.test(input.filename)) throw new AppError(422, "invalid_filename", "Choose a valid filename.")
  if (input.purpose === "document" && (!input.category || !DOCUMENT_CATEGORIES.includes(input.category))) throw new AppError(422, "category_invalid", "Choose a valid document category.")
}

export async function uploadPrincipal(actor: DealActor | undefined, merchantToken?: string, allowConsumed = false): Promise<Principal> {
  if (merchantToken) {
    const merchant = await merchantUploadBinding(merchantToken, allowConsumed)
    return { merchant, ownerKey: `merchant:${hashOpaqueToken(merchantToken)}`, actor: { workspaceId: merchant.workspaceId, userId: null, membershipId: null, role: "admin", managedMembershipIds: [], activeMembershipIds: [], source: "system", correlationId: newId() } }
  }
  if (!actor) throw new AppError(401, "authentication_required", "Sign in to upload a document.")
  return { actor, ownerKey: `${actor.source}:${actor.userId ?? actor.apiKeyId ?? "api"}:${actor.membershipId ?? "none"}` }
}

export async function authorizeDirectUpload(principal: Principal, input: DirectUploadInput) {
  validateDirectUpload(input)
  if (!usesSupabaseStorage()) throw new AppError(409, "direct_upload_unavailable", "Direct uploads require Supabase Storage.")
  if ((input.purpose === "merchant") !== Boolean(principal.merchant)) throw new AppError(403, "upload_destination_forbidden", "This upload destination is not available.")
  if (input.purpose === "task_file" && (principal.actor.source !== "user" || (input.taskEndpoint !== "/api/mca/assistant/files" && !["admin", "super_admin"].includes(principal.actor.role ?? "")))) throw new AppError(403, "permission_denied", "This upload requires an authorized company member.")
  if (input.purpose === "document") await getDealForDocument(principal.actor, input.dealId ?? "")
  const payload = principal.merchant
    ? { linkId: principal.merchant.linkId, tokenCipher: encryptSensitive(input.merchantToken!, principal.actor.workspaceId) }
    : { dealId: input.dealId, category: input.category, source: input.source?.slice(0, 80) ?? "user_upload", sourceReference: input.sourceReference?.slice(0, 300), taskEndpoint: input.taskEndpoint }
  const id = newId()
  const row = await getDatabase().prepare<UploadRow>(`INSERT INTO mca_document_uploads
    (id,workspace_id,owner_key,purpose,idempotency_key,storage_key,byte_length,checksum,mime_type,filename,payload_json,actor_json,expires_at,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT (workspace_id,owner_key,purpose,idempotency_key) DO NOTHING RETURNING *`)
    .get(id, principal.actor.workspaceId, principal.ownerKey, input.purpose, input.idempotencyKey, `${principal.actor.workspaceId}/uploads/${id}`, input.byteLength, input.checksum, input.mimeType, input.filename,
      JSON.stringify(payload), JSON.stringify(principal.actor), new Date(Date.now() + 2 * 60 * 60_000).toISOString(), nowIso())
    ?? await getDatabase().prepare<UploadRow>("SELECT * FROM mca_document_uploads WHERE workspace_id=? AND owner_key=? AND purpose=? AND idempotency_key=?")
      .get(principal.actor.workspaceId, principal.ownerKey, input.purpose, input.idempotencyKey)
  if (!row || row.byte_length !== input.byteLength || row.checksum !== input.checksum || row.mime_type !== input.mimeType || row.filename !== input.filename || (!principal.merchant && row.payload_json !== JSON.stringify(payload))) throw new AppError(409, "idempotency_conflict", "That upload retry key belongs to another file or destination.")
  if (row.job_id) return { uploadId: row.id, alreadyUploaded: true }
  if (row.expires_at <= nowIso()) throw new AppError(410, "upload_expired", "This upload expired. Start a new upload.")
  // upsert=false is encoded into the capability: replaying a URL cannot replace accepted bytes.
  const { data, error } = await storageClient().storage.from(quarantineBucket()).createSignedUploadUrl(row.storage_key, { upsert: false })
  if (error || !data) throw new AppError(503, "upload_authorization_failed", "Document storage could not authorize this upload.")
  return { uploadId: row.id, signedUrl: data.signedUrl, path: data.path, token: data.token }
}

async function findUpload(principal: Principal, id: string): Promise<UploadRow> {
  const row = await getDatabase().prepare<UploadRow>("SELECT * FROM mca_document_uploads WHERE id=? AND workspace_id=? AND owner_key=?").get(id, principal.actor.workspaceId, principal.ownerKey)
  if (!row) throw new AppError(404, "upload_not_found", "This upload was not found.")
  if (row.purpose === "document") await getDealForDocument(principal.actor, JSON.parse(row.payload_json).dealId)
  return row
}

export async function completeDirectUpload(principal: Principal, id: string) {
  const row = await findUpload(principal, id)
  if (!row.job_id) {
    if (row.expires_at <= nowIso()) throw new AppError(410, "upload_expired", "This upload has expired.")
    const { data, error } = await storageClient().storage.from(quarantineBucket()).info(row.storage_key)
    if (error || !data) throw new AppError(409, "upload_incomplete", "The file is not uploaded yet. Retry with the same file.")
    if (data.size !== row.byte_length) throw new AppError(422, "upload_size_mismatch", "The uploaded bytes do not match the authorized file size.")
    if (row.purpose === "task_file") return { uploadId: row.id }
    await withImmediateTransaction(async () => {
      const job = await enqueueBackgroundJob({ actor: principal.actor, kind: "document_upload", resourceId: row.id, idempotencyKey: row.id, payload: { uploadId: row.id } })
      await getDatabase().prepare("UPDATE mca_document_uploads SET job_id=? WHERE id=? AND workspace_id=?").run(job.id, row.id, row.workspace_id)
    })
  }
  return directUploadStatus(principal, id)
}

export async function directUploadStatus(principal: Principal, id: string) {
  const row = await findUpload(principal, id)
  if (!row.job_id) return { uploadId: row.id, state: "uploading" }
  const job = await getDatabase().prepare<BackgroundJob>("SELECT * FROM mca_background_jobs WHERE id=? AND workspace_id=?").get(row.job_id, row.workspace_id)
  if (!job) throw new AppError(404, "job_not_found", "The upload job was not found.")
  return { uploadId: row.id, ...backgroundJobView(job) }
}

export async function processDirectUpload(workspaceId: string, id: string): Promise<unknown> {
  const row = await getDatabase().prepare<UploadRow>("SELECT * FROM mca_document_uploads WHERE id=? AND workspace_id=?").get(id, workspaceId)
  if (!row) throw new AppError(404, "upload_not_found", "Upload not found.")
  const actor = await currentJobActor(JSON.parse(row.actor_json) as DealActor)
  const { data, error } = await storageClient().storage.from(quarantineBucket()).download(row.storage_key)
  if (error || !data) throw new AppError(503, "quarantine_read_failed", "The uploaded file could not be read.")
  if (data.size !== row.byte_length || data.size > MAX_DOCUMENT_BYTES) throw new AppError(422, "upload_size_mismatch", "Uploaded file size does not match.")
  const bytes = new Uint8Array(await data.arrayBuffer())
  if (createHash("sha256").update(bytes).digest("hex") !== row.checksum) throw new AppError(422, "upload_checksum_mismatch", "Uploaded file checksum does not match.")
  const input = { idempotencyKey: row.idempotency_key, filename: row.filename, mimeType: row.mime_type, bytes }
  const payload = JSON.parse(row.payload_json)
  if (row.purpose === "merchant") return uploadMerchantDocument(decryptSensitive(payload.tokenCipher, workspaceId), input)
  if (row.purpose === "draft") return createApplicationDraft(actor, input)
  return storeDocument(actor, { ...input, ...payload })
}

export async function taskUploadFile(actor: DealActor, id: string, endpoint: string): Promise<{ filename: string; mimeType: string; bytes: Uint8Array }> {
  const principal = await uploadPrincipal(actor)
  const row = await findUpload(principal, id)
  if (row.purpose !== "task_file" || JSON.parse(row.payload_json).taskEndpoint !== endpoint) throw new AppError(404, "upload_not_found", "This file does not belong to the requested operation.")
  const { data, error } = await storageClient().storage.from(quarantineBucket()).download(row.storage_key)
  if (error || !data) throw new AppError(503, "quarantine_read_failed", "The staged file could not be read.")
  if (data.size !== row.byte_length || data.size > MAX_DOCUMENT_BYTES) throw new AppError(422, "upload_size_mismatch", "Uploaded file size does not match.")
  const bytes = new Uint8Array(await data.arrayBuffer())
  if (createHash("sha256").update(bytes).digest("hex") !== row.checksum) throw new AppError(422, "upload_checksum_mismatch", "Uploaded file checksum does not match.")
  return { filename: row.filename, mimeType: row.mime_type, bytes }
}
