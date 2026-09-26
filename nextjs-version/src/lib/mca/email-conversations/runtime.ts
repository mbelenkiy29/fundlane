import "server-only"
import { getDatabase, newId } from "../db"
import { executionShouldStop, outsideExecutionScope, withExecutionDeadline } from "../jobs/execution"
import { runMessagingWorkerOnce } from "./worker"

const BUDGET_MS = 230_000

/** One database claim for the whole tick; sender leases still fence individual provider work. */
export async function runScheduledEmailConversations(signal?: AbortSignal) {
  const token = newId()
  const claimed = await getDatabase().query<{ token: string }>(
    `INSERT INTO mca_email_runtime_lease(id,token,expires_at,last_started_at)
     VALUES(1,$1,now()+interval '310 seconds',now())
     ON CONFLICT(id) DO UPDATE SET token=EXCLUDED.token,
       expires_at=EXCLUDED.expires_at,last_started_at=EXCLUDED.last_started_at
     WHERE mca_email_runtime_lease.expires_at < now()
     RETURNING token`, [token])
  if (!claimed.rows.length) return { skipped: true }
  let completed = false
  try {
    const health = await withExecutionDeadline(
      () => runMessagingWorkerOnce(executionShouldStop), signal, BUDGET_MS)
    completed = true
    return { skipped: false, health }
  } finally {
    await outsideExecutionScope(() => getDatabase().query(
      `UPDATE mca_email_runtime_lease SET expires_at=now(),
       last_completed_at=CASE WHEN $2 THEN now() ELSE last_completed_at END
       WHERE id=1 AND token=$1`, [token, completed]))
  }
}
