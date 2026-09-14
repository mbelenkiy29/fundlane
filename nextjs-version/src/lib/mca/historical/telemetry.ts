import "server-only"

export async function timeHistoricalPhase<T>(correlationId: string, phase: "authorization" | "parsing" | "validation" | "persistence", operation: () => T | Promise<T>): Promise<T> {
  const started = performance.now()
  let outcome = "error"
  try {
    const result = await operation()
    outcome = "ok"
    return result
  } finally {
    console.info(JSON.stringify({ event: "historical_preview_phase", correlationId, phase, outcome, durationMs: Math.round(performance.now() - started) }))
  }
}
