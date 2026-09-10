import "server-only"

import { z } from "zod"
import { assertTrustedMutation, consumeRequestRateLimit, clientRateKey, requireWorkspaceAccess } from "../auth"
import { getDatabase, newId, nowIso, parseJson, recordAuditEvent, withImmediateTransaction } from "../db"
import { DEAL_STATUS_LABELS, DEAL_STATUSES, type DealActor, type DealRecord, type DealStatus } from "../deals/schema"
import { actorForDeals, getDealForDocument } from "../deals/service"
import { listDealRecords } from "../deals/repository"
import { AppError } from "../errors"
import { requestCorrelationId } from "../http"
import { canManageWorkspace } from "../policy"
import { listSendersByWorkspace, type StoredEmailSender } from "../senders/repository"
import { getSmsConsent, normalizeSmsRecipient } from "../sms/service"
import { getWorkspaceSettings } from "../workspaces"
import { MESSAGE_CHANNELS, type MessageChannel, type RunCommsJobsInput, type RunCommsJobsResult } from "./contracts"
import { registerCommsJob } from "./jobs"
import { resolveFollowupSender } from "./sender-fallback"
import { getPublishedMessageTemplate, renderPublishedMessageTemplate, type RenderedMessageTemplate } from "./templates"

export const FOLLOWUP_FREQUENCIES = ["daily", "weekly", "monthly"] as const
export type FollowupFrequency = (typeof FOLLOWUP_FREQUENCIES)[number]

export const FOLLOWUP_OCCURRENCE_STATES = ["pending", "sent", "skipped", "failed"] as const
export type FollowupOccurrenceState = (typeof FOLLOWUP_OCCURRENCE_STATES)[number]

export const FOLLOWUP_SKIP_REASONS = [
  "not_due",
  "already_sent",
  "in_flight",
  "retry_wait",
  "max_retries",
  "stage_changed",
  "missing_recipient",
  "invalid_recipient",
  "sms_consent_required",
  "sms_recipient_opted_out",
  "recipient_mismatch",
  "sender_unavailable",
  "template_not_published",
  "template_channel_mismatch",
  "template_invalid",
  "deal_not_found",
  "policy_disabled",
  "invalid_schedule",
  "send_failed",
] as const
export type FollowupSkipReason = (typeof FOLLOWUP_SKIP_REASONS)[number]

export const DEFAULT_FOLLOWUP_HOUR = 9
export const DEFAULT_FOLLOWUP_RETRY = { maxAttempts: 3, backoffMinutes: 15 } as const
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const ID_MAX = 80
const IN_FLIGHT_MS = 120_000
const ALLOWED_TEMPLATE_SCOPES = new Set(["merchant", "followup", "request_info"])

const DEAL_STATUS_ENUM = DEAL_STATUSES as unknown as [DealStatus, ...DealStatus[]]
const CHANNEL_ENUM = MESSAGE_CHANNELS as unknown as [MessageChannel, ...MessageChannel[]]
const FREQUENCY_ENUM = FOLLOWUP_FREQUENCIES as unknown as [FollowupFrequency, ...FollowupFrequency[]]

export const followupLocalScheduleSchema = z.object({
  timezone: z.string().trim().min(1).max(80),
  frequency: z.enum(FREQUENCY_ENUM),
  hour: z.number().int().min(0).max(23),
  minute: z.number().int().min(0).max(59).optional(),
  weekday: z.number().int().min(0).max(6).optional(),
  dayOfMonth: z.number().int().min(1).max(31).optional(),
}).strict()

export const followupRetryPolicySchema = z.object({
  maxAttempts: z.number().int().min(1).max(10).optional(),
  backoffMinutes: z.number().int().min(1).max(1_440).optional(),
}).strict()

export const followupPolicyCreateSchema = z.object({
  dealStatus: z.enum(DEAL_STATUS_ENUM),
  channel: z.enum(CHANNEL_ENUM),
  localSchedule: followupLocalScheduleSchema,
  templateId: z.string().trim().min(1).max(ID_MAX),
  enabled: z.boolean().optional(),
  retryPolicy: followupRetryPolicySchema.optional(),
}).strict()

export const followupPolicyPatchSchema = z.object({
  dealStatus: z.enum(DEAL_STATUS_ENUM).optional(),
  channel: z.enum(CHANNEL_ENUM).optional(),
  localSchedule: followupLocalScheduleSchema.optional(),
  templateId: z.string().trim().min(1).max(ID_MAX).optional(),
  enabled: z.boolean().optional(),
  retryPolicy: followupRetryPolicySchema.optional(),
}).strict()

export const followupPreviewQuerySchema = z.object({
  policyId: z.string().trim().min(1).max(ID_MAX).optional(),
  dealId: z.string().trim().min(1).max(ID_MAX).optional(),
  nowIso: z.string().min(1).optional(),
}).strict()

export const followupTestSchema = z.object({
  dealId: z.string().trim().min(1).max(ID_MAX),
  nowIso: z.string().min(1).optional(),
}).strict()

export interface FollowupLocalSchedule {
  timezone: string
  frequency: FollowupFrequency
  hour: number
  minute: number
  weekday?: number
  dayOfMonth?: number
}

export interface FollowupRetryPolicy {
  maxAttempts: number
  backoffMinutes: number
}

export interface FollowupOccurrenceWindow {
  occurrenceKey: string
  scheduledFor: string
  due: boolean
  timezone: string
  localDate: string
}

export interface FollowupPolicyView {
  id: string
  workspaceId: string
  dealStatus: DealStatus
  channel: MessageChannel
  localSchedule: FollowupLocalSchedule
  templateId: string
  templateName: string | null
  templatePublished: boolean
  enabled: boolean
  retryPolicy: FollowupRetryPolicy
  createdAt: string
  updatedAt: string
  lastOccurrence?: {
    id: string
    dealId: string
    occurrenceKey: string
    state: FollowupOccurrenceState
    skipReason?: string
    scheduledFor: string
    attemptedAt?: string
    correlationId: string
  }
}

export interface FollowupTemplateOption {
  id: string
  name: string
  channel: MessageChannel
  scope: string
  published: boolean
}

export interface FollowupCatalog {
  policies: FollowupPolicyView[]
  templates: FollowupTemplateOption[]
  defaultTimezone: string
  statuses: Array<{ value: DealStatus; label: string }>
  canManage: boolean
}

export interface FollowupPreviewDeal {
  dealId: string
  displayId: string
  legalName: string
  status: DealStatus
  recipient?: string
  wouldSend: boolean
  reason?: FollowupSkipReason
}

export interface FollowupPreviewResult {
  mode: "preview"
  policy: FollowupPolicyView
  window?: FollowupOccurrenceWindow
  deals: FollowupPreviewDeal[]
  rendered?: {
    dealId: string
    to: string
    channel: MessageChannel
    subject?: string
    html?: string
    text: string
  }
}

export interface FollowupTestResult {
  mode: "test"
  policyId: string
  dealId: string
  wouldSend: boolean
  reason?: FollowupSkipReason
  delivery?: FollowupDelivery
  to?: string
  subject?: string
  text?: string
  correlationId: string
}

export interface FollowupDeliveryMessage {
  occurrenceId: string
  workspaceId: string
  policyId: string
  dealId: string
  channel: MessageChannel
  to: string
  fromName?: string
  fromAddress?: string
  subject?: string
  html?: string
  text: string
  correlationId: string
  mode: "live" | "preview" | "test"
  occurrenceKey: string
}

export type FollowupDelivery = "sent" | "preview" | "failed"

export type FollowupTransport = (message: FollowupDeliveryMessage) => Promise<{
  delivery: FollowupDelivery
  providerMessageId?: string
  error?: string
}>

export interface FollowupOutcome {
  policyId: string
  dealId?: string
  occurrenceKey?: string
  state: FollowupOccurrenceState | "pending"
  reason?: FollowupSkipReason
  occurrenceId?: string
  correlationId?: string
  delivery?: FollowupDelivery
}

export interface FollowupRunResult {
  attempted: number
  sent: number
  skipped: number
  failed: number
  outcomes: FollowupOutcome[]
}

type PolicyRow = {
  id: string
  workspace_id: string
  deal_status: string
  channel: string
  local_schedule: string
  template_id: string
  enabled: number | string
  retry_policy_json: string
  created_by_user_id: string | null
  created_at: string
  updated_at: string
}

type OccurrenceRow = {
  id: string
  workspace_id: string
  policy_id: string
  deal_id: string
  occurrence_key: string
  state: string
  skip_reason: string | null
  message_id: string | null
  correlation_id: string
  scheduled_for: string
  attempted_at: string | null
  created_at: string
  updated_at: string
}

type TemplateOptionRow = {
  id: string
  name: string
  channel: string
  scope: string
  published_version_id: string | null
}

type FollowupFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

type ClaimAction = "claimed" | "already" | "retry_wait" | "in_flight" | "exhausted"

let fetchOverride: FollowupFetch | undefined
let transportOverride: FollowupTransport | undefined

export function setFollowupDeliveryFetchForTests(fetchImpl?: FollowupFetch): void {
  fetchOverride = fetchImpl
}

export function setFollowupTransportForTests(transport?: FollowupTransport): void {
  transportOverride = transport
}

function db() {
  return getDatabase()
}

function invalid(field: string, message: string, extra?: Record<string, string[]>): never {
  throw new AppError(422, "validation_failed", "Review the highlighted fields.", { [field]: [message], ...extra })
}

function denied(message = "You do not have permission to perform this action."): never {
  throw new AppError(403, "permission_denied", message)
}

function isAdmin(actor: DealActor): boolean {
  return Boolean(actor.role && canManageWorkspace(actor.role))
}

function asId(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) invalid(field, `Choose a ${field}.`)
  const next = value.trim()
  if (next.length > ID_MAX) invalid(field, `Use at most ${ID_MAX} characters.`)
  return next
}

export function isValidFollowupTimeZone(value: string): boolean {
  if (!value || value.length > 80) return false
  try {
    Intl.DateTimeFormat("en-US", { timeZone: value })
    return true
  } catch {
    return false
  }
}

function pad(value: number): string {
  return String(value).padStart(2, "0")
}

function ymd(year: number, month: number, day: number): string {
  return `${year}-${pad(month)}-${pad(day)}`
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

function localWeekday(date: Date, timeZone: string): number {
  const weekday = new Intl.DateTimeFormat("en-US", { timeZone, weekday: "short" })
    .formatToParts(date)
    .find((part) => part.type === "weekday")?.value
  return ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(weekday ?? "")
}

function zonedLocalToUtcMs(timeZone: string, year: number, month: number, day: number, hour: number, minute: number): number | undefined {
  const desired = Date.UTC(year, month - 1, day, hour, minute, 0, 0)
  let millis = desired
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const parts = localParts(new Date(millis), timeZone)
    const mapped = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second, 0)
    const delta = desired - mapped
    if (delta === 0) {
      if (parts.year === year && parts.month === month && parts.day === day && parts.hour === hour && parts.minute === minute && parts.second === 0) {
        return millis
      }
      return undefined
    }
    millis += delta
  }
  return undefined
}

function addCalendarDays(year: number, month: number, day: number, delta: number): { year: number; month: number; day: number } {
  const utc = new Date(Date.UTC(year, month - 1, day + delta))
  return { year: utc.getUTCFullYear(), month: utc.getUTCMonth() + 1, day: utc.getUTCDate() }
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate()
}

function windowFromLocal(timeZone: string, year: number, month: number, day: number, hour: number, minute: number, frequency: FollowupFrequency, nowMs: number): FollowupOccurrenceWindow | undefined {
  const scheduledMs = zonedLocalToUtcMs(timeZone, year, month, day, hour, minute)
  if (scheduledMs === undefined) return undefined
  const localDate = ymd(year, month, day)
  return {
    occurrenceKey: `${frequency}:${localDate}`,
    scheduledFor: new Date(scheduledMs).toISOString(),
    due: nowMs >= scheduledMs,
    timezone: timeZone,
    localDate,
  }
}

export function followupOccurrenceFor(schedule: FollowupLocalSchedule, nowIsoValue: string): FollowupOccurrenceWindow | undefined {
  if (!isValidFollowupTimeZone(schedule.timezone)) return undefined
  const now = new Date(nowIsoValue)
  if (!Number.isFinite(now.getTime())) return undefined
  const local = localParts(now, schedule.timezone)
  const hour = schedule.hour
  const minute = schedule.minute
  if (schedule.frequency === "daily") {
    return windowFromLocal(schedule.timezone, local.year, local.month, local.day, hour, minute, "daily", now.getTime())
  }
  if (schedule.frequency === "weekly") {
    if (schedule.weekday == null || schedule.weekday < 0 || schedule.weekday > 6) return undefined
    const weekday = localWeekday(now, schedule.timezone)
    if (weekday < 0) return undefined
    const shifted = addCalendarDays(local.year, local.month, local.day, schedule.weekday - weekday)
    return windowFromLocal(schedule.timezone, shifted.year, shifted.month, shifted.day, hour, minute, "weekly", now.getTime())
  }
  if (schedule.dayOfMonth == null || schedule.dayOfMonth < 1 || schedule.dayOfMonth > 31) return undefined
  const day = Math.min(schedule.dayOfMonth, daysInMonth(local.year, local.month))
  return windowFromLocal(schedule.timezone, local.year, local.month, day, hour, minute, "monthly", now.getTime())
}

function asRetryPolicy(value: unknown): FollowupRetryPolicy {
  const parsed = typeof value === "string" ? parseJson<Record<string, unknown>>(value, {}) : (value && typeof value === "object" ? value as Record<string, unknown> : {})
  const maxAttempts = parsed.maxAttempts == null ? DEFAULT_FOLLOWUP_RETRY.maxAttempts : Number(parsed.maxAttempts)
  const backoffMinutes = parsed.backoffMinutes == null ? DEFAULT_FOLLOWUP_RETRY.backoffMinutes : Number(parsed.backoffMinutes)
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 10) invalid("retryPolicy.maxAttempts", "Choose between 1 and 10 retry attempts.")
  if (!Number.isInteger(backoffMinutes) || backoffMinutes < 1 || backoffMinutes > 1_440) invalid("retryPolicy.backoffMinutes", "Choose a backoff between 1 and 1440 minutes.")
  return { maxAttempts, backoffMinutes }
}

function asSchedule(value: unknown, fallbackTimezone: string): FollowupLocalSchedule {
  const raw = typeof value === "string" ? parseJson<Record<string, unknown>>(value, {}) : (value && typeof value === "object" ? value as Record<string, unknown> : {})
  const timezone = typeof raw.timezone === "string" && raw.timezone.trim() ? raw.timezone.trim() : fallbackTimezone
  if (!isValidFollowupTimeZone(timezone)) invalid("localSchedule.timezone", "Choose a valid IANA timezone.")
  const frequency = raw.frequency
  if (frequency !== "daily" && frequency !== "weekly" && frequency !== "monthly") {
    invalid("localSchedule.frequency", "Choose daily, weekly, or monthly.")
  }
  const hour = raw.hour == null ? DEFAULT_FOLLOWUP_HOUR : Number(raw.hour)
  const minute = raw.minute == null ? 0 : Number(raw.minute)
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) invalid("localSchedule.hour", "Choose an hour between 0 and 23.")
  if (!Number.isInteger(minute) || minute < 0 || minute > 59) invalid("localSchedule.minute", "Choose minutes between 0 and 59.")
  const schedule: FollowupLocalSchedule = { timezone, frequency, hour, minute }
  if (frequency === "weekly") {
    const weekday = Number(raw.weekday)
    if (!Number.isInteger(weekday) || weekday < 0 || weekday > 6) invalid("localSchedule.weekday", "Choose a weekday for weekly follow-ups.")
    schedule.weekday = weekday
  }
  if (frequency === "monthly") {
    const dayOfMonth = Number(raw.dayOfMonth)
    if (!Number.isInteger(dayOfMonth) || dayOfMonth < 1 || dayOfMonth > 31) invalid("localSchedule.dayOfMonth", "Choose a day of the month for monthly follow-ups.")
    schedule.dayOfMonth = dayOfMonth
  }
  return schedule
}

function failedAttempts(skipReason: string | null | undefined): number {
  if (!skipReason) return 0
  const match = /^send_failed(?::(\d+))?$/.exec(skipReason)
  if (!match) return 0
  return match[1] ? Number(match[1]) : 1
}

function appOrigin(): string {
  return (process.env.MCA_APP_ORIGIN?.trim() || "http://localhost:3000").replace(/\/$/, "")
}

function merchantEmail(deal: DealRecord): string | undefined {
  const candidates = [deal.contactEmail, deal.owners.find((owner) => owner.isPrimary)?.email, deal.owners[0]?.email]
  for (const value of candidates) {
    const email = value?.trim()
    if (email && EMAIL_PATTERN.test(email)) return email
  }
  return undefined
}

function merchantPhone(deal: DealRecord): { ok: true; recipient: string } | { ok: false; reason: "missing_recipient" | "invalid_recipient" } {
  const raw = deal.contactPhone?.trim()
  if (!raw) return { ok: false, reason: "missing_recipient" }
  try {
    return { ok: true, recipient: normalizeSmsRecipient(raw) }
  } catch {
    return { ok: false, reason: "invalid_recipient" }
  }
}

async function pickFollowupSenderFor(actor: DealActor, dealId?: string, templateId?: string): Promise<StoredEmailSender | undefined> {
  const senders = await listSendersByWorkspace(actor.workspaceId)
  const resolved = await resolveFollowupSender(actor, { dealId, templateId })
  if (resolved.ok && resolved.sender?.id) {
    const matched = senders.find((item) => item.id === resolved.sender?.id)
    if (matched) return matched
  }
  const usable = senders.filter((sender) => sender.state === "verified" && sender.credentialCipher && sender.purpose !== "submission")
  for (const purpose of ["merchant", "fallback"] as const) {
    const matched = usable.filter((sender) => sender.purpose === purpose)
    const preferred = matched.find((sender) => sender.isDefault) ?? matched[0]
    if (preferred) return preferred
  }
  return usable[0]
}

async function loadPolicyRow(workspaceId: string, policyId: string): Promise<PolicyRow | undefined> {
  return db().prepare<PolicyRow>("SELECT * FROM mca_followup_policies WHERE workspace_id=? AND id=?").get(workspaceId, policyId)
}

async function loadPolicies(workspaceId: string, enabledOnly = false): Promise<PolicyRow[]> {
  const sql = enabledOnly
    ? "SELECT * FROM mca_followup_policies WHERE workspace_id=? AND enabled=1 ORDER BY created_at, id"
    : "SELECT * FROM mca_followup_policies WHERE workspace_id=? ORDER BY created_at, id"
  return db().prepare<PolicyRow>(sql).all(workspaceId)
}

async function lastOccurrence(workspaceId: string, policyId: string): Promise<OccurrenceRow | undefined> {
  return db().prepare<OccurrenceRow>(
    `SELECT * FROM mca_followup_occurrences
     WHERE workspace_id=? AND policy_id=?
     ORDER BY scheduled_for DESC, updated_at DESC, id DESC
     LIMIT 1`,
  ).get(workspaceId, policyId)
}

async function loadOccurrence(workspaceId: string, policyId: string, dealId: string, occurrenceKey: string): Promise<OccurrenceRow | undefined> {
  return db().prepare<OccurrenceRow>(
    "SELECT * FROM mca_followup_occurrences WHERE workspace_id=? AND policy_id=? AND deal_id=? AND occurrence_key=?",
  ).get(workspaceId, policyId, dealId, occurrenceKey)
}

async function templateName(workspaceId: string, templateId: string): Promise<{ name: string | null; published: boolean }> {
  const row = await db().prepare<{ name: string; published_version_id: string | null }>(
    "SELECT name, published_version_id FROM mca_message_templates WHERE workspace_id=? AND id=?",
  ).get(workspaceId, templateId)
  return { name: row?.name ?? null, published: Boolean(row?.published_version_id) }
}

async function listPublishedTemplates(workspaceId: string): Promise<FollowupTemplateOption[]> {
  const rows = await db().prepare<TemplateOptionRow>(
    `SELECT id, name, channel, scope, published_version_id
     FROM mca_message_templates
     WHERE workspace_id=? AND published_version_id IS NOT NULL
     ORDER BY name ASC, channel ASC`,
  ).all(workspaceId)
  return rows
    .filter((row) => ALLOWED_TEMPLATE_SCOPES.has(String(row.scope)))
    .map((row) => ({
      id: String(row.id),
      name: String(row.name),
      channel: row.channel as MessageChannel,
      scope: String(row.scope),
      published: Boolean(row.published_version_id),
    }))
}

async function mapPolicy(row: PolicyRow, fallbackTimezone: string): Promise<FollowupPolicyView> {
  const template = await templateName(row.workspace_id, row.template_id)
  const last = await lastOccurrence(row.workspace_id, row.id)
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    dealStatus: row.deal_status as DealStatus,
    channel: row.channel as MessageChannel,
    localSchedule: asSchedule(row.local_schedule, fallbackTimezone),
    templateId: row.template_id,
    templateName: template.name,
    templatePublished: template.published,
    enabled: Number(row.enabled) === 1,
    retryPolicy: asRetryPolicy(row.retry_policy_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastOccurrence: last ? {
      id: last.id,
      dealId: last.deal_id,
      occurrenceKey: last.occurrence_key,
      state: last.state as FollowupOccurrenceState,
      skipReason: last.skip_reason ?? undefined,
      scheduledFor: last.scheduled_for,
      attemptedAt: last.attempted_at ?? undefined,
      correlationId: last.correlation_id,
    } : undefined,
  }
}

async function assertPublishedTemplate(actor: DealActor, templateId: string, channel: MessageChannel) {
  let template
  try {
    template = await getPublishedMessageTemplate(actor, templateId)
  } catch (error) {
    if (error instanceof AppError && (error.code === "template_not_found" || error.code === "template_not_published")) {
      invalid("templateId", "Choose a published template.")
    }
    throw error
  }
  if (template.channel !== channel) invalid("templateId", "Choose a published template for this channel.")
  if (!ALLOWED_TEMPLATE_SCOPES.has(template.scope)) invalid("templateId", "Choose a merchant or follow-up template.")
  return template
}

function http(): FollowupFetch {
  return fetchOverride ?? globalThis.fetch
}

function redactedPayload(message: FollowupDeliveryMessage) {
  return {
    template: "merchant_followup",
    occurrenceId: message.occurrenceId,
    workspaceId: message.workspaceId,
    policyId: message.policyId,
    dealId: message.dealId,
    channel: message.channel,
    to: message.to,
    fromName: message.fromName,
    fromAddress: message.fromAddress,
    subject: message.subject,
    text: message.text,
    correlationId: message.correlationId,
    mode: message.mode,
    occurrenceKey: message.occurrenceKey,
  }
}

async function defaultTransport(message: FollowupDeliveryMessage): Promise<{ delivery: FollowupDelivery; providerMessageId?: string; error?: string }> {
  if (message.channel === "sms") {
    if (process.env.NODE_ENV === "production" && !transportOverride) {
      return { delivery: "failed", error: "SMS delivery is not configured for follow-ups in this deployment." }
    }
    return { delivery: "preview" }
  }
  const webhook = process.env.MCA_EMAIL_WEBHOOK_URL?.trim()
  if (!webhook && !fetchOverride) {
    if (process.env.NODE_ENV === "production") {
      return { delivery: "failed", error: "Email delivery is not configured for this deployment." }
    }
    return { delivery: "preview" }
  }
  const target = webhook || "mca://followup/deliver"
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
    if (!response.ok) return { delivery: "failed", error: "The email provider did not accept the follow-up." }
    return { delivery: "sent" }
  } catch (error) {
    if (error instanceof AppError) return { delivery: "failed", error: error.message }
    return { delivery: "failed", error: "The email provider did not accept the follow-up." }
  }
}

async function deliverFollowup(message: FollowupDeliveryMessage): Promise<{ delivery: FollowupDelivery; providerMessageId?: string; error?: string }> {
  const transport = transportOverride ?? defaultTransport
  try {
    const result = await transport(message)
    if (result.delivery === "failed") {
      return { delivery: "failed", error: result.error ?? "The follow-up could not be delivered.", providerMessageId: result.providerMessageId }
    }
    return { delivery: result.delivery, providerMessageId: result.providerMessageId }
  } catch (error) {
    if (error instanceof AppError) return { delivery: "failed", error: error.message }
    return { delivery: "failed", error: "The follow-up could not be delivered." }
  }
}

type Preflight =
  | { kind: "send"; recipient: string; sender?: StoredEmailSender }
  | { kind: "skip"; reason: FollowupSkipReason }
  | { kind: "fail"; reason: FollowupSkipReason }

async function preflightDeal(actor: DealActor, policy: FollowupPolicyView, deal: DealRecord, sender: StoredEmailSender | undefined): Promise<Preflight> {
  if (deal.workspaceId !== actor.workspaceId) return { kind: "skip", reason: "deal_not_found" }
  if (deal.status !== policy.dealStatus) return { kind: "skip", reason: "stage_changed" }
  if (!policy.templatePublished) return { kind: "fail", reason: "template_not_published" }
  if (policy.channel === "email") {
    const email = merchantEmail(deal)
    if (!deal.contactEmail?.trim() && !deal.owners.some((owner) => owner.email?.trim())) return { kind: "skip", reason: "missing_recipient" }
    if (!email) return { kind: "skip", reason: "invalid_recipient" }
    if (!sender) return { kind: "fail", reason: "sender_unavailable" }
    return { kind: "send", recipient: email, sender }
  }
  const phone = merchantPhone(deal)
  if (!phone.ok) return { kind: "skip", reason: phone.reason }
  try {
    const consent = await getSmsConsent(actor, deal.id, phone.recipient)
    if (consent.state === "opted_out") return { kind: "skip", reason: "sms_recipient_opted_out" }
    if (consent.state !== "opted_in") return { kind: "skip", reason: "sms_consent_required" }
  } catch (error) {
    if (error instanceof AppError && (error.code === "recipient_deal_mismatch" || error.code === "recipient_invalid")) {
      return { kind: "skip", reason: error.code === "recipient_deal_mismatch" ? "recipient_mismatch" : "invalid_recipient" }
    }
    throw error
  }
  return { kind: "send", recipient: phone.recipient }
}

async function renderForDeal(actor: DealActor, policy: FollowupPolicyView, dealId: string, origin: string): Promise<RenderedMessageTemplate | { reason: FollowupSkipReason }> {
  try {
    const rendered = await renderPublishedMessageTemplate(actor, { templateId: policy.templateId, dealId, origin })
    if (rendered.publishBlocked || rendered.unknownVariables.length || rendered.forbiddenVariables.length) {
      return { reason: "template_invalid" }
    }
    if (rendered.channel !== policy.channel) return { reason: "template_channel_mismatch" }
    return rendered
  } catch (error) {
    if (error instanceof AppError) {
      if (error.code === "template_not_found" || error.code === "template_not_published") return { reason: "template_not_published" }
      if (error.code === "deal_not_found") return { reason: "deal_not_found" }
      if (error.code === "unknown_variable" || error.code === "forbidden_variable") return { reason: "template_invalid" }
    }
    throw error
  }
}

async function claimOccurrence(input: {
  id: string
  workspaceId: string
  policyId: string
  dealId: string
  occurrenceKey: string
  scheduledFor: string
  correlationId: string
  retry: FollowupRetryPolicy
  nowIsoValue: string
}): Promise<{ row: OccurrenceRow; action: ClaimAction }> {
  return withImmediateTransaction(async (database) => {
    const existing = await database.prepare<OccurrenceRow>(
      `SELECT * FROM mca_followup_occurrences
       WHERE workspace_id=? AND policy_id=? AND deal_id=? AND occurrence_key=?
       FOR UPDATE`,
    ).get(input.workspaceId, input.policyId, input.dealId, input.occurrenceKey)
    if (existing?.state === "sent" || existing?.state === "skipped") return { row: existing, action: "already" }
    const nowMs = Date.parse(input.nowIsoValue)
    if (existing?.state === "failed") {
      const attempts = failedAttempts(existing.skip_reason)
      if (attempts >= input.retry.maxAttempts) return { row: existing, action: "exhausted" }
      const attemptedMs = existing.attempted_at ? Date.parse(existing.attempted_at) : 0
      if (Number.isFinite(attemptedMs) && attemptedMs + input.retry.backoffMinutes * 60_000 > nowMs) {
        return { row: existing, action: "retry_wait" }
      }
    }
    if (existing?.state === "pending" && existing.attempted_at) {
      const attemptedMs = Date.parse(existing.attempted_at)
      if (Number.isFinite(attemptedMs) && nowMs - attemptedMs < IN_FLIGHT_MS) return { row: existing, action: "in_flight" }
    }
    if (!existing) {
      const inserted = await database.prepare<OccurrenceRow>(
        `INSERT INTO mca_followup_occurrences
          (id, workspace_id, policy_id, deal_id, occurrence_key, state, skip_reason, message_id, correlation_id, scheduled_for, attempted_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'pending', NULL, NULL, ?, ?, ?, ?, ?)
         ON CONFLICT (workspace_id, policy_id, deal_id, occurrence_key) DO NOTHING
         RETURNING *`,
      ).get(
        input.id,
        input.workspaceId,
        input.policyId,
        input.dealId,
        input.occurrenceKey,
        input.correlationId,
        input.scheduledFor,
        input.nowIsoValue,
        input.nowIsoValue,
        input.nowIsoValue,
      )
      if (inserted) return { row: inserted, action: "claimed" }
      const raced = await database.prepare<OccurrenceRow>(
        `SELECT * FROM mca_followup_occurrences
         WHERE workspace_id=? AND policy_id=? AND deal_id=? AND occurrence_key=?
         FOR UPDATE`,
      ).get(input.workspaceId, input.policyId, input.dealId, input.occurrenceKey)
      if (!raced) throw new Error("Follow-up occurrence claim did not return a row.")
      if (raced.state === "sent" || raced.state === "skipped") return { row: raced, action: "already" }
      return { row: raced, action: raced.state === "failed" ? "retry_wait" : "in_flight" }
    }
    const updated = await database.prepare<OccurrenceRow>(
      `UPDATE mca_followup_occurrences
       SET state='pending', attempted_at=?, updated_at=?
       WHERE workspace_id=? AND id=? AND state IN ('pending', 'failed')
       RETURNING *`,
    ).get(input.nowIsoValue, input.nowIsoValue, input.workspaceId, existing.id)
    return { row: updated ?? existing, action: updated ? "claimed" : "already" }
  })
}

async function finalizeOccurrence(row: OccurrenceRow, patch: {
  state: FollowupOccurrenceState
  skipReason?: string | null
  messageId?: string | null
  nowIsoValue: string
}): Promise<OccurrenceRow> {
  const updated = await db().prepare<OccurrenceRow>(
    `UPDATE mca_followup_occurrences
     SET state=?, skip_reason=?, message_id=?, attempted_at=?, updated_at=?
     WHERE workspace_id=? AND id=? AND state IN ('pending', 'failed')
     RETURNING *`,
  ).get(
    patch.state,
    patch.skipReason ?? null,
    patch.messageId === undefined ? row.message_id : patch.messageId,
    patch.nowIsoValue,
    patch.nowIsoValue,
    row.workspace_id,
    row.id,
  )
  return updated ?? { ...row, state: patch.state, skip_reason: patch.skipReason ?? row.skip_reason }
}

function alreadyOutcome(policyId: string, row: OccurrenceRow, reason: FollowupSkipReason): FollowupOutcome {
  return {
    policyId,
    dealId: row.deal_id,
    occurrenceKey: row.occurrence_key,
    state: row.state as FollowupOccurrenceState,
    reason,
    occurrenceId: row.id,
    correlationId: row.correlation_id,
  }
}

async function processDeal(input: {
  actor: DealActor
  policy: FollowupPolicyView
  dealId: string
  window: FollowupOccurrenceWindow
  sender: StoredEmailSender | undefined
  nowIsoValue: string
  origin: string
}): Promise<FollowupOutcome> {
  const correlationId = input.actor.correlationId || newId()
  const claimed = await claimOccurrence({
    id: newId(),
    workspaceId: input.actor.workspaceId,
    policyId: input.policy.id,
    dealId: input.dealId,
    occurrenceKey: input.window.occurrenceKey,
    scheduledFor: input.window.scheduledFor,
    correlationId,
    retry: input.policy.retryPolicy,
    nowIsoValue: input.nowIsoValue,
  })
  if (claimed.action === "already") return alreadyOutcome(input.policy.id, claimed.row, claimed.row.state === "sent" ? "already_sent" : (claimed.row.skip_reason as FollowupSkipReason) || "already_sent")
  if (claimed.action === "retry_wait") return alreadyOutcome(input.policy.id, claimed.row, "retry_wait")
  if (claimed.action === "in_flight") return alreadyOutcome(input.policy.id, claimed.row, "in_flight")
  if (claimed.action === "exhausted") return alreadyOutcome(input.policy.id, claimed.row, "max_retries")

  let deal: DealRecord
  try {
    deal = await getDealForDocument(input.actor, input.dealId)
  } catch (error) {
    if (error instanceof AppError && error.code === "deal_not_found") {
      const row = await finalizeOccurrence(claimed.row, { state: "skipped", skipReason: "deal_not_found", nowIsoValue: input.nowIsoValue })
      await recordAuditEvent({
        context: input.actor,
        action: "followup.skipped",
        resourceType: "followup_occurrence",
        resourceId: row.id,
        metadata: { policyId: input.policy.id, dealId: input.dealId, reason: "deal_not_found", occurrenceKey: input.window.occurrenceKey },
        correlationId: row.correlation_id,
      })
      return { policyId: input.policy.id, dealId: input.dealId, occurrenceKey: input.window.occurrenceKey, state: "skipped", reason: "deal_not_found", occurrenceId: row.id, correlationId: row.correlation_id }
    }
    throw error
  }

  const check = await preflightDeal(input.actor, input.policy, deal, input.sender)
  if (check.kind !== "send") {
    const state: FollowupOccurrenceState = check.kind === "fail" ? "failed" : "skipped"
    const skipReason = check.kind === "fail" && check.reason === "send_failed" ? `send_failed:${failedAttempts(claimed.row.skip_reason) + 1}` : check.reason
    const failedReason = check.kind === "fail" && (check.reason === "sender_unavailable" || check.reason === "template_not_published")
      ? `send_failed:${Math.max(failedAttempts(claimed.row.skip_reason), 0) + 1}`
      : skipReason
    const row = await finalizeOccurrence(claimed.row, {
      state,
      skipReason: state === "failed" ? failedReason : check.reason,
      nowIsoValue: input.nowIsoValue,
    })
    await recordAuditEvent({
      context: input.actor,
      action: state === "failed" ? "followup.failed" : "followup.skipped",
      resourceType: "followup_occurrence",
      resourceId: row.id,
      metadata: { policyId: input.policy.id, dealId: deal.id, reason: check.reason, occurrenceKey: input.window.occurrenceKey, channel: input.policy.channel },
      correlationId: row.correlation_id,
    })
    return { policyId: input.policy.id, dealId: deal.id, occurrenceKey: input.window.occurrenceKey, state, reason: check.reason, occurrenceId: row.id, correlationId: row.correlation_id }
  }

  const rendered = await renderForDeal(input.actor, input.policy, deal.id, input.origin)
  if ("reason" in rendered) {
    const fail = rendered.reason === "template_not_published" || rendered.reason === "template_invalid" || rendered.reason === "template_channel_mismatch"
    const row = await finalizeOccurrence(claimed.row, {
      state: fail ? "failed" : "skipped",
      skipReason: fail ? `send_failed:${failedAttempts(claimed.row.skip_reason) + 1}` : rendered.reason,
      nowIsoValue: input.nowIsoValue,
    })
    await recordAuditEvent({
      context: input.actor,
      action: fail ? "followup.failed" : "followup.skipped",
      resourceType: "followup_occurrence",
      resourceId: row.id,
      metadata: { policyId: input.policy.id, dealId: deal.id, reason: rendered.reason, occurrenceKey: input.window.occurrenceKey },
      correlationId: row.correlation_id,
    })
    return { policyId: input.policy.id, dealId: deal.id, occurrenceKey: input.window.occurrenceKey, state: fail ? "failed" : "skipped", reason: rendered.reason, occurrenceId: row.id, correlationId: row.correlation_id }
  }

  const message: FollowupDeliveryMessage = {
    occurrenceId: claimed.row.id,
    workspaceId: input.actor.workspaceId,
    policyId: input.policy.id,
    dealId: deal.id,
    channel: input.policy.channel,
    to: check.recipient,
    fromName: check.sender?.fromName,
    fromAddress: check.sender?.fromAddress,
    subject: rendered.subject,
    html: rendered.html,
    text: rendered.text,
    correlationId: claimed.row.correlation_id,
    mode: "live",
    occurrenceKey: input.window.occurrenceKey,
  }
  const delivered = await deliverFollowup(message)
  const accepted = delivered.delivery === "sent" || delivered.delivery === "preview"
  const attempts = failedAttempts(claimed.row.skip_reason) + 1
  const row = await finalizeOccurrence(claimed.row, {
    state: accepted ? "sent" : "failed",
    skipReason: accepted ? null : `send_failed:${attempts}`,
    messageId: delivered.providerMessageId ?? null,
    nowIsoValue: input.nowIsoValue,
  })
  await recordAuditEvent({
    context: input.actor,
    action: accepted ? "followup.sent" : "followup.failed",
    resourceType: "followup_occurrence",
    resourceId: row.id,
    metadata: {
      policyId: input.policy.id,
      dealId: deal.id,
      channel: input.policy.channel,
      occurrenceKey: input.window.occurrenceKey,
      delivery: delivered.delivery,
      templateId: input.policy.templateId,
    },
    correlationId: row.correlation_id,
  })
  return {
    policyId: input.policy.id,
    dealId: deal.id,
    occurrenceKey: input.window.occurrenceKey,
    state: accepted ? "sent" : "failed",
    reason: accepted ? undefined : "send_failed",
    occurrenceId: row.id,
    correlationId: row.correlation_id,
    delivery: delivered.delivery,
  }
}

function tally(outcomes: FollowupOutcome[]): FollowupRunResult {
  let attempted = 0
  let sent = 0
  let skipped = 0
  let failed = 0
  for (const outcome of outcomes) {
    if (
      outcome.reason === "not_due"
      || outcome.reason === "already_sent"
      || outcome.reason === "retry_wait"
      || outcome.reason === "in_flight"
      || outcome.reason === "max_retries"
      || outcome.reason === "invalid_schedule"
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

export async function runFollowups(input: RunCommsJobsInput): Promise<FollowupRunResult> {
  if (!isAdmin(input.actor) && input.actor.source !== "api_key") denied()
  const settings = await getWorkspaceSettings(input.actor.workspaceId)
  const origin = appOrigin()
  const sender = await pickFollowupSenderFor(input.actor)
  const policies = await loadPolicies(input.actor.workspaceId, true)
  const outcomes: FollowupOutcome[] = []
  for (const policyRow of policies) {
    let policy: FollowupPolicyView
    try {
      policy = await mapPolicy(policyRow, settings.timezone)
    } catch {
      outcomes.push({ policyId: policyRow.id, state: "pending", reason: "invalid_schedule" })
      continue
    }
    const window = followupOccurrenceFor(policy.localSchedule, input.nowIso)
    if (!window) {
      outcomes.push({ policyId: policy.id, state: "pending", reason: "invalid_schedule" })
      continue
    }
    if (!window.due) {
      outcomes.push({ policyId: policy.id, occurrenceKey: window.occurrenceKey, state: "pending", reason: "not_due" })
      continue
    }
    const matching = await listDealRecords(input.actor.workspaceId, { statuses: [policy.dealStatus] })
    const open = await db().prepare<OccurrenceRow>(
      `SELECT * FROM mca_followup_occurrences
       WHERE workspace_id=? AND policy_id=? AND occurrence_key=? AND state IN ('pending', 'failed')`,
    ).all(input.actor.workspaceId, policy.id, window.occurrenceKey)
    const dealIds = [...new Set([...matching.map((deal) => deal.id), ...open.map((row) => row.deal_id)])].sort()
    for (const dealId of dealIds) {
      outcomes.push(await processDeal({
        actor: input.actor,
        policy,
        dealId,
        window,
        sender,
        nowIsoValue: input.nowIso,
        origin,
      }))
    }
  }
  return tally(outcomes)
}

async function followupJobHandler(input: RunCommsJobsInput): Promise<Partial<RunCommsJobsResult>> {
  const result = await runFollowups(input)
  return { followups: { attempted: result.attempted, sent: result.sent, skipped: result.skipped } }
}

registerCommsJob("followup", followupJobHandler)

export async function listFollowupPolicies(actor: DealActor): Promise<FollowupCatalog> {
  if (!isAdmin(actor)) denied()
  const settings = await getWorkspaceSettings(actor.workspaceId)
  const rows = await loadPolicies(actor.workspaceId)
  const policies: FollowupPolicyView[] = []
  for (const row of rows) policies.push(await mapPolicy(row, settings.timezone))
  return {
    policies,
    templates: await listPublishedTemplates(actor.workspaceId),
    defaultTimezone: settings.timezone,
    statuses: DEAL_STATUSES.map((value) => ({ value, label: DEAL_STATUS_LABELS[value] })),
    canManage: isAdmin(actor) && actor.source === "user",
  }
}

export async function getFollowupPolicy(actor: DealActor, policyId: string): Promise<FollowupPolicyView> {
  if (!isAdmin(actor)) denied()
  const settings = await getWorkspaceSettings(actor.workspaceId)
  const row = await loadPolicyRow(actor.workspaceId, asId(policyId, "policyId"))
  if (!row) throw new AppError(404, "followup_policy_not_found", "The requested follow-up policy was not found.")
  return mapPolicy(row, settings.timezone)
}

export async function createFollowupPolicy(actor: DealActor, input: z.infer<typeof followupPolicyCreateSchema>): Promise<FollowupPolicyView> {
  if (!isAdmin(actor) || actor.source !== "user") denied()
  const settings = await getWorkspaceSettings(actor.workspaceId)
  const schedule = asSchedule(input.localSchedule, settings.timezone)
  const retryPolicy = asRetryPolicy(input.retryPolicy ?? {})
  const channel = input.channel
  await assertPublishedTemplate(actor, input.templateId, channel)
  const now = nowIso()
  const id = newId()
  await db().prepare(`INSERT INTO mca_followup_policies
    (id, workspace_id, deal_status, channel, local_schedule, template_id, enabled, retry_policy_json, created_by_user_id, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    id,
    actor.workspaceId,
    input.dealStatus,
    channel,
    JSON.stringify(schedule),
    input.templateId,
    input.enabled === false ? 0 : 1,
    JSON.stringify(retryPolicy),
    actor.userId,
    now,
    now,
  )
  await recordAuditEvent({
    context: actor,
    action: "followup.policy_created",
    resourceType: "followup_policy",
    resourceId: id,
    metadata: { dealStatus: input.dealStatus, channel, templateId: input.templateId, frequency: schedule.frequency, enabled: input.enabled !== false },
    correlationId: actor.correlationId,
  })
  return getFollowupPolicy(actor, id)
}

export async function updateFollowupPolicy(actor: DealActor, policyId: string, input: z.infer<typeof followupPolicyPatchSchema>): Promise<FollowupPolicyView> {
  if (!isAdmin(actor) || actor.source !== "user") denied()
  const id = asId(policyId, "policyId")
  const settings = await getWorkspaceSettings(actor.workspaceId)
  const existing = await loadPolicyRow(actor.workspaceId, id)
  if (!existing) throw new AppError(404, "followup_policy_not_found", "The requested follow-up policy was not found.")
  const channel = input.channel ?? (existing.channel as MessageChannel)
  const dealStatus = input.dealStatus ?? (existing.deal_status as DealStatus)
  const schedule = asSchedule(input.localSchedule ?? existing.local_schedule, settings.timezone)
  const retryPolicy = asRetryPolicy(input.retryPolicy ?? existing.retry_policy_json)
  const templateId = input.templateId ?? existing.template_id
  const enabled = input.enabled == null ? Number(existing.enabled) === 1 : input.enabled
  await assertPublishedTemplate(actor, templateId, channel)
  const now = nowIso()
  await db().prepare(`UPDATE mca_followup_policies
    SET deal_status=?, channel=?, local_schedule=?, template_id=?, enabled=?, retry_policy_json=?, updated_at=?
    WHERE workspace_id=? AND id=?`).run(
    dealStatus,
    channel,
    JSON.stringify(schedule),
    templateId,
    enabled ? 1 : 0,
    JSON.stringify(retryPolicy),
    now,
    actor.workspaceId,
    id,
  )
  await recordAuditEvent({
    context: actor,
    action: "followup.policy_updated",
    resourceType: "followup_policy",
    resourceId: id,
    metadata: { dealStatus, channel, templateId, frequency: schedule.frequency, enabled },
    correlationId: actor.correlationId,
  })
  return getFollowupPolicy(actor, id)
}

export async function previewFollowupPolicy(actor: DealActor, input: { policyId: string; dealId?: string; nowIso?: string; origin?: string }): Promise<FollowupPreviewResult> {
  if (!isAdmin(actor)) denied()
  const policy = await getFollowupPolicy(actor, input.policyId)
  const nowIsoValue = input.nowIso ?? nowIso()
  if (!Number.isFinite(Date.parse(nowIsoValue))) {
    throw new AppError(422, "invalid_clock", "Provide a valid ISO-8601 nowIso for follow-up schedules.")
  }
  const window = followupOccurrenceFor(policy.localSchedule, nowIsoValue)
  const sender = await pickFollowupSenderFor(actor, input.dealId, policy.templateId)
  const matching = policy.enabled
    ? await listDealRecords(actor.workspaceId, { statuses: [policy.dealStatus] })
    : []
  const deals: FollowupPreviewDeal[] = []
  for (const deal of matching.sort((left, right) => left.id.localeCompare(right.id))) {
    if (input.dealId && deal.id !== input.dealId) continue
    const check = await preflightDeal(actor, policy, deal, sender)
    const existing = window ? await loadOccurrence(actor.workspaceId, policy.id, deal.id, window.occurrenceKey) : undefined
    let reason: FollowupSkipReason | undefined
    if (!policy.enabled) reason = "policy_disabled"
    else if (!window) reason = "invalid_schedule"
    else if (!window.due) reason = "not_due"
    else if (existing?.state === "sent") reason = "already_sent"
    else if (existing?.state === "skipped") reason = (existing.skip_reason as FollowupSkipReason) || "already_sent"
    else if (check.kind !== "send") reason = check.reason
    deals.push({
      dealId: deal.id,
      displayId: deal.displayId,
      legalName: deal.legalName?.trim() || "Untitled draft",
      status: deal.status,
      recipient: check.kind === "send" ? check.recipient : undefined,
      wouldSend: !reason,
      reason,
    })
  }
  let rendered: FollowupPreviewResult["rendered"]
  const target = input.dealId ? deals.find((item) => item.dealId === input.dealId) : undefined
  if (input.dealId && target?.wouldSend) {
    const built = await renderForDeal(actor, policy, input.dealId, input.origin ?? appOrigin())
    if (!("reason" in built) && target.recipient) {
      rendered = { dealId: input.dealId, to: target.recipient, channel: policy.channel, subject: built.subject, html: built.html, text: built.text }
    } else if ("reason" in built) {
      target.wouldSend = false
      target.reason = built.reason
    }
  }
  return { mode: "preview", policy, window, deals, rendered }
}

export async function testFollowupPolicy(actor: DealActor, policyId: string, input: { dealId: string; nowIso?: string; origin?: string }): Promise<FollowupTestResult> {
  if (!isAdmin(actor) || actor.source !== "user") denied()
  const policy = await getFollowupPolicy(actor, policyId)
  const correlationId = actor.correlationId || newId()
  let deal: DealRecord
  try {
    deal = await getDealForDocument(actor, asId(input.dealId, "dealId"))
  } catch (error) {
    if (error instanceof AppError && error.code === "deal_not_found") {
      return { mode: "test", policyId: policy.id, dealId: input.dealId, wouldSend: false, reason: "deal_not_found", correlationId }
    }
    throw error
  }
  const sender = await pickFollowupSenderFor(actor, deal.id, policy.templateId)
  const check = await preflightDeal(actor, policy, deal, sender)
  if (check.kind !== "send") {
    return { mode: "test", policyId: policy.id, dealId: deal.id, wouldSend: false, reason: check.reason, correlationId }
  }
  const rendered = await renderForDeal(actor, policy, deal.id, input.origin ?? appOrigin())
  if ("reason" in rendered) {
    return { mode: "test", policyId: policy.id, dealId: deal.id, wouldSend: false, reason: rendered.reason, correlationId }
  }
  const message: FollowupDeliveryMessage = {
    occurrenceId: `test:${newId()}`,
    workspaceId: actor.workspaceId,
    policyId: policy.id,
    dealId: deal.id,
    channel: policy.channel,
    to: check.recipient,
    fromName: check.sender?.fromName,
    fromAddress: check.sender?.fromAddress,
    subject: rendered.subject,
    html: rendered.html,
    text: rendered.text,
    correlationId,
    mode: "test",
    occurrenceKey: "test",
  }
  const delivered = await deliverFollowup(message)
  await recordAuditEvent({
    context: actor,
    action: delivered.delivery === "failed" ? "followup.test_failed" : "followup.test_previewed",
    resourceType: "followup_policy",
    resourceId: policy.id,
    metadata: { dealId: deal.id, channel: policy.channel, delivery: delivered.delivery, mode: "test" },
    correlationId,
  })
  return {
    mode: "test",
    policyId: policy.id,
    dealId: deal.id,
    wouldSend: delivered.delivery !== "failed",
    reason: delivered.delivery === "failed" ? "send_failed" : undefined,
    delivery: delivered.delivery,
    to: check.recipient,
    subject: rendered.subject,
    text: rendered.text,
    correlationId,
  }
}

export async function requireFollowupAdmin(request: Request): Promise<DealActor> {
  assertTrustedMutation(request)
  const auth = await requireWorkspaceAccess(request, { sessionOnly: true, roles: ["admin", "super_admin"] })
  await consumeRequestRateLimit(clientRateKey(request, `followup-write:${auth.workspaceId}`), 30)
  return { ...await actorForDeals(auth), correlationId: requestCorrelationId(request) }
}

export async function requireFollowupAdminRead(request: Request): Promise<DealActor> {
  const auth = await requireWorkspaceAccess(request, { sessionOnly: true, roles: ["admin", "super_admin"] })
  return { ...await actorForDeals(auth), correlationId: requestCorrelationId(request) }
}
