import "server-only"

import { createHash } from "node:crypto"
import { AppError } from "../errors"
import { storageClient, validateStorageKey } from "../documents/storage"

export function artifactBucket(): string { return process.env.MCA_SUPABASE_ARTIFACT_BUCKET ?? "fundlane-artifacts" }

/** Server-generated files only. Browser uploads never receive capabilities for this bucket. */
export async function putPrivateArtifact(key: string, bytes: Uint8Array, contentType: string): Promise<void> {
  if (bytes.byteLength > 50 * 1024 * 1024) throw new AppError(413, "artifact_too_large", "This result exceeds 50 MB. Narrow the export filters or split the import into smaller batches.")
  const bucket = storageClient().storage.from(artifactBucket())
  const { error } = await bucket.upload(validateStorageKey(key), bytes, { upsert: false, contentType })
  if (error) {
    const existing = await bucket.download(key)
    if (existing.error || !existing.data || !Buffer.from(await existing.data.arrayBuffer()).equals(Buffer.from(bytes))) throw new AppError(503, "artifact_write_failed", "The operation result could not be saved.")
  }
}

export async function signedArtifactDownload(key: string, filename?: string): Promise<string> {
  const { data, error } = await storageClient().storage.from(artifactBucket()).createSignedUrl(validateStorageKey(key), 60, { download: filename ?? false })
  if (error || !data) throw new AppError(503, "artifact_download_failed", "The operation result is unavailable.")
  return data.signedUrl
}

export function artifactChecksum(bytes: Uint8Array): string { return createHash("sha256").update(bytes).digest("hex") }
