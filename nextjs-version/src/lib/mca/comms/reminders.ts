import "server-only"

import { assertTrustedMutation, requireWorkspaceAccess } from "../auth"
import { getDatabase, newId, nowIso, recordAuditEvent } from "../db"
import type { DealActor } from "../deals/schema"
import { actorForDeals, getDealForDocument } from "../deals/service"
import { AppError } from "../errors"
import { requestCorrelationId } from "../http"
import type { FunderRouteKind } from "../funders/contracts"
import type { EmailSender } from "../senders/contracts"
import { findSenderById, listSendersByWorkspace, toPublicSender, type StoredEmailSender } from "../senders/repository"
import type { JobState, SubmissionJob } from "../submissions/contracts"
import { parseEmailAttemptRef, type EmailAttemptRef } from "../submissions/email-templates"
import { findJobById, listAttemptsForJob, listJobsForDeal } from "../submissions/repository"

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const BODY_MAX = 20_000
const SUBJECT_MAX = 500
const ID_MAX = 80
const FALLBACK_DISCLOSURE =
  "Original thread headers were not stored for this submission. The reminder will be sent as a new email instead of a reply in the original thread."

export const DEFAULT_REMINDER_BODY = `Hi,

Just following up on the submission below. Please let us know if you need anything else.

Thank you.`

export const THREAD_FALLBACK_DISCLOSURE = FALLBACK_DISCLOSURE

export const REMINDER_STATES = ["previewed", "sent", "failed"] as const
export type ReminderState = (typeof REMINDER_STATES)[number]

export const REMINDER_INELIGIBLE_REASONS = ["unsupported_transport", "not_sent", "has_response"] as const
export type ReminderIneligibleReason = (typeof REMINDER_INELIGIBLE_REASONS)[number]

export type ReminderThreadMode = "reply" | "fallback"
export type ReminderDelivery = "sent" | "preview" | "failed"
export type ReminderRemindControl = "remind" | "hidden"

type ReminderFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

export interface ReminderDeliveryMessage {
  reminderId: string
  workspaceId: string
  jobId: string
  dealId: string
  funderId: string
  senderId: string
  fromName: string
  fromAddress: string
  to: string[]
  cc: string[]
  replyTo: string
  subject: string
  body: string
  correlationId: string
  messageId: string
  threadId?: string
  inReplyTo?: string
  references: string[]
  threadMode: ReminderThreadMode
}

export type ReminderTransport = (message: ReminderDeliveryMessage) => Promise<{
  delivery: ReminderDelivery
  providerMessageId?: string
  error?: string
}>

export interface ReminderJobView {
  jobId: string
  dealId: string
  funderId: string
  displayFunderName: string
  routeKind: FunderRouteKind
  submissionState: JobState
  eligible: boolean
  remindControl: ReminderRemindControl
  ineligibleReason?: ReminderIneligibleReason
  lastRemindedAt?: string
  lastReminderId?: string
  lastReminderState?: ReminderState
}

export interface ReminderListResult {
  dealId: string
  canSend: boolean
  defaultBody: string
  jobs: ReminderJobView[]
}

export interface ReminderThreadPreview {
  mode: ReminderThreadMode
  messageId?: string
  threadId?: string
  inReplyTo?: string
  references: string[]
  disclosure?: string
}

export interface ReminderPreview {
  reminderId: string
  jobId: string
  dealId: string
  funderId: string
  displayFunderName: string
  submissionState: JobState
  sender: { id: string; fromName: string; fromAddress: string }
  to: string[]
  cc: string[]
  replyTo: string
  subject: string
  body: string
  defaultBody: string
  thread: ReminderThreadPreview
  lastRemindedAt?: string
  canSend: boolean
  delivery: "preview"
}

export interface ReminderSendResult {
  reminderId: string
  jobId: string
  dealId: string
  funderId: string
  displayFunderName: string
  submissionState: JobState
  state: Extract<ReminderState, "sent" | "failed">
  lastRemindedAt?: string
  delivery: ReminderDelivery
  correlationId: string
  thread: ReminderThreadPreview
  sender: { id: string; fromName: string; fromAddress: string }
  to: string[]
  cc: string[]
  subject: string
  error?: string
}

export interface PreviewFunderReminderInput {
  jobId: string
}

export interface SendFunderReminderInput {
  jobId: string
  reminderId?: string
  body?: string
}

type ReminderRow = {
  id: string
  workspace_id: string
  job_id: string
  sender_id: string | null
  thread_id: string | null
  in_reply_to: string | null
  references_json: string
  state: string
  last_reminded_at: string | null
  correlation_id: string
  actor_user_id: string | null
  created_at: string
  updated_at: string
}

let fetchOverride: ReminderFetch | undefined
let transportOverride: ReminderTransport | undefined

export function setReminderDeliveryFetchForTests(fetchImpl?: ReminderFetch): void {
  fetchOverride = fetchImpl
}

export function setReminderTransportForTests(transport?: ReminderTransport): void {
  transportOverride = transport
}

function db() {
  return getDatabase()
}

function denied(message = "You do not have permission to perform this action."): never {
  throw new AppError(403, "permission_denied", message)
}

function invalid(field: string, message: string): never {
  throw new AppError(422, "validation_failed", "Review the highlighted fields.", { [field]: [message] })
}

function asJobId(value: unknown): string {
  if (typeof value !== "string") invalid("jobId", "Choose a submission to remind.")
  const jobId = value.trim()
  if (!jobId || jobId.length > ID_MAX) invalid("jobId", "Choose a submission to remind.")
  return jobId
}

function asDealId(value: unknown): string {
  if (typeof value !== "string") invalid("dealId", "Choose a deal.")
  const dealId = value.trim()
  if (!dealId || dealId.length > ID_MAX) invalid("dealId", "Choose a deal.")
  return dealId
}

function asReminderId(value: unknown): string | undefined {
  if (value == null || value === "") return undefined
  if (typeof value !== "string") invalid("reminderId", "The reminder identity is invalid.")
  const reminderId = value.trim()
  if (!reminderId || reminderId.length > ID_MAX) invalid("reminderId", "The reminder identity is invalid.")
  return reminderId
}

function asBody(value: unknown, fallback: string): string {
  if (value == null) return fallback
  if (typeof value !== "string") invalid("body", "Enter reminder text.")
  const body = value.replace(/\s+$/g, "")
  if (!body.trim()) invalid("body", "Enter reminder text.")
  if (body.length > BODY_MAX) invalid("body", `Enter reminder text up to ${BODY_MAX} characters.`)
  return body
}

function normalizeEmail(value: string): string {
  return value.trim().toLowerCase()
}

function uniqueAddresses(values: string[]): string[] {
  const seen = new Set<string>()
  const next: string[] = []
  for (const value of values) {
    const trimmed = value.trim()
    if (!trimmed || !EMAIL_PATTERN.test(trimmed)) continue
    const key = normalizeEmail(trimmed)
    if (seen.has(key)) continue
    seen.add(key)
    next.push(trimmed)
  }
  return next
}

function uniqueTokens(values: string[]): string[] {
  const seen = new Set<string>()
  const next: string[] = []
  for (const value of values) {
    const trimmed = value.trim()
    if (!trimmed) continue
    const key = trimmed.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    next.push(trimmed)
  }
  return next
}

function parseDestination(destination: string): string[] {
  return uniqueAddresses(destination.split(/[;,]/))
}

function replySubject(subject: string): string {
  const trimmed = subject.replace(/\s+/g, " ").trim()
  if (!trimmed) return "Following up on your submission"
  const prefixed = /^(re|fw|fwd)\s*:/i.test(trimmed) ? trimmed : `Re: ${trimmed}`
  return prefixed.slice(0, SUBJECT_MAX)
}

function messageIdFor(correlationId: string): string {
  return `<${correlationId}@reminders.mca.local>`
}

function canSend(actor: DealActor): boolean {
  return actor.source !== "api_key"
}

function unsupportedTransport(kind: FunderRouteKind): boolean {
  return kind === "api" || kind === "manual_portal" || kind === "custom_webhook"
}

function ineligibleReason(job: SubmissionJob, hasResponse: boolean): ReminderIneligibleReason | undefined {
  if (job.routeKind !== "email" || unsupportedTransport(job.routeKind)) return "unsupported_transport"
  if (job.state !== "sent") return "not_sent"
  if (hasResponse) return "has_response"
  return undefined
}

function conflict(code: string, message: string): never {
  throw new AppError(409, code, message)
}

function assertEligible(job: SubmissionJob, hasResponse: boolean): void {
  const reason = ineligibleReason(job, hasResponse)
  if (reason === "unsupported_transport") {
    conflict(
      "reminder_unsupported_transport",
      "Reminders are only available for unanswered email submissions. API, portal, and webhook jobs have no email thread to reply on.",
    )
  }
  if (reason === "not_sent") {
    conflict("reminder_not_eligible", "Remind a funder only after the email submission has been sent.")
  }
  if (reason === "has_response") {
    conflict("reminder_already_responded", "This submission already has a funder response.")
  }
}

function threadFromAttempt(ref: EmailAttemptRef | undefined): ReminderThreadPreview {
  const messageId = ref?.messageId?.trim()
  if (!messageId) {
    return { mode: "fallback", references: [], disclosure: FALLBACK_DISCLOSURE }
  }
  const references = uniqueTokens([...(ref?.references ?? []), messageId])
  return {
    mode: "reply",
    messageId,
    threadId: ref?.threadId?.trim() || messageId,
    inReplyTo: messageId,
    references,
  }
}

function redactedPayload(message: ReminderDeliveryMessage) {
  return {
    template: "funder_reminder",
    reminderId: message.reminderId,
    jobId: message.jobId,
    dealId: message.dealId,
    funderId: message.funderId,
    senderId: message.senderId,
    fromName: message.fromName,
    fromAddress: message.fromAddress,
    to: message.to,
    cc: message.cc,
    replyTo: message.replyTo,
    subject: message.subject,
    body: message.body,
    correlationId: message.correlationId,
    messageId: message.messageId,
    threadId: message.threadId,
    inReplyTo: message.inReplyTo,
    references: message.references,
    threadMode: message.threadMode,
  }
}

function http(): ReminderFetch {
  return fetchOverride ?? globalThis.fetch
}

async function defaultTransport(message: ReminderDeliveryMessage): Promise<{ delivery: ReminderDelivery; error?: string }> {
  const webhook = process.env.MCA_EMAIL_WEBHOOK_URL?.trim()
  if (!webhook && !fetchOverride) {
    if (process.env.NODE_ENV === "production") {
      return { delivery: "failed", error: "Email delivery is not configured for this deployment." }
    }
    return { delivery: "preview" }
  }
  const target = webhook || "mca://reminders/deliver"
  try {
    const response = await http()(target, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(process.env.MCA_EMAIL_WEBHOOK_TOKEN ? { authorization: `Bearer ${process.env.MCA_EMAIL_WEBHOOK_TOKEN}` } : {}),
        "x-correlation-id": message.correlationId,
        "message-id": message.messageId,
        ...(message.inReplyTo ? { "in-reply-to": message.inReplyTo } : {}),
        ...(message.threadId ? { "x-thread-id": message.threadId } : {}),
      },
      body: JSON.stringify(redactedPayload(message)),
      signal: AbortSignal.timeout(10_000),
    })
    if (!response.ok) {
      return { delivery: "failed", error: "The email provider did not accept the reminder." }
    }
    return { delivery: "sent" }
  } catch (error) {
    if (error instanceof AppError) return { delivery: "failed", error: error.message }
    return { delivery: "failed", error: "The email provider did not accept the reminder." }
  }
}

async function deliverReminder(message: ReminderDeliveryMessage): Promise<{ delivery: ReminderDelivery; error?: string }> {
  await (await import("../company-access")).assertCompanyOperational(message.workspaceId)
  const transport = transportOverride ?? defaultTransport
  try {
    const result = await transport(message)
    if (result.delivery === "failed") {
      return { delivery: "failed", error: result.error ?? "The email provider did not accept the reminder." }
    }
    return { delivery: result.delivery }
  } catch (error) {
    if (error instanceof AppError) return { delivery: "failed", error: error.message }
    return { delivery: "failed", error: "The email provider did not accept the reminder." }
  }
}

function usableSender(stored: StoredEmailSender): EmailSender {
  if (stored.purpose !== "submission") {
    throw new AppError(422, "sender_purpose_mismatch", "That sender is not assigned to this purpose.")
  }
  if (stored.state === "expired") {
    throw new AppError(409, "sender_expired", "This sender connection expired. Reconnect to resume sending.")
  }
  if (stored.state === "revoked") {
    throw new AppError(409, "sender_revoked", "This sender was revoked. Reconnect or restore it before sending.")
  }
  if (stored.state !== "verified" || !stored.credentialCipher) {
    throw new AppError(409, "sender_not_usable", "Connect and verify a submission email sender before sending a reminder.")
  }
  return toPublicSender(stored)
}

async function resolveReminderSender(actor: DealActor, senderId?: string): Promise<EmailSender> {
  if (senderId) {
    const stored = await findSenderById(actor.workspaceId, senderId)
    if (!stored || stored.workspaceId !== actor.workspaceId) denied()
    return usableSender(stored)
  }
  const stored = await listSendersByWorkspace(actor.workspaceId)
  const candidates = stored.filter((sender) => sender.purpose === "submission" && sender.state === "verified" && sender.credentialCipher)
  const preferred = candidates.find((sender) => sender.isDefault) ?? candidates[0]
  if (!preferred) {
    throw new AppError(409, "sender_not_usable", "Connect and verify a submission email sender before sending a reminder.")
  }
  return usableSender(preferred)
}

async function originalAttemptRef(job: SubmissionJob): Promise<EmailAttemptRef | undefined> {
  const attempts = await listAttemptsForJob(job.id)
  const sent = [...attempts].reverse().find((attempt) => attempt.state === "sent" && attempt.externalRef)
  return parseEmailAttemptRef(sent?.externalRef)
}

async function jobHasResponse(workspaceId: string, jobId: string): Promise<boolean> {
  const row = await db().prepare<{ ok: number }>(
    `SELECT 1 AS ok FROM mca_funder_replies
     WHERE workspace_id = ? AND matched_job_id = ? AND state IN ('matched', 'processed', 'pending_review')
     LIMIT 1`,
  ).get(workspaceId, jobId)
  return Boolean(row)
}

async function responseJobIds(workspaceId: string, jobIds: string[]): Promise<Set<string>> {
  const matched = new Set<string>()
  if (!jobIds.length) return matched
  const rows = await db().prepare<{ matched_job_id: string }>(
    `SELECT DISTINCT matched_job_id FROM mca_funder_replies
     WHERE workspace_id = ? AND matched_job_id IS NOT NULL AND state IN ('matched', 'processed', 'pending_review')`,
  ).all(workspaceId)
  const wanted = new Set(jobIds)
  for (const row of rows) {
    if (wanted.has(row.matched_job_id)) matched.add(row.matched_job_id)
  }
  return matched
}

async function loadReminder(workspaceId: string, reminderId: string): Promise<ReminderRow | undefined> {
  return db().prepare<ReminderRow>(
    "SELECT * FROM mca_funder_reminders WHERE workspace_id = ? AND id = ?",
  ).get(workspaceId, reminderId)
}

async function latestReminder(workspaceId: string, jobId: string): Promise<ReminderRow | undefined> {
  return db().prepare<ReminderRow>(
    `SELECT * FROM mca_funder_reminders
     WHERE workspace_id = ? AND job_id = ?
     ORDER BY created_at DESC, id DESC
     LIMIT 1`,
  ).get(workspaceId, jobId)
}

async function lastSentReminder(workspaceId: string, jobId: string): Promise<ReminderRow | undefined> {
  return db().prepare<ReminderRow>(
    `SELECT * FROM mca_funder_reminders
     WHERE workspace_id = ? AND job_id = ? AND state = 'sent' AND last_reminded_at IS NOT NULL
     ORDER BY last_reminded_at DESC, created_at DESC, id DESC
     LIMIT 1`,
  ).get(workspaceId, jobId)
}

function inJobIds(jobIds: string[]): string {
  return jobIds.map(() => "?").join(", ")
}

async function latestRemindersByJob(workspaceId: string, jobIds: string[]): Promise<Map<string, ReminderRow>> {
  const map = new Map<string, ReminderRow>()
  if (!jobIds.length) return map
  const rows = await db().prepare<ReminderRow>(
    `SELECT * FROM mca_funder_reminders
     WHERE workspace_id = ? AND job_id IN (${inJobIds(jobIds)})
     ORDER BY created_at DESC, id DESC`,
  ).all(workspaceId, ...jobIds)
  for (const row of rows) {
    if (!map.has(row.job_id)) map.set(row.job_id, row)
  }
  return map
}

async function lastSentByJob(workspaceId: string, jobIds: string[]): Promise<Map<string, ReminderRow>> {
  const map = new Map<string, ReminderRow>()
  if (!jobIds.length) return map
  const rows = await db().prepare<ReminderRow>(
    `SELECT * FROM mca_funder_reminders
     WHERE workspace_id = ? AND job_id IN (${inJobIds(jobIds)}) AND state = 'sent' AND last_reminded_at IS NOT NULL
     ORDER BY last_reminded_at DESC, created_at DESC, id DESC`,
  ).all(workspaceId, ...jobIds)
  for (const row of rows) {
    if (!map.has(row.job_id)) map.set(row.job_id, row)
  }
  return map
}

async function saveReminder(input: {
  id: string
  workspaceId: string
  jobId: string
  senderId: string | null
  threadId: string | null
  inReplyTo: string | null
  references: string[]
  state: ReminderState
  lastRemindedAt: string | null
  correlationId: string
  actorUserId: string | null
}): Promise<ReminderRow> {
  const now = nowIso()
  const existing = await loadReminder(input.workspaceId, input.id)
  const row = existing
    ? await db().prepare<ReminderRow>(
      `UPDATE mca_funder_reminders
       SET sender_id = ?, thread_id = ?, in_reply_to = ?, references_json = ?, state = ?, last_reminded_at = ?,
           actor_user_id = ?, updated_at = ?
       WHERE id = ? AND workspace_id = ?
       RETURNING *`,
    ).get(
      input.senderId,
      input.threadId,
      input.inReplyTo,
      JSON.stringify(input.references),
      input.state,
      input.lastRemindedAt,
      input.actorUserId,
      now,
      input.id,
      input.workspaceId,
    )
    : await db().prepare<ReminderRow>(
      `INSERT INTO mca_funder_reminders
        (id, workspace_id, job_id, sender_id, thread_id, in_reply_to, references_json, state, last_reminded_at,
         correlation_id, actor_user_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       RETURNING *`,
    ).get(
      input.id,
      input.workspaceId,
      input.jobId,
      input.senderId,
      input.threadId,
      input.inReplyTo,
      JSON.stringify(input.references),
      input.state,
      input.lastRemindedAt,
      input.correlationId,
      input.actorUserId,
      now,
      now,
    )
  if (!row) throw new Error("Funder reminder persist did not return a row")
  return row
}

function toJobView(
  job: SubmissionJob,
  hasResponse: boolean,
  latest: ReminderRow | undefined,
  lastSent: ReminderRow | undefined,
): ReminderJobView {
  const reason = ineligibleReason(job, hasResponse)
  const eligible = !reason
  return {
    jobId: job.id,
    dealId: job.dealId,
    funderId: job.funderId,
    displayFunderName: job.displayFunderName,
    routeKind: job.routeKind,
    submissionState: job.state,
    eligible,
    remindControl: eligible ? "remind" : "hidden",
    ineligibleReason: reason,
    lastRemindedAt: lastSent?.last_reminded_at ?? undefined,
    lastReminderId: latest?.id,
    lastReminderState: latest && REMINDER_STATES.includes(latest.state as ReminderState)
      ? latest.state as ReminderState
      : undefined,
  }
}

async function loadVisibleJob(actor: DealActor, jobId: string): Promise<SubmissionJob> {
  const job = await findJobById(actor.workspaceId, jobId)
  if (!job) throw new AppError(404, "job_not_found", "The requested submission was not found.")
  await getDealForDocument(actor, job.dealId)
  return job
}

async function composeReminder(actor: DealActor, job: SubmissionJob, body: string) {
  const ref = await originalAttemptRef(job)
  const thread = threadFromAttempt(ref)
  const sender = await resolveReminderSender(actor, ref?.snapshot.senderId || undefined)
  const to = uniqueAddresses(ref?.snapshot.to?.length ? ref.snapshot.to : parseDestination(job.route.destination))
  if (!to.length) {
    throw new AppError(422, "email_destination_invalid", "This funder does not have a valid email destination.")
  }
  const cc = uniqueAddresses(ref?.snapshot.cc ?? []).filter((address) => !to.some((item) => normalizeEmail(item) === normalizeEmail(address)))
  const fromName = ref?.snapshot.fromName?.trim() || sender.fromName
  const fromAddress = ref?.snapshot.fromAddress?.trim() || sender.fromAddress
  return {
    sender,
    fromName,
    fromAddress,
    to,
    cc,
    replyTo: fromAddress,
    subject: replySubject(ref?.snapshot.subject ?? ""),
    body,
    thread,
  }
}

function reusableReminder(row: ReminderRow | undefined): ReminderRow | undefined {
  if (!row) return undefined
  if (row.state === "previewed" || row.state === "failed") return row
  return undefined
}

export async function listFunderReminders(actor: DealActor, dealIdInput: unknown): Promise<ReminderListResult> {
  const dealId = asDealId(dealIdInput)
  const deal = await getDealForDocument(actor, dealId)
  const jobs = await listJobsForDeal(actor.workspaceId, deal.id)
  const jobIds = jobs.map((job) => job.id)
  const [responded, latest, lastSent] = await Promise.all([
    responseJobIds(actor.workspaceId, jobIds),
    latestRemindersByJob(actor.workspaceId, jobIds),
    lastSentByJob(actor.workspaceId, jobIds),
  ])
  return {
    dealId: deal.id,
    canSend: canSend(actor),
    defaultBody: DEFAULT_REMINDER_BODY,
    jobs: jobs.map((job) => toJobView(job, responded.has(job.id), latest.get(job.id), lastSent.get(job.id))),
  }
}

export async function previewFunderReminder(actor: DealActor, input: PreviewFunderReminderInput): Promise<ReminderPreview> {
  const job = await loadVisibleJob(actor, asJobId(input.jobId))
  const hasResponse = await jobHasResponse(actor.workspaceId, job.id)
  assertEligible(job, hasResponse)
  const composed = await composeReminder(actor, job, DEFAULT_REMINDER_BODY)
  const existing = reusableReminder(await latestReminder(actor.workspaceId, job.id))
  const reminderId = existing?.id ?? newId()
  const correlationId = existing?.correlation_id ?? actor.correlationId ?? newId()
  const lastSent = await lastSentReminder(actor.workspaceId, job.id)
  await saveReminder({
    id: reminderId,
    workspaceId: actor.workspaceId,
    jobId: job.id,
    senderId: composed.sender.id,
    threadId: composed.thread.threadId ?? null,
    inReplyTo: composed.thread.inReplyTo ?? null,
    references: composed.thread.references,
    state: "previewed",
    lastRemindedAt: null,
    correlationId,
    actorUserId: actor.userId,
  })
  await recordAuditEvent({
    context: actor,
    action: "funder_reminder.previewed",
    resourceType: "funder_reminder",
    resourceId: reminderId,
    metadata: { jobId: job.id, dealId: job.dealId, funderId: job.funderId, threadMode: composed.thread.mode },
    correlationId,
  })
  return {
    reminderId,
    jobId: job.id,
    dealId: job.dealId,
    funderId: job.funderId,
    displayFunderName: job.displayFunderName,
    submissionState: job.state,
    sender: { id: composed.sender.id, fromName: composed.fromName, fromAddress: composed.fromAddress },
    to: composed.to,
    cc: composed.cc,
    replyTo: composed.replyTo,
    subject: composed.subject,
    body: composed.body,
    defaultBody: DEFAULT_REMINDER_BODY,
    thread: composed.thread,
    lastRemindedAt: lastSent?.last_reminded_at ?? undefined,
    canSend: canSend(actor),
    delivery: "preview",
  }
}

export async function sendFunderReminder(actor: DealActor, input: SendFunderReminderInput): Promise<ReminderSendResult> {
  const job = await loadVisibleJob(actor, asJobId(input.jobId))
  const beforeState = job.state
  const hasResponse = await jobHasResponse(actor.workspaceId, job.id)
  assertEligible(job, hasResponse)
  const body = asBody(input.body, DEFAULT_REMINDER_BODY)
  const composed = await composeReminder(actor, job, body)
  const requestedId = asReminderId(input.reminderId)
  const existing = requestedId ? await loadReminder(actor.workspaceId, requestedId) : reusableReminder(await latestReminder(actor.workspaceId, job.id))
  if (requestedId) {
    if (!existing || existing.job_id !== job.id) {
      throw new AppError(404, "reminder_not_found", "The requested reminder was not found.")
    }
  }
  if (existing?.state === "sent" && existing.last_reminded_at) {
    return {
      reminderId: existing.id,
      jobId: job.id,
      dealId: job.dealId,
      funderId: job.funderId,
      displayFunderName: job.displayFunderName,
      submissionState: beforeState,
      state: "sent",
      lastRemindedAt: existing.last_reminded_at,
      delivery: "sent",
      correlationId: existing.correlation_id,
      thread: composed.thread,
      sender: { id: composed.sender.id, fromName: composed.fromName, fromAddress: composed.fromAddress },
      to: composed.to,
      cc: composed.cc,
      subject: composed.subject,
    }
  }
  const reminderId = existing?.id ?? newId()
  const correlationId = existing?.correlation_id ?? actor.correlationId ?? newId()
  const message: ReminderDeliveryMessage = {
    reminderId,
    workspaceId: actor.workspaceId,
    jobId: job.id,
    dealId: job.dealId,
    funderId: job.funderId,
    senderId: composed.sender.id,
    fromName: composed.fromName,
    fromAddress: composed.fromAddress,
    to: composed.to,
    cc: composed.cc,
    replyTo: composed.replyTo,
    subject: composed.subject,
    body: composed.body,
    correlationId,
    messageId: messageIdFor(correlationId),
    threadId: composed.thread.threadId,
    inReplyTo: composed.thread.inReplyTo,
    references: composed.thread.references,
    threadMode: composed.thread.mode,
  }
  await saveReminder({
    id: reminderId,
    workspaceId: actor.workspaceId,
    jobId: job.id,
    senderId: composed.sender.id,
    threadId: composed.thread.threadId ?? null,
    inReplyTo: composed.thread.inReplyTo ?? null,
    references: composed.thread.references,
    state: existing?.state === "failed" ? "failed" : "previewed",
    lastRemindedAt: null,
    correlationId,
    actorUserId: actor.userId,
  })
  const delivered = await deliverReminder(message)
  const accepted = delivered.delivery === "sent" || delivered.delivery === "preview"
  const lastRemindedAt = accepted ? nowIso() : null
  await saveReminder({
    id: reminderId,
    workspaceId: actor.workspaceId,
    jobId: job.id,
    senderId: composed.sender.id,
    threadId: composed.thread.threadId ?? null,
    inReplyTo: composed.thread.inReplyTo ?? null,
    references: composed.thread.references,
    state: accepted ? "sent" : "failed",
    lastRemindedAt,
    correlationId,
    actorUserId: actor.userId,
  })
  const current = await findJobById(actor.workspaceId, job.id)
  await recordAuditEvent({
    context: actor,
    action: accepted ? "funder_reminder.sent" : "funder_reminder.failed",
    resourceType: "funder_reminder",
    resourceId: reminderId,
    metadata: {
      jobId: job.id,
      dealId: job.dealId,
      funderId: job.funderId,
      threadMode: composed.thread.mode,
      delivery: delivered.delivery,
      submissionState: beforeState,
    },
    correlationId,
  })
  return {
    reminderId,
    jobId: job.id,
    dealId: job.dealId,
    funderId: job.funderId,
    displayFunderName: job.displayFunderName,
    submissionState: current?.state ?? beforeState,
    state: accepted ? "sent" : "failed",
    lastRemindedAt: lastRemindedAt ?? undefined,
    delivery: delivered.delivery,
    correlationId,
    thread: composed.thread,
    sender: { id: composed.sender.id, fromName: composed.fromName, fromAddress: composed.fromAddress },
    to: composed.to,
    cc: composed.cc,
    subject: composed.subject,
    error: accepted ? undefined : delivered.error,
  }
}

export async function requireReminderActor(request: Request, mode: "read" | "write"): Promise<DealActor> {
  if (mode === "write") assertTrustedMutation(request)
  const auth = await requireWorkspaceAccess(request, { scopes: [mode === "read" ? "deals:read" : "deals:write"] })
  return { ...await actorForDeals(auth), correlationId: requestCorrelationId(request) }
}
