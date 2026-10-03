/**
 * Errors that Fundlane code caught and handled (shown a message, will retry). A browser extension
 * that wraps `window.fetch` can leak the same error object as an unhandled rejection; Sentry's
 * filter in scrub.ts drops that copy only when the error is marked here. Browser-safe, no imports.
 */
const caught = new WeakSet<object>()

/** Marks an error our code has handled. Call it only in a catch that does not rethrow. */
export function markCaughtError(error: unknown): void {
  if (typeof error === "object" && error !== null) caught.add(error)
}

export function wasCaughtError(error: unknown): boolean {
  return typeof error === "object" && error !== null && caught.has(error)
}
