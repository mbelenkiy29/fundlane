import "server-only"
import { getDatabase, nowIso, withImmediateTransaction, recordAuditEvent, type DbExecutor } from "./db"
import { AppError } from "./errors"
import { monthlyPriceCents, TRIAL_DAYS, TRIAL_SEATS } from "./billing-catalog"

export interface CompanyAccess {
  allowed: boolean; status: string; reason: string | null; seatLimit: number
  trialEndsAt: string | null; graceEndsAt: string | null; manualPaused: boolean
}
export interface CompanyAccessRow {
  legacy_exempt: number; trial_ends_at: string | null; manual_paused: number
  access_extended_until: string | null; grace_ends_at: string | null
  processing_extension_until: string | null; pending_seats: number | null
  status: string | null; period_end: string | null; seat_limit: number
}
/** Deterministic local gate: no provider requests and no reliance on cron punctuality. */
export function evaluateCompanyAccess(row: CompanyAccessRow, now = Date.now()): CompanyAccess {
  const future = (value: string | null) => Boolean(value && Date.parse(value) > now)
  const grace = [row.grace_ends_at, row.processing_extension_until].filter((v): v is string => !!v).sort().at(-1) ?? null
  let status = "paused", reason: string | null = "subscription_required", allowed = false
  if (row.legacy_exempt) { allowed = true; status = "legacy_exempt"; reason = null }
  else if (future(row.access_extended_until)) { allowed = true; status = "extended"; reason = null }
  else if (row.grace_ends_at) { allowed = future(grace); status = allowed ? "grace" : "paused"; reason = allowed ? null : "payment_overdue" }
  else if (row.status === "active" && future(row.period_end)) { allowed = true; status = "active"; reason = null }
  else if (!row.status || ["none", "incomplete", "incomplete_expired"].includes(row.status)) {
    allowed = future(row.trial_ends_at); status = allowed ? "trial" : "paused"; reason = allowed ? null : "trial_expired"
  }
  if (row.manual_paused) { allowed = false; status = "paused"; reason = "manual_suspension" }
  const trialCapacity = status === "trial" || (status === "extended" && !!row.trial_ends_at && (!row.status || ["none","incomplete","incomplete_expired"].includes(row.status)))
  return { allowed, status, reason, seatLimit: trialCapacity ? TRIAL_SEATS : Math.min(row.seat_limit, row.pending_seats ?? row.seat_limit), trialEndsAt: row.trial_ends_at, graceEndsAt: grace, manualPaused: !!row.manual_paused }
}
export async function getCompanyAccess(workspaceId: string): Promise<CompanyAccess> {
  const row = await getDatabase().prepare<CompanyAccessRow>(`SELECT COALESCE(s.legacy_exempt,1) legacy_exempt, s.trial_ends_at,
    COALESCE(s.manual_paused,0) manual_paused, s.access_extended_until, s.grace_ends_at, s.processing_extension_until,
    s.pending_seats, e.status, e.period_end, w.seat_limit FROM workspaces w
    LEFT JOIN company_subscription_state s ON s.workspace_id=w.id
    LEFT JOIN workspace_billing_entitlements e ON e.workspace_id=w.id WHERE w.id=?`).get(workspaceId)
  if (!row) throw new AppError(404, "workspace_not_found", "Company not found.")
  return evaluateCompanyAccess(row)
}
export async function assertCompanyOperational(workspaceId: string): Promise<void> {
  const access = await getCompanyAccess(workspaceId)
  if (!access.allowed) throw new AppError(402, "company_paused", "Company access is paused. The owner can recover access in Plans & Billing.")
}

/** Monotonic lifecycle history, not a freshness timestamp. Call in the workspace transaction. */
export async function recordCompanyPauseBoundary(workspaceId: string, boundary: string, db: DbExecutor = getDatabase()) {
  if (!Number.isFinite(Date.parse(boundary)) || Date.parse(boundary) > Date.now()) return
  const normalized = new Date(boundary).toISOString()
  const result = await db.prepare("UPDATE company_subscription_state SET last_paused_at=? WHERE workspace_id=? AND (last_paused_at IS NULL OR last_paused_at<?)").run(normalized,workspaceId,normalized)
  if (result.changes) await recordAuditEvent({ context:{ workspaceId,userId:null,source:"system" },action:"billing.pause_boundary_recorded",resourceType:"workspace",resourceId:workspaceId,metadata:{effectiveAt:normalized},executor:db })
}

/** Capture an expired trial/grace before mutation erases the deadline. through may be provider paid_at. */
export async function captureCompanyPauseBoundary(workspaceId: string, db: DbExecutor = getDatabase(), through = Date.now()) {
  const row = await db.prepare<{ legacy_exempt:number; trial_ends_at:string|null; grace_ends_at:string|null; processing_extension_until:string|null; access_extended_until:string|null; status:string|null }>(`SELECT s.legacy_exempt,s.trial_ends_at,s.grace_ends_at,s.processing_extension_until,s.access_extended_until,e.status
    FROM company_subscription_state s LEFT JOIN workspace_billing_entitlements e ON e.workspace_id=s.workspace_id WHERE s.workspace_id=?`).get(workspaceId)
  if (!row || row.legacy_exempt) return
  const grace = row.processing_extension_until ?? row.grace_ends_at
  const trial = !row.status || ["none","incomplete","incomplete_expired"].includes(row.status) ? row.trial_ends_at : null
  const boundary = [grace ?? trial,row.access_extended_until].filter((value):value is string=>!!value).sort().at(-1)
  if ((grace || trial) && boundary && Date.parse(boundary) <= through) await recordCompanyPauseBoundary(workspaceId,boundary,db)
}

/** Approval must be newer than the last real pause; healthy reconciliation never invalidates it. */
export async function assertCompanyOutboundAllowed(workspaceId: string, approvedAt: string): Promise<void> {
  await assertCompanyOperational(workspaceId)
  const row = await getDatabase().prepare<{last_paused_at:string|null}>("SELECT last_paused_at FROM company_subscription_state WHERE workspace_id=?").get(workspaceId)
  const approved = Date.parse(approvedAt)
  if (!Number.isFinite(approved) || approved > Date.now() || (row?.last_paused_at && approved <= Date.parse(row.last_paused_at))) {
    throw new AppError(409,"company_outbound_reapproval_required","This outbound action was approved before a company pause. Review and approve it again before sending.")
  }
}
/** Onboarding calls this in its creation transaction. Repeated calls never restart a trial. */
export async function initializeCompanyTrial(workspaceId: string, selectedSeats: number, executor?: DbExecutor) {
  monthlyPriceCents(selectedSeats)
  const initialize = async (db: DbExecutor) => {
    const workspace = await db.prepare("SELECT id FROM workspaces WHERE id=? FOR UPDATE").get(workspaceId)
    if (!workspace) throw new AppError(404, "workspace_not_found", "Company not found.")
    const start = nowIso(), end = new Date(Date.parse(start) + TRIAL_DAYS * 86400000).toISOString()
    const inserted = await db.prepare(`INSERT INTO company_subscription_state (workspace_id, trial_started_at, trial_ends_at, selected_seats, updated_at)
      VALUES (?,?,?,?,?) ON CONFLICT (workspace_id) DO NOTHING`).run(workspaceId, start, end, selectedSeats, start)
    if (inserted.changes) {
      await db.prepare("UPDATE workspaces SET seat_limit=?, updated_at=? WHERE id=?").run(TRIAL_SEATS, start, workspaceId)
      await recordAuditEvent({context:{workspaceId,userId:null,source:"system"},action:"billing.trial_started",resourceType:"workspace",resourceId:workspaceId,metadata:{trialStartedAt:start,trialEndsAt:end,selectedSeats,seatLimit:TRIAL_SEATS},executor:db})
    }
    return db.prepare("SELECT * FROM company_subscription_state WHERE workspace_id=?").get(workspaceId)
  }
  return executor ? initialize(executor) : withImmediateTransaction(initialize)
}
