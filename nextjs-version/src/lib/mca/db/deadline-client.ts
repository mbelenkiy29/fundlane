export class DatabaseConnectionDeadlineError extends Error {
  constructor() {
    super("The database connection wait exceeded the execution deadline.")
    this.name = "DatabaseConnectionDeadlineError"
  }
}

/** Acquiring a client does not execute SQL. An abandoned acquisition may finish
 * later, but its client must be returned to the pool before any work can start.
 */
export function acquireDeadlineClient<T extends { release(): void }>(
  connect: () => Promise<T>, remainingMs?: number, signal?: AbortSignal,
): Promise<T> {
  if (signal?.aborted || (remainingMs !== undefined && remainingMs <= 0)) {
    return Promise.reject(new DatabaseConnectionDeadlineError())
  }
  if (remainingMs === undefined && !signal) return connect()
  const deadline = remainingMs === undefined ? Infinity : Date.now() + remainingMs
  return new Promise<T>((resolve, reject) => {
    let settled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const cleanup = () => { clearTimeout(timer); signal?.removeEventListener("abort", expire) }
    const expire = () => {
      if (settled) return
      settled = true; cleanup(); reject(new DatabaseConnectionDeadlineError())
    }
    signal?.addEventListener("abort", expire, { once: true })
    if (Number.isFinite(deadline)) timer = setTimeout(expire, Math.max(1, deadline - Date.now()))
    let pending: Promise<T>
    try { pending = connect() }
    catch (error) {
      if (signal?.aborted || Date.now() >= deadline) expire()
      else { settled = true; cleanup(); reject(error) }
      return
    }
    pending.then(client => {
      if (signal?.aborted || Date.now() >= deadline) expire()
      if (settled) { client.release(); return }
      settled = true; cleanup(); resolve(client)
    }, error => {
      if (settled) return
      if (signal?.aborted || Date.now() >= deadline) { expire(); return }
      settled = true; cleanup(); reject(error)
    })
  })
}
