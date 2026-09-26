import { AsyncLocalStorage } from "node:async_hooks"
import { AppError } from "../errors"

export interface ExecutionScope {
  signal: AbortSignal
  deadline: number
  fence?: { token: string; subsystem: string; generation: string }
}
const scope = new AsyncLocalStorage<ExecutionScope>()

/** A deadline cancels cooperative I/O; it must never be treated as completed work. */
export function executionSignal(): AbortSignal | undefined { return scope.getStore()?.signal }
export function executionFence(): ExecutionScope["fence"] { return scope.getStore()?.fence }
export function executionRemainingMs(): number | undefined {
  const current = scope.getStore()
  return current ? Math.max(1, current.deadline - Date.now()) : undefined
}
/** Lease cleanup must still be able to write after the work deadline expires. */
export function outsideExecutionScope<T>(run: () => T): T { return scope.exit(run) }
export function executionShouldStop(): boolean {
  const current = scope.getStore()
  return Boolean(current && (current.signal.aborted || Date.now() >= current.deadline))
}
export function assertExecutionActive(): void {
  if (executionShouldStop()) throw new AppError(503, "execution_expired", "The worker execution expired; remaining work will be retried.")
}
export async function withExecutionDeadline<T>(run: () => Promise<T>, parent?: AbortSignal, durationMs = 90_000, fence?: ExecutionScope["fence"]): Promise<T> {
  const controller = new AbortController()
  const abort = () => controller.abort()
  parent?.addEventListener("abort", abort, { once: true })
  if (parent?.aborted) abort()
  const timer = setTimeout(abort, durationMs)
  try {
    return await scope.run({ signal: controller.signal, deadline: Date.now() + durationMs, fence }, async () => {
      assertExecutionActive()
      const result = await run()
      assertExecutionActive()
      return result
    })
  } finally {
    clearTimeout(timer)
    parent?.removeEventListener("abort", abort)
  }
}
