import "server-only"

import { createHash, createHmac, randomBytes } from "node:crypto"
import { lookup } from "node:dns/promises"
import { isIP } from "node:net"
import { z } from "zod"
import { assertTrustedMutation, clientRateKey, consumeRequestRateLimit, requireWorkspaceAccess } from "../auth"
import { createOpaqueToken, decryptSensitive, encryptSensitive } from "../crypto"
import { getDatabase, newId, nowIso, parseJson, recordAuditEvent, withImmediateTransaction } from "../db"
import { canActorAccessDeal } from "../deals/access-policy"
import { activeMembershipIds, managedMembershipIds } from "../deals/repository"
import type { AssignmentKind, DealActor, DealAssignment, DealRecord, DealStatus } from "../deals/schema"
import { actorForDeals, getDealForDocument } from "../deals/service"
import { AppError } from "../errors"
import { requestCorrelationId } from "../http"
import type { Role } from "../types"
import type { RunCommsJobsInput, RunCommsJobsResult } from "./contracts"
import { registerCommsJob } from "./jobs"

export const WORKFLOW_WEBHOOK_SPEC_VERSION = "1" as const
export const WORKFLOW_WEBHOOK_TEST_HOOK = "mca://webhook/test"
export const WORKFLOW_WEBHOOK_MAX_ATTEMPTS = 5
export const WORKFLOW_WEBHOOK_EVENT_TYPES = [
  "offer.created",
  "deal.transitioned",
  "deal.assigned",
  "submission.created",
] as const
export type WorkflowWebhookEventType = (typeof WORKFLOW_WEBHOOK_EVENT_TYPES)[number]

export const WORKFLOW_WEBHOOK_OUTBOX_STATES = ["pending", "delivered", "failed"] as const
export type WorkflowWebhookOutboxState = (typeof WORKFLOW_WEBHOOK_OUTBOX_STATES)[number]
export const WORKFLOW_WEBHOOK_DELIVERY_STATES = ["delivered", "failed"] as const
export type WorkflowWebhookDeliveryState = (typeof WORKFLOW_WEBHOOK_DELIVERY_STATES)[number]

const EVENT_SET = new Set<string>(WORKFLOW_WEBHOOK_EVENT_TYPES)
const LABEL_MAX = 80
const URL_MAX = 2000
const ID_MAX = 80
const EVENT_ID_MAX = 160
const SECRET_MIN = 32
const SECRET_MAX = 200
const EVENT_ID_PATTERN = /^[A-Za-z0-9._:-]{1,160}$/
const BATCH_LIMIT = 50
const FORBIDDEN_PAYLOAD_KEYS = [
  "commission",
  "commissions",
  "commission_cents",
  "buy_rate",
  "buyRate",
  "fee_cents",
  "signing_secret",
  "signingSecret",
  "signing_secret_cipher",
  "ein",
  "identityLast4",
  "password",
  "credentialCipher",
] as const

type WebhookFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
let fetchOverride: WebhookFetch | undefined

export function setWorkflowWebhookFetchForTests(fetchImpl?: WebhookFetch): void {
  fetchOverride = fetchImpl
}

type EndpointRow = {
  id: string
  workspace_id: string
  label: string
  destination_url: string
  events_json: string
  signing_secret_cipher: string
  notify_originator: number | string
  notify_closer: number | string
  enabled: number | string
  created_by_user_id: string | null
  created_at: string
  updated_at: string
}

type OutboxRow = {
  id: string
  workspace_id: string
  endpoint_id: string
  event_id: string
  event_type: string
  payload_json: string
  state: string
  attempts: number | string
  last_error: string | null
  created_at: string
  updated_at: string
}

type DeliveryRow = {
  id: string
  workspace_id: string
  outbox_id: string
  event_id: string
  attempt: number | string
  http_status: number | string | null
  state: string
  error: string | null
  created_at: string
}

type MemberRow = {
  id: string
  user_id: string
  role: string
  status: string
}

export interface WorkflowWebhookDealSnapshot {
  id: string
  display_id: string
  status: DealStatus
  legal_name: string
  version: number
}

export interface WorkflowWebhookRecipient {
  membership_id: string
  kind: AssignmentKind
}

export interface WorkflowWebhookNotifications {
  originator: boolean
  closer: boolean
  recipients: WorkflowWebhookRecipient[]
}

export interface WorkflowWebhookOfferData {
  offer_id: string
  revision_id: string
  revision_number: number
  funder_name: string
  source: string
  amount_cents?: number
}

export interface WorkflowWebhookTransitionData {
  from_status: string
  to_status: string
}

export interface WorkflowWebhookAssignmentData {
  assignments: Array<{ membership_id: string; kind: AssignmentKind; is_primary: boolean }>
}

export interface WorkflowWebhookSubmissionData {
  job_id: string
  funder_id: string
  funder_name: string
  route_kind: string
  state: string
}

export type WorkflowWebhookEventData =
  | WorkflowWebhookOfferData
  | WorkflowWebhookTransitionData
  | WorkflowWebhookAssignmentData
  | WorkflowWebhookSubmissionData

export interface WorkflowWebhookEnvelope {
  spec_version: typeof WORKFLOW_WEBHOOK_SPEC_VERSION
  event_id: string
  event_type: WorkflowWebhookEventType
  occurred_at: string
  workspace_id: string
  correlation_id: string
  deal: WorkflowWebhookDealSnapshot
  data: WorkflowWebhookEventData
  notifications: WorkflowWebhookNotifications
}

export interface WorkflowWebhookEndpointView {
  id: string
  label: string
  destinationUrl: string
  destinationHost: string
  events: WorkflowWebhookEventType[]
  notifyOriginator: boolean
  notifyCloser: boolean
  enabled: boolean
  signingSecretConfigured: boolean
  signingSecret?: string
  createdAt: string
  updatedAt: string
}

export interface WorkflowWebhookOutboxView {
  id: string
  endpointId: string
  endpointLabel?: string
  eventId: string
  eventType: WorkflowWebhookEventType
  state: WorkflowWebhookOutboxState
  attempts: number
  lastError?: string
  createdAt: string
  updatedAt: string
}

export interface WorkflowWebhookDeliveryView {
  id: string
  outboxId: string
  endpointId: string
  eventId: string
  eventType: WorkflowWebhookEventType
  attempt: number
  httpStatus?: number
  state: WorkflowWebhookDeliveryState
  error?: string
  createdAt: string
}

export interface WorkflowWebhookConsole {
  specVersion: typeof WORKFLOW_WEBHOOK_SPEC_VERSION
  events: typeof WORKFLOW_WEBHOOK_EVENT_TYPES
  testHook: typeof WORKFLOW_WEBHOOK_TEST_HOOK
  maxAttempts: typeof WORKFLOW_WEBHOOK_MAX_ATTEMPTS
  endpoints: WorkflowWebhookEndpointView[]
  outbox: WorkflowWebhookOutboxView[]
  deliveries: WorkflowWebhookDeliveryView[]
}

export interface CreateWorkflowWebhookEndpointInput {
  label: string
  destinationUrl: string
  events: WorkflowWebhookEventType[]
  notifyOriginator?: boolean
  notifyCloser?: boolean
  enabled?: boolean
  signingSecret?: string
}

export interface UpdateWorkflowWebhookEndpointInput {
  label?: string
  destinationUrl?: string
  events?: WorkflowWebhookEventType[]
  notifyOriginator?: boolean
  notifyCloser?: boolean
  enabled?: boolean
  rotateSecret?: boolean
  signingSecret?: string
}

export interface PublishWorkflowWebhookInput {
  eventType: WorkflowWebhookEventType
  eventId?: string
  dealId: string
  occurredAt?: string
  offer?: {
    offerId: string
    revisionId: string
    revisionNumber: number
    funderName: string
    source: string
    amountCents?: number
  }
  fromStatus?: string
  toStatus?: string
  submission?: {
    jobId: string
    funderId: string
    funderName: string
    routeKind: string
    state: string
  }
}

export interface PublishWorkflowWebhookResult {
  eventId: string
  eventType: WorkflowWebhookEventType
  enqueued: number
  skipped: number
}

export interface WorkflowWebhookRunResult {
  attempted: number
  delivered: number
  failed: number
  outcomes: Array<{
    outboxId: string
    eventId: string
    state: WorkflowWebhookOutboxState
    httpStatus?: number
    error?: string
  }>
}

function db() {
  return getDatabase()
}

function invalid(field: string, message: string): never {
  throw new AppError(422, "validation_failed", "Review the highlighted fields.", { [field]: [message] })
}

function flag(value: unknown): boolean {
  return Number(value) === 1
}

function asInt(value: number | string | null | undefined): number {
  return Number(value) || 0
}

function http(): WebhookFetch {
  if (fetchOverride) return fetchOverride
  if (process.env.NODE_ENV === "test") {
    throw new AppError(503, "webhook_fetch_uninjected", "Webhook delivery requires an injected fetch in tests.")
  }
  return globalThis.fetch
}

export function isWorkflowWebhookTestHook(value: string): boolean {
  const trimmed = value.trim()
  return trimmed === WORKFLOW_WEBHOOK_TEST_HOOK || trimmed === `${WORKFLOW_WEBHOOK_TEST_HOOK}/`
}

function privateIp(address: string): boolean {
  const normalized = address.toLowerCase()
  if (normalized === "::1" || normalized === "0:0:0:0:0:0:0:1" || normalized.startsWith("fe80:") || normalized.startsWith("fc") || normalized.startsWith("fd")) {
    return true
  }
  const mapped = normalized.startsWith("::ffff:") ? normalized.slice(7) : normalized
  if (isIP(mapped) !== 4) return false
  const [a, b] = mapped.split(".").map(Number)
  return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
}

function blockedHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "")
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) return true
  if (host === "metadata.google.internal") return true
  if (isIP(host)) return privateIp(host)
  return false
}

export async function assertSafeWorkflowWebhookDestination(raw: string, options?: { resolveDns?: boolean }): Promise<string> {
  const value = raw.trim()
  if (!value || value.length > URL_MAX) invalid("destinationUrl", "Enter a valid HTTPS webhook URL.")
  if (isWorkflowWebhookTestHook(value)) return WORKFLOW_WEBHOOK_TEST_HOOK
  let url: URL
  try {
    url = new URL(value)
  } catch {
    invalid("destinationUrl", "Enter a valid HTTPS webhook URL.")
  }
  if (url.protocol !== "https:") invalid("destinationUrl", "Webhook destinations must use HTTPS.")
  if (url.username || url.password) invalid("destinationUrl", "Webhook destinations cannot include credentials.")
  if (url.port && url.port !== "443") invalid("destinationUrl", "Webhook destinations must use HTTPS without a nonstandard port.")
  if (blockedHostname(url.hostname)) invalid("destinationUrl", "Webhook destinations cannot target localhost or a private IP.")
  if (options?.resolveDns !== false && !fetchOverride) {
    const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "")
    let addresses: Array<{ address: string }>
    try {
      addresses = await lookup(host, { all: true, verbatim: true })
    } catch {
      throw new AppError(422, "webhook_destination_unresolvable", "The webhook destination host could not be resolved.", {
        destinationUrl: ["The webhook destination host could not be resolved."],
      })
    }
    if (!addresses.length || addresses.some((entry) => privateIp(entry.address))) {
      invalid("destinationUrl", "Webhook destinations cannot target localhost or a private IP.")
    }
  }
  return url.toString()
}

function destinationHost(url: string): string {
  if (isWorkflowWebhookTestHook(url)) return "mca-test-hook"
  try {
    return new URL(url).host
  } catch {
    return ""
  }
}

function asLabel(value: unknown): string {
  if (typeof value !== "string") invalid("label", "Enter a label.")
  const label = value.trim()
  if (!label || label.length > LABEL_MAX) invalid("label", "Enter a label of at most 80 characters.")
  return label
}

function asEvents(value: unknown): WorkflowWebhookEventType[] {
  if (!Array.isArray(value) || value.length === 0) invalid("events", "Choose at least one event.")
  const unique: WorkflowWebhookEventType[] = []
  for (const item of value) {
    if (typeof item !== "string" || !EVENT_SET.has(item)) invalid("events", "Choose at least one event.")
    const event = item as WorkflowWebhookEventType
    if (!unique.includes(event)) unique.push(event)
  }
  if (!unique.length) invalid("events", "Choose at least one event.")
  return unique
}

function asBoolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") invalid(field, `Choose whether ${field} is enabled.`)
  return value
}

function asEventId(value: string | undefined, fallback: string): string {
  const eventId = (value ?? fallback).trim()
  if (!EVENT_ID_PATTERN.test(eventId) || eventId.length > EVENT_ID_MAX) invalid("eventId", "Provide a stable event id.")
  return eventId
}

function asResourceId(value: string, field: string): string {
  const id = value.trim()
  if (!id || id.length > ID_MAX) invalid(field, `Choose a valid ${field}.`)
  return id
}

function asSecret(value: string | undefined, generate: boolean): string {
  if (value != null) {
    const secret = value.trim()
    if (secret.length < SECRET_MIN || secret.length > SECRET_MAX) invalid("signingSecret", "Use a signing secret of at least 32 characters.")
    return secret
  }
  if (!generate) invalid("signingSecret", "Use a signing secret of at least 32 characters.")
  return `${createOpaqueToken(24)}${randomBytes(8).toString("base64url")}`
}

function parseEvents(raw: string): WorkflowWebhookEventType[] {
  return parseJson<string[]>(raw, []).filter((item): item is WorkflowWebhookEventType => EVENT_SET.has(item))
}

export function workflowWebhookEventId(parts: string[]): string {
  return `${parts[0]}:${createHash("sha256").update(parts.join("\0")).digest("hex").slice(0, 32)}`
}

export function signWorkflowWebhookBody(secret: string, timestamp: string, body: string): string {
  return `v1=${createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex")}`
}

export function verifyWorkflowWebhookSignature(input: { secret: string; timestamp: string; body: string; signature: string }): boolean {
  const expected = signWorkflowWebhookBody(input.secret, input.timestamp, input.body)
  return expected.length === input.signature.length && expected === input.signature
}

function dealSnapshot(deal: DealRecord): WorkflowWebhookDealSnapshot {
  return {
    id: deal.id,
    display_id: deal.displayId,
    status: deal.status,
    legal_name: deal.legalName?.trim() || "Untitled draft",
    version: deal.version,
  }
}

function authorizedAssignments(deal: DealRecord, members: Map<string, MemberRow>): DealAssignment[] {
  return [...deal.assignments]
    .filter((item) => {
      const member = members.get(item.membershipId)
      return Boolean(member && member.status === "active")
    })
    .sort((left, right) => {
      if (left.kind !== right.kind) return left.kind < right.kind ? -1 : 1
      return left.membershipId < right.membershipId ? -1 : 1
    })
}

async function loadMembers(workspaceId: string): Promise<Map<string, MemberRow>> {
  const rows = await db().prepare<MemberRow>(
    "SELECT id, user_id, role, status FROM memberships WHERE workspace_id = ?",
  ).all(workspaceId)
  return new Map(rows.map((row) => [row.id, row]))
}

async function recipientCanAccess(workspaceId: string, member: MemberRow, deal: DealRecord, correlationId: string): Promise<boolean> {
  if (member.status !== "active") return false
  const managed = member.role === "manager" ? await managedMembershipIds(workspaceId, member.id) : []
  const actor: DealActor = {
    workspaceId,
    userId: member.user_id,
    membershipId: member.id,
    role: member.role as Role,
    managedMembershipIds: managed,
    activeMembershipIds: await activeMembershipIds(workspaceId),
    source: "user",
    correlationId,
  }
  return canActorAccessDeal(actor, deal)
}

async function notificationRecipients(
  actor: DealActor,
  deal: DealRecord,
  endpoint: Pick<EndpointRow, "notify_originator" | "notify_closer">,
  members: Map<string, MemberRow>,
): Promise<WorkflowWebhookRecipient[]> {
  const notifyOriginator = flag(endpoint.notify_originator)
  const notifyCloser = flag(endpoint.notify_closer)
  if (!notifyOriginator && !notifyCloser) return []
  const recipients: WorkflowWebhookRecipient[] = []
  for (const assignment of authorizedAssignments(deal, members)) {
    if (assignment.kind === "originator" && !notifyOriginator) continue
    if (assignment.kind === "closer" && !notifyCloser) continue
    const member = members.get(assignment.membershipId)
    if (!member) continue
    if (!(await recipientCanAccess(actor.workspaceId, member, deal, actor.correlationId))) continue
    recipients.push({ membership_id: assignment.membershipId, kind: assignment.kind })
  }
  return recipients
}

function offerData(input: NonNullable<PublishWorkflowWebhookInput["offer"]>): WorkflowWebhookOfferData {
  const data: WorkflowWebhookOfferData = {
    offer_id: asResourceId(input.offerId, "offerId"),
    revision_id: asResourceId(input.revisionId, "revisionId"),
    revision_number: Number.isInteger(input.revisionNumber) && input.revisionNumber > 0 ? input.revisionNumber : invalid("revisionNumber", "Provide a revision number."),
    funder_name: input.funderName.trim() || invalid("funderName", "Provide a funder name."),
    source: input.source.trim() || invalid("source", "Provide an offer source."),
  }
  if (input.amountCents != null) {
    if (!Number.isSafeInteger(input.amountCents) || input.amountCents < 0) invalid("amountCents", "Provide a non-negative amount in cents.")
    data.amount_cents = input.amountCents
  }
  return data
}

function submissionData(input: NonNullable<PublishWorkflowWebhookInput["submission"]>): WorkflowWebhookSubmissionData {
  return {
    job_id: asResourceId(input.jobId, "jobId"),
    funder_id: asResourceId(input.funderId, "funderId"),
    funder_name: input.funderName.trim() || invalid("funderName", "Provide a funder name."),
    route_kind: input.routeKind.trim() || invalid("routeKind", "Provide a submission route."),
    state: input.state.trim() || invalid("state", "Provide a submission state."),
  }
}

function eventData(input: PublishWorkflowWebhookInput, deal: DealRecord, members: Map<string, MemberRow>): WorkflowWebhookEventData {
  if (input.eventType === "offer.created") {
    if (!input.offer) invalid("offer", "Provide offer fields.")
    return offerData(input.offer)
  }
  if (input.eventType === "deal.transitioned") {
    const fromStatus = input.fromStatus?.trim()
    const toStatus = input.toStatus?.trim()
    if (!fromStatus || !toStatus) invalid("toStatus", "Provide the previous and next deal status.")
    return { from_status: fromStatus, to_status: toStatus }
  }
  if (input.eventType === "submission.created") {
    if (!input.submission) invalid("submission", "Provide submission fields.")
    return submissionData(input.submission)
  }
  return {
    assignments: authorizedAssignments(deal, members).map((item) => ({
      membership_id: item.membershipId,
      kind: item.kind,
      is_primary: item.isPrimary,
    })),
  }
}

function defaultEventId(input: PublishWorkflowWebhookInput, deal: DealRecord, data: WorkflowWebhookEventData): string {
  if (input.eventType === "offer.created") {
    const offer = data as WorkflowWebhookOfferData
    return workflowWebhookEventId(["offer.created", deal.workspaceId, deal.id, offer.offer_id, offer.revision_id])
  }
  if (input.eventType === "deal.transitioned") {
    const transition = data as WorkflowWebhookTransitionData
    return workflowWebhookEventId(["deal.transitioned", deal.workspaceId, deal.id, transition.from_status, transition.to_status, String(deal.version)])
  }
  if (input.eventType === "submission.created") {
    const submission = data as WorkflowWebhookSubmissionData
    return workflowWebhookEventId(["submission.created", deal.workspaceId, submission.job_id])
  }
  const assignment = data as WorkflowWebhookAssignmentData
  const fingerprint = assignment.assignments.map((item) => `${item.kind}:${item.membership_id}:${item.is_primary ? "1" : "0"}`).join(",")
  return workflowWebhookEventId(["deal.assigned", deal.workspaceId, deal.id, fingerprint])
}

function buildEnvelope(input: {
  eventId: string
  eventType: WorkflowWebhookEventType
  occurredAt: string
  correlationId: string
  deal: DealRecord
  data: WorkflowWebhookEventData
  notifications: WorkflowWebhookNotifications
}): WorkflowWebhookEnvelope {
  return {
    spec_version: WORKFLOW_WEBHOOK_SPEC_VERSION,
    event_id: input.eventId,
    event_type: input.eventType,
    occurred_at: input.occurredAt,
    workspace_id: input.deal.workspaceId,
    correlation_id: input.correlationId,
    deal: dealSnapshot(input.deal),
    data: input.data,
    notifications: input.notifications,
  }
}

function assertEnvelopeMinimum(envelope: WorkflowWebhookEnvelope): void {
  const text = JSON.stringify(envelope)
  for (const key of FORBIDDEN_PAYLOAD_KEYS) {
    if (text.includes(`"${key}"`)) {
      throw new AppError(500, "webhook_payload_forbidden", "Workflow webhook payloads cannot include internal secrets or commission fields.")
    }
  }
}

function toEndpointView(row: EndpointRow, signingSecret?: string): WorkflowWebhookEndpointView {
  return {
    id: row.id,
    label: row.label,
    destinationUrl: row.destination_url,
    destinationHost: destinationHost(row.destination_url),
    events: parseEvents(row.events_json),
    notifyOriginator: flag(row.notify_originator),
    notifyCloser: flag(row.notify_closer),
    enabled: flag(row.enabled),
    signingSecretConfigured: Boolean(row.signing_secret_cipher),
    ...(signingSecret ? { signingSecret } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function toOutboxView(row: OutboxRow, label?: string): WorkflowWebhookOutboxView {
  return {
    id: row.id,
    endpointId: row.endpoint_id,
    endpointLabel: label,
    eventId: row.event_id,
    eventType: row.event_type as WorkflowWebhookEventType,
    state: row.state as WorkflowWebhookOutboxState,
    attempts: asInt(row.attempts),
    lastError: row.last_error ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function toDeliveryView(row: DeliveryRow & { endpoint_id?: string; event_type?: string }): WorkflowWebhookDeliveryView {
  return {
    id: row.id,
    outboxId: row.outbox_id,
    endpointId: row.endpoint_id ?? "",
    eventId: row.event_id,
    eventType: (row.event_type ?? "deal.assigned") as WorkflowWebhookEventType,
    attempt: asInt(row.attempt),
    httpStatus: row.http_status == null ? undefined : asInt(row.http_status),
    state: row.state as WorkflowWebhookDeliveryState,
    error: row.error ?? undefined,
    createdAt: row.created_at,
  }
}

async function loadEndpoint(workspaceId: string, id: string): Promise<EndpointRow> {
  const row = await db().prepare<EndpointRow>(
    "SELECT * FROM mca_workflow_webhook_endpoints WHERE workspace_id = ? AND id = ?",
  ).get(workspaceId, id)
  if (!row) throw new AppError(404, "webhook_endpoint_not_found", "The webhook endpoint was not found.")
  return row
}

async function loadOutbox(workspaceId: string, id: string): Promise<OutboxRow> {
  const row = await db().prepare<OutboxRow>(
    "SELECT * FROM mca_workflow_webhook_outbox WHERE workspace_id = ? AND id = ?",
  ).get(workspaceId, id)
  if (!row) throw new AppError(404, "webhook_outbox_not_found", "The webhook outbox item was not found.")
  return row
}

async function assertUniqueLabel(workspaceId: string, label: string, excludeId?: string): Promise<void> {
  const row = await db().prepare<{ id: string }>(
    "SELECT id FROM mca_workflow_webhook_endpoints WHERE workspace_id = ? AND label = ?",
  ).get(workspaceId, label)
  if (row && row.id !== excludeId) {
    throw new AppError(409, "webhook_label_conflict", "A webhook endpoint with this label already exists.", {
      label: ["A webhook endpoint with this label already exists."],
    })
  }
}

export async function listWorkflowWebhookConsole(actor: DealActor): Promise<WorkflowWebhookConsole> {
  const endpoints = await db().prepare<EndpointRow>(
    "SELECT * FROM mca_workflow_webhook_endpoints WHERE workspace_id = ? ORDER BY created_at, id",
  ).all(actor.workspaceId)
  const labels = new Map(endpoints.map((row) => [row.id, row.label]))
  const outbox = await db().prepare<OutboxRow>(
    "SELECT * FROM mca_workflow_webhook_outbox WHERE workspace_id = ? ORDER BY created_at DESC, id DESC LIMIT 100",
  ).all(actor.workspaceId)
  const deliveries = await db().prepare<DeliveryRow & { endpoint_id: string; event_type: string }>(
    `SELECT d.*, o.endpoint_id, o.event_type
     FROM mca_workflow_webhook_deliveries d
     JOIN mca_workflow_webhook_outbox o ON o.id = d.outbox_id AND o.workspace_id = d.workspace_id
     WHERE d.workspace_id = ?
     ORDER BY d.created_at DESC, d.attempt DESC, d.id DESC
     LIMIT 100`,
  ).all(actor.workspaceId)
  return {
    specVersion: WORKFLOW_WEBHOOK_SPEC_VERSION,
    events: WORKFLOW_WEBHOOK_EVENT_TYPES,
    testHook: WORKFLOW_WEBHOOK_TEST_HOOK,
    maxAttempts: WORKFLOW_WEBHOOK_MAX_ATTEMPTS,
    endpoints: endpoints.map((row) => toEndpointView(row)),
    outbox: outbox.map((row) => toOutboxView(row, labels.get(row.endpoint_id))),
    deliveries: deliveries.map((row) => toDeliveryView(row)),
  }
}

export async function getWorkflowWebhookEndpoint(actor: DealActor, id: string): Promise<WorkflowWebhookEndpointView> {
  return toEndpointView(await loadEndpoint(actor.workspaceId, asResourceId(id, "id")))
}

export async function createWorkflowWebhookEndpoint(actor: DealActor, input: CreateWorkflowWebhookEndpointInput): Promise<WorkflowWebhookEndpointView> {
  const label = asLabel(input.label)
  const events = asEvents(input.events)
  const destinationUrl = await assertSafeWorkflowWebhookDestination(input.destinationUrl, { resolveDns: false })
  const notifyOriginator = input.notifyOriginator === undefined ? false : asBoolean(input.notifyOriginator, "notifyOriginator")
  const notifyCloser = input.notifyCloser === undefined ? false : asBoolean(input.notifyCloser, "notifyCloser")
  const enabled = input.enabled === undefined ? true : asBoolean(input.enabled, "enabled")
  const signingSecret = asSecret(input.signingSecret, true)
  await assertUniqueLabel(actor.workspaceId, label)
  const now = nowIso()
  const id = newId()
  const row = await db().prepare<EndpointRow>(
    `INSERT INTO mca_workflow_webhook_endpoints
      (id, workspace_id, label, destination_url, events_json, signing_secret_cipher, notify_originator, notify_closer, enabled, created_by_user_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     RETURNING *`,
  ).get(
    id,
    actor.workspaceId,
    label,
    destinationUrl,
    JSON.stringify(events),
    encryptSensitive(signingSecret, actor.workspaceId),
    notifyOriginator ? 1 : 0,
    notifyCloser ? 1 : 0,
    enabled ? 1 : 0,
    actor.userId,
    now,
    now,
  )
  if (!row) throw new Error("Webhook endpoint was not saved.")
  await recordAuditEvent({
    context: actor,
    action: "webhook.endpoint_created",
    resourceType: "workflow_webhook_endpoint",
    resourceId: row.id,
    metadata: { label, events, notifyOriginator, notifyCloser, enabled, destinationHost: destinationHost(destinationUrl) },
    correlationId: actor.correlationId,
  })
  return toEndpointView(row, signingSecret)
}

export async function updateWorkflowWebhookEndpoint(actor: DealActor, id: string, input: UpdateWorkflowWebhookEndpointInput): Promise<WorkflowWebhookEndpointView> {
  const current = await loadEndpoint(actor.workspaceId, asResourceId(id, "id"))
  const label = input.label === undefined ? current.label : asLabel(input.label)
  const events = input.events === undefined ? parseEvents(current.events_json) : asEvents(input.events)
  const destinationUrl = input.destinationUrl === undefined
    ? current.destination_url
    : await assertSafeWorkflowWebhookDestination(input.destinationUrl, { resolveDns: false })
  const notifyOriginator = input.notifyOriginator === undefined ? flag(current.notify_originator) : asBoolean(input.notifyOriginator, "notifyOriginator")
  const notifyCloser = input.notifyCloser === undefined ? flag(current.notify_closer) : asBoolean(input.notifyCloser, "notifyCloser")
  const enabled = input.enabled === undefined ? flag(current.enabled) : asBoolean(input.enabled, "enabled")
  await assertUniqueLabel(actor.workspaceId, label, current.id)
  let secretCipher = current.signing_secret_cipher
  let signingSecret: string | undefined
  if (input.rotateSecret || input.signingSecret) {
    signingSecret = asSecret(input.signingSecret, Boolean(input.rotateSecret))
    secretCipher = encryptSensitive(signingSecret, actor.workspaceId)
  }
  const now = nowIso()
  const row = await db().prepare<EndpointRow>(
    `UPDATE mca_workflow_webhook_endpoints
     SET label = ?, destination_url = ?, events_json = ?, signing_secret_cipher = ?, notify_originator = ?, notify_closer = ?, enabled = ?, updated_at = ?
     WHERE workspace_id = ? AND id = ?
     RETURNING *`,
  ).get(
    label,
    destinationUrl,
    JSON.stringify(events),
    secretCipher,
    notifyOriginator ? 1 : 0,
    notifyCloser ? 1 : 0,
    enabled ? 1 : 0,
    now,
    actor.workspaceId,
    current.id,
  )
  if (!row) throw new AppError(404, "webhook_endpoint_not_found", "The webhook endpoint was not found.")
  await recordAuditEvent({
    context: actor,
    action: "webhook.endpoint_updated",
    resourceType: "workflow_webhook_endpoint",
    resourceId: row.id,
    metadata: {
      label,
      events,
      notifyOriginator,
      notifyCloser,
      enabled,
      secretRotated: Boolean(signingSecret),
      destinationHost: destinationHost(destinationUrl),
    },
    correlationId: actor.correlationId,
  })
  return toEndpointView(row, signingSecret)
}

export async function disableWorkflowWebhookEndpoint(actor: DealActor, id: string): Promise<WorkflowWebhookEndpointView> {
  return updateWorkflowWebhookEndpoint(actor, id, { enabled: false })
}

export async function removeWorkflowWebhookEndpoint(actor: DealActor, id: string): Promise<{ id: string; removed: true }> {
  const current = await loadEndpoint(actor.workspaceId, asResourceId(id, "id"))
  const now = nowIso()
  await withImmediateTransaction(async () => {
    await db().prepare(
      `UPDATE mca_workflow_webhook_outbox
       SET state = 'failed', last_error = ?, updated_at = ?
       WHERE workspace_id = ? AND endpoint_id = ? AND state = 'pending'`,
    ).run("Webhook endpoint removed.", now, actor.workspaceId, current.id)
    const deleted = await db().prepare<{ id: string }>(
      "DELETE FROM mca_workflow_webhook_endpoints WHERE workspace_id = ? AND id = ? RETURNING id",
    ).get(actor.workspaceId, current.id)
    if (!deleted) throw new AppError(404, "webhook_endpoint_not_found", "The webhook endpoint was not found.")
  })
  await recordAuditEvent({
    context: actor,
    action: "webhook.endpoint_removed",
    resourceType: "workflow_webhook_endpoint",
    resourceId: current.id,
    metadata: { label: current.label, destinationHost: destinationHost(current.destination_url) },
    correlationId: actor.correlationId,
  })
  return { id: current.id, removed: true }
}

export async function publishWorkflowWebhook(actor: DealActor, input: PublishWorkflowWebhookInput): Promise<PublishWorkflowWebhookResult> {
  if (!EVENT_SET.has(input.eventType)) invalid("eventType", "Choose a workflow webhook event.")
  const deal = await getDealForDocument(actor, asResourceId(input.dealId, "dealId"))
  const members = await loadMembers(actor.workspaceId)
  const data = eventData(input, deal, members)
  const eventId = asEventId(input.eventId, defaultEventId(input, deal, data))
  const occurredAt = input.occurredAt && Number.isFinite(Date.parse(input.occurredAt)) ? input.occurredAt : nowIso()
  const endpoints = await db().prepare<EndpointRow>(
    "SELECT * FROM mca_workflow_webhook_endpoints WHERE workspace_id = ? AND enabled = 1 ORDER BY created_at, id",
  ).all(actor.workspaceId)
  const matching = endpoints.filter((row) => parseEvents(row.events_json).includes(input.eventType))
  let enqueued = 0
  await withImmediateTransaction(async () => {
    for (const endpoint of matching) {
      const envelope = buildEnvelope({
        eventId,
        eventType: input.eventType,
        occurredAt,
        correlationId: actor.correlationId,
        deal,
        data,
        notifications: {
          originator: flag(endpoint.notify_originator),
          closer: flag(endpoint.notify_closer),
          recipients: await notificationRecipients(actor, deal, endpoint, members),
        },
      })
      assertEnvelopeMinimum(envelope)
      const payload = JSON.stringify(envelope)
      const now = nowIso()
      const inserted = await db().prepare<OutboxRow>(
        `INSERT INTO mca_workflow_webhook_outbox
          (id, workspace_id, endpoint_id, event_id, event_type, payload_json, state, attempts, last_error, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'pending', 0, NULL, ?, ?)
         ON CONFLICT (workspace_id, endpoint_id, event_id) DO NOTHING
         RETURNING *`,
      ).get(newId(), actor.workspaceId, endpoint.id, eventId, input.eventType, payload, now, now)
      if (inserted) {
        enqueued += 1
        await recordAuditEvent({
          context: actor,
          action: "webhook.event_enqueued",
          resourceType: "workflow_webhook_outbox",
          resourceId: inserted.id,
          metadata: { eventId, eventType: input.eventType, endpointId: endpoint.id, dealId: deal.id },
          correlationId: actor.correlationId,
        })
      }
    }
  })
  return { eventId, eventType: input.eventType, enqueued, skipped: matching.length - enqueued }
}

async function recordDelivery(input: {
  workspaceId: string
  outboxId: string
  eventId: string
  attempt: number
  httpStatus?: number
  state: WorkflowWebhookDeliveryState
  error?: string
}): Promise<DeliveryRow> {
  const createdAt = nowIso()
  const inserted = await db().prepare<DeliveryRow>(
    `INSERT INTO mca_workflow_webhook_deliveries
      (id, workspace_id, outbox_id, event_id, attempt, http_status, state, error, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (workspace_id, outbox_id, attempt) DO NOTHING
     RETURNING *`,
  ).get(
    newId(),
    input.workspaceId,
    input.outboxId,
    input.eventId,
    input.attempt,
    input.httpStatus ?? null,
    input.state,
    input.error ?? null,
    createdAt,
  )
  if (inserted) return inserted
  const existing = await db().prepare<DeliveryRow>(
    "SELECT * FROM mca_workflow_webhook_deliveries WHERE workspace_id = ? AND outbox_id = ? AND attempt = ?",
  ).get(input.workspaceId, input.outboxId, input.attempt)
  if (!existing) throw new Error("Webhook delivery claim did not return a row.")
  return existing
}

async function postEnvelope(input: {
  workspaceId: string
  approvedAt: string
  destinationUrl: string
  secret: string
  body: string
  eventId: string
  eventType: string
  correlationId: string
  nowIso: string
}): Promise<{ ok: boolean; httpStatus?: number; error?: string }> {
  let destination: string
  try {
    destination = await assertSafeWorkflowWebhookDestination(input.destinationUrl, { resolveDns: !fetchOverride })
  } catch (error) {
    return { ok: false, error: error instanceof AppError ? error.message : "The webhook destination is not allowed." }
  }
  const timestamp = String(Math.floor((Number.isFinite(Date.parse(input.nowIso)) ? Date.parse(input.nowIso) : Date.now()) / 1000))
  const signature = signWorkflowWebhookBody(input.secret, timestamp, input.body)
  await (await import("../company-access")).assertCompanyOperational(input.workspaceId)
  await (await import("../outbound-approval")).assertOutboundDispatch(input.workspaceId, input.approvedAt)
  try {
    const response = await http()(destination, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-mca-spec-version": WORKFLOW_WEBHOOK_SPEC_VERSION,
        "x-mca-event-id": input.eventId,
        "x-mca-event-type": input.eventType,
        "x-mca-webhook-timestamp": timestamp,
        "x-mca-webhook-signature": signature,
        "x-correlation-id": input.correlationId,
      },
      body: input.body,
      redirect: "manual",
      signal: AbortSignal.timeout(10_000),
    })
    if (response.status >= 300 && response.status < 400) {
      return { ok: false, httpStatus: response.status, error: "The webhook destination redirected the request." }
    }
    if (response.ok) return { ok: true, httpStatus: response.status }
    return { ok: false, httpStatus: response.status, error: "The webhook destination did not accept the event." }
  } catch (error) {
    if (error instanceof AppError) return { ok: false, error: error.message }
    return { ok: false, error: "The webhook destination did not accept the event." }
  }
}

async function finishOutbox(row: OutboxRow, input: { state: WorkflowWebhookOutboxState; lastError?: string | null }): Promise<OutboxRow> {
  const updated = await db().prepare<OutboxRow>(
    `UPDATE mca_workflow_webhook_outbox
     SET state = ?, last_error = ?, updated_at = ?
     WHERE workspace_id = ? AND id = ?
     RETURNING *`,
  ).get(input.state, input.lastError ?? null, nowIso(), row.workspace_id, row.id)
  return updated ?? { ...row, state: input.state, last_error: input.lastError ?? null }
}

async function deliverOutboxRow(actor: DealActor, row: OutboxRow, nowIsoValue: string, options?: { force?: boolean }): Promise<WorkflowWebhookRunResult["outcomes"][number]> {
  if (!(await (await import("../company-access")).getCompanyAccess(actor.workspaceId)).allowed) {
    await finishOutbox(row, { state: "failed", lastError: "Company paused. Review and explicitly replay this event after recovery." })
    return { outboxId: row.id, eventId: row.event_id, state: "failed", error: "company_paused" }
  }
  const claimed = options?.force
    ? await db().prepare<OutboxRow>(
      `UPDATE mca_workflow_webhook_outbox
       SET attempts = attempts + 1, state = 'pending', updated_at = ?
       WHERE workspace_id = ? AND id = ?
       RETURNING *`,
    ).get(nowIso(), row.workspace_id, row.id)
    : await db().prepare<OutboxRow>(
      `UPDATE mca_workflow_webhook_outbox
       SET attempts = attempts + 1, updated_at = ?
       WHERE workspace_id = ? AND id = ? AND state = 'pending' AND attempts < ?
       RETURNING *`,
    ).get(nowIso(), row.workspace_id, row.id, WORKFLOW_WEBHOOK_MAX_ATTEMPTS)
  if (!claimed) {
    return { outboxId: row.id, eventId: row.event_id, state: row.state as WorkflowWebhookOutboxState }
  }
  const endpoint = await db().prepare<EndpointRow>(
    "SELECT * FROM mca_workflow_webhook_endpoints WHERE workspace_id = ? AND id = ?",
  ).get(claimed.workspace_id, claimed.endpoint_id)
  if (!endpoint || !flag(endpoint.enabled)) {
    const failed = await finishOutbox(claimed, { state: "failed", lastError: "The webhook endpoint is missing or disabled." })
    await recordDelivery({
      workspaceId: claimed.workspace_id,
      outboxId: claimed.id,
      eventId: claimed.event_id,
      attempt: asInt(claimed.attempts),
      state: "failed",
      error: failed.last_error ?? undefined,
    })
    return { outboxId: claimed.id, eventId: claimed.event_id, state: "failed", error: failed.last_error ?? undefined }
  }
  const secret = decryptSensitive(endpoint.signing_secret_cipher, actor.workspaceId)
  let posted: Awaited<ReturnType<typeof postEnvelope>>
  try {
    posted = await postEnvelope({ workspaceId: actor.workspaceId, approvedAt: options?.force ? nowIsoValue : row.created_at, destinationUrl: endpoint.destination_url, secret,
      body: claimed.payload_json, eventId: claimed.event_id, eventType: claimed.event_type, correlationId: actor.correlationId, nowIso: nowIsoValue })
  } catch (error) {
    if (!(error instanceof AppError && ["company_paused", "company_outbound_reapproval_required"].includes(error.code))) throw error
    await db().prepare("UPDATE mca_workflow_webhook_outbox SET state='failed',attempts=GREATEST(0,attempts-1),last_error='company_paused',updated_at=? WHERE workspace_id=? AND id=?")
      .run(nowIso(), actor.workspaceId, claimed.id)
    return { outboxId: claimed.id, eventId: claimed.event_id, state: "failed", error: "company_paused" }
  }
  const attempts = asInt(claimed.attempts)
  const succeeded = posted.ok
  const nextState: WorkflowWebhookOutboxState = succeeded ? "delivered" : attempts >= WORKFLOW_WEBHOOK_MAX_ATTEMPTS ? "failed" : "pending"
  const finished = await finishOutbox(claimed, { state: nextState, lastError: succeeded ? null : posted.error ?? "The webhook destination did not accept the event." })
  await recordDelivery({
    workspaceId: claimed.workspace_id,
    outboxId: claimed.id,
    eventId: claimed.event_id,
    attempt: attempts,
    httpStatus: posted.httpStatus,
    state: succeeded ? "delivered" : "failed",
    error: succeeded ? undefined : finished.last_error ?? undefined,
  })
  await recordAuditEvent({
    context: actor,
    action: succeeded ? "webhook.delivered" : "webhook.failed",
    resourceType: "workflow_webhook_outbox",
    resourceId: claimed.id,
    metadata: { eventId: claimed.event_id, attempt: attempts, httpStatus: posted.httpStatus, state: nextState },
    correlationId: actor.correlationId,
  })
  return {
    outboxId: claimed.id,
    eventId: claimed.event_id,
    state: nextState,
    httpStatus: posted.httpStatus,
    error: succeeded ? undefined : finished.last_error ?? undefined,
  }
}

export async function processWebhookOutbox(input: RunCommsJobsInput): Promise<WorkflowWebhookRunResult> {
  const pending = await db().prepare<OutboxRow>(
    `SELECT * FROM mca_workflow_webhook_outbox
     WHERE workspace_id = ? AND state = 'pending' AND attempts < ?
     ORDER BY created_at, id
     LIMIT ?`,
  ).all(input.actor.workspaceId, WORKFLOW_WEBHOOK_MAX_ATTEMPTS, BATCH_LIMIT)
  const outcomes: WorkflowWebhookRunResult["outcomes"] = []
  for (const row of pending) {
    outcomes.push(await deliverOutboxRow(input.actor, row, input.nowIso))
  }
  let delivered = 0
  let failed = 0
  for (const outcome of outcomes) {
    if (outcome.state === "delivered") delivered += 1
    else failed += 1
  }
  return { attempted: outcomes.length, delivered, failed, outcomes }
}

export async function replayWebhookOutbox(actor: DealActor, outboxId: string, nowIsoValue = nowIso()): Promise<WorkflowWebhookRunResult["outcomes"][number]> {
  const row = await loadOutbox(actor.workspaceId, asResourceId(outboxId, "outboxId"))
  const outcome = await deliverOutboxRow(actor, row, nowIsoValue, { force: true })
  await recordAuditEvent({
    context: actor,
    action: "webhook.replayed",
    resourceType: "workflow_webhook_outbox",
    resourceId: row.id,
    metadata: { eventId: row.event_id, state: outcome.state, httpStatus: outcome.httpStatus },
    correlationId: actor.correlationId,
  })
  return outcome
}

export async function testWorkflowWebhookEndpoint(actor: DealActor, endpointId: string, nowIsoValue = nowIso()): Promise<{
  endpointId: string
  delivered: boolean
  httpStatus?: number
  error?: string
  markedDelivered: false
}> {
  const endpoint = await loadEndpoint(actor.workspaceId, asResourceId(endpointId, "id"))
  const body = JSON.stringify({
    spec_version: WORKFLOW_WEBHOOK_SPEC_VERSION,
    event_id: `webhook.test:${endpoint.id}`,
    event_type: "webhook.test",
    occurred_at: nowIsoValue,
    workspace_id: actor.workspaceId,
    correlation_id: actor.correlationId,
    test: true,
  })
  const secret = decryptSensitive(endpoint.signing_secret_cipher, actor.workspaceId)
  const posted = await postEnvelope({
    destinationUrl: endpoint.destination_url,
    workspaceId: actor.workspaceId,
    approvedAt: nowIsoValue,
    secret,
    body,
    eventId: `webhook.test:${endpoint.id}`,
    eventType: "webhook.test",
    correlationId: actor.correlationId,
    nowIso: nowIsoValue,
  })
  return {
    endpointId: endpoint.id,
    delivered: posted.ok,
    httpStatus: posted.httpStatus,
    error: posted.ok ? undefined : posted.error,
    markedDelivered: false,
  }
}

async function webhookOutboxJobHandler(input: RunCommsJobsInput): Promise<Partial<RunCommsJobsResult>> {
  const result = await processWebhookOutbox(input)
  return { webhooks: { attempted: result.attempted, delivered: result.delivered, failed: result.failed } }
}

registerCommsJob("webhook_outbox", webhookOutboxJobHandler)

export const webhookEndpointCreateSchema = z.object({
  label: z.string().min(1).max(LABEL_MAX),
  destinationUrl: z.string().min(1).max(URL_MAX),
  events: z.array(z.enum(WORKFLOW_WEBHOOK_EVENT_TYPES)),
  notifyOriginator: z.boolean().optional(),
  notifyCloser: z.boolean().optional(),
  enabled: z.boolean().optional(),
  signingSecret: z.string().min(SECRET_MIN).max(SECRET_MAX).optional(),
}).strict()

export const webhookEndpointPatchSchema = z.object({
  label: z.string().min(1).max(LABEL_MAX).optional(),
  destinationUrl: z.string().min(1).max(URL_MAX).optional(),
  events: z.array(z.enum(WORKFLOW_WEBHOOK_EVENT_TYPES)).optional(),
  notifyOriginator: z.boolean().optional(),
  notifyCloser: z.boolean().optional(),
  enabled: z.boolean().optional(),
  rotateSecret: z.boolean().optional(),
  signingSecret: z.string().min(SECRET_MIN).max(SECRET_MAX).optional(),
}).strict()

export const webhookPublishSchema = z.object({
  eventType: z.enum(WORKFLOW_WEBHOOK_EVENT_TYPES),
  eventId: z.string().min(1).max(EVENT_ID_MAX).optional(),
  dealId: z.string().min(1).max(ID_MAX),
  occurredAt: z.string().min(1).optional(),
  offer: z.object({
    offerId: z.string().min(1).max(ID_MAX),
    revisionId: z.string().min(1).max(ID_MAX),
    revisionNumber: z.number().int().positive(),
    funderName: z.string().min(1).max(200),
    source: z.string().min(1).max(40),
    amountCents: z.number().int().nonnegative().optional(),
  }).strict().optional(),
  fromStatus: z.string().min(1).max(40).optional(),
  toStatus: z.string().min(1).max(40).optional(),
  submission: z.object({
    jobId: z.string().min(1).max(ID_MAX),
    funderId: z.string().min(1).max(ID_MAX),
    funderName: z.string().min(1).max(200),
    routeKind: z.string().min(1).max(40),
    state: z.string().min(1).max(40),
  }).strict().optional(),
}).strict()

async function actorFromRequest(request: Request, options: { write?: boolean; sessionOnly?: boolean; admin?: boolean }): Promise<DealActor> {
  if (options.write) assertTrustedMutation(request)
  const auth = await requireWorkspaceAccess(request, {
    sessionOnly: options.sessionOnly,
    roles: options.admin ? ["admin", "super_admin"] : undefined,
  })
  return { ...await actorForDeals(auth), correlationId: requestCorrelationId(request) }
}

export async function requireWebhookAdmin(request: Request): Promise<DealActor> {
  const actor = await actorFromRequest(request, { write: true, sessionOnly: true, admin: true })
  await consumeRequestRateLimit(clientRateKey(request, `workflow-webhook-write:${actor.workspaceId}`), 30)
  return actor
}

export async function requireWebhookAdminRead(request: Request): Promise<DealActor> {
  return actorFromRequest(request, { sessionOnly: true, admin: true })
}
