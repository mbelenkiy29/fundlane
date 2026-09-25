import "server-only"

import { AppError } from "../errors"
import { newId, nowIso, recordAuditEvent, withImmediateTransaction } from "../db"
import { canManageWorkspace } from "../policy"
import type { DealActor } from "../deals/schema"
import { FUNDER_ROUTE_KINDS, type FunderContact, type FunderGroup, type FunderRecord, type FunderRoute, type FunderRouteKind } from "./contracts"
import { validateFunderProfile, validateGroupName } from "./validation"
import {
  findFunderById,
  findFunderByIdForUpdate,
  findGroupById,
  findGroupByIdForUpdate,
  insertFunder,
  insertGroup,
  listFunderRecords,
  listGroupRecords,
  toFunderRecord,
  updateFunderRecord,
  updateGroupRecord,
  type StoredFunder,
} from "./directory-repository"

export interface FunderContactInput {
  id?: string
  name?: string
  email?: string
  phone?: string
  role?: string
}

export interface FunderRouteInput {
  id?: string
  kind?: string
  label?: string
  destination?: string
  documentExceptions?: string[]
  active?: boolean
}

export interface CreateFunderInput {
  idempotencyKey: string
  legalName: string
  nickname?: string
  website?: string
  domains?: string[]
  products?: string[]
  active?: boolean
  contacts?: FunderContactInput[]
  routes?: FunderRouteInput[]
}

export interface UpdateFunderInput {
  legalName?: string
  nickname?: string | null
  website?: string | null
  domains?: string[]
  products?: string[]
  active?: boolean
  contacts?: FunderContactInput[]
  routes?: FunderRouteInput[]
}

export interface CreateGroupInput {
  name: string
  funderIds?: string[]
}

export interface UpdateGroupInput {
  name?: string
  funderIds?: string[]
}

function assertManage(actor: DealActor): void {
  if (!actor.role || !canManageWorkspace(actor.role)) {
    throw new AppError(403, "permission_denied", "You do not have permission to perform this action.")
  }
}

function invalid(field: string, message: string): never {
  throw new AppError(422, "validation_failed", "Review the highlighted fields.", { [field]: [message] })
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : ""
}

function optionalText(value: unknown, field: string, max: number): string | undefined {
  if (value === undefined || value === null) return undefined
  const next = text(value)
  if (!next) return undefined
  if (next.length > max) invalid(field, `Use at most ${max} characters.`)
  return next
}

function requiredText(value: unknown, field: string, message: string, max: number): string {
  const next = text(value)
  if (!next) invalid(field, message)
  if (next.length > max) invalid(field, `Use at most ${max} characters.`)
  return next
}

function uniqueList(value: unknown, field: string, maxItems: number, maxLength: number): string[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) invalid(field, "Provide a list of values.")
  if (value.length > maxItems) invalid(field, `Use at most ${maxItems} values.`)
  const seen = new Set<string>()
  const items: string[] = []
  for (const [index, entry] of value.entries()) {
    const next = text(entry)
    if (!next) continue
    if (next.length > maxLength) invalid(`${field}.${index}`, `Use at most ${maxLength} characters.`)
    const key = next.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    items.push(next)
  }
  return items
}

function normalizeContacts(value: unknown): FunderContact[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) invalid("contacts", "Provide a list of contacts.")
  if (value.length > 50) invalid("contacts", "Use at most 50 contacts.")
  const contacts: FunderContact[] = []
  for (const [index, entry] of value.entries()) {
    const row = entry && typeof entry === "object" && !Array.isArray(entry) ? entry as FunderContactInput : {}
    const name = optionalText(row.name, `contacts.${index}.name`, 120)
    const email = optionalText(row.email, `contacts.${index}.email`, 200)
    const phone = optionalText(row.phone, `contacts.${index}.phone`, 40)
    const role = optionalText(row.role, `contacts.${index}.role`, 80)
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) invalid(`contacts.${index}.email`, "Enter a valid email address.")
    if (!name && !email && !phone && !role) continue
    contacts.push({
      id: text(row.id) || newId(),
      name,
      email,
      phone,
      role,
    })
  }
  return contacts
}

function normalizeRoutes(value: unknown): FunderRoute[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) invalid("routes", "Provide a list of routes.")
  if (value.length > 20) invalid("routes", "Use at most 20 routes.")
  const routes: FunderRoute[] = []
  for (const [index, entry] of value.entries()) {
    const row = entry && typeof entry === "object" && !Array.isArray(entry) ? entry as FunderRouteInput : {}
    const kind = text(row.kind)
    const label = text(row.label)
    const destination = text(row.destination)
    if (!kind && !label && !destination) continue
    if (!FUNDER_ROUTE_KINDS.includes(kind as FunderRouteKind)) invalid(`routes.${index}.kind`, "Choose email, API, manual portal, or custom webhook.")
    if (!label) invalid(`routes.${index}.label`, "Enter a route label.")
    if (label.length > 120) invalid(`routes.${index}.label`, "Use at most 120 characters.")
    if (!destination) invalid(`routes.${index}.destination`, "Enter a route destination.")
    if (destination.length > 500) invalid(`routes.${index}.destination`, "Use at most 500 characters.")
    const documentExceptions = uniqueList(row.documentExceptions ?? [], `routes.${index}.documentExceptions`, 30, 80)
    routes.push({
      id: text(row.id) || newId(),
      kind: kind as FunderRouteKind,
      label,
      destination,
      documentExceptions,
      active: row.active !== false,
    })
  }
  return routes
}

function profileFromInput(input: CreateFunderInput | UpdateFunderInput, current?: StoredFunder): Omit<StoredFunder, "id" | "workspaceId" | "idempotencyKey" | "criteriaVersion" | "profileVersion" | "createdAt" | "updatedAt"> {
  const fieldErrors = validateFunderProfile(input, { requireLegalName: input.legalName !== undefined || !current })
  if (Object.keys(fieldErrors).length) {
    throw new AppError(422, "validation_failed", "Review the highlighted fields.", fieldErrors)
  }
  return {
    legalName: input.legalName !== undefined || !current ? requiredText(input.legalName, "legalName", "Enter the funder legal name.", 200) : current.legalName,
    nickname: input.nickname !== undefined ? optionalText(input.nickname, "nickname", 120) : current?.nickname,
    website: input.website !== undefined ? optionalText(input.website, "website", 300) : current?.website,
    domains: input.domains !== undefined ? uniqueList(input.domains, "domains", 30, 200) : current?.domains ?? [],
    products: input.products !== undefined ? uniqueList(input.products, "products", 30, 80) : current?.products ?? [],
    active: input.active !== undefined ? Boolean(input.active) : current?.active ?? true,
    contacts: input.contacts !== undefined ? normalizeContacts(input.contacts) : current?.contacts ?? [],
    routes: input.routes !== undefined ? normalizeRoutes(input.routes) : current?.routes ?? [],
  }
}

function normalizeFunderIds(value: unknown): string[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) invalid("funderIds", "Provide a list of funder IDs.")
  if (value.length > 200) invalid("funderIds", "Use at most 200 funders in a group.")
  return value.map((id, index) => {
    const next = text(id)
    if (!next) invalid(`funderIds.${index}`, "Each funder ID must be present.")
    return next
  })
}

async function assertWorkspaceFunders(actor: DealActor, funderIds: string[]): Promise<void> {
  for (const id of funderIds) {
    if (!await findFunderById(actor.workspaceId, id)) {
      throw new AppError(404, "funder_not_found", "The requested funder was not found.")
    }
  }
}

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Error && ((error as Error & { code?: string }).code === "23505" || /unique/i.test(error.message))
}

export async function listFunders(actor: DealActor, options: { includeInactive?: boolean } = {}): Promise<FunderRecord[]> {
  return (await listFunderRecords(actor.workspaceId, Boolean(options.includeInactive))).map(toFunderRecord)
}

export async function getFunder(actor: DealActor, id: string): Promise<FunderRecord> {
  const record = await findFunderById(actor.workspaceId, id)
  if (!record) throw new AppError(404, "funder_not_found", "The requested funder was not found.")
  return toFunderRecord(record)
}

export async function createFunder(actor: DealActor, input: CreateFunderInput): Promise<{ funder: FunderRecord; created: boolean }> {
  assertManage(actor)
  const idempotencyKey = requiredText(input.idempotencyKey, "idempotencyKey", "Provide a stable retry key.", 128)
  const now = nowIso()
  const profile = profileFromInput(input)
  const saved = await insertFunder({
    id: newId(),
    workspaceId: actor.workspaceId,
    idempotencyKey,
    ...profile,
    criteriaVersion: 1,
    profileVersion: 1,
    createdAt: now,
    updatedAt: now,
  })
  if (saved.inserted) {
    await recordAuditEvent({
      context: actor,
      action: "funder.created",
      resourceType: "funder",
      resourceId: saved.record.id,
      metadata: { profileVersion: 1, active: saved.record.active },
      correlationId: actor.correlationId,
    })
  }
  return { funder: toFunderRecord(saved.record), created: saved.inserted }
}

export async function updateFunder(actor: DealActor, id: string, input: UpdateFunderInput): Promise<FunderRecord> {
  assertManage(actor)
  const saved = await withImmediateTransaction(async (database) => {
    const current = await findFunderByIdForUpdate(database, actor.workspaceId, id)
    if (!current) throw new AppError(404, "funder_not_found", "The requested funder was not found.")
    return updateFunderRecord({
      ...current,
      ...profileFromInput(input, current),
      profileVersion: current.profileVersion + 1,
      updatedAt: nowIso(),
    })
  })
  await recordAuditEvent({
    context: actor,
    action: saved.active ? "funder.updated" : "funder.archived",
    resourceType: "funder",
    resourceId: saved.id,
    metadata: { profileVersion: saved.profileVersion, active: saved.active },
    correlationId: actor.correlationId,
  })
  return toFunderRecord(saved)
}

export async function listGroups(actor: DealActor): Promise<FunderGroup[]> {
  return listGroupRecords(actor.workspaceId)
}

export async function getGroup(actor: DealActor, id: string): Promise<FunderGroup> {
  const group = await findGroupById(actor.workspaceId, id)
  if (!group) throw new AppError(404, "group_not_found", "The requested funder group was not found.")
  return group
}

export async function createGroup(actor: DealActor, input: CreateGroupInput): Promise<FunderGroup> {
  assertManage(actor)
  const nameErrors = validateGroupName(input.name, { required: true })
  if (Object.keys(nameErrors).length) throw new AppError(422, "validation_failed", "Review the highlighted fields.", nameErrors)
  const name = requiredText(input.name, "name", "Enter a group name.", 120)
  const funderIds = normalizeFunderIds(input.funderIds)
  await assertWorkspaceFunders(actor, funderIds)
  const now = nowIso()
  const record: FunderGroup = { id: newId(), workspaceId: actor.workspaceId, name, funderIds, createdAt: now, updatedAt: now }
  try {
    await insertGroup(record)
  } catch (error) {
    if (isUniqueViolation(error)) throw new AppError(422, "group_name_conflict", "A group with that name already exists in this workspace.", { name: ["Choose a different group name."] })
    throw error
  }
  await recordAuditEvent({
    context: actor,
    action: "funder_group.created",
    resourceType: "funder_group",
    resourceId: record.id,
    metadata: { funderCount: funderIds.length },
    correlationId: actor.correlationId,
  })
  return record
}

export async function updateGroup(actor: DealActor, id: string, input: UpdateGroupInput): Promise<FunderGroup> {
  assertManage(actor)
  const requestedFunderIds = input.funderIds !== undefined ? normalizeFunderIds(input.funderIds) : undefined
  if (requestedFunderIds) await assertWorkspaceFunders(actor, requestedFunderIds)
  const next = await withImmediateTransaction(async (database) => {
    const current = await findGroupByIdForUpdate(database, actor.workspaceId, id)
    if (!current) throw new AppError(404, "group_not_found", "The requested funder group was not found.")
    const record: FunderGroup = {
      ...current,
      name: input.name !== undefined ? requiredText(input.name, "name", "Enter a group name.", 120) : current.name,
      funderIds: requestedFunderIds ?? current.funderIds,
      updatedAt: nowIso(),
    }
    try {
      return await updateGroupRecord(record)
    } catch (error) {
      if (isUniqueViolation(error)) throw new AppError(422, "group_name_conflict", "A group with that name already exists in this workspace.", { name: ["Choose a different group name."] })
      throw error
    }
  })
  await recordAuditEvent({
    context: actor,
    action: "funder_group.updated",
    resourceType: "funder_group",
    resourceId: next.id,
    metadata: { funderCount: next.funderIds.length },
    correlationId: actor.correlationId,
  })
  return next
}

export async function resolveGroup(actor: DealActor, groupId: string): Promise<string[]> {
  const group = await getGroup(actor, groupId)
  const seen = new Set<string>()
  const resolved: string[] = []
  for (const id of group.funderIds) {
    if (seen.has(id)) continue
    seen.add(id)
    const funder = await findFunderById(actor.workspaceId, id)
    if (funder?.active) resolved.push(funder.id)
  }
  return resolved
}

export async function assertSelectableFunder(actor: DealActor, funderId: string): Promise<FunderRecord> {
  const funder = await getFunder(actor, funderId)
  if (!funder.active) throw new AppError(422, "inactive_funder", "Inactive funders cannot be selected for new targeting.")
  return funder
}
