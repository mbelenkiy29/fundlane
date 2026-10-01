import type { RuntimeSignals } from "./runtime-signals"
export type Window = "24h" | "7d" | "30d"
export type Metrics = {
  queued: number
  running: number
  failed: number
  retrying: number
  billingRetrying: number
  expired: number
  oldestSeconds: number
  emailQueued: number
  emailAccepted: number
  emailFailed: number
  emailBlocked: number
  emailUnknown: number
  reconnect: number
  recentEmailFailures: number
  recentErrors: number
  documentWorkerHeartbeatAgeSeconds: number | null
  documentFailed: number
  scannerUnavailable: number
  queueAgeByKind?: Record<string, number>
  billingMaintenanceFailures?: number
  assistantRuns?: number
  runtimeSignals?: RuntimeSignals
}
export function documentWorkerReady(metrics: {
  documentWorkerHeartbeatAgeSeconds: number | null
}): boolean {
  return (
    metrics.documentWorkerHeartbeatAgeSeconds != null &&
    metrics.documentWorkerHeartbeatAgeSeconds <= 90
  )
}
export type Health = {
  checked_at: string
  website_ok: boolean
  database_ok: boolean
  website_ms: number | null
  database_ms: number | null
  deployment: string | null
  metrics: Metrics | null
}
export type ErrorEvent = {
  id: string
  occurred_at: string
  component: string
  code: string
  route: string | null
  correlation_id: string | null
  deployment: string | null
}
export type Status = {
  asOf: string
  startedAt: string
  window: Window
  latest: Health | null
  stale: boolean
  observedAvailability: number | null
  samples: number
  errors: number
  companies: number
  newCompanies: number
  activeUsers: number
  invitations: number
  submitted: number
  health: {
    time: string
    websiteMs: number | null
    databaseMs: number | null
    errors: number
  }[]
  usage: {
    day: string
    activeUsers: number
    invitations: number
    submitted: number
  }[]
  incidents: {
    component: string
    opened_at: string | null
    delivery_state: string | null
  }[]
  emailRuntime?: {
    queued: number
    oldestQueuedSeconds: number | null
    expiredSenders: number
    revokedSenders: number
    syncFailures: number
    staleSyncs: number
    lastCompletedAt: string | null
    lastStartedAt: string | null
  } | null
  calendar?: { connections: number; stale: number; failures: number; reconnect: number; expiringWatches: number } | null
  jobKinds: {
    kind: string
    queued: number
    running: number
    failures: number
    oldestPendingAt: string | null
    oldestPendingSeconds: number | null
    lastSuccessAt: string | null
  }[]
}
export function parseWindow(value: string | null): Window {
  if (value === null) return "24h"
  if (value === "24h" || value === "7d" || value === "30d") return value
  throw new Error("invalid_window")
}
export function sinceFor(window: Window, now = Date.now()): string {
  return new Date(
    now - { "24h": 1, "7d": 7, "30d": 30 }[window] * 86400000
  ).toISOString()
}
export function safeIdentifier(value: unknown): string | null {
  return typeof value === "string" && /^[a-zA-Z0-9_-]{1,100}$/.test(value)
    ? value
    : null
}
export function positiveThreshold(value: string | undefined, fallback: number): number {
  if (!value || !/^[1-9]\d*$/.test(value)) return fallback
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed <= 86400 ? parsed : fallback
}
// Only fixed route families leave the request boundary. IDs and search strings never enter telemetry.
export function safeRoute(raw: string): string {
  const path = new URL(raw, "https://fundlane.io").pathname
  const match = path.match(
    /^\/api\/(?:mca\/)?(auth|deals|imports|applications|intake|email|calendar|documents|assistant|submissions|admin|workspace|memberships|invitations)(?:\/|$)/
  )
  return match ? `/api/${match[1]}/*` : "/api/other"
}
export function isInteractiveApi(request: Request): boolean {
  const path = new URL(request.url).pathname
  if (!path.startsWith('/api/') || ['HEAD','OPTIONS'].includes(request.method)) return false
  if (/^\/api\/(admin|internal|webhooks)(\/|$)/.test(path) || /\/(sync|heartbeat|notifications|read|reads|status)$/.test(path)) return false
  // These GET endpoints are also polled automatically. Without an explicit foreground
  // signal, do not inflate engagement from a tab left open. Mutations still count.
  if (request.method === 'GET' && /^\/api\/(auth\/session|mca\/(jobs|email|sms|assistant|applications|intake|calendar|senders))(\/|$)/.test(path)) return false
  if (request.method === 'POST' && path === '/api/mca/sms/conversations') return false // automatic read receipt
  return true
}

export type Incident = {
  opened_at: string | null
  bad_checks: number
  good_checks: number
  last_sent_at: string | null
  pending_kind: string | null
}
export function incidentTransition(
  previous: Incident,
  bad: boolean,
  threshold: number,
  now: string
) {
  const badChecks = bad ? previous.bad_checks + 1 : 0
  const goodChecks = bad ? 0 : previous.good_checks + 1
  let opened = previous.opened_at
  let kind: "opening" | "reminder" | "recovery" | null = null
  if (!previous.pending_kind) {
    if (!opened && badChecks >= threshold) {
      opened = now
      kind = "opening"
    } else if (opened && goodChecks >= 3) {
      opened = null
      kind = "recovery"
    } else if (
      opened &&
      bad &&
      previous.last_sent_at &&
      Date.parse(now) - Date.parse(previous.last_sent_at) >= 21600000
    )
      kind = "reminder"
  }
  return { opened, badChecks, goodChecks, kind }
}
