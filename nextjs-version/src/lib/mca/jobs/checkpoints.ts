import { encryptSensitive, decryptSensitive } from "../crypto"
import { getDatabase, withTransaction } from "../db"
import { AppError } from "../errors"
import type { BackgroundJob } from "./queue"

export type Checkpoint = { stage: string; revision: number; inputHash: string; data: Record<string, unknown> }
export async function loadCheckpoint(job: BackgroundJob, inputHash: string): Promise<Checkpoint | null> {
  const row = await getDatabase().prepare<{ stage: string; revision: string; input_hash: string; payload_cipher: string }>(
    "SELECT stage,revision,input_hash,payload_cipher FROM mca_private.job_checkpoints WHERE job_id=? AND workspace_id=?"
  ).get(job.id, job.workspace_id)
  if (!row) return null
  if (row.input_hash !== inputHash) throw new AppError(409, "checkpoint_input_changed", "The job input changed.")
  return { stage: row.stage, revision: Number(row.revision), inputHash, data: JSON.parse(decryptSensitive(row.payload_cipher, job.workspace_id)) }
}

/** Checkpoint and continuation are committed together under the current job lease. */
export async function checkpointAndYield(job: BackgroundJob, next: Omit<Checkpoint, "revision">, expectedRevision = -1, delaySeconds = 0): Promise<void> {
  if (!Number.isInteger(delaySeconds) || delaySeconds < 0 || delaySeconds > 3600) throw new Error("Invalid continuation delay")
  await withTransaction(async db => {
    const active = await db.prepare("SELECT id FROM mca_background_jobs WHERE id=? AND workspace_id=? AND state='running' AND lease_token=? AND lease_expires_at::timestamptz>now() FOR UPDATE")
      .get(job.id, job.workspace_id, job.lease_token)
    if (!active) throw new AppError(409, "job_lease_lost", "The job lease expired.")
    const cipher = encryptSensitive(JSON.stringify(next.data), job.workspace_id)
    const stored = expectedRevision < 0
      ? await db.prepare("INSERT INTO mca_private.job_checkpoints(job_id,workspace_id,stage,input_hash,payload_cipher) VALUES(?,?,?,?,?) ON CONFLICT DO NOTHING").run(job.id, job.workspace_id, next.stage, next.inputHash, cipher)
      : await db.prepare("UPDATE mca_private.job_checkpoints SET stage=?,payload_cipher=?,revision=revision+1,updated_at=now() WHERE job_id=? AND workspace_id=? AND input_hash=? AND revision=?").run(next.stage, cipher, job.id, job.workspace_id, next.inputHash, expectedRevision)
    if (!stored.changes) throw new AppError(409, "checkpoint_conflict", "The job checkpoint changed.")
    await db.prepare(`UPDATE mca_background_jobs SET state='queued',attempts=greatest(0,attempts-1),lease_token=NULL,lease_expires_at=NULL,
      available_at=?,updated_at=? WHERE id=? AND lease_token=?`).run(new Date(Date.now() + delaySeconds * 1000).toISOString(), new Date().toISOString(), job.id, job.lease_token)
  })
}
