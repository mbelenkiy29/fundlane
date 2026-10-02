export const PLATFORM_REFRESH_EVENT = "mca:platform-refresh"
export const PLATFORM_REFRESH_MS = 30_000

/** One visible-tab clock for the server pages and their independently loaded queues. */
export function startPlatformRefresh(refresh: () => void) {
  const visible = () => { if (document.visibilityState === "visible") refresh() }
  const timer = setInterval(visible, PLATFORM_REFRESH_MS)
  document.addEventListener("visibilitychange", visible)
  return () => { clearInterval(timer); document.removeEventListener("visibilitychange", visible) }
}

export type BillingObservation = {
  workspaceId: string; companyName: string; livemode: boolean | null; syncedAt: string | null
  source: string | null; pending: boolean; failed: boolean
}

export function billingObservationStatus(row: BillingObservation, now = Date.now()) {
  if (row.failed) return "failed"
  if (row.pending) return "pending"
  if (row.livemode === null) return "not_connected"
  const stamp = Date.parse(row.syncedAt ?? "")
  if (!["stripe_api", "sync_engine"].includes(row.source ?? "") || !Number.isFinite(stamp) || stamp > now) return "unverified"
  return now - stamp > 15 * 60_000 ? "stale" : "verified"
}
