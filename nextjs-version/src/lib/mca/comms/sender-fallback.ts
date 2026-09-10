import "server-only"

import { z } from "zod"
import { assertTrustedMutation, consumeRequestRateLimit, clientRateKey, requireWorkspaceAccess } from "../auth"
import { getDatabase, newId, nowIso, parseJson, recordAuditEvent, withImmediateTransaction } from "../db"
import type { DealActor, DealRecord } from "../deals/schema"
import { actorForDeals, getDealForDocument } from "../deals/service"
import { AppError } from "../errors"
import { requestCorrelationId } from "../http"
import { canManageWorkspace } from "../policy"
import type { SenderPurpose, SenderState } from "../senders/contracts"
import { toPublicSender, listSendersByWorkspace, type StoredEmailSender } from "../senders/repository"

export const FOLLOWUP_SENDER_MODES = ["workspace_shared", "originator"] as const
export type FollowupSenderMode = (typeof FOLLOWUP_SENDER_MODES)[number]

export const FOLLOWUP_SENDER_REASONS = [
  "sender_unavailable",
  "originator_disconnected",
  "originator_missing",
  "fallback_unavailable",
  "fallback_unverified",
  "deal_required",
  "deal_not_found",
] as const
export type FollowupSenderReason = (typeof FOLLOWUP_SENDER_REASONS)[number]

export const SENDER_FALLBACK_COPY = {
  loading: "Loading follow-up sender settings…",
  empty: "No merchant or fallback senders yet. Connect a verified fallback sender before follow-ups can send.",
  modeRequired: "Choose workspace-shared or each deal's originator.",
  ccInvalid: "Enter valid CC email addresses.",
  ccLimit: "Remove extra CC addresses. 25 is the maximum.",
  saved: "Follow-up sender settings saved.",
  failed: "Follow-up sender settings could not be saved.",
  previewFailed: "This follow-up sender could not be previewed.",
  senderUnavailable: "Neither the originator's merchant-facing sender nor the workspace fallback sender is connected and verified.",
  fallbackOnce: "The originator sender is unavailable. This follow-up will send once from the verified fallback sender.",
  workspaceShared: "Workspace-shared follow-ups send from the verified fallback sender.",
  originatorMode: "Follow-ups send from the deal originator's merchant-facing sender when it is connected and verified.",
  bccHint: "BCC on reminder emails goes to the fallback sender address, not submission rep-copy recipients.",
  ccHint: "Template CC addresses are independent from submission originator/closer copy settings.",
} as const

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const ID_MAX = 80
const CC_MAX = 25
const MODE_ENUM = FOLLOWUP_SENDER_MODES as unknown as [FollowupSenderMode, ...FollowupSenderMode[]]

const SETTINGS_DDL = `CREATE TABLE IF NOT EXISTS mca_followup_sender_settings (
  workspace_id text PRIMARY KEY,
  id text NOT NULL,
  sender_mode text NOT NULL,
  bcc_fallback integer NOT NULL DEFAULT 0,
  created_at text NOT NULL,
  updated_at text NOT NULL,
  updated_by_user_id text
)`

const COPY_DDL = `CREATE TABLE IF NOT EXISTS mca_followup_template_copy (
  workspace_id text NOT NULL,
  template_id text NOT NULL,
  cc_emails text NOT NULL DEFAULT '[]',
  created_at text NOT NULL,
  updated_at text NOT NULL,
  PRIMARY KEY (workspace_id, template_id)
)`

type SettingsRow = {
  workspace_id: string
  id: string
  sender_mode: string
  bcc_fallback: number | string
  created_at: string
  updated_at: string
  updated_by_user_id: string | null
}

type CopyRow = {
  workspace_id: string
  template_id: string
  cc_emails: string
  created_at: string
  updated_at: string
}

type TemplateRow = {
  id: string
  name: string
  channel: string
  scope: string
}

export interface FollowupSenderSettingsView {
  id: string
  workspaceId: string
  senderMode: FollowupSenderMode
  bccFallback: boolean
  persisted: boolean
  createdAt: string
  updatedAt: string
}

export interface FollowupTemplateCopyView {
  templateId: string
  name: string
  channel: string
  scope: string
  ccEmails: string[]
}

export interface FollowupSenderPublic {
  id: string
  purpose: SenderPurpose
  fromName: string
  fromAddress: string
  state: SenderState
  isDefault: boolean
  memberIds: string[]
  hasCredential: boolean
}

export interface FollowupSenderCatalog {
  settings: FollowupSenderSettingsView
  senders: {
    merchant: FollowupSenderPublic[]
    fallback: FollowupSenderPublic[]
    submission: FollowupSenderPublic[]
  }
  templates: FollowupTemplateCopyView[]
  copy: typeof SENDER_FALLBACK_COPY
  canManage: boolean
  submissionRepCopyIndependent: true
}

export interface FollowupSenderResolution {
  mode: "preview"
  ok: boolean
  success: boolean
  wouldSend: boolean
  reason?: FollowupSenderReason
  problem?: string
  originatorProblem?: string
  fallbackProblem?: string
  senderMode: FollowupSenderMode
  source?: "originator" | "fallback" | "workspace"
  usedFallback: boolean
  fallbackAttempts: 0 | 1
  sender?: FollowupSenderPublic
  fromName?: string
  fromAddress?: string
  cc: string[]
  bcc: string[]
  ccSource: "template"
  bccSource: "fallback" | "none"
  templateId?: string
  dealId?: string
  originatorMembershipId?: string
  settingsId: string
  correlationId: string
}

const templateCopySchema = z.object({
  templateId: z.string().trim().min(1).max(ID_MAX),
  ccEmails: z.union([z.array(z.string()), z.string()]).optional(),
}).strict()

export const senderFallbackPatchSchema = z.object({
  senderMode: z.enum(MODE_ENUM).optional(),
  bccFallback: z.boolean().optional(),
  templates: z.array(templateCopySchema).optional(),
}).strict()

export const senderFallbackPreviewSchema = z.object({
  dealId: z.string().trim().min(1).max(ID_MAX).optional(),
  templateId: z.string().trim().min(1).max(ID_MAX).optional(),
  originatorMembershipId: z.string().trim().min(1).max(ID_MAX).optional(),
}).strict()

let ensurePromise: Promise<void> | undefined

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

async function ensureTables(): Promise<void> {
  if (!ensurePromise) {
    ensurePromise = (async () => {
      await db().execute(SETTINGS_DDL)
      await db().execute(COPY_DDL)
    })().catch((error) => {
      ensurePromise = undefined
      throw error
    })
  }
  await ensurePromise
}

function asMode(value: unknown): FollowupSenderMode {
  if (value !== "workspace_shared" && value !== "originator") {
    invalid("senderMode", SENDER_FALLBACK_COPY.modeRequired)
  }
  return value
}

function normalizeEmail(value: string): string {
  return value.trim().toLowerCase()
}

function parseCcEmails(value: unknown, field = "ccEmails"): string[] {
  const raw = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(/[,;\n]+/)
      : value == null
        ? []
        : invalid(field, SENDER_FALLBACK_COPY.ccInvalid)
  const emails: string[] = []
  const seen = new Set<string>()
  for (const item of raw) {
    if (typeof item !== "string") invalid(field, SENDER_FALLBACK_COPY.ccInvalid)
    const email = item.trim()
    if (!email) continue
    if (!EMAIL_PATTERN.test(email) || email.length > 320) invalid(field, SENDER_FALLBACK_COPY.ccInvalid)
    const key = normalizeEmail(email)
    if (seen.has(key)) continue
    seen.add(key)
    emails.push(email)
  }
  if (emails.length > CC_MAX) invalid(field, SENDER_FALLBACK_COPY.ccLimit)
  return emails
}

function defaultSettings(workspaceId: string): FollowupSenderSettingsView {
  return {
    id: `followup-sender:${workspaceId}`,
    workspaceId,
    senderMode: "originator",
    bccFallback: false,
    persisted: false,
    createdAt: "",
    updatedAt: "",
  }
}

function mapSettings(row: SettingsRow): FollowupSenderSettingsView {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    senderMode: row.sender_mode === "workspace_shared" ? "workspace_shared" : "originator",
    bccFallback: Number(row.bcc_fallback) === 1,
    persisted: true,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function publicSender(record: StoredEmailSender): FollowupSenderPublic {
  const published = toPublicSender(record)
  return {
    id: published.id,
    purpose: published.purpose,
    fromName: published.fromName,
    fromAddress: published.fromAddress,
    state: published.state,
    isDefault: published.isDefault,
    memberIds: [...published.memberIds],
    hasCredential: published.hasCredential,
  }
}

function isUsable(sender: StoredEmailSender | undefined): sender is StoredEmailSender {
  return Boolean(sender && sender.state === "verified" && sender.credentialCipher)
}

function senderProblem(sender: StoredEmailSender | undefined, kind: "originator" | "fallback"): string | undefined {
  const label = kind === "originator" ? "originator's merchant-facing sender" : "workspace fallback sender"
  if (!sender) return kind === "originator" ? "The originator has no merchant-facing email sender." : "No verified fallback sender is connected."
  if (sender.state === "revoked") return `The ${label} was revoked.`
  if (sender.state === "expired") return `The ${label} expired.`
  if (sender.state === "pending" || !sender.credentialCipher || sender.state !== "verified") {
    return `The ${label} is not verified.`
  }
  return undefined
}

function originatorMembershipIds(deal: DealRecord | undefined, explicit?: string): string[] {
  if (explicit?.trim()) return [explicit.trim()]
  if (!deal) return []
  const originators = deal.assignments.filter((item) => item.kind === "originator")
  const ordered = [
    ...originators.filter((item) => item.isPrimary),
    ...originators.filter((item) => !item.isPrimary),
  ]
  return [...new Set(ordered.map((item) => item.membershipId))]
}

function pickAssignedMerchant(senders: StoredEmailSender[], membershipIds: string[]): StoredEmailSender | undefined {
  if (!membershipIds.length) return undefined
  const merchants = senders.filter((sender) => sender.purpose === "merchant")
  for (const membershipId of membershipIds) {
    const matched = merchants.filter((sender) => sender.memberIds.includes(membershipId))
    const preferred = matched.find((sender) => sender.isDefault) ?? matched[0]
    if (preferred) return preferred
  }
  return undefined
}

function pickFallback(senders: StoredEmailSender[]): StoredEmailSender | undefined {
  const matched = senders.filter((sender) => sender.purpose === "fallback")
  return matched.find((sender) => sender.isDefault) ?? matched[0]
}

function uniqueAddresses(values: string[]): string[] {
  const seen = new Set<string>()
  const next: string[] = []
  for (const value of values) {
    const email = value.trim()
    if (!email || !EMAIL_PATTERN.test(email)) continue
    const key = normalizeEmail(email)
    if (seen.has(key)) continue
    seen.add(key)
    next.push(email)
  }
  return next
}

export function senderFallbackGate(input: {
  loading: boolean
  merchantCount: number
  fallbackCount: number
  senderMode?: string
  ccEmails?: string[]
  previewOk?: boolean
  previewReason?: string
}): { phase: "loading" | "empty" | "validation" | "ready" | "failure"; saveEnabled: boolean; reason: string } {
  if (input.loading) return { phase: "loading", saveEnabled: false, reason: SENDER_FALLBACK_COPY.loading }
  if (!input.merchantCount && !input.fallbackCount) {
    return { phase: "empty", saveEnabled: false, reason: SENDER_FALLBACK_COPY.empty }
  }
  if (input.senderMode && input.senderMode !== "workspace_shared" && input.senderMode !== "originator") {
    return { phase: "validation", saveEnabled: false, reason: SENDER_FALLBACK_COPY.modeRequired }
  }
  if (input.ccEmails?.some((email) => email.trim() && !EMAIL_PATTERN.test(email.trim()))) {
    return { phase: "validation", saveEnabled: false, reason: SENDER_FALLBACK_COPY.ccInvalid }
  }
  if (input.previewOk === false && (input.previewReason === "sender_unavailable" || input.previewReason === "fallback_unavailable" || input.previewReason === "fallback_unverified")) {
    return { phase: "failure", saveEnabled: true, reason: SENDER_FALLBACK_COPY.senderUnavailable }
  }
  return { phase: "ready", saveEnabled: true, reason: SENDER_FALLBACK_COPY.saved }
}

async function loadSettingsRow(workspaceId: string): Promise<SettingsRow | undefined> {
  await ensureTables()
  return db().prepare<SettingsRow>("SELECT * FROM mca_followup_sender_settings WHERE workspace_id=?").get(workspaceId)
}

async function loadCopyRows(workspaceId: string): Promise<CopyRow[]> {
  await ensureTables()
  return db().prepare<CopyRow>("SELECT * FROM mca_followup_template_copy WHERE workspace_id=? ORDER BY template_id").all(workspaceId)
}

async function loadTemplates(workspaceId: string): Promise<TemplateRow[]> {
  return db().prepare<TemplateRow>(
    `SELECT id, name, channel, scope FROM mca_message_templates
     WHERE workspace_id=? AND scope IN ('merchant', 'followup', 'request_info')
     ORDER BY name ASC, channel ASC, id ASC`,
  ).all(workspaceId)
}

export async function getFollowupSenderSettings(actor: DealActor): Promise<FollowupSenderSettingsView> {
  const row = await loadSettingsRow(actor.workspaceId)
  return row ? mapSettings(row) : defaultSettings(actor.workspaceId)
}

async function persistSettings(actor: DealActor, patch: { senderMode?: FollowupSenderMode; bccFallback?: boolean }): Promise<FollowupSenderSettingsView> {
  await ensureTables()
  const now = nowIso()
  return withImmediateTransaction(async (database) => {
    const existing = await database.prepare<SettingsRow>("SELECT * FROM mca_followup_sender_settings WHERE workspace_id=? FOR UPDATE").get(actor.workspaceId)
    const senderMode = patch.senderMode ?? (existing ? mapSettings(existing).senderMode : "originator")
    const bccFallback = patch.bccFallback ?? (existing ? Number(existing.bcc_fallback) === 1 : false)
    if (existing) {
      const updated = await database.prepare<SettingsRow>(
        `UPDATE mca_followup_sender_settings
         SET sender_mode=?, bcc_fallback=?, updated_at=?, updated_by_user_id=?
         WHERE workspace_id=? AND id=?
         RETURNING *`,
      ).get(senderMode, bccFallback ? 1 : 0, now, actor.userId, actor.workspaceId, existing.id)
      return mapSettings(updated ?? { ...existing, sender_mode: senderMode, bcc_fallback: bccFallback ? 1 : 0, updated_at: now })
    }
    const id = newId()
    const inserted = await database.prepare<SettingsRow>(
      `INSERT INTO mca_followup_sender_settings
        (workspace_id, id, sender_mode, bcc_fallback, created_at, updated_at, updated_by_user_id)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (workspace_id) DO UPDATE SET
         sender_mode=excluded.sender_mode,
         bcc_fallback=excluded.bcc_fallback,
         updated_at=excluded.updated_at,
         updated_by_user_id=excluded.updated_by_user_id
       RETURNING *`,
    ).get(actor.workspaceId, id, senderMode, bccFallback ? 1 : 0, now, now, actor.userId)
    return mapSettings(inserted ?? {
      workspace_id: actor.workspaceId,
      id,
      sender_mode: senderMode,
      bcc_fallback: bccFallback ? 1 : 0,
      created_at: now,
      updated_at: now,
      updated_by_user_id: actor.userId,
    })
  })
}

async function persistTemplateCopy(actor: DealActor, templateId: string, ccEmails: string[]): Promise<void> {
  await ensureTables()
  const now = nowIso()
  await db().prepare(
    `INSERT INTO mca_followup_template_copy (workspace_id, template_id, cc_emails, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (workspace_id, template_id) DO UPDATE SET
       cc_emails=excluded.cc_emails,
       updated_at=excluded.updated_at`,
  ).run(actor.workspaceId, templateId, JSON.stringify(ccEmails), now, now)
}

export async function listFollowupSenderCatalog(actor: DealActor): Promise<FollowupSenderCatalog> {
  if (!isAdmin(actor)) denied()
  const [settings, senders, templates, copyRows] = await Promise.all([
    getFollowupSenderSettings(actor),
    listSendersByWorkspace(actor.workspaceId),
    loadTemplates(actor.workspaceId),
    loadCopyRows(actor.workspaceId),
  ])
  const copyByTemplate = new Map(copyRows.map((row) => [row.template_id, uniqueAddresses(parseJson<string[]>(row.cc_emails, []))]))
  return {
    settings,
    senders: {
      merchant: senders.filter((sender) => sender.purpose === "merchant").map(publicSender),
      fallback: senders.filter((sender) => sender.purpose === "fallback").map(publicSender),
      submission: senders.filter((sender) => sender.purpose === "submission").map(publicSender),
    },
    templates: templates.map((template) => ({
      templateId: template.id,
      name: template.name,
      channel: template.channel,
      scope: template.scope,
      ccEmails: copyByTemplate.get(template.id) ?? [],
    })),
    copy: SENDER_FALLBACK_COPY,
    canManage: isAdmin(actor) && actor.source === "user",
    submissionRepCopyIndependent: true,
  }
}

export async function updateFollowupSenderSettings(
  actor: DealActor,
  input: z.infer<typeof senderFallbackPatchSchema>,
): Promise<FollowupSenderCatalog> {
  if (!isAdmin(actor) || actor.source !== "user") denied()
  const senderMode = input.senderMode !== undefined ? asMode(input.senderMode) : undefined
  const templates = input.templates ?? []
  if (templates.length) {
    const known = new Set((await loadTemplates(actor.workspaceId)).map((row) => row.id))
    for (const [index, item] of templates.entries()) {
      if (!known.has(item.templateId)) invalid(`templates.${index}.templateId`, "Choose a merchant or follow-up template in this workspace.")
      parseCcEmails(item.ccEmails, `templates.${index}.ccEmails`)
    }
  }
  const saved = await persistSettings(actor, { senderMode, bccFallback: input.bccFallback })
  for (const [index, item] of templates.entries()) {
    await persistTemplateCopy(actor, item.templateId, parseCcEmails(item.ccEmails, `templates.${index}.ccEmails`))
  }
  await recordAuditEvent({
    context: actor,
    action: "followup.sender_settings_updated",
    resourceType: "followup_sender_settings",
    resourceId: saved.id,
    metadata: {
      senderMode: saved.senderMode,
      bccFallback: saved.bccFallback,
      templateCount: templates.length,
      submissionRepCopyIndependent: true,
    },
    correlationId: actor.correlationId,
  })
  return listFollowupSenderCatalog(actor)
}

async function templateCc(workspaceId: string, templateId: string | undefined): Promise<string[]> {
  if (!templateId) return []
  await ensureTables()
  const row = await db().prepare<CopyRow>(
    "SELECT * FROM mca_followup_template_copy WHERE workspace_id=? AND template_id=?",
  ).get(workspaceId, templateId)
  return uniqueAddresses(parseJson<string[]>(row?.cc_emails, []))
}

function failResolution(base: Omit<FollowupSenderResolution, "ok" | "success" | "wouldSend" | "usedFallback" | "fallbackAttempts" | "cc" | "bcc" | "ccSource" | "bccSource" | "mode"> & {
  cc?: string[]
  bcc?: string[]
  usedFallback?: boolean
  fallbackAttempts?: 0 | 1
}): FollowupSenderResolution {
  return {
    mode: "preview",
    ok: false,
    success: false,
    wouldSend: false,
    usedFallback: base.usedFallback ?? false,
    fallbackAttempts: base.fallbackAttempts ?? 0,
    cc: base.cc ?? [],
    bcc: base.bcc ?? [],
    ccSource: "template",
    bccSource: (base.bcc?.length ? "fallback" : "none"),
    ...base,
  }
}

/**
 * Choose one merchant-facing follow-up sender. Originator mode tries the deal
 * originator's merchant sender, then the verified fallback exactly once.
 * Workspace-shared mode uses only the verified fallback. Submission senders
 * and submission rep-copy CC are never consulted.
 */
export async function resolveFollowupSender(
  actor: DealActor,
  input: {
    dealId?: string
    templateId?: string
    originatorMembershipId?: string
  } = {},
): Promise<FollowupSenderResolution> {
  const correlationId = actor.correlationId || newId()
  const settings = await getFollowupSenderSettings(actor)
  const senders = await listSendersByWorkspace(actor.workspaceId)
  const cc = await templateCc(actor.workspaceId, input.templateId)
  const fallbackRecord = pickFallback(senders)
  const fallbackUsable = isUsable(fallbackRecord) ? fallbackRecord : undefined
  const fallbackProblem = senderProblem(fallbackRecord, "fallback")
  const bcc = settings.bccFallback && fallbackRecord?.fromAddress ? uniqueAddresses([fallbackRecord.fromAddress]) : []
  const bccSource = bcc.length ? "fallback" as const : "none" as const

  let deal: DealRecord | undefined
  if (input.dealId) {
    try {
      deal = await getDealForDocument(actor, input.dealId)
    } catch (error) {
      if (error instanceof AppError && error.code === "deal_not_found") {
        return failResolution({
          reason: "deal_not_found",
          problem: "The requested deal was not found.",
          senderMode: settings.senderMode,
          templateId: input.templateId,
          dealId: input.dealId,
          settingsId: settings.id,
          correlationId,
          cc,
          bcc,
        })
      }
      throw error
    }
  }

  const membershipIds = originatorMembershipIds(deal, input.originatorMembershipId)
  const originatorRecord = pickAssignedMerchant(senders, membershipIds)
  const originatorUsable = isUsable(originatorRecord) ? originatorRecord : undefined
  let originatorProblem: string | undefined
  if (settings.senderMode === "originator") {
    if (!input.dealId && !input.originatorMembershipId) originatorProblem = "Choose a deal to preview the originator's merchant-facing sender."
    else if (!membershipIds.length) originatorProblem = "This deal has no originator assignment."
    else originatorProblem = senderProblem(originatorRecord, "originator")
  }

  const base = {
    senderMode: settings.senderMode,
    originatorProblem,
    fallbackProblem,
    templateId: input.templateId,
    dealId: deal?.id ?? input.dealId,
    originatorMembershipId: membershipIds[0],
    settingsId: settings.id,
    correlationId,
    cc,
    bcc,
  }

  if (settings.senderMode === "workspace_shared") {
    if (!fallbackUsable) {
      return failResolution({
        ...base,
        reason: fallbackRecord ? "fallback_unverified" : "fallback_unavailable",
        problem: fallbackProblem ?? SENDER_FALLBACK_COPY.senderUnavailable,
      })
    }
    const sender = publicSender(fallbackUsable)
    return {
      mode: "preview",
      ok: true,
      success: true,
      wouldSend: true,
      senderMode: settings.senderMode,
      source: "workspace",
      usedFallback: false,
      fallbackAttempts: 0,
      sender,
      fromName: sender.fromName,
      fromAddress: sender.fromAddress,
      originatorProblem,
      fallbackProblem: undefined,
      cc,
      bcc,
      ccSource: "template",
      bccSource,
      templateId: input.templateId,
      dealId: deal?.id ?? input.dealId,
      originatorMembershipId: membershipIds[0],
      settingsId: settings.id,
      correlationId,
    }
  }

  if (!input.dealId && !input.originatorMembershipId) {
    return failResolution({
      ...base,
      reason: "deal_required",
      problem: "Choose a deal to preview the originator's merchant-facing sender.",
    })
  }

  if (originatorUsable) {
    const sender = publicSender(originatorUsable)
    return {
      mode: "preview",
      ok: true,
      success: true,
      wouldSend: true,
      senderMode: settings.senderMode,
      source: "originator",
      usedFallback: false,
      fallbackAttempts: 0,
      sender,
      fromName: sender.fromName,
      fromAddress: sender.fromAddress,
      originatorProblem: undefined,
      fallbackProblem,
      cc,
      bcc,
      ccSource: "template",
      bccSource,
      templateId: input.templateId,
      dealId: deal?.id ?? input.dealId,
      originatorMembershipId: membershipIds[0],
      settingsId: settings.id,
      correlationId,
    }
  }

  if (fallbackUsable) {
    const sender = publicSender(fallbackUsable)
    return {
      mode: "preview",
      ok: true,
      success: true,
      wouldSend: true,
      reason: originatorProblem ? "originator_disconnected" : undefined,
      problem: SENDER_FALLBACK_COPY.fallbackOnce,
      senderMode: settings.senderMode,
      source: "fallback",
      usedFallback: true,
      fallbackAttempts: 1,
      sender,
      fromName: sender.fromName,
      fromAddress: sender.fromAddress,
      originatorProblem,
      fallbackProblem: undefined,
      cc,
      bcc,
      ccSource: "template",
      bccSource,
      templateId: input.templateId,
      dealId: deal?.id ?? input.dealId,
      originatorMembershipId: membershipIds[0],
      settingsId: settings.id,
      correlationId,
    }
  }

  const originatorReason: FollowupSenderReason = !membershipIds.length || !originatorRecord
    ? "originator_missing"
    : "originator_disconnected"
  const fallbackReason: FollowupSenderReason = fallbackRecord ? "fallback_unverified" : "fallback_unavailable"
  return failResolution({
    ...base,
    reason: "sender_unavailable",
    problem: [originatorProblem, fallbackProblem].filter(Boolean).join(" ") || SENDER_FALLBACK_COPY.senderUnavailable,
    originatorProblem: originatorProblem ?? originatorReason,
    fallbackProblem: fallbackProblem ?? fallbackReason,
  })
}

export async function previewFollowupSender(
  actor: DealActor,
  input: z.infer<typeof senderFallbackPreviewSchema>,
): Promise<FollowupSenderResolution> {
  if (!isAdmin(actor)) denied()
  return resolveFollowupSender(actor, input)
}

export async function requireSenderFallbackAdmin(request: Request): Promise<DealActor> {
  assertTrustedMutation(request)
  const auth = await requireWorkspaceAccess(request, { sessionOnly: true, roles: ["admin", "super_admin"] })
  await consumeRequestRateLimit(clientRateKey(request, `sender-fallback-write:${auth.workspaceId}`), 30)
  return { ...await actorForDeals(auth), correlationId: requestCorrelationId(request) }
}

export async function requireSenderFallbackRead(request: Request): Promise<DealActor> {
  const auth = await requireWorkspaceAccess(request, { sessionOnly: true, roles: ["admin", "super_admin"] })
  return { ...await actorForDeals(auth), correlationId: requestCorrelationId(request) }
}
