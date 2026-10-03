/** Edge workers bundle without Next.js: API errors are plain Web Responses. */
export const NextResponse = Response

/** Mirrors Next.js outside a request scope; telemetry and workflow callers already fall back. */
export function after(): never {
  throw new Error("after() requires a Next.js request scope.")
}
