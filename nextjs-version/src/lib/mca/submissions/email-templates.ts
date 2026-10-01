import "server-only"

import { providerReadinessView } from "./provider-readiness"
import { createHash } from "node:crypto"
import { assertTrustedMutation, requireMembershipAccess, requireWorkspaceAccess } from "../auth"
import { getDatabase, newId, nowIso, recordAuditEvent } from "../db"
import type { DealActor, DealRecord } from "../deals/schema"
import { findDealById } from "../deals/repository"
import { actorForDeals, getDealForDocument } from "../deals/service"
import type { DocumentSummary } from "../documents/contracts"
import { listSubmissionDocuments } from "../documents/service"
import { AppError } from "../errors"
import type { FunderRecord, FunderRoute } from "../funders/contracts"
import { getFunder, listFunders } from "../funders/directory"
import { requestCorrelationId } from "../http"
import { canManageWorkspace } from "../policy"
import type { EmailSender } from "../senders/contracts"
import { listSendersByWorkspace } from "../senders/repository"
import { assertSenderUsable, listSenders } from "../senders/service"
import type { DeliverResult, OutgoingDocument, SubmissionJob } from "./contracts"
import { getOutgoingDocumentBytes } from "./compress"

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const SUBJECT_MAX = 500
const BODY_MAX = 20_000
const PREFIX_MAX = 80
const FUNDER_ID_MAX = 80

export const DEFAULT_SUBJECT_TEMPLATE = "{{legalName}} funding submission"
export const DEFAULT_BODY_TEMPLATE = `Hello,

Please find the attached submission package for {{legalName}} ({{displayId}}).

Requested amount: {{requestedAmount}}
Monthly revenue: {{monthlyRevenue}}
Industry: {{industry}}
Funder: {{funderName}}

Thank you.`

type EmailFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
let fetchOverride: EmailFetch | undefined
let productionForTests: boolean | undefined

export function setEmailDeliveryFetchForTests(fetchImpl?: EmailFetch): void {
  fetchOverride = fetchImpl
}

export function setSubmissionEmailProductionForTests(value?: boolean): void {
  productionForTests = value
}

export function isSubmissionEmailProduction(): boolean {
  return productionForTests ?? process.env.NODE_ENV === "production"
}

function http(): EmailFetch {
  return fetchOverride ?? globalThis.fetch
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

function isAdmin(actor: DealActor): boolean {
  return Boolean(actor.role && canManageWorkspace(actor.role))
}

function flag(value: unknown): boolean {
  return value === true || value === 1 || value === "1"
}

function systemActor(workspaceId: string, correlationId: string): DealActor {
  return {
    workspaceId,
    userId: null,
    membershipId: null,
    role: null,
    managedMembershipIds: [],
    activeMembershipIds: [],
    source: "system",
    correlationId,
  }
}

export interface SubmissionEmailTemplate {
  id: string
  workspaceId: string
  funderId: string | null
  subjectTemplate: string
  bodyTemplate: string
  prefix: string
  ccOriginator: boolean
  ccCloser: boolean
  updatedByUserId: string | null
  updatedAt: string
  persisted: boolean
}

export interface SubmissionEmailAttachment {
  documentId: string
  filename: string
  checksum: string
  byteLength: number
  category: string
  bytesBase64?: string
}

export interface RenderedSubmissionEmail {
  funderId: string
  funderName: string
  senderId: string
  fromName: string
  fromAddress: string
  to: string[]
  cc: string[]
  replyTo: string
  subject: string
  body: string
  workspacePrefix: string
  funderPrefix: string
  signature: string
  templateId?: string
  attachments: SubmissionEmailAttachment[]
}

export interface SubmissionEmailPreview extends RenderedSubmissionEmail {
  error?: string
}

export interface EmailAttemptSnapshot {
  to: string[]
  cc: string[]
  replyTo: string
  fromName: string
  fromAddress: string
  subject: string
  body: string
  attachments: Array<{ documentId: string; filename: string; checksum: string }>
  workspacePrefix: string
  funderPrefix: string
  signature: string
  templateId?: string
  senderId: string
}

export interface EmailAttemptRef {
  messageId: string
  threadId: string
  inReplyTo: string | null
  references: string[]
  delivery: "sent" | "preview" | "uncertain"
  snapshot: EmailAttemptSnapshot
}

export interface SubmissionEmailTemplateList {
  templates: SubmissionEmailTemplate[]
  funders: Array<{ id: string; legalName: string; nickname?: string }>
  defaults: { subjectTemplate: string; bodyTemplate: string }
  canManage: boolean
}

export interface UpsertSubmissionEmailTemplateInput {
  funderId?: unknown
  subjectTemplate?: unknown
  bodyTemplate?: unknown
  prefix?: unknown
  ccOriginator?: unknown
  ccCloser?: unknown
}

export interface PreviewSubmissionEmailsInput {
  dealId?: unknown
  funderIds?: unknown
  senderId?: unknown
}

export interface PreviewSubmissionEmailsResult {
  dealId: string
  delivery: "preview"
  providerReadiness?: string
  sender: { id: string; fromName: string; fromAddress: string }
  previews: SubmissionEmailPreview[]
  canManage: boolean
}

type TemplateRow = {
  id: string
  workspace_id: string
  funder_id: string | null
  subject_template: string
  body_template: string
  prefix: string | null
  cc_originator: number | string | boolean
  cc_closer: number | string | boolean
  updated_by_user_id: string | null
  updated_at: string
}

type AssignmentEmailRow = {
  kind: string
  email: string | null
}

type DocumentRow = {
  id: string
  display_filename: string
  checksum: string
  byte_length: number | string
  category: string
}

function mapTemplate(row: TemplateRow): SubmissionEmailTemplate {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    funderId: row.funder_id,
    subjectTemplate: row.subject_template,
    bodyTemplate: row.body_template,
    prefix: row.prefix?.trim() ?? "",
    ccOriginator: flag(row.cc_originator),
    ccCloser: flag(row.cc_closer),
    updatedByUserId: row.updated_by_user_id,
    updatedAt: row.updated_at,
    persisted: true,
  }
}

function workspaceDefault(workspaceId: string): SubmissionEmailTemplate {
  return {
    id: "workspace",
    workspaceId,
    funderId: null,
    subjectTemplate: DEFAULT_SUBJECT_TEMPLATE,
    bodyTemplate: DEFAULT_BODY_TEMPLATE,
    prefix: "",
    ccOriginator: false,
    ccCloser: false,
    updatedByUserId: null,
    updatedAt: "",
    persisted: false,
  }
}

function asRequiredText(value: unknown, field: string, fallback: string, max: number): string {
  if (value == null || value === "") return fallback
  if (typeof value !== "string") invalid(field, `Enter a valid ${field}.`)
  const next = value.trim()
  if (!next) invalid(field, `Enter a ${field}.`)
  if (next.length > max) invalid(field, `Use at most ${max} characters.`)
  return next
}

function asPrefix(value: unknown): string {
  if (value == null) return ""
  if (typeof value !== "string") invalid("prefix", "Enter a prefix as text.")
  const prefix = value.replace(/\s+/g, " ").trim()
  if (prefix.length > PREFIX_MAX) invalid("prefix", `Use at most ${PREFIX_MAX} characters.`)
  if (/[\r\n]/.test(value)) invalid("prefix", "Prefixes cannot contain line breaks.")
  return prefix
}

function asFunderId(value: unknown): string | null {
  if (value == null || value === "") return null
  if (typeof value !== "string") invalid("funderId", "Choose a funder or leave blank for the workspace default.")
  const next = value.trim()
  if (!next) return null
  if (next.length > FUNDER_ID_MAX) invalid("funderId", `Use at most ${FUNDER_ID_MAX} characters.`)
  return next
}

function asFunderIds(value: unknown): string[] | undefined {
  if (value == null) return undefined
  if (!Array.isArray(value)) invalid("funderIds", "Provide a list of funder IDs.")
  if (value.length === 0) invalid("funderIds", "Select at least one funder.")
  if (value.length > 200) invalid("funderIds", "Use at most 200 funders.")
  const seen = new Set<string>()
  const ids: string[] = []
  for (const [index, item] of value.entries()) {
    if (typeof item !== "string" || !item.trim()) invalid("funderIds", `Funder ${index + 1} is invalid.`)
    const id = item.trim()
    if (seen.has(id)) continue
    seen.add(id)
    ids.push(id)
  }
  return ids
}

function asSenderId(value: unknown): string | undefined {
  if (value == null || value === "") return undefined
  if (typeof value !== "string" || !value.trim()) invalid("senderId", "Choose a submission sender.")
  return value.trim()
}

function asDealId(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) invalid("dealId", "Choose a deal.")
  return value.trim()
}

function formatMoney(value: number | undefined): string {
  if (value == null || !Number.isFinite(value)) return ""
  return `$${value.toLocaleString("en-US", { maximumFractionDigits: 0 })}`
}

function dealFields(deal: DealRecord, workspaceName: string, funderName: string): Record<string, string> {
  return {
    legalName: deal.legalName?.trim() || "",
    dbaName: deal.dbaName?.trim() || "",
    displayId: deal.displayId,
    entityType: deal.entityType ?? "",
    industry: deal.industry?.trim() || "",
    naicsCode: deal.naicsCode?.trim() || "",
    monthlyRevenue: formatMoney(deal.monthlyRevenue),
    ficoScore: deal.ficoScore == null ? "" : String(deal.ficoScore),
    fundingPurpose: deal.fundingPurpose?.trim() || "",
    requestedAmount: formatMoney(deal.requestedAmount),
    contactName: deal.contactName?.trim() || "",
    status: deal.status,
    startDate: deal.startDate ?? "",
    city: deal.address?.city?.trim() || "",
    state: deal.address?.state?.trim() || "",
    workspaceName,
    funderName,
    funderLegalName: funderName,
  }
}

function renderTemplate(template: string, fields: Record<string, string>): string {
  return template.replace(/\{\{\s*([a-zA-Z][a-zA-Z0-9_]*)\s*\}\}/g, (_match, key: string) => fields[key] ?? "")
}

function applyPrefixes(subject: string, workspacePrefix: string, funderPrefix: string): string {
  const tokens = [workspacePrefix, funderPrefix].map((value) => value.replace(/\s+/g, " ").trim()).filter(Boolean)
  return tokens.length ? `${tokens.join(" ")} ${subject}`.trim() : subject
}

function applySignature(body: string, signature: string): string {
  const trimmed = body.replace(/\s+$/g, "")
  if (!signature.trim()) return trimmed
  return `${trimmed}\n\n${signature.trim()}`
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

function parseDestination(destination: string): string[] {
  return uniqueAddresses(destination.split(/[;,]/))
}

function messageIdFor(correlationId: string): string {
  return `<${correlationId}@submissions.mca.local>`
}

export function parseEmailAttemptRef(value: string | null | undefined): EmailAttemptRef | undefined {
  if (!value) return undefined
  try {
    const parsed = JSON.parse(value) as Partial<EmailAttemptRef>
    if (!parsed || typeof parsed !== "object" || typeof parsed.messageId !== "string" || !parsed.snapshot) return undefined
    return {
      messageId: parsed.messageId,
      threadId: typeof parsed.threadId === "string" ? parsed.threadId : parsed.messageId,
      inReplyTo: typeof parsed.inReplyTo === "string" ? parsed.inReplyTo : null,
      references: Array.isArray(parsed.references) ? parsed.references.filter((item): item is string => typeof item === "string") : [parsed.messageId],
      delivery: parsed.delivery === "sent" || parsed.delivery === "uncertain" ? parsed.delivery : "preview",
      snapshot: {
        to: Array.isArray(parsed.snapshot.to) ? parsed.snapshot.to.filter((item): item is string => typeof item === "string") : [],
        cc: Array.isArray(parsed.snapshot.cc) ? parsed.snapshot.cc.filter((item): item is string => typeof item === "string") : [],
        replyTo: typeof parsed.snapshot.replyTo === "string" ? parsed.snapshot.replyTo : "",
        fromName: typeof parsed.snapshot.fromName === "string" ? parsed.snapshot.fromName : "",
        fromAddress: typeof parsed.snapshot.fromAddress === "string" ? parsed.snapshot.fromAddress : "",
        subject: typeof parsed.snapshot.subject === "string" ? parsed.snapshot.subject : "",
        body: typeof parsed.snapshot.body === "string" ? parsed.snapshot.body : "",
        attachments: Array.isArray(parsed.snapshot.attachments)
          ? parsed.snapshot.attachments.flatMap((item) => {
            if (!item || typeof item !== "object") return []
            const row = item as { documentId?: unknown; filename?: unknown; checksum?: unknown }
            if (typeof row.documentId !== "string" || typeof row.filename !== "string" || typeof row.checksum !== "string") return []
            return [{ documentId: row.documentId, filename: row.filename, checksum: row.checksum }]
          })
          : [],
        workspacePrefix: typeof parsed.snapshot.workspacePrefix === "string" ? parsed.snapshot.workspacePrefix : "",
        funderPrefix: typeof parsed.snapshot.funderPrefix === "string" ? parsed.snapshot.funderPrefix : "",
        signature: typeof parsed.snapshot.signature === "string" ? parsed.snapshot.signature : "",
        templateId: typeof parsed.snapshot.templateId === "string" ? parsed.snapshot.templateId : undefined,
        senderId: typeof parsed.snapshot.senderId === "string" ? parsed.snapshot.senderId : "",
      },
    }
  } catch {
    return undefined
  }
}

function encodeExternalRef(ref: EmailAttemptRef): string {
  return JSON.stringify(ref)
}

function snapshotOf(rendered: RenderedSubmissionEmail): EmailAttemptSnapshot {
  return {
    to: [...rendered.to],
    cc: [...rendered.cc],
    replyTo: rendered.replyTo,
    fromName: rendered.fromName,
    fromAddress: rendered.fromAddress,
    subject: rendered.subject,
    body: rendered.body,
    attachments: rendered.attachments.map((item) => ({
      documentId: item.documentId,
      filename: item.filename,
      checksum: item.checksum,
    })),
    workspacePrefix: rendered.workspacePrefix,
    funderPrefix: rendered.funderPrefix,
    signature: rendered.signature,
    templateId: rendered.templateId,
    senderId: rendered.senderId,
  }
}

export function approvedEmailAttemptRef(job: SubmissionJob, correlationId: string): EmailAttemptRef | undefined {
  const approved = job.approvedPackage?.email
  if (!approved) return undefined
  const messageId = messageIdFor(correlationId)
  return { messageId, threadId: messageId, inReplyTo: null, references: [messageId], delivery: "uncertain", snapshot: snapshotOf(approved) }
}

function redactedPayload(rendered: RenderedSubmissionEmail, correlationId: string, messageId: string, job?: SubmissionJob) {
  return {
    template: "submission_email",
    correlationId,
    messageId,
    threadId: messageId,
    senderId: rendered.senderId,
    fromName: rendered.fromName,
    fromAddress: rendered.fromAddress,
    to: rendered.to,
    cc: rendered.cc,
    replyTo: rendered.replyTo,
    subject: rendered.subject,
    body: rendered.body,
    attachments: rendered.attachments.map((item) => ({
      documentId: item.documentId,
      filename: item.filename,
      checksum: item.checksum,
      byteLength: item.byteLength,
      ...(item.bytesBase64 ? { bytesBase64: item.bytesBase64 } : {}),
    })),
    jobId: job?.id,
    dealId: job?.dealId,
    funderId: rendered.funderId,
  }
}

async function findTemplate(workspaceId: string, funderId: string | null): Promise<SubmissionEmailTemplate | undefined> {
  const row = await db().prepare<TemplateRow>(
    `SELECT * FROM mca_submission_templates
     WHERE workspace_id = ? AND funder_id IS NOT DISTINCT FROM ?
     ORDER BY updated_at DESC, id DESC`,
  ).get(workspaceId, funderId)
  return row ? mapTemplate(row) : undefined
}

async function listTemplateRows(workspaceId: string): Promise<SubmissionEmailTemplate[]> {
  const rows = await db().prepare<TemplateRow>(
    `SELECT * FROM mca_submission_templates WHERE workspace_id = ? ORDER BY funder_id NULLS FIRST, updated_at DESC, id DESC`,
  ).all(workspaceId)
  const seen = new Set<string>()
  const templates: SubmissionEmailTemplate[] = []
  for (const row of rows) {
    const key = row.funder_id ?? ""
    if (seen.has(key)) continue
    seen.add(key)
    templates.push(mapTemplate(row))
  }
  return templates
}

function resolveTemplates(workspace: SubmissionEmailTemplate, funder?: SubmissionEmailTemplate) {
  return {
    subjectTemplate: (funder?.subjectTemplate.trim() || workspace.subjectTemplate.trim() || DEFAULT_SUBJECT_TEMPLATE),
    bodyTemplate: (funder?.bodyTemplate.trim() || workspace.bodyTemplate.trim() || DEFAULT_BODY_TEMPLATE),
    workspacePrefix: workspace.prefix,
    funderPrefix: funder?.prefix ?? "",
    ccOriginator: funder ? funder.ccOriginator : workspace.ccOriginator,
    ccCloser: funder ? funder.ccCloser : workspace.ccCloser,
    templateId: funder?.persisted ? funder.id : workspace.persisted ? workspace.id : undefined,
  }
}

async function loadWorkspaceName(workspaceId: string): Promise<string> {
  const row = await db().prepare<{ name: string }>("SELECT name FROM workspaces WHERE id = ?").get(workspaceId)
  return row?.name?.trim() || ""
}

async function loadAssignmentEmails(workspaceId: string, dealId: string): Promise<{ originator: string[]; closer: string[] }> {
  const rows = await db().prepare<AssignmentEmailRow>(
    `SELECT da.kind, u.email
     FROM deal_assignments da
     INNER JOIN memberships m ON m.id = da.membership_id
     INNER JOIN users u ON u.id = m.user_id
     WHERE da.workspace_id = ? AND da.deal_id = ? AND m.workspace_id = ? AND m.status = 'active'
     ORDER BY da.is_primary DESC, da.assigned_at ASC, da.id ASC`,
  ).all(workspaceId, dealId, workspaceId)
  const originator: string[] = []
  const closer: string[] = []
  for (const row of rows) {
    if (!row.email) continue
    if (row.kind === "originator") originator.push(row.email)
    if (row.kind === "closer") closer.push(row.email)
  }
  return { originator: uniqueAddresses(originator), closer: uniqueAddresses(closer) }
}

function attachmentsFor(
  documents: Array<{ id: string; filename: string; checksum: string; byteLength: number; category: string }>,
  route: Pick<FunderRoute, "documentExceptions">,
  includedIds?: string[],
): SubmissionEmailAttachment[] {
  const excluded = new Set(route.documentExceptions.map((item) => item.toLowerCase()))
  const included = includedIds ? new Set(includedIds) : undefined
  return documents
    .filter((document) => !excluded.has(document.category.toLowerCase()))
    .filter((document) => !included || included.has(document.id))
    .map((document) => ({
      documentId: document.id,
      filename: document.filename,
      checksum: document.checksum,
      byteLength: document.byteLength,
      category: document.category,
    }))
}

async function loadJobDocuments(job: SubmissionJob): Promise<Array<{ id: string; filename: string; checksum: string; byteLength: number; category: string }>> {
  const rows = await db().prepare<DocumentRow>(
    `SELECT id, display_filename, checksum, byte_length, category
     FROM mca_documents WHERE workspace_id = ? AND deal_id = ?`,
  ).all(job.workspaceId, job.dealId)
  const byId = new Map(rows.map((row) => [row.id, row]))
  return job.documentVersions.map((version) => {
    const row = byId.get(version.documentId)
    return {
      id: version.documentId,
      filename: row?.display_filename ?? version.documentId,
      checksum: version.checksum,
      byteLength: Number(row?.byte_length ?? 0),
      category: version.category,
    }
  })
}

async function attachmentsFromPackage(
  packaged: OutgoingDocument[],
  originals: Array<{ id: string; filename: string; checksum: string; byteLength: number; category: string }>,
): Promise<SubmissionEmailAttachment[]> {
  const byOriginal = new Map(originals.map((document) => [document.id, document]))
  const attachments: SubmissionEmailAttachment[] = []
  for (const document of packaged) {
    const meta = byOriginal.get(document.originalDocumentId)
    const bytes = await getOutgoingDocumentBytes(document)
    attachments.push({
      documentId: document.documentId,
      filename: meta?.filename ?? document.documentId,
      checksum: document.checksum,
      byteLength: bytes.byteLength,
      category: meta?.category ?? "other_stip",
      bytesBase64: Buffer.from(bytes).toString("base64"),
    })
  }
  return attachments
}

function summariesToAttachments(documents: DocumentSummary[]) {
  return documents.map((document) => ({
    id: document.id,
    filename: document.displayFilename,
    checksum: document.checksum,
    byteLength: document.byteLength,
    category: document.category,
  }))
}

async function renderEmail(input: {
  deal: DealRecord
  funderId: string
  funderName: string
  destination: string
  route: Pick<FunderRoute, "documentExceptions">
  documents: Array<{ id: string; filename: string; checksum: string; byteLength: number; category: string }>
  sender: EmailSender
  includedDocumentIds?: string[]
}): Promise<RenderedSubmissionEmail> {
  const to = parseDestination(input.destination)
  if (!to.length) {
    throw new AppError(422, "email_destination_invalid", "This funder does not have a valid email destination.")
  }
  const [workspaceTemplate, funderTemplate, workspaceName, assignmentEmails] = await Promise.all([
    findTemplate(input.deal.workspaceId, null),
    findTemplate(input.deal.workspaceId, input.funderId),
    loadWorkspaceName(input.deal.workspaceId),
    loadAssignmentEmails(input.deal.workspaceId, input.deal.id),
  ])
  const resolved = resolveTemplates(workspaceTemplate ?? workspaceDefault(input.deal.workspaceId), funderTemplate)
  const fields = dealFields(input.deal, workspaceName, input.funderName)
  const subject = applyPrefixes(renderTemplate(resolved.subjectTemplate, fields).trim() || DEFAULT_SUBJECT_TEMPLATE, resolved.workspacePrefix, resolved.funderPrefix)
  const signature = input.sender.signature?.trim() ?? ""
  const body = applySignature(renderTemplate(resolved.bodyTemplate, fields), signature)
  const blocked = new Set(to.map(normalizeEmail))
  const ccSource = [
    ...(resolved.ccOriginator ? assignmentEmails.originator : []),
    ...(resolved.ccCloser ? assignmentEmails.closer : []),
  ]
  const cc = uniqueAddresses(ccSource).filter((address) => !blocked.has(normalizeEmail(address)))
  return {
    funderId: input.funderId,
    funderName: input.funderName,
    senderId: input.sender.id,
    fromName: input.sender.fromName,
    fromAddress: input.sender.fromAddress,
    to,
    cc,
    replyTo: input.sender.fromAddress,
    subject,
    body,
    workspacePrefix: resolved.workspacePrefix,
    funderPrefix: resolved.funderPrefix,
    signature,
    templateId: resolved.templateId,
    attachments: attachmentsFor(input.documents, input.route, input.includedDocumentIds),
  }
}

async function resolvePreviewSender(actor: DealActor, senderId?: string): Promise<EmailSender> {
  if (senderId) return assertSenderUsable(actor, senderId, "submission")
  const listed = await listSenders(actor)
  const candidates = listed.senders.filter((sender) => sender.purpose === "submission" && sender.state === "verified" && sender.hasCredential)
  const preferred = candidates.find((sender) => sender.isDefault) ?? candidates[0]
  if (!preferred) {
    throw new AppError(409, "sender_not_usable", "Connect and verify a submission email sender before sending by email.")
  }
  return preferred
}

async function resolveJobSender(job: SubmissionJob): Promise<EmailSender> {
  const actor = systemActor(job.workspaceId, job.id)
  const stored = await listSendersByWorkspace(job.workspaceId)
  const candidates = stored.filter((sender) => sender.purpose === "submission" && sender.state === "verified" && sender.credentialCipher)
  const preferred = candidates.find((sender) => sender.isDefault) ?? candidates[0]
  if (!preferred) {
    throw new AppError(409, "sender_not_usable", "Connect and verify a submission email sender before sending by email.")
  }
  return assertSenderUsable(actor, preferred.id, "submission")
}

function failed(correlationId: string, errorCode: string, errorMessage: string): DeliverResult {
  return { ok: false, state: "failed", correlationId, errorCode, errorMessage }
}

function uncertain(correlationId: string, messageId: string, rendered: RenderedSubmissionEmail): DeliverResult {
  return { ...failed(correlationId, "delivery_uncertain", "Email delivery outcome is uncertain. Reconcile the provider receipt before another send."),
    externalRef: encodeExternalRef({ messageId, threadId: messageId, inReplyTo: null, references: [messageId], delivery: "uncertain", snapshot: snapshotOf(rendered) }) }
}

async function deliverRendered(rendered: RenderedSubmissionEmail, correlationId: string, job?: SubmissionJob): Promise<DeliverResult> {
  if (job) await (await import("../company-access")).assertCompanyOperational(job.workspaceId)
  if (job) await (await import("../outbound-approval")).assertOutboundDispatch(job.workspaceId, job.createdAt)
  const messageId = messageIdFor(correlationId)
  const webhook = process.env.MCA_EMAIL_WEBHOOK_URL?.trim()
  if (!webhook) {
    if (isSubmissionEmailProduction()) {
      return failed(correlationId, "email_delivery_unconfigured", "Email delivery is not configured for this deployment.")
    }
    const ref: EmailAttemptRef = {
      messageId,
      threadId: messageId,
      inReplyTo: null,
      references: [messageId],
      delivery: "preview",
      snapshot: snapshotOf(rendered),
    }
    return { ok: true, state: "sent", correlationId, externalRef: encodeExternalRef(ref) }
  }
  try {
    const response = await http()(webhook, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(process.env.MCA_EMAIL_WEBHOOK_TOKEN ? { authorization: `Bearer ${process.env.MCA_EMAIL_WEBHOOK_TOKEN}` } : {}),
        "x-correlation-id": correlationId,
        "message-id": messageId,
      },
      body: JSON.stringify(redactedPayload(rendered, correlationId, messageId, job)),
      signal: AbortSignal.timeout(10_000),
    })
    if (!response.ok) {
      if ((job?.approvedPackage || process.env.MCA_FUNDER_UNKNOWN_SEND_GUARD_ENABLED === "true") && (response.status === 408 || response.status >= 500)) {
        return uncertain(correlationId, messageId, rendered)
      }
      return failed(correlationId, "email_delivery_failed", "The email provider did not accept the submission message.")
    }
    const ref: EmailAttemptRef = {
      messageId,
      threadId: messageId,
      inReplyTo: null,
      references: [messageId],
      delivery: "sent",
      snapshot: snapshotOf(rendered),
    }
    return { ok: true, state: "sent", correlationId, externalRef: encodeExternalRef(ref) }
  } catch (error) {
    if (error instanceof AppError) return failed(correlationId, error.code, error.message)
    if (job?.approvedPackage || process.env.MCA_FUNDER_UNKNOWN_SEND_GUARD_ENABLED === "true") {
      return uncertain(correlationId, messageId, rendered)
    }
    return failed(correlationId, "email_delivery_failed", "The email provider did not accept the submission message.")
  }
}

export async function sendSubmissionEmail(job: SubmissionJob, packaged: OutgoingDocument[] = []): Promise<DeliverResult> {
  await (await import("./broker-approval")).assertBrokerApprovedDelivery(job)
  const reserved = job.approvedPackage || process.env.MCA_FUNDER_UNKNOWN_SEND_GUARD_ENABLED === "true"
    ? await db().prepare<{ correlation_id: string }>(`SELECT correlation_id FROM mca_submission_attempts
        WHERE workspace_id = ? AND job_id = ? AND attempt_key = ? AND state = 'sending'`).get(job.workspaceId, job.id, job.attemptKey)
    : undefined
  const correlationId = reserved?.correlation_id ?? newId()
  if (job.routeKind !== "email") {
    return failed(correlationId, "provider_unavailable", `Email transport for ${job.funderId} is not configured yet.`)
  }
  try {
    if (job.approvedPackage?.email) {
      const approved = job.approvedPackage.email
      const sender = await assertSenderUsable(systemActor(job.workspaceId, job.id), approved.senderId, "submission")
      if (sender.fromAddress !== approved.fromAddress) throw new AppError(409, "approved_sender_changed", "The approved sender changed. Prepare a new preview.")
      const attachments = await Promise.all(approved.attachments.map(async (attachment) => {
        const document = packaged.find((item) => item.documentId === attachment.documentId)
        if (!document) throw new AppError(409, "approved_package_changed", "An approved attachment is missing.")
        const bytes = await getOutgoingDocumentBytes(document)
        if (createHash("sha256").update(bytes).digest("hex") !== attachment.checksum) throw new AppError(409, "approved_package_changed", "The approved attachment changed. Prepare a new preview.")
        return { ...attachment, bytesBase64: Buffer.from(bytes).toString("base64") }
      }))
      return await deliverRendered({ ...approved, attachments }, correlationId, job)
    }
    const deal = await findDealById(job.workspaceId, job.dealId)
    if (!deal) return failed(correlationId, "deal_not_found", "The requested deal was not found.")
    const sender = await resolveJobSender(job)
    const documents = await loadJobDocuments(job)
    const rendered = await renderEmail({
      deal,
      funderId: job.funderId,
      funderName: job.displayFunderName,
      destination: job.route.destination,
      route: job.route,
      documents,
      sender,
      includedDocumentIds: packaged.length
        ? packaged.map((document) => document.originalDocumentId)
        : job.packageDocumentIds,
    })
    const attachments = packaged.length ? await attachmentsFromPackage(packaged, documents) : rendered.attachments
    return await deliverRendered({ ...rendered, attachments }, correlationId, job)
  } catch (error) {
    if (error instanceof AppError) return failed(correlationId, error.code, error.message)
    return failed(correlationId, "delivery_failed", "Email delivery failed.")
  }
}

export async function listSubmissionEmailTemplates(actor: DealActor): Promise<SubmissionEmailTemplateList> {
  const [templates, funders] = await Promise.all([
    listTemplateRows(actor.workspaceId),
    listFunders(actor),
  ])
  const hasWorkspace = templates.some((item) => item.funderId == null)
  return {
    templates: hasWorkspace ? templates : [workspaceDefault(actor.workspaceId), ...templates],
    funders: funders.filter((funder) => funder.routes.some((route) => route.active && route.kind === "email")).map((funder) => ({
      id: funder.id,
      legalName: funder.legalName,
      nickname: funder.nickname,
    })),
    defaults: { subjectTemplate: DEFAULT_SUBJECT_TEMPLATE, bodyTemplate: DEFAULT_BODY_TEMPLATE },
    canManage: isAdmin(actor),
  }
}

export async function upsertSubmissionEmailTemplate(actor: DealActor, input: UpsertSubmissionEmailTemplateInput): Promise<SubmissionEmailTemplate> {
  if (!isAdmin(actor)) denied("Only workspace administrators can manage submission email templates.")
  const funderId = asFunderId(input.funderId)
  if (funderId) await getFunder(actor, funderId)
  const current = await findTemplate(actor.workspaceId, funderId)
  const fallback = current ?? workspaceDefault(actor.workspaceId)
  const subjectTemplate = asRequiredText(input.subjectTemplate, "subjectTemplate", fallback.subjectTemplate, SUBJECT_MAX)
  const bodyTemplate = asRequiredText(input.bodyTemplate, "bodyTemplate", fallback.bodyTemplate, BODY_MAX)
  const prefix = input.prefix === undefined ? fallback.prefix : asPrefix(input.prefix)
  const ccOriginator = input.ccOriginator === undefined ? fallback.ccOriginator : Boolean(input.ccOriginator)
  const ccCloser = input.ccCloser === undefined ? fallback.ccCloser : Boolean(input.ccCloser)
  const now = nowIso()
  const id = current?.id && current.persisted ? current.id : newId()
  const row = current?.persisted
    ? await db().prepare<TemplateRow>(
      `UPDATE mca_submission_templates
       SET subject_template = ?, body_template = ?, prefix = ?, cc_originator = ?, cc_closer = ?, updated_by_user_id = ?, updated_at = ?
       WHERE id = ? AND workspace_id = ?
       RETURNING *`,
    ).get(subjectTemplate, bodyTemplate, prefix || null, ccOriginator ? 1 : 0, ccCloser ? 1 : 0, actor.userId, now, id, actor.workspaceId)
    : await db().prepare<TemplateRow>(
      `INSERT INTO mca_submission_templates
        (id, workspace_id, funder_id, subject_template, body_template, prefix, cc_originator, cc_closer, updated_by_user_id, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       RETURNING *`,
    ).get(id, actor.workspaceId, funderId, subjectTemplate, bodyTemplate, prefix || null, ccOriginator ? 1 : 0, ccCloser ? 1 : 0, actor.userId, now)
  const saved = row ? mapTemplate(row) : {
    id,
    workspaceId: actor.workspaceId,
    funderId,
    subjectTemplate,
    bodyTemplate,
    prefix,
    ccOriginator,
    ccCloser,
    updatedByUserId: actor.userId,
    updatedAt: now,
    persisted: true,
  }
  await recordAuditEvent({
    context: actor,
    action: "submission_email.template_updated",
    resourceType: "submission_template",
    resourceId: saved.id,
    metadata: { funderId: saved.funderId, ccOriginator: saved.ccOriginator, ccCloser: saved.ccCloser },
    correlationId: actor.correlationId,
  })
  return saved
}

function emailRoute(funder: FunderRecord): FunderRoute | undefined {
  return funder.routes.find((route) => route.active && route.kind === "email")
}

function displayFunderName(funder: FunderRecord): string {
  return funder.nickname?.trim() || funder.legalName
}

export async function previewSubmissionEmails(actor: DealActor, input: PreviewSubmissionEmailsInput): Promise<PreviewSubmissionEmailsResult> {
  const dealId = asDealId(input.dealId)
  const deal = await getDealForDocument(actor, dealId)
  const sender = await resolvePreviewSender(actor, asSenderId(input.senderId))
  const documents = summariesToAttachments(await listSubmissionDocuments(actor, deal.id))
  const requested = asFunderIds(input.funderIds)
  const funders = requested
    ? await Promise.all(requested.map(async (funderId) => {
      try {
        return await getFunder(actor, funderId)
      } catch (error) {
        if (error instanceof AppError && error.status === 404) return undefined
        throw error
      }
    }))
    : (await listFunders(actor)).filter((funder) => emailRoute(funder))
  const previews: SubmissionEmailPreview[] = []
  for (const [index, funder] of funders.entries()) {
    const funderId = requested?.[index] ?? funder?.id ?? ""
    if (!funder) {
      previews.push({
        funderId,
        funderName: "Unknown funder",
        senderId: sender.id,
        fromName: sender.fromName,
        fromAddress: sender.fromAddress,
        to: [],
        cc: [],
        replyTo: sender.fromAddress,
        subject: "",
        body: "",
        workspacePrefix: "",
        funderPrefix: "",
        signature: sender.signature?.trim() ?? "",
        attachments: [],
        error: "The requested funder was not found.",
      })
      continue
    }
    const route = emailRoute(funder)
    if (!route) {
      previews.push({
        funderId: funder.id,
        funderName: displayFunderName(funder),
        senderId: sender.id,
        fromName: sender.fromName,
        fromAddress: sender.fromAddress,
        to: [],
        cc: [],
        replyTo: sender.fromAddress,
        subject: "",
        body: "",
        workspacePrefix: "",
        funderPrefix: "",
        signature: sender.signature?.trim() ?? "",
        attachments: [],
        error: "This funder has no active email submission route.",
      })
      continue
    }
    try {
      previews.push(await renderEmail({
        deal,
        funderId: funder.id,
        funderName: displayFunderName(funder),
        destination: route.destination,
        route,
        documents,
        sender,
      }))
    } catch (error) {
      previews.push({
        funderId: funder.id,
        funderName: displayFunderName(funder),
        senderId: sender.id,
        fromName: sender.fromName,
        fromAddress: sender.fromAddress,
        to: [],
        cc: [],
        replyTo: sender.fromAddress,
        subject: "",
        body: "",
        workspacePrefix: "",
        funderPrefix: "",
        signature: sender.signature?.trim() ?? "",
        attachments: [],
        error: error instanceof AppError ? error.message : "This destination could not be previewed.",
      })
    }
  }
  return {
    dealId: deal.id,
    delivery: "preview",
    ...providerReadinessView({ kind: "email", destination: "" }),
    sender: { id: sender.id, fromName: sender.fromName, fromAddress: sender.fromAddress },
    previews,
    canManage: isAdmin(actor),
  }
}

export async function requireEmailTemplateAdmin(request: Request, mode: "read" | "write"): Promise<DealActor> {
  if (mode === "write") assertTrustedMutation(request)
  const auth = await requireMembershipAccess(request, ["admin", "super_admin"])
  return { ...await actorForDeals(auth), correlationId: requestCorrelationId(request) }
}

export async function requireEmailPreviewActor(request: Request): Promise<DealActor> {
  const auth = await requireWorkspaceAccess(request, { scopes: ["deals:read"] })
  return { ...await actorForDeals(auth), correlationId: requestCorrelationId(request) }
}

/** Render exactly the route and transformed attachments shown for approval, without delivery. */
export async function prepareApprovedSubmissionEmail(actor: DealActor, deal: DealRecord, funder: FunderRecord, route: FunderRoute, documents: DocumentSummary[], packaged: OutgoingDocument[]): Promise<RenderedSubmissionEmail> {
  const originals = summariesToAttachments(documents)
  const rendered = await renderEmail({ deal, funderId: funder.id, funderName: displayFunderName(funder), destination: route.destination, route, documents: originals, sender: await resolvePreviewSender(actor) })
  const attachments = await attachmentsFromPackage(packaged, originals)
  return { ...rendered, attachments: attachments.map((attachment) => ({ documentId: attachment.documentId, filename: attachment.filename, checksum: attachment.checksum, byteLength: attachment.byteLength, category: attachment.category })) }
}
