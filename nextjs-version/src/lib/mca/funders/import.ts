import "server-only"

import { createHash } from "node:crypto"
import { assertTrustedMutation, requireWorkspaceAccess } from "../auth"
import { actorForDeals } from "../deals/service"
import type { DealActor } from "../deals/schema"
import { newId, recordAuditEvent, withImmediateTransaction, type DbExecutor } from "../db"
import { AppError } from "../errors"
import { requestCorrelationId } from "../http"
import { parseSpreadsheet } from "../imports/parser"
import { canManageWorkspace } from "../policy"
import {
  normalizeEligibilityRules,
  publishFunderCriteria,
  type EligibilityRuleInput,
} from "./criteria"
import {
  createFunder,
  funderDomainKey,
  funderIdentityKey,
  listFunders,
  validateCreateFunderInput,
  type CreateFunderInput,
  type FunderContactInput,
  type FunderRouteInput,
} from "./directory"
import { findFunderByIdempotencyKey } from "./directory-repository"
import type {
  FunderImportCommitResult,
  FunderImportDraft,
  FunderImportDuplicate,
  FunderImportPreview,
  FunderImportPreviewRow,
  FunderRecord,
} from "./contracts"

const MAX_IMPORT_ROWS = 200
const MAX_IMPORT_BYTES = 1_048_576
const PREVIEW_IDEMPOTENCY = "funder-import-preview"

const HEADER_ALIASES: Record<string, keyof MappedRow> = {
  legalname: "legalName",
  legal_name: "legalName",
  "legal name": "legalName",
  name: "legalName",
  funder: "legalName",
  fundername: "legalName",
  "funder name": "legalName",
  nickname: "nickname",
  dba: "nickname",
  website: "website",
  url: "website",
  site: "website",
  domains: "domains",
  domain: "domains",
  products: "products",
  product: "products",
  active: "active",
  status: "active",
  contactname: "contactName",
  contact_name: "contactName",
  "contact name": "contactName",
  contactemail: "contactEmail",
  contact_email: "contactEmail",
  "contact email": "contactEmail",
  email: "contactEmail",
  contactphone: "contactPhone",
  contact_phone: "contactPhone",
  "contact phone": "contactPhone",
  phone: "contactPhone",
  contactrole: "contactRole",
  contact_role: "contactRole",
  "contact role": "contactRole",
  role: "contactRole",
  criteria: "criteria",
  rules: "criteria",
  eligibility: "criteria",
}

type MappedRow = {
  legalName?: string
  nickname?: string
  website?: string
  domains?: string
  products?: string
  active?: string
  contactName?: string
  contactEmail?: string
  contactPhone?: string
  contactRole?: string
  criteria?: string
}

function assertManage(actor: DealActor): void {
  if (!actor.role || !canManageWorkspace(actor.role)) {
    throw new AppError(403, "permission_denied", "You do not have permission to perform this action.")
  }
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : ""
}

function splitList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((item) => text(item)).filter(Boolean)
  return text(value).split(/[,;]/).map((item) => item.trim()).filter(Boolean)
}

function parseActive(value: unknown, fallback = true): boolean {
  if (value === undefined || value === null || text(value) === "") return fallback
  if (typeof value === "boolean") return value
  const normalized = text(value).toLowerCase()
  if (["true", "yes", "1", "active"].includes(normalized)) return true
  if (["false", "no", "0", "inactive"].includes(normalized)) return false
  throw new AppError(422, "validation_failed", "Review the highlighted fields.", { active: ["Use true, false, active, or inactive."] })
}

function parseCriteria(value: unknown): EligibilityRuleInput[] | undefined {
  if (value === undefined || value === null || value === "") return undefined
  if (Array.isArray(value)) return value as EligibilityRuleInput[]
  const raw = text(value)
  if (!raw) return undefined
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) throw new Error("not-array")
    return parsed as EligibilityRuleInput[]
  } catch {
    throw new AppError(422, "validation_failed", "Review the highlighted fields.", { criteria: ["Criteria must be a JSON array of eligibility rules."] })
  }
}

function parseContacts(value: unknown, fallback: FunderContactInput[]): FunderContactInput[] {
  if (value === undefined) return fallback
  if (!Array.isArray(value)) {
    throw new AppError(422, "validation_failed", "Review the highlighted fields.", { contacts: ["Provide a list of contacts."] })
  }
  return value as FunderContactInput[]
}

function parseRoutes(value: unknown, fallback: FunderRouteInput[]): FunderRouteInput[] {
  if (value === undefined) return fallback
  if (!Array.isArray(value)) {
    throw new AppError(422, "validation_failed", "Review the highlighted fields.", { routes: ["Provide a list of routes."] })
  }
  return value as FunderRouteInput[]
}

function fieldErrorsFrom(error: unknown): Record<string, string[]> | undefined {
  if (error instanceof AppError && error.fieldErrors) return error.fieldErrors
  if (error instanceof AppError) return { _row: [error.message] }
  return undefined
}

type ParsedDraft = { draft: FunderImportDraft; parseErrors?: Record<string, string[]> }

function draftSkeleton(value: unknown): FunderImportDraft {
  const row = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}
  return {
    legalName: text(row.legalName ?? row.legal_name ?? row.name),
    nickname: text(row.nickname ?? row.dba) || undefined,
    website: text(row.website ?? row.url) || undefined,
    domains: splitList(row.domains ?? row.domain),
    products: splitList(row.products ?? row.product),
    active: true,
    contacts: [],
    routes: [],
  }
}

function draftFromUnknown(value: unknown): FunderImportDraft {
  const row = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}
  const contactFallback: FunderContactInput[] = []
  const contactName = text(row.contactName ?? row.contact_name)
  const contactEmail = text(row.contactEmail ?? row.contact_email)
  const contactPhone = text(row.contactPhone ?? row.contact_phone)
  const contactRole = text(row.contactRole ?? row.contact_role)
  if (contactName || contactEmail || contactPhone || contactRole) {
    contactFallback.push({ name: contactName || undefined, email: contactEmail || undefined, phone: contactPhone || undefined, role: contactRole || undefined })
  }
  return {
    legalName: text(row.legalName ?? row.legal_name ?? row.name),
    nickname: text(row.nickname ?? row.dba) || undefined,
    website: text(row.website ?? row.url) || undefined,
    domains: splitList(row.domains ?? row.domain),
    products: splitList(row.products ?? row.product),
    active: parseActive(row.active ?? row.status),
    contacts: parseContacts(row.contacts, contactFallback),
    routes: parseRoutes(row.routes, []),
    criteria: parseCriteria(row.criteria ?? row.rules),
  }
}

function tryDraftFromUnknown(value: unknown): ParsedDraft {
  try {
    return { draft: draftFromUnknown(value) }
  } catch (error) {
    return {
      draft: draftSkeleton(value),
      parseErrors: fieldErrorsFrom(error) ?? { _row: ["This row could not be parsed."] },
    }
  }
}

function assertImportByteSize(value: string | Uint8Array): void {
  const bytes = typeof value === "string" ? new TextEncoder().encode(value).byteLength : value.byteLength
  if (bytes > MAX_IMPORT_BYTES) {
    throw new AppError(422, "funder_import_file_size", "Funder import files must be 1 MiB or smaller.")
  }
}

function mapCsvHeaders(headers: string[]): { fields: Array<keyof MappedRow | undefined>; warning?: string } {
  const fields = headers.map((header) => HEADER_ALIASES[header.trim().toLowerCase()])
  if (!fields.includes("legalName")) {
    throw new AppError(422, "funder_import_headers", "The CSV needs a legal name column. Use legalName, name, or funder.")
  }
  const unknown = headers.filter((_, index) => !fields[index]).map((header) => header.trim()).filter(Boolean)
  return {
    fields,
    ...(unknown.length ? { warning: `Ignored unrecognized columns: ${unknown.join(", ")}.` } : {}),
  }
}

function draftsFromJsonText(raw: string): { drafts: ParsedDraft[]; warnings: string[] } {
  try {
    return draftsFromPayload({ funders: JSON.parse(raw) as unknown })
  } catch (error) {
    if (error instanceof AppError) throw error
    throw new AppError(400, "invalid_json", "Funder import JSON must be an array or { funders: [] }.")
  }
}

function draftsFromCsv(filename: string, bytes: Uint8Array): { drafts: ParsedDraft[]; warnings: string[] } {
  const parsed = parseSpreadsheet({ filename, bytes })
  if (parsed.rows.length > MAX_IMPORT_ROWS) {
    throw new AppError(422, "funder_import_row_limit", `Import at most ${MAX_IMPORT_ROWS} funders at a time.`)
  }
  const mapped = mapCsvHeaders(parsed.headers)
  const drafts = parsed.rows.map((cells) => {
    const row: MappedRow = {}
    mapped.fields.forEach((field, index) => {
      if (!field) return
      row[field] = cells[index] ?? ""
    })
    return tryDraftFromUnknown(row)
  })
  return { drafts, warnings: [...parsed.warnings, ...(mapped.warning ? [mapped.warning] : [])] }
}

function draftsFromPayload(input: { funders?: unknown; filename?: string; bytes?: Uint8Array; text?: string }): { drafts: ParsedDraft[]; warnings: string[] } {
  if (input.bytes && input.bytes.byteLength) {
    assertImportByteSize(input.bytes)
    const filename = text(input.filename) || "funders.csv"
    if (filename.toLowerCase().endsWith(".json") || text(input.text).startsWith("{") || text(input.text).startsWith("[")) {
      const decoded = new TextDecoder("utf-8", { fatal: false }).decode(input.bytes)
      return draftsFromJsonText(decoded)
    }
    return draftsFromCsv(filename, input.bytes)
  }
  if (text(input.text)) {
    const raw = text(input.text)
    assertImportByteSize(raw)
    if (raw.startsWith("{") || raw.startsWith("[")) return draftsFromJsonText(raw)
    return draftsFromCsv("funders.csv", new TextEncoder().encode(raw))
  }
  const payload = input.funders
  const list = Array.isArray(payload)
    ? payload
    : payload && typeof payload === "object" && Array.isArray((payload as { funders?: unknown }).funders)
      ? (payload as { funders: unknown[] }).funders
      : undefined
  if (!list) throw new AppError(422, "funder_import_empty", "Provide a CSV file or a JSON array of funders.")
  if (list.length > MAX_IMPORT_ROWS) throw new AppError(422, "funder_import_row_limit", `Import at most ${MAX_IMPORT_ROWS} funders at a time.`)
  if (!list.length) throw new AppError(422, "funder_import_empty", "The import does not contain any funders.")
  assertImportByteSize(JSON.stringify(list))
  return { drafts: list.map(tryDraftFromUnknown), warnings: [] }
}

function draftDomains(draft: FunderImportDraft): string[] {
  const values = [...draft.domains]
  const website = funderDomainKey(draft.website ?? "")
  if (website) values.push(website)
  return [...new Set(values.map(funderDomainKey).filter(Boolean))]
}

function validateDraft(draft: FunderImportDraft): { errors: Record<string, string[]>; draft: FunderImportDraft } {
  const errors: Record<string, string[]> = {}
  try {
    const normalized = validateCreateFunderInput({
      idempotencyKey: PREVIEW_IDEMPOTENCY,
      legalName: draft.legalName,
      nickname: draft.nickname,
      website: draft.website,
      domains: draft.domains,
      products: draft.products,
      active: draft.active,
      contacts: draft.contacts,
      routes: draft.routes,
    })
    if (draft.criteria?.length) {
      try {
        normalizeEligibilityRules("preview", draft.criteria)
      } catch (error) {
        Object.assign(errors, fieldErrorsFrom(error) ?? { criteria: ["Review the eligibility rules."] })
      }
    }
    return {
      errors,
      draft: {
        legalName: normalized.legalName,
        nickname: normalized.nickname,
        website: normalized.website,
        domains: normalized.domains ?? [],
        products: normalized.products ?? [],
        active: normalized.active !== false,
        contacts: normalized.contacts ?? [],
        routes: normalized.routes ?? [],
        criteria: draft.criteria,
      },
    }
  } catch (error) {
    return { errors: fieldErrorsFrom(error) ?? { _row: ["This funder could not be validated."] }, draft }
  }
}

function detectDuplicates(
  drafts: FunderImportDraft[],
  existing: FunderRecord[],
): Array<FunderImportDuplicate | undefined> {
  const existingByName = new Map(existing.map((funder) => [funderIdentityKey(funder.legalName), funder]))
  const existingByDomain = new Map<string, FunderRecord>()
  for (const funder of existing) {
    for (const domain of [...funder.domains, funder.website ?? ""].map(funderDomainKey).filter(Boolean)) {
      if (!existingByDomain.has(domain)) existingByDomain.set(domain, funder)
    }
  }
  const seenNames = new Map<string, number>()
  const seenDomains = new Map<string, number>()
  return drafts.map((draft, index) => {
    const nameKey = funderIdentityKey(draft.legalName)
    const existingName = nameKey ? existingByName.get(nameKey) : undefined
    if (existingName) return { match: "legal_name", legalName: existingName.legalName, funderId: existingName.id }
    const firstName = nameKey ? seenNames.get(nameKey) : undefined
    if (nameKey && firstName !== undefined) {
      return { match: "batch", legalName: drafts[firstName]?.legalName || draft.legalName }
    }
    if (nameKey) seenNames.set(nameKey, index)
    for (const domain of draftDomains(draft)) {
      const existingDomain = existingByDomain.get(domain)
      if (existingDomain) return { match: "domain", legalName: existingDomain.legalName, funderId: existingDomain.id }
      const firstDomain = seenDomains.get(domain)
      if (firstDomain !== undefined) {
        return { match: "batch", legalName: drafts[firstDomain]?.legalName || draft.legalName }
      }
      seenDomains.set(domain, index)
    }
    return undefined
  })
}

function previewRows(parsed: ParsedDraft[], existing: FunderRecord[]): FunderImportPreviewRow[] {
  const drafts = parsed.map((item) => item.draft)
  const duplicates = detectDuplicates(drafts, existing)
  return parsed.map((item, index) => {
    const validated = validateDraft(item.draft)
    const errors = { ...item.parseErrors, ...validated.errors }
    const duplicate = funderIdentityKey(validated.draft.legalName) ? duplicates[index] : undefined
    const status = Object.keys(errors).length ? "invalid" : duplicate ? "duplicate" : "ready"
    return {
      key: newId(),
      rowNumber: index + 1,
      draft: validated.draft,
      status,
      included: status === "ready",
      errors,
      ...(duplicate ? { duplicate } : {}),
    }
  })
}

function summarize(rows: FunderImportPreviewRow[]): FunderImportPreview["summary"] {
  return {
    ready: rows.filter((row) => row.status === "ready").length,
    invalid: rows.filter((row) => row.status === "invalid").length,
    duplicate: rows.filter((row) => row.status === "duplicate").length,
    included: rows.filter((row) => row.included).length,
  }
}

export async function requireFunderImportActor(request: Request): Promise<DealActor> {
  assertTrustedMutation(request)
  const auth = await requireWorkspaceAccess(request, { sessionOnly: true, roles: ["admin", "super_admin"] })
  return { ...await actorForDeals(auth), correlationId: requestCorrelationId(request) }
}

export async function previewFunderImport(actor: DealActor, input: {
  funders?: unknown
  filename?: string
  bytes?: Uint8Array
  text?: string
}): Promise<FunderImportPreview> {
  assertManage(actor)
  const parsed = draftsFromPayload(input)
  const existing = await listFunders(actor, { includeInactive: true })
  const rows = previewRows(parsed.drafts, existing)
  return { rows, warnings: parsed.warnings, summary: summarize(rows) }
}

function parseJsonList(value: string | null | undefined): string[] {
  if (!value) return []
  try {
    const parsed = JSON.parse(value) as unknown
    return Array.isArray(parsed) ? parsed.map((item) => text(item)).filter(Boolean) : []
  } catch {
    return []
  }
}

async function assertNoIdentityClash(database: DbExecutor, workspaceId: string, funder: FunderRecord): Promise<void> {
  const nameClash = await database.prepare<{ id: string; legal_name: string }>(
    "SELECT id, legal_name FROM mca_funders WHERE workspace_id = ? AND lower(legal_name) = lower(?) AND id <> ? LIMIT 1",
  ).get(workspaceId, funder.legalName, funder.id)
  if (nameClash) {
    throw new AppError(422, "funder_import_review_required", "Some reviewed funders are invalid or already exist. Remove them before saving.", {
      legalName: [`${nameClash.legal_name} is already in this workspace.`],
    })
  }
  const ours = new Set(draftDomains({
    legalName: funder.legalName,
    website: funder.website,
    domains: funder.domains,
    products: funder.products,
    active: funder.active,
    contacts: funder.contacts,
    routes: funder.routes,
  }))
  if (!ours.size) return
  const others = await database.prepare<{ legal_name: string; website: string | null; domains: string }>(
    "SELECT legal_name, website, domains FROM mca_funders WHERE workspace_id = ? AND id <> ?",
  ).all(workspaceId, funder.id)
  for (const other of others) {
    const theirDomains = new Set([...parseJsonList(other.domains), other.website ?? ""].map(funderDomainKey).filter(Boolean))
    for (const domain of ours) {
      if (theirDomains.has(domain)) {
        throw new AppError(422, "funder_import_review_required", "Some reviewed funders are invalid or already exist. Remove them before saving.", {
          legalName: [`${other.legal_name} is already in this workspace.`],
        })
      }
    }
  }
}

function rowIdempotencyKey(commitKey: string, rowKey: string): string {
  return `funder-import:${createHash("sha256").update(`${commitKey}:${rowKey}`).digest("hex").slice(0, 48)}`
}

export async function commitFunderImport(actor: DealActor, input: {
  idempotencyKey: string
  rows: Array<{ key: string; included?: boolean; draft: FunderImportDraft }>
}): Promise<FunderImportCommitResult> {
  assertManage(actor)
  const commitKey = text(input.idempotencyKey)
  if (!commitKey || commitKey.length > 128) {
    throw new AppError(422, "validation_failed", "Review the highlighted fields.", { idempotencyKey: ["Provide a stable retry key."] })
  }
  if (!Array.isArray(input.rows) || !input.rows.length) {
    throw new AppError(422, "funder_import_empty", "Review the import before saving. No funders were selected.")
  }
  if (input.rows.length > MAX_IMPORT_ROWS) {
    throw new AppError(422, "funder_import_row_limit", `Import at most ${MAX_IMPORT_ROWS} funders at a time.`)
  }
  const selected = input.rows.filter((row) => row.included !== false)
  if (!selected.length) {
    throw new AppError(422, "funder_import_empty", "Select at least one reviewed funder to save.")
  }

  return withImmediateTransaction(async (database) => {
    await database.prepare("SELECT pg_advisory_xact_lock(hashtext(?))").get(`funder-import:${actor.workspaceId}`)
    const existing = await listFunders(actor, { includeInactive: true })
    const existingByKey = new Map<string, FunderRecord>()
    for (const row of selected) {
      const key = rowIdempotencyKey(commitKey, text(row.key) || newId())
      const replay = await findFunderByIdempotencyKey(actor.workspaceId, key)
      if (replay) existingByKey.set(key, replay)
    }
    const others = existing.filter((funder) => ![...existingByKey.values()].some((replay) => replay.id === funder.id))
    const reviewed = selected.map((row) => {
      const validated = validateDraft(row.draft)
      return { ...row, key: text(row.key) || newId(), draft: validated.draft, errors: validated.errors }
    })
    const duplicates = detectDuplicates(reviewed.map((row) => row.draft), others)
    const blocked = reviewed.map((row, index) => {
      const idempotencyKey = rowIdempotencyKey(commitKey, row.key)
      if (existingByKey.has(idempotencyKey)) return undefined
      if (Object.keys(row.errors).length) return { ...row, status: "invalid" as const, errors: row.errors }
      if (duplicates[index]) {
        return {
          ...row,
          status: "duplicate" as const,
          errors: { legalName: [`${duplicates[index]?.legalName} is already in this workspace.`] },
          duplicate: duplicates[index],
        }
      }
      return undefined
    }).filter(Boolean)
    if (blocked.length) {
      throw new AppError(
        422,
        "funder_import_review_required",
        "Some reviewed funders are invalid or already exist. Remove them before saving.",
        undefined,
        { rows: blocked },
      )
    }

    const created: FunderRecord[] = []
    const replayed: FunderRecord[] = []
    let criteriaPublished = 0
    for (const row of reviewed) {
      const idempotencyKey = rowIdempotencyKey(commitKey, row.key)
      const payload: CreateFunderInput = {
        idempotencyKey,
        legalName: row.draft.legalName,
        nickname: row.draft.nickname,
        website: row.draft.website,
        domains: row.draft.domains,
        products: row.draft.products,
        active: row.draft.active,
        contacts: row.draft.contacts,
        routes: row.draft.routes,
      }
      const result = await createFunder(actor, payload)
      if (result.created) {
        await assertNoIdentityClash(database, actor.workspaceId, result.funder)
        created.push(result.funder)
      } else replayed.push(result.funder)
      if (row.draft.criteria?.length) {
        await publishFunderCriteria(actor, result.funder.id, row.draft.criteria)
        criteriaPublished += 1
      }
    }
    await recordAuditEvent({
      context: actor,
      action: "funder.bulk_imported",
      resourceType: "funder_import",
      resourceId: commitKey,
      metadata: {
        created: created.length,
        replayed: replayed.length,
        skipped: input.rows.length - selected.length,
        criteriaPublished,
      },
      correlationId: actor.correlationId,
    })
    return {
      created,
      replayed,
      skipped: input.rows.length - selected.length,
      criteriaPublished,
    }
  })
}
