import "server-only"

import { AsyncLocalStorage } from "node:async_hooks"
import { assertTrustedMutation, requireWorkspaceAccess } from "../../auth"
import { decryptSensitive, encryptSensitive } from "../../crypto"
import { getDatabase, newId, recordAuditEvent, withTransaction, type DbExecutor } from "../../db"
import { actorForDeals } from "../../deals/service"
import type { DealActor } from "../../deals/schema"
import { AppError } from "../../errors"
import { requestCorrelationId } from "../../http"
import { canManageWorkspace } from "../../policy"
import { getFunder, listFunders } from "../../funders/directory"
import { ADAPTER_ENVIRONMENTS, type AdapterCapabilities, type AdapterEnvironment } from "../contracts"
import { adapterReadiness, getAdapter, listAdapters } from "./registry"
import {
  ADAPTER_SECRET_FIELDS,
  type AdapterCatalogEntry,
  type AdapterConnectionList,
  type AdapterCredentialPublic,
  type AdapterEncryptedPayload,
  type AdapterFunderOption,
  type AdapterInventory,
  type AdapterLastAction,
  type AdapterResolvedSecrets,
  type AdapterRuntime,
  type AdapterSecretField,
  type AdapterSecretValues,
} from "./contracts"

const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/
const SECRET_MAX = 512
const URL_MAX = 500
const runtimeStore = new AsyncLocalStorage<AdapterRuntime>()
let environmentOverride: AdapterEnvironment | undefined

type CredentialRow = {
  id: string
  workspace_id: string
  funder_id: string
  adapter_slug: string
  environment: string
  credential_cipher: string | null
  capabilities_json: string
  active: number | string
  updated_by_user_id: string | null
  updated_at: string
}

export interface StoredAdapterCredential {
  id: string
  workspaceId: string
  funderId: string
  adapterSlug: string
  environment: AdapterEnvironment
  credentialCipher?: string
  capabilities: AdapterCapabilities
  lastAction?: AdapterLastAction
  active: boolean
  updatedByUserId?: string
  updatedAt: string
}

export interface UpsertAdapterCredentialInput {
  funderId: string
  adapterSlug: string
  environment: AdapterEnvironment
  secrets?: AdapterSecretValues
  active?: boolean
}

function db(): DbExecutor {
  return getDatabase()
}

function invalid(field: string, message: string): never {
  throw new AppError(422, "validation_failed", "Review the highlighted fields.", { [field]: [message] })
}

function denied(message = "You do not have permission to perform this action."): never {
  throw new AppError(403, "permission_denied", message)
}

function isAdmin(actor: DealActor): boolean {
  return Boolean(actor.role && canManageWorkspace(actor.role))
}

function assertAdmin(actor: DealActor): void {
  if (!isAdmin(actor)) denied("Only workspace administrators can manage funder API credentials.")
}

async function requireActor(request: Request, options: { write?: boolean; admin?: boolean }): Promise<DealActor> {
  if (options.write) assertTrustedMutation(request)
  const auth = await requireWorkspaceAccess(request, {
    sessionOnly: options.admin ? true : undefined,
    roles: options.admin ? ["admin", "super_admin"] : undefined,
    scopes: options.admin ? undefined : ["deals:read"],
  })
  return { ...await actorForDeals(auth), correlationId: requestCorrelationId(request) }
}

export async function requireAdapterRead(request: Request): Promise<DealActor> {
  return requireActor(request, {})
}

export async function requireAdapterAdmin(request: Request): Promise<DealActor> {
  return requireActor(request, { write: true, admin: true })
}

export function setAdapterEnvironmentForTests(value?: AdapterEnvironment): void {
  environmentOverride = value
}

export function resolveAdapterEnvironment(requested?: AdapterEnvironment): AdapterEnvironment {
  if (requested === "production" || requested === "development") return requested
  if (environmentOverride === "production" || environmentOverride === "development") return environmentOverride
  if (process.env.NODE_ENV === "production") return "production"
  const configured = process.env.MCA_ADAPTER_ENVIRONMENT
  if (configured === "production" || configured === "development") return configured
  return "development"
}

export function adapterRuntime(): AdapterRuntime | undefined {
  return runtimeStore.getStore()
}

export function requireAdapterRuntime(): AdapterRuntime {
  const runtime = runtimeStore.getStore()
  if (!runtime) throw new Error("Funder adapter runtime is not available.")
  return runtime
}

export async function runWithAdapterRuntime<T>(runtime: AdapterRuntime, operation: () => Promise<T>): Promise<T> {
  return runtimeStore.run(runtime, operation)
}

function emptyHints(): Record<AdapterSecretField, boolean> {
  return {
    apiKey: false,
    clientId: false,
    clientSecret: false,
    username: false,
    password: false,
    baseUrl: false,
    webhookSecret: false,
  }
}

function secretHints(secrets?: AdapterSecretValues): Record<AdapterSecretField, boolean> {
  const hints = emptyHints()
  if (!secrets) return hints
  for (const field of ADAPTER_SECRET_FIELDS) hints[field] = Boolean(secrets[field])
  return hints
}

function trimSecret(value: unknown, field: AdapterSecretField): string | undefined {
  if (value == null) return undefined
  if (typeof value !== "string") invalid(`secrets.${field}`, "Enter a text value.")
  const next = value.trim()
  if (!next) return undefined
  const max = field === "baseUrl" ? URL_MAX : SECRET_MAX
  if (next.length > max) invalid(`secrets.${field}`, `Use at most ${max} characters.`)
  return next
}

export function parseAdapterSecrets(value: unknown): AdapterSecretValues {
  if (value == null) return {}
  if (typeof value !== "object" || Array.isArray(value)) invalid("secrets", "Provide adapter secret fields as an object.")
  const input = value as Record<string, unknown>
  const secrets: AdapterSecretValues = {}
  for (const field of ADAPTER_SECRET_FIELDS) {
    if (input[field] === undefined) continue
    const next = trimSecret(input[field], field)
    if (next) secrets[field] = next
  }
  return secrets
}

function hasAnySecret(secrets: AdapterSecretValues): boolean {
  return ADAPTER_SECRET_FIELDS.some((field) => Boolean(secrets[field]))
}

export function mergeAdapterSecrets(current: AdapterSecretValues | undefined, patch: AdapterSecretValues): AdapterSecretValues {
  const merged: AdapterSecretValues = { ...(current ?? {}) }
  for (const field of ADAPTER_SECRET_FIELDS) {
    if (patch[field] !== undefined) {
      if (patch[field]) merged[field] = patch[field]
      else delete merged[field]
    }
  }
  return merged
}

export function redactAdapterSecrets<T>(value: T, secrets: AdapterSecretValues = adapterRuntime()?.secrets ?? {}): T {
  const replacements = Object.values(secrets).filter((item): item is string => Boolean(item && item.length >= 4))
  const walk = (input: unknown): unknown => {
    if (typeof input === "string") {
      let next = input
      for (const secret of replacements) next = next.split(secret).join("[redacted]")
      if (/credentialCipher|credential_cipher|apiKey|clientSecret|webhookSecret|password/i.test(next) && replacements.length === 0) {
        return next
      }
      return next
    }
    if (Array.isArray(input)) return input.map(walk)
    if (input && typeof input === "object") {
      const output: Record<string, unknown> = {}
      for (const [key, nested] of Object.entries(input as Record<string, unknown>)) {
        if (/^(apiKey|clientSecret|password|webhookSecret|credentialCipher|credential_cipher|authorization|token)$/i.test(key)) {
          output[key] = nested ? "[redacted]" : nested
          continue
        }
        output[key] = walk(nested)
      }
      return output
    }
    return input
  }
  return walk(value) as T
}

export function encryptAdapterCredential(workspaceId: string, environment: AdapterEnvironment, secrets: AdapterSecretValues): string {
  const payload: AdapterEncryptedPayload = { version: 1, workspaceId, environment, secrets }
  return encryptSensitive(JSON.stringify(payload), workspaceId)
}

export function decryptAdapterCredential(workspaceId: string, cipher: string): AdapterEncryptedPayload | undefined {
  try {
    const parsed = JSON.parse(decryptSensitive(cipher, workspaceId)) as AdapterEncryptedPayload
    if (!parsed || parsed.version !== 1 || parsed.workspaceId !== workspaceId) return undefined
    if (parsed.environment !== "development" && parsed.environment !== "production") return undefined
    if (!parsed.secrets || typeof parsed.secrets !== "object") return undefined
    return parsed
  } catch {
    return undefined
  }
}

function defaultCapabilities(): AdapterCapabilities {
  return { submit: true, statusPoll: false, webhooks: false, offers: false }
}

export function asAdapterCapabilities(value: unknown, fallback: AdapterCapabilities = defaultCapabilities()): AdapterCapabilities {
  const row = value && typeof value === "object" ? value as Record<string, unknown> : {}
  return {
    submit: true,
    statusPoll: row.statusPoll === true,
    webhooks: row.webhooks === true,
    offers: row.offers === true,
  }
}

export function effectiveAdapterCapabilities(slug: string, stored?: AdapterCapabilities): AdapterCapabilities {
  const adapter = getAdapter(slug)
  if (!adapter) {
    return {
      submit: true,
      statusPoll: false,
      webhooks: false,
      offers: stored?.offers === true,
    }
  }
  return {
    submit: true,
    statusPoll: adapter.capabilities.statusPoll === true && typeof adapter.getStatus === "function",
    webhooks: adapter.capabilities.webhooks === true && typeof adapter.parseWebhook === "function",
    offers: adapter.capabilities.offers === true,
  }
}

function parseStoredCapabilities(json: string): { capabilities: AdapterCapabilities; lastAction?: AdapterLastAction } {
  const parsed = (() => {
    try { return JSON.parse(json) as Record<string, unknown> } catch { return {} }
  })()
  const last = parsed.lastAction && typeof parsed.lastAction === "object" ? parsed.lastAction as AdapterLastAction : undefined
  return { capabilities: asAdapterCapabilities(parsed), lastAction: last }
}

function capabilitiesJson(capabilities: AdapterCapabilities, lastAction?: AdapterLastAction): string {
  return JSON.stringify(lastAction ? { ...capabilities, lastAction } : capabilities)
}

function mapRow(row: CredentialRow): StoredAdapterCredential {
  const parsed = parseStoredCapabilities(row.capabilities_json)
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    funderId: row.funder_id,
    adapterSlug: row.adapter_slug,
    environment: row.environment as AdapterEnvironment,
    credentialCipher: row.credential_cipher ?? undefined,
    capabilities: parsed.capabilities,
    lastAction: parsed.lastAction,
    active: Number(row.active) !== 0,
    updatedByUserId: row.updated_by_user_id ?? undefined,
    updatedAt: row.updated_at,
  }
}

function asEnvironment(value: unknown): AdapterEnvironment {
  if (typeof value !== "string" || !ADAPTER_ENVIRONMENTS.includes(value as AdapterEnvironment)) {
    invalid("environment", "Choose development or production.")
  }
  return value as AdapterEnvironment
}

function asSlug(value: unknown): string {
  if (typeof value !== "string") invalid("adapterSlug", "Enter an adapter slug.")
  const slug = value.trim().toLowerCase()
  if (!SLUG_PATTERN.test(slug)) invalid("adapterSlug", "Use a lowercase slug with letters, numbers, and dashes.")
  return slug
}

function asFunderId(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) invalid("funderId", "Choose a funder.")
  return value.trim()
}

export function toPublicAdapterCredential(
  record: StoredAdapterCredential,
  options: { funderName?: string; secrets?: AdapterSecretValues } = {},
): AdapterCredentialPublic {
  const payload = record.credentialCipher
    ? decryptAdapterCredential(record.workspaceId, record.credentialCipher)
    : undefined
  const secrets = options.secrets ?? (payload?.environment === record.environment ? payload.secrets : undefined)
  return {
    id: record.id,
    workspaceId: record.workspaceId,
    funderId: record.funderId,
    funderName: options.funderName,
    adapterSlug: record.adapterSlug,
    readiness: adapterReadiness(record.adapterSlug),
    environment: record.environment,
    hasCredential: Boolean(record.credentialCipher),
    capabilities: effectiveAdapterCapabilities(record.adapterSlug, record.capabilities),
    active: record.active,
    secretHints: secretHints(secrets),
    lastAction: record.lastAction ? redactAdapterSecrets(record.lastAction, secrets) : undefined,
    updatedAt: record.updatedAt,
  }
}

async function findRow(workspaceId: string, id: string, executor: DbExecutor = db()): Promise<CredentialRow | undefined> {
  return executor.prepare<CredentialRow>(
    "SELECT * FROM mca_adapter_credentials WHERE workspace_id = ? AND id = ?",
  ).get(workspaceId, id)
}

async function findRowByScope(
  workspaceId: string,
  funderId: string,
  environment: AdapterEnvironment,
  executor: DbExecutor = db(),
): Promise<CredentialRow | undefined> {
  return executor.prepare<CredentialRow>(
    "SELECT * FROM mca_adapter_credentials WHERE workspace_id = ? AND funder_id = ? AND environment = ?",
  ).get(workspaceId, funderId, environment)
}

export async function findAdapterCredential(workspaceId: string, id: string, executor: DbExecutor = db()): Promise<StoredAdapterCredential | undefined> {
  const row = await findRow(workspaceId, id, executor)
  return row ? mapRow(row) : undefined
}

export async function findAdapterCredentialByScope(
  workspaceId: string,
  funderId: string,
  environment: AdapterEnvironment,
  executor: DbExecutor = db(),
): Promise<StoredAdapterCredential | undefined> {
  const row = await findRowByScope(workspaceId, funderId, environment, executor)
  return row ? mapRow(row) : undefined
}

export async function listAdapterCredentialRecords(workspaceId: string, executor: DbExecutor = db()): Promise<StoredAdapterCredential[]> {
  const rows = await executor.prepare<CredentialRow>(
    "SELECT * FROM mca_adapter_credentials WHERE workspace_id = ? ORDER BY adapter_slug, environment, id",
  ).all(workspaceId)
  return rows.map(mapRow)
}

function assertSameWorkspace(record: StoredAdapterCredential | undefined, workspaceId: string): StoredAdapterCredential {
  if (!record || record.workspaceId !== workspaceId) denied()
  return record
}

export async function resolveAdapterSecrets(input: {
  workspaceId: string
  funderId: string
  environment: AdapterEnvironment
  adapterSlug?: string
}): Promise<AdapterResolvedSecrets | undefined> {
  const environment = resolveAdapterEnvironment(input.environment)
  if (environment !== input.environment) return undefined
  const record = await findAdapterCredentialByScope(input.workspaceId, input.funderId, environment)
  if (!record || !record.active || !record.credentialCipher) return undefined
  if (input.adapterSlug && record.adapterSlug !== input.adapterSlug) return undefined
  const payload = decryptAdapterCredential(input.workspaceId, record.credentialCipher)
  if (!payload) return undefined
  if (payload.environment !== environment) return undefined
  if (payload.workspaceId !== input.workspaceId) return undefined
  if (!hasAnySecret(payload.secrets) && record.adapterSlug !== "sandbox") return undefined
  return {
    credentialId: record.id,
    workspaceId: record.workspaceId,
    funderId: record.funderId,
    adapterSlug: record.adapterSlug,
    environment,
    capabilities: effectiveAdapterCapabilities(record.adapterSlug, record.capabilities),
    secrets: payload.secrets,
    active: record.active,
  }
}

async function funderNameMap(actor: DealActor): Promise<Map<string, AdapterFunderOption>> {
  const funders = await listFunders(actor, { includeInactive: true })
  const map = new Map<string, AdapterFunderOption>()
  for (const funder of funders) {
    const apiRoute = funder.routes.find((route) => route.kind === "api" && route.active)
    map.set(funder.id, {
      id: funder.id,
      name: funder.nickname?.trim() || funder.legalName,
      adapterSlug: apiRoute?.destination,
      configuredAdapterSlug: funder.routes.find((route) => route.kind === "api")?.destination,
      hasApiRoute: Boolean(apiRoute),
    })
  }
  return map
}

function buildInventory(funders: Map<string, AdapterFunderOption>, records: StoredAdapterCredential[]): AdapterInventory {
  const assigned = new Set<string>()
  const rows = [...funders.values()].map((funder) => {
    const scoped = records.filter((record) => record.funderId === funder.id)
    const slug = funder.configuredAdapterSlug ?? scoped[0]?.adapterSlug
    if (slug) assigned.add(slug)
    for (const record of scoped) assigned.add(record.adapterSlug)
    const adapter = slug ? getAdapter(slug) : undefined
    return {
      id: funder.id,
      name: funder.name,
      adapterSlug: slug,
      routeActive: funder.hasApiRoute,
      credentials: scoped.map((record) => ({
        adapterSlug: record.adapterSlug,
        environment: record.environment,
        present: Boolean(record.credentialCipher && (() => {
          const payload = decryptAdapterCredential(record.workspaceId, record.credentialCipher)
          return payload?.environment === record.environment && (record.adapterSlug === "sandbox" || hasAnySecret(payload.secrets))
        })()),
        active: record.active,
      })),
      apiContract: slug === "sandbox" ? "Local deterministic fixture" : "No verified provider API contract in repo",
      callback: adapter?.capabilities.webhooks && adapter.parseWebhook ? "Handler in code; provider delivery unverified" : "No provider callback verified",
      commercialAccess: slug === "sandbox" ? "Local test only" : "Provider authorization not evidenced",
      readiness: slug === "sandbox" ? "sandbox verified" as const : "untested" as const,
    }
  })
  return {
    funders: rows,
    unassignedAdapters: listAdapters().filter((adapter) => !assigned.has(adapter.slug)).map((adapter) => ({
      slug: adapter.slug,
      credentialsPresent: false as const,
      apiContract: adapter.slug === "sandbox" ? "Local deterministic fixture" : "No verified provider API contract in repo",
      callback: adapter.capabilities.webhooks && adapter.parseWebhook ? "Handler in code; provider delivery unverified" : "No provider callback verified",
      commercialAccess: adapter.slug === "sandbox" ? "Local test only" : "Provider authorization not evidenced",
      readiness: adapter.slug === "sandbox" ? "sandbox verified" as const : "untested" as const,
    })),
  }
}

export async function listAdapterConnections(actor: DealActor): Promise<AdapterConnectionList> {
  const [records, funders] = await Promise.all([
    listAdapterCredentialRecords(actor.workspaceId),
    funderNameMap(actor),
  ])
  const adapters: AdapterCatalogEntry[] = listAdapters().map((adapter) => ({
    slug: adapter.slug,
    readiness: adapterReadiness(adapter.slug),
    capabilities: effectiveAdapterCapabilities(adapter.slug),
  }))
  const credentials = records.map((record) => toPublicAdapterCredential(record, { funderName: funders.get(record.funderId)?.name }))
  const visibleFunders = [...funders.values()].filter((funder) => funder.hasApiRoute || records.some((record) => record.funderId === funder.id))
  return {
    adapters,
    credentials,
    funders: visibleFunders,
    environments: ADAPTER_ENVIRONMENTS,
    canManage: isAdmin(actor),
    ...(isAdmin(actor) && process.env.MCA_FUNDER_READINESS_INVENTORY_ENABLED === "true"
      ? { inventory: buildInventory(funders, records) }
      : {}),
  }
}

export async function getAdapterCredential(actor: DealActor, id: string): Promise<AdapterCredentialPublic> {
  const record = assertSameWorkspace(await findAdapterCredential(actor.workspaceId, id), actor.workspaceId)
  const funders = await funderNameMap(actor)
  return toPublicAdapterCredential(record, { funderName: funders.get(record.funderId)?.name })
}

async function audit(actor: DealActor, action: string, record: StoredAdapterCredential, extra: Record<string, unknown> = {}): Promise<void> {
  await recordAuditEvent({
    context: actor,
    action,
    resourceType: "adapter_credential",
    resourceId: record.id,
    metadata: redactAdapterSecrets({
      adapterSlug: record.adapterSlug,
      funderId: record.funderId,
      environment: record.environment,
      hasCredential: Boolean(record.credentialCipher),
      active: record.active,
      ...extra,
    }),
    correlationId: actor.correlationId,
  })
}

export async function upsertAdapterCredential(actor: DealActor, input: UpsertAdapterCredentialInput): Promise<AdapterCredentialPublic> {
  assertAdmin(actor)
  const funderId = asFunderId(input.funderId)
  const adapterSlug = asSlug(input.adapterSlug)
  const adapter = getAdapter(adapterSlug)
  if (!adapter) invalid("adapterSlug", "Select a registered adapter.")
  const environment = asEnvironment(input.environment)
  const patch = parseAdapterSecrets(input.secrets ?? {})
  if ("validateConfig" in adapter && typeof adapter.validateConfig === "function") {
    const checked = adapter.validateConfig(patch)
    if (!checked.ok) throw new AppError(422, "validation_failed", "Review the highlighted fields.", Object.fromEntries(Object.entries(checked.fields).map(([key, message]) => [`secrets.${key}`, [String(message)]])))
  }
  if (adapterSlug === "sandbox" && environment !== "development") invalid("environment", "Sandbox is available only in development.")
  const funder = await getFunder(actor, funderId)
  if (!funder.routes.some((route) => route.kind === "api" && route.active && route.destination === adapterSlug)) {
    invalid("adapterSlug", "Select the adapter on this funder's active API route.")
  }
  const capabilities = effectiveAdapterCapabilities(adapterSlug)
  const now = new Date().toISOString()
  const stored = await withTransaction(async (executor) => {
    const current = await findAdapterCredentialByScope(actor.workspaceId, funderId, environment, executor)
    if (!current) {
      if (!hasAnySecret(patch) && adapterSlug !== "sandbox") invalid("secrets", "Enter at least one credential field for this environment.")
      const id = newId()
      await executor.prepare(`INSERT INTO mca_adapter_credentials
        (id, workspace_id, funder_id, adapter_slug, environment, credential_cipher, capabilities_json, active, updated_by_user_id, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        id,
        actor.workspaceId,
        funderId,
        adapterSlug,
        environment,
        encryptAdapterCredential(actor.workspaceId, environment, patch),
        capabilitiesJson(capabilities),
        input.active === false ? 0 : 1,
        actor.userId,
        now,
      )
      const created = await findAdapterCredential(actor.workspaceId, id, executor)
      if (!created) throw new Error("Adapter credential was not found after insert.")
      return created
    }
    const existingPayload = current.credentialCipher
      ? decryptAdapterCredential(actor.workspaceId, current.credentialCipher)
      : undefined
    const existing = existingPayload?.environment === current.environment ? existingPayload.secrets : undefined
    const merged = mergeAdapterSecrets(existing, patch)
    if (Object.keys(patch).length && !hasAnySecret(merged) && !current.credentialCipher && adapterSlug !== "sandbox") {
      invalid("secrets", "Enter at least one credential field for this environment.")
    }
    const nextCipher = hasAnySecret(merged) || adapterSlug === "sandbox"
      ? encryptAdapterCredential(actor.workspaceId, environment, merged)
      : current.credentialCipher ?? null
    await executor.prepare(`UPDATE mca_adapter_credentials SET
      adapter_slug = ?, credential_cipher = ?, capabilities_json = ?, active = ?, updated_by_user_id = ?, updated_at = ?
      WHERE workspace_id = ? AND id = ?`).run(
      adapterSlug,
      nextCipher,
      capabilitiesJson(capabilities, current.lastAction),
      input.active === undefined ? (current.active ? 1 : 0) : input.active ? 1 : 0,
      actor.userId,
      now,
      actor.workspaceId,
      current.id,
    )
    const updated = await findAdapterCredential(actor.workspaceId, current.id, executor)
    if (!updated) throw new Error("Adapter credential was not found after update.")
    return updated
  })
  await audit(actor, stored.updatedAt === now && stored.id ? "adapter_credential.saved" : "adapter_credential.saved", stored, {
    funderName: funder.nickname || funder.legalName,
  })
  return toPublicAdapterCredential(stored, { funderName: funder.nickname || funder.legalName })
}

export async function updateAdapterCredential(
  actor: DealActor,
  id: string,
  input: Partial<UpsertAdapterCredentialInput> & { secrets?: AdapterSecretValues },
): Promise<AdapterCredentialPublic> {
  assertAdmin(actor)
  const current = assertSameWorkspace(await findAdapterCredential(actor.workspaceId, id), actor.workspaceId)
  return upsertAdapterCredential(actor, {
    funderId: input.funderId ?? current.funderId,
    adapterSlug: input.adapterSlug ?? current.adapterSlug,
    environment: input.environment ?? current.environment,
    secrets: input.secrets,
    active: input.active,
  })
}

export async function deactivateAdapterCredential(actor: DealActor, id: string): Promise<AdapterCredentialPublic> {
  assertAdmin(actor)
  const current = assertSameWorkspace(await findAdapterCredential(actor.workspaceId, id), actor.workspaceId)
  const now = new Date().toISOString()
  await db().prepare(
    "UPDATE mca_adapter_credentials SET active = 0, updated_by_user_id = ?, updated_at = ? WHERE workspace_id = ? AND id = ?",
  ).run(actor.userId, now, actor.workspaceId, current.id)
  const stored = await findAdapterCredential(actor.workspaceId, current.id)
  if (!stored) denied()
  await audit(actor, "adapter_credential.deactivated", stored)
  const funders = await funderNameMap(actor)
  return toPublicAdapterCredential(stored, { funderName: funders.get(stored.funderId)?.name })
}

export async function recordAdapterLastAction(
  workspaceId: string,
  credentialId: string,
  lastAction: AdapterLastAction,
  executor: DbExecutor = db(),
): Promise<void> {
  const current = await findAdapterCredential(workspaceId, credentialId, executor)
  if (!current) return
  const secrets = current.credentialCipher
    ? decryptAdapterCredential(workspaceId, current.credentialCipher)?.secrets
    : undefined
  await executor.prepare(
    "UPDATE mca_adapter_credentials SET capabilities_json = ?, updated_at = ? WHERE workspace_id = ? AND id = ?",
  ).run(
    capabilitiesJson(effectiveAdapterCapabilities(current.adapterSlug, current.capabilities), redactAdapterSecrets(lastAction, secrets)),
    new Date().toISOString(),
    workspaceId,
    credentialId,
  )
}
