import "server-only"

import { z } from "zod"
import { assertTrustedMutation, consumeRequestRateLimit, clientRateKey, requireWorkspaceAccess } from "../auth"
import { getDatabase, newId, nowIso, recordAuditEvent } from "../db"
import { canActorAccessDeal } from "../deals/access-policy"
import { activeMembershipIds, managedMembershipIds } from "../deals/repository"
import { actorForDeals } from "../deals/service"
import type { AssignmentKind, DealActor, DealAssignment } from "../deals/schema"
import { AppError } from "../errors"
import { requestCorrelationId } from "../http"
import type { Role } from "../types"
import { getWorkspaceSettings } from "../workspaces"
import { registerCommsJob } from "./jobs"
import type { RunCommsJobsInput, RunCommsJobsResult } from "./contracts"
import { listSendersByWorkspace, type StoredEmailSender } from "../senders/repository"

export const DEFAULT_DIGEST_LOCAL_SEND_HOUR = 6
export const DIGEST_STAGES = ["new", "submitted", "approved", "funded"] as const
export type DigestStage = (typeof DIGEST_STAGES)[number]

export const DIGEST_DELIVERY_STATES = ["sent", "skipped", "failed"] as const
export type DigestDeliveryState = (typeof DIGEST_DELIVERY_STATES)[number]

export const DIGEST_SKIP_REASONS = [
  "not_due",
  "invalid_timezone",
  "invalid_local_time",
  "suspended",
  "missing_email",
  "empty",
  "already_delivered",
] as const
export type DigestSkipReason = (typeof DIGEST_SKIP_REASONS)[number]

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const SUBMITTED_STATUSES = new Set(["submitted", "resubmitting"])
const APPROVED_STATUSES = new Set(["offer", "contract"])
const FUNDED_STATUSES = new Set(["funded"])
const DAY_MS = 24 * 60 * 60 * 1000

type DigestFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

export interface DigestDealItem {
  dealId: string
  displayId: string
  legalName: string
  href: string
  occurredAt: string
}

export interface DigestStageGroup {
  stage: DigestStage
  deals: DigestDealItem[]
}

export interface DigestWindow {
  windowStart: string
  windowEnd: string
  timezone: string
  localSendHour: number
  due: boolean
}

export interface DigestPayload {
  window: DigestWindow
  groups: DigestStageGroup[]
  empty: boolean
}

export interface DigestDeliveryMessage {
  deliveryId: string
  workspaceId: string
  membershipId: string
  windowStart: string
  windowEnd: string
  timezone: string
  senderId?: string
  fromName: string
  fromAddress: string
  to: string
  subject: string
  body: string
  correlationId: string
  groups: DigestStageGroup[]
}

export type DigestDelivery = "sent" | "preview" | "failed"

export type DigestTransport = (message: DigestDeliveryMessage) => Promise<{
  delivery: DigestDelivery
  providerMessageId?: string
  error?: string
}>

export interface DigestSubscriptionView {
  membershipId: string
  enabled: boolean
  timezone: string
  localSendHour: number
  defaultTimezone: string
  defaultLocalSendHour: typeof DEFAULT_DIGEST_LOCAL_SEND_HOUR
  window?: DigestWindow
  preview: DigestPayload
  lastDelivery?: {
    id: string
    windowStart: string
    windowEnd: string
    state: DigestDeliveryState
    createdAt: string
    correlationId: string
  }
}

export interface UpdateDigestSubscriptionInput {
  enabled: boolean
  timezone?: string
  localSendHour?: number
}

export interface DigestOutcome {
  membershipId: string
  windowStart?: string
  windowEnd?: string
  state: DigestDeliveryState | "pending"
  reason?: DigestSkipReason | "send_failed" | "sender_unavailable"
  deliveryId?: string
  correlationId?: string
}

export interface DigestRunResult {
  attempted: number
  sent: number
  skipped: number
  failed: number
  outcomes: DigestOutcome[]
}

type SubscriptionRow = {
  id: string
  workspace_id: string
  membership_id: string
  enabled: number | string
  timezone: string
  local_send_hour: number | string
  created_at: string
  updated_at: string
}

type DeliveryRow = {
  id: string
  workspace_id: string
  membership_id: string
  window_start: string
  window_end: string
  state: string
  correlation_id: string
  created_at: string
}

type MemberRow = {
  id: string
  user_id: string
  role: string
  status: string
  email: string
  name: string
}

type ActivityRow = {
  deal_id: string
  action: string
  to_status: string | null
  created_at: string
  display_id: string
  legal_name: string | null
}

type AssignmentRow = {
  deal_id: string
  membership_id: string
  kind: string
}

let fetchOverride: DigestFetch | undefined
let transportOverride: DigestTransport | undefined

export function setDigestDeliveryFetchForTests(fetchImpl?: DigestFetch): void {
  fetchOverride = fetchImpl
}

export function setDigestTransportForTests(transport?: DigestTransport): void {
  transportOverride = transport
}

function db() {
  return getDatabase()
}

function invalid(field: string, message: string): never {
  throw new AppError(422, "validation_failed", "Review the highlighted fields.", { [field]: [message] })
}

export function isValidDigestTimeZone(value: string): boolean {
  if (!value || value.length > 80) return false
  try {
    Intl.DateTimeFormat("en-US", { timeZone: value })
    return true
  } catch {
    return false
  }
}

function asTimeZone(value: unknown, fallback: string): string {
  if (value == null || value === "") return fallback
  if (typeof value !== "string") invalid("timezone", "Choose a valid IANA timezone.")
  const timezone = value.trim()
  if (!isValidDigestTimeZone(timezone)) invalid("timezone", "Choose a valid IANA timezone.")
  return timezone
}

function asHour(value: unknown, fallback: number): number {
  if (value == null || value === "") return fallback
  const hour = typeof value === "number" ? value : Number(value)
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) invalid("localSendHour", "Choose an hour between 0 and 23.")
  return hour
}

function asEnabled(value: unknown): boolean {
  if (typeof value !== "boolean") invalid("enabled", "Choose whether the daily digest is on.")
  return value
}

function localParts(date: Date, timeZone: string): { year: number; month: number; day: number; hour: number; minute: number; second: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(date)
  const read = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? ""
  return {
    year: Number(read("year")),
    month: Number(read("month")),
    day: Number(read("day")),
    hour: Number(read("hour")),
    minute: Number(read("minute")),
    second: Number(read("second")),
  }
}

function zonedLocalToUtcMs(timeZone: string, year: number, month: number, day: number, hour: number): number | undefined {
  const desired = Date.UTC(year, month - 1, day, hour, 0, 0, 0)
  let millis = desired
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const parts = localParts(new Date(millis), timeZone)
    const mapped = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second, 0)
    const delta = desired - mapped
    if (delta === 0) {
      if (parts.year === year && parts.month === month && parts.day === day && parts.hour === hour && parts.minute === 0 && parts.second === 0) {
        return millis
      }
      return undefined
    }
    millis += delta
  }
  return undefined
}

export function digestWindowFor(nowIsoValue: string, timeZone: string, localSendHour = DEFAULT_DIGEST_LOCAL_SEND_HOUR): DigestWindow | undefined {
  if (!isValidDigestTimeZone(timeZone)) return undefined
  const now = new Date(nowIsoValue)
  if (!Number.isFinite(now.getTime())) return undefined
  const local = localParts(now, timeZone)
  const endMs = zonedLocalToUtcMs(timeZone, local.year, local.month, local.day, localSendHour)
  if (endMs === undefined) return undefined
  return {
    windowStart: new Date(endMs - DAY_MS).toISOString(),
    windowEnd: new Date(endMs).toISOString(),
    timezone: timeZone,
    localSendHour,
    due: now.getTime() >= endMs,
  }
}

function dealHref(dealId: string): string {
  const origin = process.env.MCA_APP_ORIGIN?.trim().replace(/\/$/, "") ?? ""
  const path = `/deals?deal=${encodeURIComponent(dealId)}`
  return origin ? `${origin}${path}` : path
}

function stageFromActivity(action: string, toStatus: string | null): DigestStage | undefined {
  if (action === "created") return "new"
  if (action !== "status_changed" || !toStatus) return undefined
  if (SUBMITTED_STATUSES.has(toStatus)) return "submitted"
  if (APPROVED_STATUSES.has(toStatus)) return "approved"
  if (FUNDED_STATUSES.has(toStatus)) return "funded"
  return undefined
}

function emptyGroups(): DigestStageGroup[] {
  return DIGEST_STAGES.map((stage) => ({ stage, deals: [] }))
}

function sortDeals(deals: DigestDealItem[]): DigestDealItem[] {
  return [...deals].sort((left, right) => {
    if (left.occurredAt !== right.occurredAt) return left.occurredAt < right.occurredAt ? -1 : 1
    if (left.displayId !== right.displayId) return left.displayId < right.displayId ? -1 : 1
    return left.dealId < right.dealId ? -1 : 1
  })
}

function calendarDateLabel(iso: string, timeZone: string): string {
  const date = new Date(iso)
  if (!Number.isFinite(date.getTime())) return iso
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(date)
}

function formatHourLabel(hour: number): string {
  const suffix = hour < 12 ? "AM" : "PM"
  const twelve = hour % 12 === 0 ? 12 : hour % 12
  return `${twelve}:00 ${suffix}`
}

function composeSubject(window: DigestWindow): string {
  return `Daily deal activity — ${calendarDateLabel(window.windowEnd, window.timezone)}`
}

function composeBody(payload: DigestPayload): string {
  const lines = [
    "Daily deal activity",
    `Window: ${payload.window.windowStart} to ${payload.window.windowEnd} (${payload.window.timezone} ${formatHourLabel(payload.window.localSendHour)})`,
    "",
  ]
  for (const group of payload.groups) {
    const label = group.stage === "new" ? "New" : group.stage.charAt(0).toUpperCase() + group.stage.slice(1)
    lines.push(`${label} (${group.deals.length})`)
    if (!group.deals.length) {
      lines.push("  None")
    } else {
      for (const deal of group.deals) {
        lines.push(`  ${deal.displayId}  ${deal.legalName}  ${deal.href}`)
      }
    }
    lines.push("")
  }
  return lines.join("\n").trimEnd()
}

function redactedPayload(message: DigestDeliveryMessage) {
  return {
    template: "deal_activity_digest",
    deliveryId: message.deliveryId,
    workspaceId: message.workspaceId,
    membershipId: message.membershipId,
    windowStart: message.windowStart,
    windowEnd: message.windowEnd,
    timezone: message.timezone,
    senderId: message.senderId,
    fromName: message.fromName,
    fromAddress: message.fromAddress,
    to: message.to,
    subject: message.subject,
    body: message.body,
    correlationId: message.correlationId,
    groups: message.groups.map((group) => ({
      stage: group.stage,
      dealIds: group.deals.map((deal) => deal.dealId),
    })),
  }
}

function http(): DigestFetch {
  return fetchOverride ?? globalThis.fetch
}

async function defaultTransport(message: DigestDeliveryMessage): Promise<{ delivery: DigestDelivery; error?: string }> {
  const webhook = process.env.MCA_EMAIL_WEBHOOK_URL?.trim()
  if (!webhook && !fetchOverride) {
    if (process.env.NODE_ENV === "production") {
      return { delivery: "failed", error: "Email delivery is not configured for this deployment." }
    }
    return { delivery: "preview" }
  }
  const target = webhook || "mca://digest/deliver"
  try {
    const response = await http()(target, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(process.env.MCA_EMAIL_WEBHOOK_TOKEN ? { authorization: `Bearer ${process.env.MCA_EMAIL_WEBHOOK_TOKEN}` } : {}),
        "x-correlation-id": message.correlationId,
      },
      body: JSON.stringify(redactedPayload(message)),
      signal: AbortSignal.timeout(10_000),
    })
    if (!response.ok) {
      return { delivery: "failed", error: "The email provider did not accept the digest." }
    }
    return { delivery: "sent" }
  } catch (error) {
    if (error instanceof AppError) return { delivery: "failed", error: error.message }
    return { delivery: "failed", error: "The email provider did not accept the digest." }
  }
}

async function deliverDigest(message: DigestDeliveryMessage): Promise<{ delivery: DigestDelivery; error?: string }> {
  await (await import("../company-access")).assertCompanyOperational(message.workspaceId)
  await (await import("../outbound-approval")).assertOutboundDispatch(message.workspaceId, message.windowEnd)
  const transport = transportOverride ?? defaultTransport
  try {
    const result = await transport(message)
    if (result.delivery === "failed") {
      return { delivery: "failed", error: result.error ?? "The email provider did not accept the digest." }
    }
    return { delivery: result.delivery }
  } catch (error) {
    if (error instanceof AppError) return { delivery: "failed", error: error.message }
    return { delivery: "failed", error: "The email provider did not accept the digest." }
  }
}

function pickDigestSender(senders: StoredEmailSender[]): StoredEmailSender | undefined {
  const usable = senders.filter((sender) => sender.state === "verified" && sender.credentialCipher)
  for (const purpose of ["merchant", "fallback", "submission"] as const) {
    const matched = usable.filter((sender) => sender.purpose === purpose)
    const preferred = matched.find((sender) => sender.isDefault) ?? matched[0]
    if (preferred) return preferred
  }
  return usable.find((sender) => sender.isDefault) ?? usable[0]
}

async function loadSubscription(workspaceId: string, membershipId: string): Promise<SubscriptionRow | undefined> {
  return db().prepare<SubscriptionRow>(
    "SELECT * FROM mca_digest_subscriptions WHERE workspace_id = ? AND membership_id = ?",
  ).get(workspaceId, membershipId)
}

async function loadDelivery(workspaceId: string, membershipId: string, windowStart: string): Promise<DeliveryRow | undefined> {
  return db().prepare<DeliveryRow>(
    "SELECT * FROM mca_digest_deliveries WHERE workspace_id = ? AND membership_id = ? AND window_start = ?",
  ).get(workspaceId, membershipId, windowStart)
}

async function lastDelivery(workspaceId: string, membershipId: string): Promise<DeliveryRow | undefined> {
  return db().prepare<DeliveryRow>(
    `SELECT * FROM mca_digest_deliveries
     WHERE workspace_id = ? AND membership_id = ?
     ORDER BY window_start DESC, created_at DESC, id DESC
     LIMIT 1`,
  ).get(workspaceId, membershipId)
}

function toPublicDelivery(row: DeliveryRow): NonNullable<DigestSubscriptionView["lastDelivery"]> {
  return {
    id: row.id,
    windowStart: row.window_start,
    windowEnd: row.window_end,
    state: row.state as DigestDeliveryState,
    createdAt: row.created_at,
    correlationId: row.correlation_id,
  }
}

async function claimDelivery(input: {
  id: string
  workspaceId: string
  membershipId: string
  windowStart: string
  windowEnd: string
  state: DigestDeliveryState
  correlationId: string
}): Promise<{ row: DeliveryRow; inserted: boolean }> {
  const createdAt = nowIso()
  const inserted = await db().prepare<DeliveryRow>(
    `INSERT INTO mca_digest_deliveries
      (id, workspace_id, membership_id, window_start, window_end, state, correlation_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (workspace_id, membership_id, window_start) DO NOTHING
     RETURNING *`,
  ).get(
    input.id,
    input.workspaceId,
    input.membershipId,
    input.windowStart,
    input.windowEnd,
    input.state,
    input.correlationId,
    createdAt,
  )
  if (inserted) return { row: inserted, inserted: true }
  const existing = await loadDelivery(input.workspaceId, input.membershipId, input.windowStart)
  if (!existing) throw new Error("Digest delivery claim did not return a row.")
  return { row: existing, inserted: false }
}

async function markDelivery(row: DeliveryRow, state: DigestDeliveryState): Promise<DeliveryRow> {
  const updated = await db().prepare<DeliveryRow>(
    `UPDATE mca_digest_deliveries SET state = ? WHERE id = ? AND workspace_id = ? RETURNING *`,
  ).get(state, row.id, row.workspace_id)
  return updated ?? { ...row, state }
}

async function enabledSubscriptions(workspaceId: string): Promise<Array<SubscriptionRow & MemberRow>> {
  return db().prepare<SubscriptionRow & MemberRow>(
    `SELECT s.*, m.user_id, m.role, m.status, u.email, u.name
     FROM mca_digest_subscriptions s
     JOIN memberships m ON m.id = s.membership_id AND m.workspace_id = s.workspace_id
     JOIN users u ON u.id = m.user_id
     WHERE s.workspace_id = ? AND s.enabled = 1
     ORDER BY s.membership_id`,
  ).all(workspaceId)
}

async function recipientActor(workspaceId: string, membership: SubscriptionRow & MemberRow, correlationId: string): Promise<DealActor> {
  const allActive = await activeMembershipIds(workspaceId)
  const managed = membership.role === "manager"
    ? await managedMembershipIds(workspaceId, membership.membership_id)
    : []
  return {
    workspaceId,
    userId: membership.user_id,
    membershipId: membership.membership_id,
    role: membership.role as Role,
    managedMembershipIds: managed,
    activeMembershipIds: allActive,
    source: "user",
    correlationId,
  }
}

function assignmentRecord(workspaceId: string, dealId: string, rows: AssignmentRow[]): { workspaceId: string; assignments: DealAssignment[] } {
  return {
    workspaceId,
    assignments: rows.filter((row) => row.deal_id === dealId).map((row) => ({
      id: `${row.deal_id}:${row.membership_id}:${row.kind}`,
      membershipId: row.membership_id,
      kind: row.kind as AssignmentKind,
      isPrimary: false,
      assignedAt: "",
      assignedByUserId: null,
    })),
  }
}

async function activityInWindow(workspaceId: string, window: DigestWindow): Promise<{
  items: Array<{ stage: DigestStage; dealId: string; displayId: string; legalName: string; occurredAt: string }>
  assignments: AssignmentRow[]
}> {
  const activityRows = await db().prepare<ActivityRow>(
    `SELECT a.deal_id, a.action, a.to_status, a.created_at, d.display_id, d.legal_name
     FROM deal_activity a
     JOIN deals d ON d.id = a.deal_id AND d.workspace_id = a.workspace_id
     WHERE a.workspace_id = ?
       AND a.created_at >= ?
       AND a.created_at < ?
       AND a.action IN ('created', 'status_changed')
     ORDER BY a.created_at, a.id`,
  ).all(workspaceId, window.windowStart, window.windowEnd)
  const fundingRows = await db().prepare<{ deal_id: string; funded_at: string; display_id: string; legal_name: string | null }>(
    `SELECT e.deal_id, e.funded_at, d.display_id, d.legal_name
     FROM mca_funding_events e
     JOIN deals d ON d.id = e.deal_id AND d.workspace_id = e.workspace_id
     WHERE e.workspace_id = ?
       AND e.state = 'committed'
       AND e.funded_at >= ?
       AND e.funded_at < ?
     ORDER BY e.funded_at, e.id`,
  ).all(workspaceId, window.windowStart, window.windowEnd)

  const items: Array<{ stage: DigestStage; dealId: string; displayId: string; legalName: string; occurredAt: string }> = []
  for (const row of activityRows) {
    const stage = stageFromActivity(row.action, row.to_status)
    if (!stage) continue
    items.push({
      stage,
      dealId: row.deal_id,
      displayId: row.display_id,
      legalName: row.legal_name?.trim() || "Untitled draft",
      occurredAt: row.created_at,
    })
  }
  for (const row of fundingRows) {
    items.push({
      stage: "funded",
      dealId: row.deal_id,
      displayId: row.display_id,
      legalName: row.legal_name?.trim() || "Untitled draft",
      occurredAt: row.funded_at,
    })
  }

  const dealIds = [...new Set(items.map((item) => item.dealId))]
  const assignments = dealIds.length
    ? await db().prepare<AssignmentRow>(
      `SELECT deal_id, membership_id, kind FROM deal_assignments
       WHERE workspace_id = ? AND deal_id IN (${dealIds.map(() => "?").join(",")})`,
    ).all(workspaceId, ...dealIds)
    : []
  return { items, assignments }
}

function groupsForRecipient(
  actor: DealActor,
  items: Array<{ stage: DigestStage; dealId: string; displayId: string; legalName: string; occurredAt: string }>,
  assignments: AssignmentRow[],
): DigestStageGroup[] {
  const grouped = new Map<DigestStage, Map<string, DigestDealItem>>()
  for (const stage of DIGEST_STAGES) grouped.set(stage, new Map())
  for (const item of items) {
    if (!canActorAccessDeal(actor, assignmentRecord(actor.workspaceId, item.dealId, assignments))) continue
    const bucket = grouped.get(item.stage)
    if (!bucket) continue
    const existing = bucket.get(item.dealId)
    if (existing && existing.occurredAt <= item.occurredAt) continue
    bucket.set(item.dealId, {
      dealId: item.dealId,
      displayId: item.displayId,
      legalName: item.legalName,
      href: dealHref(item.dealId),
      occurredAt: item.occurredAt,
    })
  }
  return DIGEST_STAGES.map((stage) => ({
    stage,
    deals: sortDeals([...(grouped.get(stage)?.values() ?? [])]),
  }))
}

export async function buildDigestPayload(actor: DealActor, window: DigestWindow): Promise<DigestPayload> {
  const { items, assignments } = await activityInWindow(actor.workspaceId, window)
  const groups = groupsForRecipient(actor, items, assignments)
  return { window, groups, empty: groups.every((group) => group.deals.length === 0) }
}

async function defaultWindow(actor: DealActor, nowIsoValue: string, timezone?: string, hour?: number): Promise<DigestWindow> {
  const settings = await getWorkspaceSettings(actor.workspaceId)
  const zone = timezone && isValidDigestTimeZone(timezone) ? timezone : settings.timezone
  const sendHour = hour ?? DEFAULT_DIGEST_LOCAL_SEND_HOUR
  const window = digestWindowFor(nowIsoValue, zone, sendHour)
  if (!window) {
    throw new AppError(422, "validation_failed", "Review the highlighted fields.", { timezone: ["Choose a valid IANA timezone."] })
  }
  return window
}

function viewFrom(input: {
  actor: DealActor
  enabled: boolean
  timezone: string
  localSendHour: number
  defaultTimezone: string
  window: DigestWindow
  preview: DigestPayload
  last?: DeliveryRow
}): DigestSubscriptionView {
  return {
    membershipId: input.actor.membershipId ?? "",
    enabled: input.enabled,
    timezone: input.timezone,
    localSendHour: input.localSendHour,
    defaultTimezone: input.defaultTimezone,
    defaultLocalSendHour: DEFAULT_DIGEST_LOCAL_SEND_HOUR,
    window: input.window,
    preview: input.preview,
    lastDelivery: input.last ? toPublicDelivery(input.last) : undefined,
  }
}

export async function getDigestSubscription(actor: DealActor, nowIsoValue = nowIso()): Promise<DigestSubscriptionView> {
  if (!actor.membershipId) {
    throw new AppError(403, "session_required", "Daily digest settings require an interactive user session.")
  }
  const settings = await getWorkspaceSettings(actor.workspaceId)
  const stored = await loadSubscription(actor.workspaceId, actor.membershipId)
  const timezone = stored?.timezone ?? settings.timezone
  const localSendHour = stored ? Number(stored.local_send_hour) : DEFAULT_DIGEST_LOCAL_SEND_HOUR
  const window = await defaultWindow(actor, nowIsoValue, timezone, localSendHour)
  const preview = await buildDigestPayload(actor, window)
  const last = await lastDelivery(actor.workspaceId, actor.membershipId)
  return viewFrom({
    actor,
    enabled: stored ? Number(stored.enabled) !== 0 : false,
    timezone,
    localSendHour,
    defaultTimezone: settings.timezone,
    window,
    preview,
    last,
  })
}

export async function updateDigestSubscription(actor: DealActor, input: UpdateDigestSubscriptionInput, nowIsoValue = nowIso()): Promise<DigestSubscriptionView> {
  if (!actor.membershipId) {
    throw new AppError(403, "session_required", "Daily digest settings require an interactive user session.")
  }
  const settings = await getWorkspaceSettings(actor.workspaceId)
  const enabled = asEnabled(input.enabled)
  const timezone = asTimeZone(input.timezone, settings.timezone)
  const localSendHour = asHour(input.localSendHour, DEFAULT_DIGEST_LOCAL_SEND_HOUR)
  const now = nowIso()
  const existing = await loadSubscription(actor.workspaceId, actor.membershipId)
  const id = existing?.id ?? newId()
  const saved = await db().prepare<SubscriptionRow>(
    `INSERT INTO mca_digest_subscriptions
      (id, workspace_id, membership_id, enabled, timezone, local_send_hour, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (workspace_id, membership_id) DO UPDATE SET
       enabled = EXCLUDED.enabled,
       timezone = EXCLUDED.timezone,
       local_send_hour = EXCLUDED.local_send_hour,
       updated_at = EXCLUDED.updated_at
     RETURNING *`,
  ).get(id, actor.workspaceId, actor.membershipId, enabled ? 1 : 0, timezone, localSendHour, existing?.created_at ?? now, now)
  if (!saved) throw new Error("Digest subscription was not saved.")
  await recordAuditEvent({
    context: actor,
    action: enabled ? "digest.opt_in" : "digest.opt_out",
    resourceType: "digest_subscription",
    resourceId: saved.id,
    metadata: { timezone, localSendHour, enabled },
    correlationId: actor.correlationId,
  })
  return getDigestSubscription(actor, nowIsoValue)
}

export async function previewDigest(actor: DealActor, nowIsoValue = nowIso()): Promise<DigestPayload> {
  const view = await getDigestSubscription(actor, nowIsoValue)
  return view.preview
}

async function skipDelivery(input: {
  workspaceId: string
  membershipId: string
  window: DigestWindow
  correlationId: string
  reason: DigestSkipReason
  actor: DealActor
}): Promise<DigestOutcome> {
  const claimed = await claimDelivery({
    id: newId(),
    workspaceId: input.workspaceId,
    membershipId: input.membershipId,
    windowStart: input.window.windowStart,
    windowEnd: input.window.windowEnd,
    state: "skipped",
    correlationId: input.correlationId,
  })
  if (claimed.row.state === "sent") {
    return {
      membershipId: input.membershipId,
      windowStart: claimed.row.window_start,
      windowEnd: claimed.row.window_end,
      state: "sent",
      reason: "already_delivered",
      deliveryId: claimed.row.id,
      correlationId: claimed.row.correlation_id,
    }
  }
  const row = claimed.row.state === "skipped" ? claimed.row : await markDelivery(claimed.row, "skipped")
  if (claimed.inserted || claimed.row.state === "failed") {
    await recordAuditEvent({
      context: input.actor,
      action: "digest.skipped",
      resourceType: "digest_delivery",
      resourceId: row.id,
      metadata: { membershipId: input.membershipId, reason: input.reason, windowStart: row.window_start, windowEnd: row.window_end },
      correlationId: row.correlation_id,
    })
  }
  return {
    membershipId: input.membershipId,
    windowStart: row.window_start,
    windowEnd: row.window_end,
    state: "skipped",
    reason: claimed.inserted || claimed.row.state === "failed" ? input.reason : "already_delivered",
    deliveryId: row.id,
    correlationId: row.correlation_id,
  }
}

async function processSubscription(
  jobActor: DealActor,
  nowIsoValue: string,
  subscription: SubscriptionRow & MemberRow,
  sender: StoredEmailSender | undefined,
): Promise<DigestOutcome> {
  const correlationId = jobActor.correlationId || newId()
  if (!isValidDigestTimeZone(subscription.timezone)) {
    return { membershipId: subscription.membership_id, state: "pending", reason: "invalid_timezone" }
  }
  const window = digestWindowFor(nowIsoValue, subscription.timezone, Number(subscription.local_send_hour) || DEFAULT_DIGEST_LOCAL_SEND_HOUR)
  if (!window) {
    return { membershipId: subscription.membership_id, state: "pending", reason: "invalid_local_time" }
  }
  if (!window.due) {
    return { membershipId: subscription.membership_id, windowStart: window.windowStart, windowEnd: window.windowEnd, state: "pending", reason: "not_due" }
  }

  const existing = await loadDelivery(subscription.workspace_id, subscription.membership_id, window.windowStart)
  if (existing?.state === "sent" || existing?.state === "skipped") {
    return {
      membershipId: subscription.membership_id,
      windowStart: existing.window_start,
      windowEnd: existing.window_end,
      state: existing.state,
      reason: "already_delivered",
      deliveryId: existing.id,
      correlationId: existing.correlation_id,
    }
  }

  if (subscription.status !== "active" || !(await (await import("../company-access")).getCompanyAccess(subscription.workspace_id)).allowed) {
    return skipDelivery({
      workspaceId: subscription.workspace_id,
      membershipId: subscription.membership_id,
      window,
      correlationId: existing?.correlation_id ?? correlationId,
      reason: "suspended",
      actor: jobActor,
    })
  }
  if (!EMAIL_PATTERN.test(subscription.email.trim())) {
    return skipDelivery({
      workspaceId: subscription.workspace_id,
      membershipId: subscription.membership_id,
      window,
      correlationId: existing?.correlation_id ?? correlationId,
      reason: "missing_email",
      actor: jobActor,
    })
  }

  const recipient = await recipientActor(subscription.workspace_id, subscription, correlationId)
  const payload = await buildDigestPayload(recipient, window)
  if (payload.empty) {
    return skipDelivery({
      workspaceId: subscription.workspace_id,
      membershipId: subscription.membership_id,
      window,
      correlationId: existing?.correlation_id ?? correlationId,
      reason: "empty",
      actor: jobActor,
    })
  }

  const claimed = await claimDelivery({
    id: existing?.id ?? newId(),
    workspaceId: subscription.workspace_id,
    membershipId: subscription.membership_id,
    windowStart: window.windowStart,
    windowEnd: window.windowEnd,
    state: "failed",
    correlationId: existing?.correlation_id ?? correlationId,
  })
  if (claimed.row.state === "sent" || claimed.row.state === "skipped") {
    return {
      membershipId: subscription.membership_id,
      windowStart: claimed.row.window_start,
      windowEnd: claimed.row.window_end,
      state: claimed.row.state,
      reason: "already_delivered",
      deliveryId: claimed.row.id,
      correlationId: claimed.row.correlation_id,
    }
  }

  if (!sender) {
    await recordAuditEvent({
      context: jobActor,
      action: "digest.failed",
      resourceType: "digest_delivery",
      resourceId: claimed.row.id,
      metadata: { membershipId: subscription.membership_id, reason: "sender_unavailable", windowStart: window.windowStart },
      correlationId: claimed.row.correlation_id,
    })
    return {
      membershipId: subscription.membership_id,
      windowStart: window.windowStart,
      windowEnd: window.windowEnd,
      state: "failed",
      reason: "sender_unavailable",
      deliveryId: claimed.row.id,
      correlationId: claimed.row.correlation_id,
    }
  }

  const message: DigestDeliveryMessage = {
    deliveryId: claimed.row.id,
    workspaceId: subscription.workspace_id,
    membershipId: subscription.membership_id,
    windowStart: window.windowStart,
    windowEnd: window.windowEnd,
    timezone: window.timezone,
    senderId: sender.id,
    fromName: sender.fromName,
    fromAddress: sender.fromAddress,
    to: subscription.email.trim(),
    subject: composeSubject(window),
    body: composeBody(payload),
    correlationId: claimed.row.correlation_id,
    groups: payload.groups,
  }
  let delivered: Awaited<ReturnType<typeof deliverDigest>>
  try { delivered = await deliverDigest(message) }
  catch (error) {
    if (!(error instanceof AppError && ["company_paused", "company_outbound_reapproval_required"].includes(error.code))) throw error
    await markDelivery(claimed.row, "skipped")
    return { membershipId: subscription.membership_id, windowStart: window.windowStart, windowEnd: window.windowEnd, state: "skipped", reason: "suspended", deliveryId: claimed.row.id, correlationId: claimed.row.correlation_id }
  }
  const accepted = delivered.delivery === "sent" || delivered.delivery === "preview"
  const row = await markDelivery(claimed.row, accepted ? "sent" : "failed")
  await recordAuditEvent({
    context: jobActor,
    action: accepted ? "digest.sent" : "digest.failed",
    resourceType: "digest_delivery",
    resourceId: row.id,
    metadata: {
      membershipId: subscription.membership_id,
      windowStart: window.windowStart,
      windowEnd: window.windowEnd,
      delivery: delivered.delivery,
      stages: payload.groups.map((group) => ({ stage: group.stage, count: group.deals.length })),
    },
    correlationId: row.correlation_id,
  })
  return {
    membershipId: subscription.membership_id,
    windowStart: window.windowStart,
    windowEnd: window.windowEnd,
    state: accepted ? "sent" : "failed",
    reason: accepted ? undefined : "send_failed",
    deliveryId: row.id,
    correlationId: row.correlation_id,
  }
}

export async function runDailyDigests(input: RunCommsJobsInput): Promise<DigestRunResult> {
  const subscriptions = await enabledSubscriptions(input.actor.workspaceId)
  const sender = pickDigestSender(await listSendersByWorkspace(input.actor.workspaceId))
  const outcomes: DigestOutcome[] = []
  for (const subscription of subscriptions) {
    outcomes.push(await processSubscription(input.actor, input.nowIso, subscription, sender))
  }
  let sent = 0
  let skipped = 0
  let failed = 0
  let attempted = 0
  for (const outcome of outcomes) {
    if (
      outcome.reason === "not_due"
      || outcome.reason === "invalid_timezone"
      || outcome.reason === "invalid_local_time"
      || outcome.reason === "already_delivered"
    ) {
      skipped += 1
      continue
    }
    attempted += 1
    if (outcome.state === "sent") sent += 1
    else if (outcome.state === "skipped") skipped += 1
    else if (outcome.state === "failed") failed += 1
  }
  return { attempted, sent, skipped, failed, outcomes }
}

async function digestJobHandler(input: RunCommsJobsInput): Promise<Partial<RunCommsJobsResult>> {
  const result = await runDailyDigests(input)
  return { digests: { attempted: result.attempted, sent: result.sent, skipped: result.skipped } }
}

registerCommsJob("digest", digestJobHandler)

export const digestSubscriptionPatchSchema = z.object({
  enabled: z.boolean(),
  timezone: z.string().trim().min(1).max(80).optional(),
  localSendHour: z.number().int().min(0).max(23).optional(),
  nowIso: z.string().min(1).optional(),
}).strict()

export async function requireDigestActor(request: Request, mode: "read" | "write"): Promise<DealActor> {
  if (mode === "write") assertTrustedMutation(request)
  const auth = await requireWorkspaceAccess(request, { sessionOnly: true })
  if (!auth.membershipId) {
    throw new AppError(403, "session_required", "Daily digest settings require an interactive user session.")
  }
  return { ...await actorForDeals(auth), correlationId: requestCorrelationId(request) }
}

export async function requireDigestWrite(request: Request): Promise<DealActor> {
  const actor = await requireDigestActor(request, "write")
  await consumeRequestRateLimit(clientRateKey(request, `digest-settings:${actor.workspaceId}:${actor.membershipId}`), 30)
  return actor
}
