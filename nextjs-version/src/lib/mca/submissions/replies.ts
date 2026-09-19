import "server-only"

import { assertTrustedMutation, requireWorkspaceAccess } from "../auth"
import { decryptSensitive, encryptSensitive } from "../crypto"
import { getDatabase, newId, nowIso, parseJson, recordAuditEvent } from "../db"
import { canActorAccessDeal } from "../deals/access-policy"
import { findDealById } from "../deals/repository"
import type { DealActor, DealRecord } from "../deals/schema"
import { actorForDeals, getDealForDocument } from "../deals/service"
import { AppError } from "../errors"
import type { FunderRecord } from "../funders/contracts"
import { listFunders } from "../funders/directory"
import { requestCorrelationId } from "../http"
import { canManageWorkspace } from "../policy"
import { findSenderById, listSendersByWorkspace, type StoredEmailSender } from "../senders/repository"
import { REPLY_STATES, type ReplyState, type SubmissionJob } from "./contracts"
import { parseEmailAttemptRef } from "./email-templates"
import { findJobById, listJobsForDeal } from "./repository"

/** Documented 15-minute fallback polling interval. Not a live cron; workers POST `/api/mca/submissions/replies/run`. */
export const REPLY_INGEST_INTERVAL_MS = 15 * 60 * 1000

const CHECKPOINT_PROVIDER_MESSAGE_ID = "mca:mailbox-checkpoint:v1"
const BODY_PREVIEW_MAX = 240
const FROM_MAX = 320
const SUBJECT_MAX = 998
const PROVIDER_ID_MAX = 512
const THREAD_MAX = 512

export type ReplyMatchMethod = "message_id" | "thread" | "domain" | "unrecognized" | "ambiguous" | "manual"

export interface ReplyMatchEvidence {
  method: ReplyMatchMethod
  flagsUnchanged: true
  rfcMessageId?: string
  inReplyTo?: string
  references?: string[]
  threadId?: string
  fromDomain?: string
  funderIds?: string[]
  funderNames?: string[]
  candidateJobIds?: string[]
  candidateDealIds?: string[]
  subjectHits?: string[]
  notes: string[]
}

export interface FunderReply {
  id: string
  workspaceId: string
  senderId: string
  providerMessageId: string
  threadId?: string
  fromAddress: string
  subject?: string
  bodyPreview?: string
  body?: string
  matchedDealId?: string
  matchedJobId?: string
  evidence: ReplyMatchEvidence
  state: ReplyState
  created: boolean
  replayed: boolean
  createdAt: string
  updatedAt: string
}

export interface MailboxMessage {
  providerMessageId: string
  threadId?: string
  rfcMessageId?: string
  inReplyTo?: string
  references?: string[]
  from: string
  subject?: string
  body?: string
  receivedAt?: string
}

export interface MailboxListInput {
  workspaceId: string
  senderId: string
  fromAddress: string
  cursor?: string
}

export interface MailboxListResult {
  messages: MailboxMessage[]
  nextCursor: string
}

export interface ReplyMailbox {
  listMessages(input: MailboxListInput): Promise<MailboxListResult>
  markRead?(providerMessageId: string): Promise<void>
  markUnread?(providerMessageId: string): Promise<void>
  addLabel?(providerMessageId: string, label: string): Promise<void>
  removeLabel?(providerMessageId: string, label: string): Promise<void>
  deleteMessage?(providerMessageId: string): Promise<void>
  move?(providerMessageId: string, destination: string): Promise<void>
  archive?(providerMessageId: string): Promise<void>
}

export interface ReplySenderHealth {
  senderId: string
  fromAddress: string
  provider: string
  purpose: string
  state: string
  optedIn: boolean
  cursor?: string
  lastRunAt?: string
  lastError?: string | null
  health: "idle" | "ready" | "error" | "unconfigured"
}

export interface ReplyCandidateJob {
  jobId: string
  funderId: string
  displayFunderName: string
  state: SubmissionJob["state"]
}

export interface ReplyQueueResult {
  dealId?: string
  intervalMs: number
  mailbox: { mode: "fixture" | "unconfigured"; liveOAuth: false }
  senders: ReplySenderHealth[]
  replies: FunderReply[]
  candidateJobs: ReplyCandidateJob[]
  canReview: boolean
  canManage: boolean
}

export interface RunReplyIngestInput {
  senderId?: unknown
  enabled?: unknown
}

export interface RunReplyIngestResult {
  intervalMs: number
  mailbox: { mode: "fixture" | "unconfigured"; liveOAuth: false; flagsUnchanged: true }
  senders: ReplySenderHealth[]
  ingested: Array<{ id: string; providerMessageId: string; state: ReplyState; created: boolean; replayed: boolean }>
  createdCount: number
  replayedCount: number
}

export interface ReviewReplyInput {
  state?: unknown
  matchedDealId?: unknown
  matchedJobId?: unknown
}

type ReplyRow = {
  id: string
  workspace_id: string
  sender_id: string
  provider_message_id: string
  thread_id: string | null
  from_address: string
  subject: string | null
  body_cipher: string | null
  matched_deal_id: string | null
  matched_job_id: string | null
  match_evidence: string | null
  state: string
  created_at: string
  updated_at: string
}

type AttemptAnchorRow = {
  job_id: string
  deal_id: string
  funder_id: string
  display_funder_name: string
  confirmation_key: string
  job_state: string
  external_ref: string | null
}

type SubmissionAnchor = {
  jobId: string
  dealId: string
  funderId: string
  funderName: string
  confirmationKey: string
  messageId: string
  threadId: string
  references: string[]
  subject: string
  displayId: string
  legalName: string
  domains: string[]
}

type CheckpointRecord = {
  cursor?: string
  optedIn: boolean
  lastRunAt?: string
  lastError?: string | null
}

type MailboxFetch = ReplyMailbox | undefined
let mailboxOverride: MailboxFetch

function db() {
  return getDatabase()
}

function denied(message = "You do not have permission to perform this action."): never {
  throw new AppError(403, "permission_denied", message)
}

function invalid(field: string, message: string): never {
  throw new AppError(422, "validation_failed", "Review the highlighted fields.", { [field]: [message] })
}

function isAdmin(actor: DealActor): boolean {
  return Boolean(actor.role && canManageWorkspace(actor.role))
}

function asReplyState(value: string): ReplyState {
  return REPLY_STATES.includes(value as ReplyState) ? value as ReplyState : "pending_review"
}

export function setReplyMailboxForTests(mailbox?: ReplyMailbox): void {
  mailboxOverride = mailbox
}

export function replyMailboxMode(): "fixture" | "unconfigured" {
  return mailboxOverride ? "fixture" : "unconfigured"
}

function activeMailbox(): ReplyMailbox | undefined {
  return mailboxOverride
}

function mailboxUnavailable(): never {
  throw new AppError(
    503,
    "mailbox_oauth_not_configured",
    "Live mailbox OAuth is not configured. Tests inject a fixture mailbox; production Google/Microsoft read access remains a remaining gate.",
  )
}

async function requireActor(request: Request, mode: "read" | "write" | "admin"): Promise<DealActor> {
  if (mode !== "read") assertTrustedMutation(request)
  const auth = await requireWorkspaceAccess(request, {
    sessionOnly: mode === "admin",
    roles: mode === "admin" ? ["admin", "super_admin"] : undefined,
    scopes: mode === "read" ? ["deals:read"] : mode === "write" ? ["deals:write"] : undefined,
  })
  return { ...await actorForDeals(auth), correlationId: requestCorrelationId(request) }
}

export async function requireReplyRead(request: Request): Promise<DealActor> {
  return requireActor(request, "read")
}

export async function requireReplyWrite(request: Request): Promise<DealActor> {
  return requireActor(request, "write")
}

export async function requireReplyAdmin(request: Request): Promise<DealActor> {
  return requireActor(request, "admin")
}

function normalizeToken(value: string | undefined | null): string {
  return (value ?? "").trim().replace(/^<|>$/g, "").toLowerCase()
}

function extractAddress(value: string): string {
  const angle = value.match(/<([^>]+)>/)
  return (angle ? angle[1] : value).trim()
}

function domainOf(value: string): string | undefined {
  const address = extractAddress(value).toLowerCase()
  const at = address.lastIndexOf("@")
  if (at <= 0 || at === address.length - 1) return undefined
  return address.slice(at + 1)
}

function domainMatches(fromDomain: string, allowed: string): boolean {
  const needle = allowed.trim().toLowerCase().replace(/^@/, "")
  if (!needle) return false
  return fromDomain === needle || fromDomain.endsWith(`.${needle}`)
}

function normalizedSubject(value: string): string {
  return value.toLowerCase().replace(/^\s*((re|fw|fwd)\s*:\s*)+/g, "").replace(/\s+/g, " ").trim()
}

function uniqueStrings(values: Array<string | undefined>): string[] {
  const seen = new Set<string>()
  const next: string[] = []
  for (const value of values) {
    const item = value?.trim()
    if (!item || seen.has(item)) continue
    seen.add(item)
    next.push(item)
  }
  return next
}

function previewBody(value: string | undefined): string | undefined {
  if (!value) return undefined
  const compact = value.replace(/\s+/g, " ").trim()
  if (!compact) return undefined
  return compact.length > BODY_PREVIEW_MAX ? `${compact.slice(0, BODY_PREVIEW_MAX)}…` : compact
}

function defaultEvidence(partial: Omit<ReplyMatchEvidence, "flagsUnchanged" | "notes"> & { notes?: string[] }): ReplyMatchEvidence {
  return {
    flagsUnchanged: true,
    notes: partial.notes ?? [],
    ...partial,
  }
}

function parseEvidence(value: string | null): ReplyMatchEvidence {
  const parsed = parseJson<Partial<ReplyMatchEvidence>>(value, {})
  const method = parsed.method
  return defaultEvidence({
    method: method === "message_id" || method === "thread" || method === "domain" || method === "unrecognized" || method === "ambiguous" || method === "manual"
      ? method
      : "unrecognized",
    rfcMessageId: typeof parsed.rfcMessageId === "string" ? parsed.rfcMessageId : undefined,
    inReplyTo: typeof parsed.inReplyTo === "string" ? parsed.inReplyTo : undefined,
    references: Array.isArray(parsed.references) ? parsed.references.filter((item): item is string => typeof item === "string") : undefined,
    threadId: typeof parsed.threadId === "string" ? parsed.threadId : undefined,
    fromDomain: typeof parsed.fromDomain === "string" ? parsed.fromDomain : undefined,
    funderIds: Array.isArray(parsed.funderIds) ? parsed.funderIds.filter((item): item is string => typeof item === "string") : undefined,
    funderNames: Array.isArray(parsed.funderNames) ? parsed.funderNames.filter((item): item is string => typeof item === "string") : undefined,
    candidateJobIds: Array.isArray(parsed.candidateJobIds) ? parsed.candidateJobIds.filter((item): item is string => typeof item === "string") : undefined,
    candidateDealIds: Array.isArray(parsed.candidateDealIds) ? parsed.candidateDealIds.filter((item): item is string => typeof item === "string") : undefined,
    subjectHits: Array.isArray(parsed.subjectHits) ? parsed.subjectHits.filter((item): item is string => typeof item === "string") : undefined,
    notes: Array.isArray(parsed.notes) ? parsed.notes.filter((item): item is string => typeof item === "string") : [],
  })
}

function parseCheckpoint(value: string | null): CheckpointRecord {
  const parsed = parseJson<Record<string, unknown>>(value, {})
  if (parsed.kind !== "checkpoint") return { optedIn: false }
  return {
    optedIn: parsed.optedIn === true,
    cursor: typeof parsed.cursor === "string" ? parsed.cursor : undefined,
    lastRunAt: typeof parsed.lastRunAt === "string" ? parsed.lastRunAt : undefined,
    lastError: parsed.lastError == null ? null : typeof parsed.lastError === "string" ? parsed.lastError : String(parsed.lastError),
  }
}

function encodeCheckpoint(record: CheckpointRecord): string {
  return JSON.stringify({
    kind: "checkpoint",
    optedIn: record.optedIn,
    cursor: record.cursor,
    lastRunAt: record.lastRunAt,
    lastError: record.lastError ?? null,
    intervalMs: REPLY_INGEST_INTERVAL_MS,
    flagsUnchanged: true,
  })
}

function decryptBody(workspaceId: string, cipher: string | null): string | undefined {
  if (!cipher) return undefined
  try {
    return decryptSensitive(cipher, workspaceId)
  } catch {
    return undefined
  }
}

function mapReply(row: ReplyRow, options: { includeBody?: boolean; created?: boolean } = {}): FunderReply {
  const body = decryptBody(row.workspace_id, row.body_cipher)
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    senderId: row.sender_id,
    providerMessageId: row.provider_message_id,
    threadId: row.thread_id ?? undefined,
    fromAddress: row.from_address,
    subject: row.subject ?? undefined,
    bodyPreview: previewBody(body),
    body: options.includeBody ? body : undefined,
    matchedDealId: row.matched_deal_id ?? undefined,
    matchedJobId: row.matched_job_id ?? undefined,
    evidence: parseEvidence(row.match_evidence),
    state: asReplyState(row.state),
    created: options.created === true,
    replayed: options.created === false,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function publicReply(reply: FunderReply): FunderReply {
  return {
    ...reply,
    body: reply.body,
  }
}

async function findReplyRow(workspaceId: string, id: string): Promise<ReplyRow | undefined> {
  return db().prepare<ReplyRow>(
    "SELECT * FROM mca_funder_replies WHERE workspace_id = ? AND id = ? AND provider_message_id <> ?",
  ).get(workspaceId, id, CHECKPOINT_PROVIDER_MESSAGE_ID)
}

async function findReplyByProvider(workspaceId: string, senderId: string, providerMessageId: string): Promise<ReplyRow | undefined> {
  return db().prepare<ReplyRow>(
    "SELECT * FROM mca_funder_replies WHERE workspace_id = ? AND sender_id = ? AND provider_message_id = ?",
  ).get(workspaceId, senderId, providerMessageId)
}

async function listReplyRows(workspaceId: string): Promise<ReplyRow[]> {
  return db().prepare<ReplyRow>(
    `SELECT * FROM mca_funder_replies
     WHERE workspace_id = ? AND provider_message_id <> ?
     ORDER BY created_at DESC, id DESC`,
  ).all(workspaceId, CHECKPOINT_PROVIDER_MESSAGE_ID)
}

async function loadCheckpoint(workspaceId: string, senderId: string): Promise<CheckpointRecord> {
  const row = await findReplyByProvider(workspaceId, senderId, CHECKPOINT_PROVIDER_MESSAGE_ID)
  return row ? parseCheckpoint(row.match_evidence) : { optedIn: false }
}

async function saveCheckpoint(sender: StoredEmailSender, record: CheckpointRecord): Promise<void> {
  const now = nowIso()
  const existing = await findReplyByProvider(sender.workspaceId, sender.id, CHECKPOINT_PROVIDER_MESSAGE_ID)
  const evidence = encodeCheckpoint(record)
  if (existing) {
    await db().prepare(
      "UPDATE mca_funder_replies SET match_evidence = ?, from_address = ?, updated_at = ? WHERE id = ? AND workspace_id = ?",
    ).run(evidence, sender.fromAddress, now, existing.id, sender.workspaceId)
    return
  }
  await db().prepare(`INSERT INTO mca_funder_replies
    (id, workspace_id, sender_id, provider_message_id, thread_id, from_address, subject, body_cipher,
     matched_deal_id, matched_job_id, match_evidence, state, created_at, updated_at)
    VALUES (?, ?, ?, ?, NULL, ?, NULL, NULL, NULL, NULL, ?, 'processed', ?, ?)
    ON CONFLICT (workspace_id, sender_id, provider_message_id) DO UPDATE SET
      match_evidence = EXCLUDED.match_evidence, from_address = EXCLUDED.from_address, updated_at = EXCLUDED.updated_at`,
  ).run(newId(), sender.workspaceId, sender.id, CHECKPOINT_PROVIDER_MESSAGE_ID, sender.fromAddress, evidence, now, now)
}

function healthFor(sender: StoredEmailSender, checkpoint: CheckpointRecord): ReplySenderHealth {
  const mailbox = replyMailboxMode()
  let health: ReplySenderHealth["health"] = "idle"
  if (!checkpoint.optedIn) health = "idle"
  else if (checkpoint.lastError) health = "error"
  else if (mailbox === "unconfigured") health = "unconfigured"
  else health = "ready"
  return {
    senderId: sender.id,
    fromAddress: sender.fromAddress,
    provider: sender.provider,
    purpose: sender.purpose,
    state: sender.state,
    optedIn: checkpoint.optedIn,
    cursor: checkpoint.cursor,
    lastRunAt: checkpoint.lastRunAt,
    lastError: checkpoint.lastError,
    health,
  }
}

function asSenderId(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) invalid("senderId", "Choose a submission sender.")
  return value.trim()
}

function asOptionalId(value: unknown, field: string): string | undefined {
  if (value == null || value === "") return undefined
  if (typeof value !== "string" || !value.trim()) invalid(field, `Enter a valid ${field}.`)
  return value.trim()
}

function asEnabled(value: unknown): boolean | undefined {
  if (value == null) return undefined
  if (typeof value !== "boolean") invalid("enabled", "enabled must be true or false.")
  return value
}

function asDealQuery(value: string | null): string | undefined {
  if (value == null || value === "") return undefined
  const next = value.trim()
  if (!next) return undefined
  if (next.length > 80) invalid("dealId", "Enter a valid deal id.")
  return next
}

function assertSubmissionSender(sender: StoredEmailSender | undefined): StoredEmailSender {
  if (!sender) throw new AppError(404, "resource_not_found", "The requested resource was not found.")
  if (sender.purpose !== "submission") {
    throw new AppError(422, "sender_purpose_mismatch", "That sender is not assigned to this purpose.")
  }
  if (sender.state === "expired") {
    throw new AppError(409, "sender_expired", "This sender connection expired. Reconnect to resume sending.")
  }
  if (sender.state === "revoked") {
    throw new AppError(409, "sender_revoked", "This sender was revoked. Reconnect or restore it before sending.")
  }
  if (sender.state !== "verified") {
    throw new AppError(409, "sender_not_usable", "This sender is not verified for sending.")
  }
  return sender
}

async function audit(actor: DealActor, action: string, resourceId: string, metadata: Record<string, unknown>): Promise<void> {
  await recordAuditEvent({
    context: actor,
    action,
    resourceType: "funder_reply",
    resourceId,
    metadata,
    correlationId: actor.correlationId,
  })
}

async function loadAnchors(actor: DealActor): Promise<SubmissionAnchor[]> {
  const [rows, funders] = await Promise.all([
    db().prepare<AttemptAnchorRow>(
      `SELECT a.job_id, j.deal_id, j.funder_id, j.display_funder_name, j.confirmation_key, j.state AS job_state, a.external_ref
       FROM mca_submission_attempts a
       INNER JOIN mca_submission_jobs j ON j.id = a.job_id
       WHERE j.workspace_id = ? AND a.transport = 'email' AND a.external_ref IS NOT NULL
       ORDER BY a.created_at DESC, a.id DESC`,
    ).all(actor.workspaceId),
    listFunders(actor, { includeInactive: true }),
  ])
  const funderById = new Map(funders.map((funder) => [funder.id, funder]))
  const deals = new Map<string, DealRecord>()
  const anchors: SubmissionAnchor[] = []
  for (const row of rows) {
    const ref = parseEmailAttemptRef(row.external_ref)
    if (!ref?.messageId) continue
    let deal = deals.get(row.deal_id)
    if (!deal) {
      deal = await findDealById(actor.workspaceId, row.deal_id)
      if (deal) deals.set(row.deal_id, deal)
    }
    if (!deal) continue
    const funder = funderById.get(row.funder_id)
    anchors.push({
      jobId: row.job_id,
      dealId: row.deal_id,
      funderId: row.funder_id,
      funderName: row.display_funder_name,
      confirmationKey: row.confirmation_key,
      messageId: ref.messageId,
      threadId: ref.threadId,
      references: ref.references,
      subject: ref.snapshot.subject,
      displayId: deal.displayId,
      legalName: deal.legalName?.trim() || "",
      domains: funder?.domains ?? [],
    })
  }
  return anchors
}

function fundersMatchingDomain(fromDomain: string | undefined, funders: FunderRecord[]): FunderRecord[] {
  if (!fromDomain) return []
  return funders.filter((funder) => funder.domains.some((domain) => domainMatches(fromDomain, domain)))
}

function threadHits(message: MailboxMessage, anchors: SubmissionAnchor[]): SubmissionAnchor[] {
  const incomingThread = normalizeToken(message.threadId)
  const inReplyTo = normalizeToken(message.inReplyTo)
  const references = (message.references ?? []).map(normalizeToken).filter(Boolean)
  const hits: SubmissionAnchor[] = []
  const seen = new Set<string>()
  for (const anchor of anchors) {
    const messageId = normalizeToken(anchor.messageId)
    const threadId = normalizeToken(anchor.threadId)
    const storedRefs = anchor.references.map(normalizeToken)
    const byMessage = Boolean(inReplyTo && (inReplyTo === messageId || inReplyTo === threadId))
      || references.some((item) => item === messageId || item === threadId || storedRefs.includes(item))
    const byThread = Boolean(incomingThread && (incomingThread === threadId || incomingThread === messageId))
    if ((byMessage || byThread) && !seen.has(anchor.jobId)) {
      seen.add(anchor.jobId)
      hits.push(anchor)
    }
  }
  return hits
}

function subjectHitsFor(message: MailboxMessage, anchor: SubmissionAnchor): string[] {
  const hay = `${message.subject ?? ""}\n${message.body ?? ""}`.toLowerCase()
  const hits: string[] = []
  if (anchor.displayId && hay.includes(anchor.displayId.toLowerCase())) hits.push("displayId")
  if (anchor.legalName && hay.includes(anchor.legalName.toLowerCase())) hits.push("legalName")
  if (anchor.confirmationKey && hay.includes(anchor.confirmationKey.toLowerCase())) hits.push("confirmationKey")
  const incoming = normalizedSubject(message.subject ?? "")
  const original = normalizedSubject(anchor.subject)
  if (incoming && original && (incoming === original || incoming.includes(original) || original.includes(incoming))) hits.push("subject")
  return hits
}

function scoreAnchor(message: MailboxMessage, anchor: SubmissionAnchor, fromDomain: string | undefined): number {
  let score = 0
  if (fromDomain && anchor.domains.some((domain) => domainMatches(fromDomain, domain))) score += 4
  score += subjectHitsFor(message, anchor).length * 3
  return score
}

function correlate(message: MailboxMessage, anchors: SubmissionAnchor[], funders: FunderRecord[]): {
  state: ReplyState
  matchedDealId?: string
  matchedJobId?: string
  evidence: ReplyMatchEvidence
} {
  const fromDomain = domainOf(message.from)
  const notes: string[] = []
  const inReplyTo = message.inReplyTo?.trim()
  const references = (message.references ?? []).map((item) => item.trim()).filter(Boolean)
  const threadMatched = threadHits(message, anchors)
  if (threadMatched.length === 1) {
    const hit = threadMatched[0]!
    const byHeader = Boolean(normalizeToken(inReplyTo) === normalizeToken(hit.messageId)
      || references.some((item) => normalizeToken(item) === normalizeToken(hit.messageId)))
    notes.push(byHeader
      ? "Correlated by Message-ID / In-Reply-To before domain matching."
      : "Correlated by stored submission thread id before domain matching.")
    if (fromDomain) notes.push(`From domain ${fromDomain} recorded after thread correlation.`)
    return {
      state: "matched",
      matchedDealId: hit.dealId,
      matchedJobId: hit.jobId,
      evidence: defaultEvidence({
        method: byHeader ? "message_id" : "thread",
        rfcMessageId: message.rfcMessageId,
        inReplyTo,
        references,
        threadId: message.threadId,
        fromDomain,
        funderIds: [hit.funderId],
        funderNames: [hit.funderName],
        candidateJobIds: [hit.jobId],
        candidateDealIds: [hit.dealId],
        subjectHits: subjectHitsFor(message, hit),
        notes,
      }),
    }
  }
  if (threadMatched.length > 1) {
    notes.push("Multiple stored submissions share this thread or Message-ID.")
    return {
      state: "pending_review",
      evidence: defaultEvidence({
        method: "ambiguous",
        rfcMessageId: message.rfcMessageId,
        inReplyTo,
        references,
        threadId: message.threadId,
        fromDomain,
        funderIds: uniqueStrings(threadMatched.map((item) => item.funderId)),
        funderNames: uniqueStrings(threadMatched.map((item) => item.funderName)),
        candidateJobIds: uniqueStrings(threadMatched.map((item) => item.jobId)),
        candidateDealIds: uniqueStrings(threadMatched.map((item) => item.dealId)),
        notes,
      }),
    }
  }

  notes.push("No In-Reply-To, References, or thread id matched a stored Message-ID.")
  const domainFunders = fundersMatchingDomain(fromDomain, funders)
  if (!fromDomain || domainFunders.length === 0) {
    notes.push(fromDomain
      ? `From domain ${fromDomain} is not an authorized funder reply alias.`
      : "The From address has no domain to map to funder.domains.")
    return {
      state: "pending_review",
      evidence: defaultEvidence({
        method: "unrecognized",
        rfcMessageId: message.rfcMessageId,
        inReplyTo,
        references,
        threadId: message.threadId,
        fromDomain,
        notes,
      }),
    }
  }

  const domainAnchors = anchors.filter((anchor) => domainFunders.some((funder) => funder.id === anchor.funderId))
  notes.push(`From domain ${fromDomain} is an authorized alias for ${domainFunders.map((item) => item.nickname || item.legalName).join(", ")}.`)
  if (domainAnchors.length === 1) {
    const hit = domainAnchors[0]!
    const hits = subjectHitsFor(message, hit)
    if (hits.length) {
      notes.push(`Separate-thread subject/body matched ${hits.join(", ")}.`)
      return {
        state: "matched",
        matchedDealId: hit.dealId,
        matchedJobId: hit.jobId,
        evidence: defaultEvidence({
          method: "domain",
          rfcMessageId: message.rfcMessageId,
          inReplyTo,
          references,
          threadId: message.threadId,
          fromDomain,
          funderIds: [hit.funderId],
          funderNames: [hit.funderName],
          candidateJobIds: [hit.jobId],
          candidateDealIds: [hit.dealId],
          subjectHits: hits,
          notes,
        }),
      }
    }
    notes.push("Unique authorized domain without subject or deal identifier evidence; left pending review.")
    return {
      state: "pending_review",
      evidence: defaultEvidence({
        method: "domain",
        rfcMessageId: message.rfcMessageId,
        inReplyTo,
        references,
        threadId: message.threadId,
        fromDomain,
        funderIds: [hit.funderId],
        funderNames: [hit.funderName],
        candidateJobIds: [hit.jobId],
        candidateDealIds: [hit.dealId],
        subjectHits: hits,
        notes,
      }),
    }
  }

  const ranked = domainAnchors
    .map((anchor) => ({ anchor, score: scoreAnchor(message, anchor, fromDomain), hits: subjectHitsFor(message, anchor) }))
    .sort((left, right) => right.score - left.score)
  const best = ranked[0]
  const uniqueBest = best && best.hits.length > 0 && ranked.filter((item) => item.score === best.score).length === 1
  if (uniqueBest && best) {
    notes.push(`Separate-thread fuzzy match used funder.domains then subject evidence (${best.hits.join(", ")}).`)
    return {
      state: "matched",
      matchedDealId: best.anchor.dealId,
      matchedJobId: best.anchor.jobId,
      evidence: defaultEvidence({
        method: "domain",
        rfcMessageId: message.rfcMessageId,
        inReplyTo,
        references,
        threadId: message.threadId,
        fromDomain,
        funderIds: [best.anchor.funderId],
        funderNames: [best.anchor.funderName],
        candidateJobIds: ranked.map((item) => item.anchor.jobId),
        candidateDealIds: uniqueStrings(ranked.map((item) => item.anchor.dealId)),
        subjectHits: best.hits,
        notes,
      }),
    }
  }

  notes.push(domainAnchors.length
    ? "Multiple submissions share this authorized domain without a unique subject or deal identifier."
    : "Authorized domain has no stored email submission to link.")
  return {
    state: "pending_review",
    evidence: defaultEvidence({
      method: domainAnchors.length ? "ambiguous" : "unrecognized",
      rfcMessageId: message.rfcMessageId,
      inReplyTo,
      references,
      threadId: message.threadId,
      fromDomain,
      funderIds: domainFunders.map((item) => item.id),
      funderNames: domainFunders.map((item) => item.nickname || item.legalName),
      candidateJobIds: uniqueStrings(domainAnchors.map((item) => item.jobId)),
      candidateDealIds: uniqueStrings(domainAnchors.map((item) => item.dealId)),
      notes,
    }),
  }
}

function sanitizeMessage(message: MailboxMessage): MailboxMessage {
  const providerMessageId = message.providerMessageId?.trim()
  if (!providerMessageId || providerMessageId.length > PROVIDER_ID_MAX) {
    throw new AppError(422, "validation_failed", "Review the highlighted fields.", { providerMessageId: ["Each mailbox message needs a provider message id."] })
  }
  if (providerMessageId === CHECKPOINT_PROVIDER_MESSAGE_ID) {
    throw new AppError(422, "validation_failed", "Review the highlighted fields.", { providerMessageId: ["That provider message id is reserved."] })
  }
  const from = extractAddress(message.from || "")
  if (!from || from.length > FROM_MAX) {
    throw new AppError(422, "validation_failed", "Review the highlighted fields.", { from: ["Each mailbox message needs a From address."] })
  }
  return {
    providerMessageId,
    threadId: message.threadId?.trim().slice(0, THREAD_MAX) || undefined,
    rfcMessageId: message.rfcMessageId?.trim() || undefined,
    inReplyTo: message.inReplyTo?.trim() || undefined,
    references: (message.references ?? []).map((item) => item.trim()).filter(Boolean).slice(0, 50),
    from,
    subject: message.subject?.trim().slice(0, SUBJECT_MAX) || undefined,
    body: message.body,
    receivedAt: message.receivedAt,
  }
}

async function persistReply(input: {
  sender: StoredEmailSender
  message: MailboxMessage
  state: ReplyState
  matchedDealId?: string
  matchedJobId?: string
  evidence: ReplyMatchEvidence
}): Promise<{ reply: FunderReply; created: boolean }> {
  const now = nowIso()
  const id = newId()
  const bodyCipher = input.message.body ? encryptSensitive(input.message.body, input.sender.workspaceId) : null
  const inserted = await db().prepare<{ id: string }>(`INSERT INTO mca_funder_replies
    (id, workspace_id, sender_id, provider_message_id, thread_id, from_address, subject, body_cipher,
     matched_deal_id, matched_job_id, match_evidence, state, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (workspace_id, sender_id, provider_message_id) DO NOTHING
    RETURNING id`).get(
    id,
    input.sender.workspaceId,
    input.sender.id,
    input.message.providerMessageId,
    input.message.threadId ?? null,
    input.message.from,
    input.message.subject ?? null,
    bodyCipher,
    input.matchedDealId ?? null,
    input.matchedJobId ?? null,
    JSON.stringify(input.evidence),
    input.state,
    now,
    now,
  )
  if (!inserted) {
    const existing = await findReplyByProvider(input.sender.workspaceId, input.sender.id, input.message.providerMessageId)
    if (!existing) throw new Error("Funder reply insert conflicted but no row was found.")
    return { reply: mapReply(existing, { includeBody: false, created: false }), created: false }
  }
  const saved = await findReplyByProvider(input.sender.workspaceId, input.sender.id, input.message.providerMessageId)
  if (!saved) throw new Error("Funder reply insert did not return a persisted row.")
  return { reply: mapReply(saved, { includeBody: false, created: true }), created: true }
}

async function ingestSender(actor: DealActor, sender: StoredEmailSender, checkpoint: CheckpointRecord): Promise<{
  ingested: RunReplyIngestResult["ingested"]
  checkpoint: CheckpointRecord
  flagsUnchanged: true
}> {
  const mailbox = activeMailbox()
  if (!mailbox) mailboxUnavailable()
  const listed = await mailbox.listMessages({
    workspaceId: sender.workspaceId,
    senderId: sender.id,
    fromAddress: sender.fromAddress,
    cursor: checkpoint.cursor,
  })
  const [anchors, funders] = await Promise.all([loadAnchors(actor), listFunders(actor, { includeInactive: true })])
  const ingested: RunReplyIngestResult["ingested"] = []
  for (const raw of listed.messages) {
    const message = sanitizeMessage(raw)
    const correlated = correlate(message, anchors, funders)
    const saved = await persistReply({
      sender,
      message,
      state: correlated.state,
      matchedDealId: correlated.matchedDealId,
      matchedJobId: correlated.matchedJobId,
      evidence: correlated.evidence,
    })
    ingested.push({
      id: saved.reply.id,
      providerMessageId: saved.reply.providerMessageId,
      state: saved.reply.state,
      created: saved.created,
      replayed: !saved.created,
    })
    await audit(actor, saved.created ? "funder_reply.ingested" : "funder_reply.replayed", saved.reply.id, {
      senderId: sender.id,
      providerMessageId: saved.reply.providerMessageId,
      state: saved.reply.state,
      method: saved.reply.evidence.method,
      created: saved.created,
      flagsUnchanged: true,
    })
  }
  const next: CheckpointRecord = {
    ...checkpoint,
    optedIn: true,
    cursor: listed.nextCursor,
    lastRunAt: nowIso(),
    lastError: null,
  }
  await saveCheckpoint(sender, next)
  return { ingested, checkpoint: next, flagsUnchanged: true }
}

async function senderHealth(workspaceId: string, senders: StoredEmailSender[]): Promise<ReplySenderHealth[]> {
  const health: ReplySenderHealth[] = []
  for (const sender of senders.filter((item) => item.purpose === "submission")) {
    health.push(healthFor(sender, await loadCheckpoint(workspaceId, sender.id)))
  }
  return health
}

function visibleReply(actor: DealActor, reply: FunderReply, deals: Map<string, DealRecord>): boolean {
  if (!reply.matchedDealId) return true
  const deal = deals.get(reply.matchedDealId)
  if (!deal) return false
  return canActorAccessDeal(actor, deal)
}

async function dealsFor(actor: DealActor, ids: Array<string | undefined>): Promise<Map<string, DealRecord>> {
  const map = new Map<string, DealRecord>()
  for (const id of uniqueStrings(ids)) {
    const deal = await findDealById(actor.workspaceId, id)
    if (deal) map.set(id, deal)
  }
  return map
}

export async function listReplyQueue(actor: DealActor, dealId?: string): Promise<ReplyQueueResult> {
  let scopedDeal: DealRecord | undefined
  const scopedId = dealId ? asDealQuery(dealId) : undefined
  if (scopedId) scopedDeal = await getDealForDocument(actor, scopedId)
  const [rows, senders, jobs] = await Promise.all([
    listReplyRows(actor.workspaceId),
    listSendersByWorkspace(actor.workspaceId),
    scopedDeal ? listJobsForDeal(actor.workspaceId, scopedDeal.id) : Promise.resolve([] as SubmissionJob[]),
  ])
  const mapped = rows.map((row) => mapReply(row, { includeBody: false }))
  const dealMap = await dealsFor(actor, mapped.flatMap((item) => [item.matchedDealId, ...(item.evidence.candidateDealIds ?? [])]))
  const replies = mapped.filter((reply) => {
    if (!visibleReply(actor, reply, dealMap)) return false
    if (!scopedDeal) return true
    if (reply.matchedDealId === scopedDeal.id) return true
    if (reply.state === "pending_review" && (reply.evidence.candidateDealIds ?? []).includes(scopedDeal.id)) return true
    return false
  }).map(publicReply)
  return {
    dealId: scopedDeal?.id,
    intervalMs: REPLY_INGEST_INTERVAL_MS,
    mailbox: { mode: replyMailboxMode(), liveOAuth: false },
    senders: await senderHealth(actor.workspaceId, senders),
    replies,
    candidateJobs: jobs.map((job) => ({
      jobId: job.id,
      funderId: job.funderId,
      displayFunderName: job.displayFunderName,
      state: job.state,
    })),
    canReview: actor.source === "user",
    canManage: isAdmin(actor),
  }
}

export async function getReply(actor: DealActor, id: string): Promise<FunderReply> {
  const row = await findReplyRow(actor.workspaceId, id)
  if (!row) throw new AppError(404, "resource_not_found", "The requested resource was not found.")
  const reply = mapReply(row, { includeBody: true, created: true })
  if (reply.matchedDealId) await getDealForDocument(actor, reply.matchedDealId)
  return publicReply(reply)
}

export async function reviewReply(actor: DealActor, id: string, input: ReviewReplyInput): Promise<FunderReply> {
  const row = await findReplyRow(actor.workspaceId, id)
  if (!row) throw new AppError(404, "resource_not_found", "The requested resource was not found.")
  const current = mapReply(row, { includeBody: true })
  if (current.matchedDealId) await getDealForDocument(actor, current.matchedDealId)
  const requestedState = input.state == null ? current.state : typeof input.state === "string" ? input.state.trim() : ""
  if (!REPLY_STATES.includes(requestedState as ReplyState)) {
    invalid("state", "Choose pending_review, matched, ignored, or processed.")
  }
  const nextState = requestedState as ReplyState
  let matchedDealId = asOptionalId(input.matchedDealId, "matchedDealId") ?? (nextState === "matched" ? current.matchedDealId : undefined)
  let matchedJobId = asOptionalId(input.matchedJobId, "matchedJobId") ?? (nextState === "matched" ? current.matchedJobId : undefined)
  if (nextState === "matched") {
    if (matchedJobId) {
      const job = await findJobById(actor.workspaceId, matchedJobId)
      if (!job) invalid("matchedJobId", "Choose a submission job in this workspace.")
      if (matchedDealId && job.dealId !== matchedDealId) invalid("matchedJobId", "That job does not belong to the selected deal.")
      matchedDealId = job.dealId
    }
    if (!matchedDealId) invalid("matchedDealId", "Choose a deal to link this reply.")
    await getDealForDocument(actor, matchedDealId)
  } else {
    if (nextState === "ignored" || nextState === "pending_review") {
      if (input.matchedDealId === null) matchedDealId = undefined
      if (input.matchedJobId === null) matchedJobId = undefined
      if (nextState === "ignored") {
        matchedDealId = current.matchedDealId
        matchedJobId = current.matchedJobId
      }
    }
  }
  const evidence = defaultEvidence({
    ...current.evidence,
    method: nextState === "matched" && current.evidence.method !== "message_id" && current.evidence.method !== "thread" && current.evidence.method !== "domain"
      ? "manual"
      : current.evidence.method,
    notes: uniqueStrings([...current.evidence.notes, nextState === "matched" ? "Linked during review." : nextState === "ignored" ? "Ignored during review." : undefined]),
  })
  const now = nowIso()
  await db().prepare(`UPDATE mca_funder_replies
    SET state = ?, matched_deal_id = ?, matched_job_id = ?, match_evidence = ?, updated_at = ?
    WHERE workspace_id = ? AND id = ?`).run(
    nextState,
    nextState === "matched" ? matchedDealId ?? null : nextState === "ignored" ? current.matchedDealId ?? null : current.matchedDealId ?? null,
    nextState === "matched" ? matchedJobId ?? null : current.matchedJobId ?? null,
    JSON.stringify(evidence),
    now,
    actor.workspaceId,
    id,
  )
  await audit(actor, "funder_reply.reviewed", id, {
    state: nextState,
    matchedDealId: nextState === "matched" ? matchedDealId : current.matchedDealId,
    matchedJobId: nextState === "matched" ? matchedJobId : current.matchedJobId,
  })
  return getReply(actor, id)
}

export async function runReplyIngest(actor: DealActor, input: RunReplyIngestInput = {}): Promise<RunReplyIngestResult> {
  const enabled = asEnabled(input.enabled)
  const senderId = input.senderId == null || input.senderId === "" ? undefined : asSenderId(input.senderId)
  const stored = await listSendersByWorkspace(actor.workspaceId)
  const selected = senderId ? assertSubmissionSender(stored.find((item) => item.id === senderId) ?? await findSenderById(actor.workspaceId, senderId)) : undefined
  if (enabled !== undefined) {
    if (!isAdmin(actor)) denied("Only workspace administrators can opt in mailbox ingestion.")
    if (!selected) invalid("senderId", "Choose a submission sender to opt in.")
    const current = await loadCheckpoint(actor.workspaceId, selected.id)
    const next: CheckpointRecord = { ...current, optedIn: enabled, lastError: enabled ? current.lastError ?? null : current.lastError ?? null }
    await saveCheckpoint(selected, next)
    await audit(actor, enabled ? "funder_reply.mailbox_opted_in" : "funder_reply.mailbox_opted_out", selected.id, {
      senderId: selected.id,
      optedIn: enabled,
      intervalMs: REPLY_INGEST_INTERVAL_MS,
    })
    if (!enabled) {
      return {
        intervalMs: REPLY_INGEST_INTERVAL_MS,
        mailbox: { mode: replyMailboxMode(), liveOAuth: false, flagsUnchanged: true },
        senders: await senderHealth(actor.workspaceId, stored),
        ingested: [],
        createdCount: 0,
        replayedCount: 0,
      }
    }
  }

  const targets: StoredEmailSender[] = []
  if (selected) {
    const checkpoint = await loadCheckpoint(actor.workspaceId, selected.id)
    if (!checkpoint.optedIn) invalid("senderId", "Opt in this submission sender before ingesting replies.")
    targets.push(selected)
  } else {
    for (const sender of stored.filter((item) => item.purpose === "submission" && item.state === "verified")) {
      if ((await loadCheckpoint(actor.workspaceId, sender.id)).optedIn) targets.push(sender)
    }
    if (!targets.length) invalid("senderId", "Opt in a submission sender before ingesting replies.")
  }

  if (!activeMailbox()) mailboxUnavailable()

  const ingested: RunReplyIngestResult["ingested"] = []
  for (const sender of targets) {
    const checkpoint = await loadCheckpoint(actor.workspaceId, sender.id)
    try {
      const result = await ingestSender(actor, sender, checkpoint)
      ingested.push(...result.ingested)
    } catch (error) {
      const message = error instanceof AppError ? error.message : "Mailbox ingest failed."
      await saveCheckpoint(sender, { ...checkpoint, lastRunAt: nowIso(), lastError: message })
      throw error
    }
  }

  return {
    intervalMs: REPLY_INGEST_INTERVAL_MS,
    mailbox: { mode: replyMailboxMode(), liveOAuth: false, flagsUnchanged: true },
    senders: await senderHealth(actor.workspaceId, await listSendersByWorkspace(actor.workspaceId)),
    ingested,
    createdCount: ingested.filter((item) => item.created).length,
    replayedCount: ingested.filter((item) => item.replayed).length,
  }
}
