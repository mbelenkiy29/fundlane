import "server-only"
import { getDatabase, newId, nowIso, withTransaction } from "../db"
import { experienceEnabled } from "./experience-contracts"
import { removeStoredFile } from "./files"
import { providerClient } from "./hosted-tools"

/** Durable, idempotent cleanup. Resource deletion is safe to retry after a lost reply. */
export async function maintainAssistantExperience() {
  if (!experienceEnabled()) return
  const db = getDatabase(),
    now = nowIso()
  await db
    .prepare(
      "UPDATE mca_assistant_runs SET status='failed',state_cipher=NULL,error='This session expired. Review saved results before starting again.' WHERE status IN ('running','awaiting_input','awaiting_approval') AND expires_at<?"
    )
    .run(now)
  await db
    .prepare(
      "UPDATE mca_assistant_questions SET status='expired',answer_cipher=NULL WHERE status='pending' AND run_id IN (SELECT id FROM mca_assistant_runs WHERE status IN ('failed','cancelled'))"
    )
    .run()
  await db
    .prepare(
      "UPDATE mca_assistant_approvals SET status='cancelled' WHERE status IN ('prepared','pending','approved') AND run_id IN (SELECT id FROM mca_assistant_runs WHERE status IN ('failed','cancelled'))"
    )
    .run()
  await db
    .prepare(
      "UPDATE mca_assistant_run_meta SET active_since=NULL WHERE active_since IS NOT NULL AND run_id IN (SELECT id FROM mca_assistant_runs WHERE status<>'running')"
    )
    .run()
  const files = await db
    .prepare<{
      id: string
      workspace_id: string
      run_id: string | null
    }>("SELECT id,workspace_id,run_id FROM mca_assistant_files f WHERE NOT EXISTS (SELECT 1 FROM mca_assistant_cleanup q WHERE q.resource_type='file' AND q.resource_id=f.id) AND (expires_at<? OR state IN ('deleted','failed') OR (state='processing' AND created_at<?)) AND state<>'expired' LIMIT 200")
    .all(now, new Date(Date.now() - 600_000).toISOString())
  for (const file of files)
    await db
      .prepare(
        "INSERT INTO mca_assistant_cleanup(id,resource_type,resource_id,workspace_id,run_id,next_attempt_at) VALUES (?,'file',?,?,?,?) ON CONFLICT(resource_type,resource_id) DO NOTHING"
      )
      .run(newId(), file.id, file.workspace_id, file.run_id, now)
  // A crashed worker's lease expires; separate workers claim different rows.
  for (let i = 0; i < 30; i++) {
    const job = await withTransaction(async (tx) => {
      const row = await tx
        .prepare<{
          id: string
          resource_type: string
          resource_id: string
          attempts: number
        }>("SELECT * FROM mca_assistant_cleanup WHERE state='pending' AND attempts<8 AND next_attempt_at<=? ORDER BY next_attempt_at FOR UPDATE SKIP LOCKED LIMIT 1")
        .get(nowIso())
      if (row)
        await tx
          .prepare(
            "UPDATE mca_assistant_cleanup SET attempts=attempts+1,next_attempt_at=? WHERE id=?"
          )
          .run(new Date(Date.now() + 120_000).toISOString(), row.id)
      return row
    })
    if (!job) break
    try {
      if (job.resource_type === "container") {
        try {
          await providerClient().containers.delete(job.resource_id, {
            timeout: 10_000
          })
        } catch (error) {
          if (
            !(
              error &&
              typeof error === "object" &&
              "status" in error &&
              error.status === 404
            )
          )
            throw error
        }
      } else if (job.resource_type === "file") {
        const file = await db
          .prepare<{
            storage_key: string
          }>("SELECT storage_key FROM mca_assistant_files WHERE id=?")
          .get(job.resource_id)
        if (file) await removeStoredFile(file.storage_key)
        await db
          .prepare(
            "UPDATE mca_assistant_files SET state='expired' WHERE id=? AND state<>'deleted'"
          )
          .run(job.resource_id)
      } else throw new Error("Unknown cleanup resource")
      await db
        .prepare(
          "UPDATE mca_assistant_cleanup SET state='completed' WHERE id=?"
        )
        .run(job.id)
    } catch {
      await db
        .prepare(
          "UPDATE mca_assistant_cleanup SET state=?,next_attempt_at=? WHERE id=?"
        )
        .run(
          job.attempts >= 7 ? "failed" : "pending",
          new Date(
            Date.now() + Math.min(3600_000, 30_000 * 2 ** job.attempts)
          ).toISOString(),
          job.id
        )
    }
  }
}
