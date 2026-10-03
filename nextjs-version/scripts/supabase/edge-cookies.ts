/** Explicit boundary: Edge jobs must authorize their persisted actor, never browser cookies. */
export async function cookies(): Promise<never> {
  throw new Error("Browser session adapters cannot execute in a Supabase worker.")
}

/** Edge workers have no Next.js request context; callers such as telemetry treat empty headers as "no route". */
export async function headers(): Promise<Headers> {
  return new Headers()
}
