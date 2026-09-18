import { createHash, randomUUID } from "node:crypto"
import { getDatabase, withTransaction } from "../db"
import { AppError } from "../errors"
import { quarantineBucket, storageClient } from "./storage"
import { fetchVerisysScan, submitVerisysScan, verifiedObjectScan, verisysResult, type ObjectScanResult } from "./verisys"
import type { BackgroundJob } from "../jobs/queue"

type ScanRow = { id: string; job_id: string; workspace_id: string; object_key: string; sha256: string; byte_length: number; provider_id: string | null; state: ObjectScanResult["status"]; evidence_json: Record<string, unknown> | null }
const result = (row: ScanRow): ObjectScanResult => ({ status: row.state, provider: "verisys", evidence: row.evidence_json ?? { scanId: row.provider_id } })

/** Called by resumable stages with an already-authorized, currently leased job. */
export async function prepareObjectScan(job: BackgroundJob, bytes: Uint8Array, filename: string): Promise<ObjectScanResult> {
  if (!bytes.byteLength || bytes.byteLength > 25 * 1024 * 1024) throw new AppError(413, "file_limit", "The scan exceeds the existing upload limit.")
  const sha256 = createHash("sha256").update(bytes).digest("hex"), objectKey = `${job.workspace_id}/worker-scans/${job.id}/${sha256}`
  const db = getDatabase(), id = randomUUID()
  await db.prepare(`INSERT INTO mca_private.verisys_scans(id,job_id,workspace_id,object_key,sha256,byte_length)
    SELECT ?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM mca_background_jobs WHERE id=? AND workspace_id=? AND state='running' AND lease_token=? AND lease_expires_at::timestamptz>now())
    ON CONFLICT(job_id,sha256) DO NOTHING`).run(id,job.id,job.workspace_id,objectKey,sha256,bytes.byteLength,job.id,job.workspace_id,job.lease_token)
  const row = await db.prepare<ScanRow>("SELECT * FROM mca_private.verisys_scans WHERE job_id=? AND workspace_id=? AND sha256=?").get(job.id,job.workspace_id,sha256)
  if (!row) throw new AppError(409,"job_lease_lost","The scan job lease expired.")
  if (row.state !== "pending" || row.provider_id) return result(row)
  const token = randomUUID()
  const leased = await db.prepare(`UPDATE mca_private.verisys_scans SET submit_token=?,submit_expires_at=now()+interval '120 seconds'
    WHERE id=? AND state='pending' AND provider_id IS NULL AND (submit_expires_at IS NULL OR submit_expires_at<now()) RETURNING id`).get(token,row.id)
  if (!leased) return result(row)
  try {
    const storage = storageClient().storage.from(quarantineBucket())
    const uploaded = await storage.upload(objectKey,bytes,{upsert:false,contentType:"application/octet-stream"})
    if (uploaded.error) {
      const existing = await storage.download(objectKey)
      if (existing.error || !existing.data || createHash("sha256").update(new Uint8Array(await existing.data.arrayBuffer())).digest("hex") !== sha256) throw new AppError(409,"scan_object_conflict","The immutable scan object could not be verified.")
    }
    const signed = await storage.createSignedUrl(objectKey,300)
    if (signed.error || !signed.data) throw new AppError(503,"scanner_unavailable","The scanner could not access the private object.")
    const project = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL
    const providerId = await submitVerisysScan({signedUrl:signed.data.signedUrl,filename,callbackUrl:`${project}/functions/v1/mca-scan-callback`})
    const saved = await db.prepare(`UPDATE mca_private.verisys_scans SET provider_id=?,submit_token=NULL,submit_expires_at=NULL,next_poll_at=now()+interval '10 seconds',updated_at=now()
      WHERE id=? AND submit_token=? AND provider_id IS NULL`).run(providerId,row.id,token)
    if (!saved.changes) throw new AppError(409,"scan_submission_lease_lost","The scan submission lease changed.")
    return {status:"pending",provider:"verisys",evidence:{scanId:providerId}}
  } catch(error) {
    await db.prepare("UPDATE mca_private.verisys_scans SET submit_token=NULL,submit_expires_at=NULL WHERE id=? AND submit_token=?").run(row.id,token)
    throw error
  }
}

/** Callback retries are monotonic; only the original immutable object can become clean. */
export async function recordScanResult(raw: unknown): Promise<void> {
  const parsed = verisysResult.parse(raw)
  await withTransaction(async db => {
    const row = await db.prepare<ScanRow>("SELECT * FROM mca_private.verisys_scans WHERE provider_id=? FOR UPDATE").get(parsed.id)
    if (!row) throw new AppError(503,"scan_receipt_not_ready","The scan receipt has not been recorded yet. Retry the callback.")
    if (row.state !== "pending") return
    const verdict = verifiedObjectScan(parsed,{scanId:parsed.id,sha256:row.sha256,bytes:row.byte_length})
    await db.prepare("UPDATE mca_private.verisys_scans SET state=?,evidence_json=?::jsonb,next_poll_at=now()+interval '30 seconds',updated_at=now() WHERE id=?")
      .run(verdict.status,JSON.stringify(verdict.evidence),row.id)
    if (verdict.status !== "pending") await db.prepare("UPDATE mca_background_jobs SET available_at=? WHERE id=? AND workspace_id=? AND state='queued'").run(new Date().toISOString(),row.job_id,row.workspace_id)
  })
}

export async function reconcileScans(): Promise<void> {
  if (!process.env.MCA_VERISYS_API_KEY) return
  const rows = await getDatabase().prepare<{provider_id:string}>("SELECT provider_id FROM mca_private.verisys_scans WHERE state='pending' AND provider_id IS NOT NULL AND next_poll_at<=now() ORDER BY next_poll_at LIMIT 10").all()
  for (const row of rows) {
    try { await recordScanResult(await fetchVerisysScan(row.provider_id)) }
    catch {
      await getDatabase().prepare("UPDATE mca_private.verisys_scans SET next_poll_at=now()+interval '60 seconds' WHERE provider_id=? AND state='pending'").run(row.provider_id)
      console.error(JSON.stringify({event:"scanner_reconciliation_deferred"}))
    }
  }
}
