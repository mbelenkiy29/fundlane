import { apiError, AppError } from "../errors"
import { requireWorkerCredential } from "./edge-auth"
import { claimWorkerExecution, releaseWorkerExecution, type WorkerSubsystem } from "./edge-control"
import { executionShouldStop, withExecutionDeadline } from "./execution"
import { runMessagingWorkerOnce } from "../email-conversations/worker"
import { cleanupWorkerStorage } from "./cleanup"

export function edgeWorkerHandler(subsystem: WorkerSubsystem) {
  return async (request: Request): Promise<Response> => {
    try {
      requireWorkerCredential(request)
      // The original document dispatcher is not an Edge-safe implementation. Keep
      // this endpoint fail-closed until every resumable stage passes hosted acceptance.
      if (subsystem === "documents") throw new AppError(503, "document_migration_incomplete", "Document worker migration has not passed hosted acceptance.")
      const execution = await claimWorkerExecution(subsystem)
      if (!execution) return Response.json({ accepted: false, reason: "inactive_or_busy" }, { status: 202 })
      try {
        const result = await withExecutionDeadline(async () => {
          if (subsystem === "messaging") return runMessagingWorkerOnce(executionShouldStop)
          await cleanupWorkerStorage()
          return { maintenance: "complete" }
        }, request.signal, 90_000, execution)
        return Response.json({ accepted: true, result }, { headers: { "cache-control": "no-store" } })
      } finally { await releaseWorkerExecution(execution) }
    } catch (error) { return apiError(error) }
  }
}
