import { randomUUID } from "node:crypto"
import { getDatabase, withTransaction } from "../db"
import { AppError } from "../errors"

export type WorkerSubsystem = "documents" | "messaging" | "maintenance"
export type WorkerExecution = { token: string; subsystem: WorkerSubsystem; generation: string }

export async function claimWorkerExecution(subsystem: WorkerSubsystem): Promise<WorkerExecution | null> {
  return withTransaction(async db => {
    // Serialize admission without holding a database transaction across provider I/O.
    await db.prepare("SELECT pg_advisory_xact_lock(hashtext(?))").get(`edge-worker:${subsystem}`)
    const control = await db.prepare<{ generation: string; enabled: boolean; concurrency: number }>(
      "SELECT generation,enabled,concurrency FROM mca_private.worker_controls WHERE subsystem=? FOR SHARE"
    ).get(subsystem)
    if (!control?.enabled) return null
    await db.prepare("DELETE FROM mca_private.worker_executions WHERE subsystem=? AND expires_at<=now()").run(subsystem)
    const count = await db.prepare<{ count: string }>("SELECT count(*) AS count FROM mca_private.worker_executions WHERE subsystem=?").get(subsystem)
    if (Number(count?.count ?? 0) >= control.concurrency) return null
    const token = randomUUID()
    await db.prepare("INSERT INTO mca_private.worker_executions(token,subsystem,generation,expires_at) VALUES(?,?,?,now()+interval '120 seconds')").run(token, subsystem, control.generation)
    return { token, subsystem, generation: control.generation }
  })
}

export async function assertWorkerExecution(execution: WorkerExecution): Promise<void> {
  const row = await getDatabase().prepare(`SELECT e.token FROM mca_private.worker_executions e
    JOIN mca_private.worker_controls c ON c.subsystem=e.subsystem
    WHERE e.token=? AND e.subsystem=? AND e.generation=? AND c.generation=e.generation
      AND c.enabled AND e.expires_at>now()`).get(execution.token, execution.subsystem, execution.generation)
  if (!row) throw new AppError(503, "worker_execution_fenced", "This worker execution is no longer active.")
}

export async function releaseWorkerExecution(execution: WorkerExecution): Promise<void> {
  await getDatabase().prepare("DELETE FROM mca_private.worker_executions WHERE token=?").run(execution.token)
}
