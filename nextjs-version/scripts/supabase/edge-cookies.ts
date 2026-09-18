/** Explicit boundary: Edge jobs must authorize their persisted actor, never browser cookies. */
export async function cookies(): Promise<never> {
  throw new Error("Browser session adapters cannot execute in a Supabase worker.")
}
