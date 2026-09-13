import "server-only"

import { getDatabase } from "../db"
import { quarantineBucket, storageClient, usesSupabaseStorage, validateStorageKey } from "../documents/storage"

export async function cleanupWorkerStorage(): Promise<void> {
  if (!usesSupabaseStorage()) return
  const cutoff = new Date(Date.now() - 24 * 60 * 60_000).toISOString()
  const uploads = await getDatabase().prepare<{ id: string; storage_key: string }>(`SELECT u.id,u.storage_key FROM mca_document_uploads u
    WHERE u.expires_at<? AND NOT EXISTS (SELECT 1 FROM mca_background_jobs j WHERE j.workspace_id=u.workspace_id AND j.state IN ('queued','running')
      AND (j.id=u.job_id OR j.payload_json LIKE '%' || u.id || '%')) ORDER BY u.created_at LIMIT 50`).all(cutoff)
  const storage = storageClient().storage.from(quarantineBucket())
  for (const upload of uploads) {
    const { error } = await storage.remove([validateStorageKey(upload.storage_key)])
    if (!error) await getDatabase().prepare("DELETE FROM mca_document_uploads WHERE id=?").run(upload.id)
  }
  const scans = await getDatabase().prepare<{ resource_id: string }>("SELECT resource_id FROM mca_background_jobs WHERE kind='assistant_scan' AND state IN ('complete','failed') AND updated_at<? ORDER BY updated_at DESC LIMIT 50").all(cutoff)
  if (scans.length) await storage.remove(scans.map((scan) => validateStorageKey(scan.resource_id)))
}
