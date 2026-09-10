import "server-only"

import { assertTrustedMutation, requireMembershipAccess, requireWorkspaceAccess } from "../auth"
import { decryptSensitive, encryptSensitive } from "../crypto"
import { newId, nowIso, recordAuditEvent, withTransaction } from "../db"
import { actorForDeals, getDealForDocument } from "../deals/service"
import type { DealActor, DealRecord } from "../deals/schema"
import { AppError } from "../errors"
import { requestCorrelationId } from "../http"
import { canManageWorkspace } from "../policy"
import type { DataMerchCheck, DataMerchConfig } from "./contracts"
import {
  lookupMerchants,
  setDataMerchFetchForTests,
  type DataMerchLookupFailureKind,
  type DataMerchMerchantPayload,
  type DataMerchRecordPayload,
} from "./client"
import {
  claimCheck,
  completeClaimedCheck,
  findCheckByCorrelation,
  insertCheck,
  listChecks,
  readConfig,
  toPublicCheck,
  toPublicConfig,
  updateConfigDiagnostic,
  upsertConfig,
  type StoredDataMerchCheck,
  type StoredDataMerchConfig,
} from "./repository"

export { setDataMerchFetchForTests }
export type { DataMerchCheck, DataMerchConfig }

export interface DataMerchRecordView {
  category?: string
  notes?: string
  funder?: string
  occurredOn?: string
  merchantName?: string
  riskLevel?: string
}

export interface DataMerchCheckView extends DataMerchCheck {
  records: DataMerchRecordView[]
  queryKind?: "ein" | "legal_name"
}

export interface DealDataMerch {
  config: DataMerchConfig
  canRun: boolean
  checks: DataMerchCheck[]
  latest: DataMerchCheckView | null
}

export interface SaveDataMerchConfigInput {
  enabled?: boolean
  credential?: string
  credentialExpiresAt?: string | null
  testConnection?: boolean
}

function assertAdmin(actor: DealActor): void {
  if (!actor.role || !canManageWorkspace(actor.role)) {
    throw new AppError(403, "permission_denied", "Only workspace administrators can update Data Merch settings.")
  }
}

export async function requireDataMerchActor(request: Request, mode: "read" | "write"): Promise<DealActor> {
  if (mode === "write") assertTrustedMutation(request)
  const auth = await requireWorkspaceAccess(request, { scopes: [mode === "read" ? "deals:read" : "deals:write"] })
  return { ...await actorForDeals(auth), correlationId: requestCorrelationId(request) }
}

export async function requireDataMerchAdmin(request: Request, mode: "read" | "write"): Promise<DealActor> {
  if (mode === "write") assertTrustedMutation(request)
  const auth = await requireMembershipAccess(request, ["admin", "super_admin"])
  return { ...await actorForDeals(auth), correlationId: requestCorrelationId(request) }
}

function publicConfig(record: StoredDataMerchConfig): DataMerchConfig {
  return toPublicConfig(record)
}

function credentialExpired(record: StoredDataMerchConfig, now = Date.now()): boolean {
  if (!record.credentialExpiresAt) return false
  const expires = Date.parse(record.credentialExpiresAt)
  return Number.isFinite(expires) && expires <= now
}

function revealCredential(record: StoredDataMerchConfig): string | undefined {
  if (!record.credentialCipher) return undefined
  try {
    return decryptSensitive(record.credentialCipher, record.workspaceId)
  } catch {
    return undefined
  }
}

function merchantQuery(deal: DealRecord): { query: string; queryKind: "ein" | "legal_name" } | undefined {
  // `getDeal` masks EIN for browser payloads. Lookups must use `getDealForDocument`.
  const ein = deal.ein?.trim()
  if (ein) return { query: ein, queryKind: "ein" }
  const legalName = deal.legalName?.trim()
  if (legalName) return { query: legalName, queryKind: "legal_name" }
  return undefined
}

function canRunConfig(record: StoredDataMerchConfig, deal: DealRecord): boolean {
  return record.enabled && record.hasCredential && !credentialExpired(record) && Boolean(merchantQuery(deal))
}

function viewRecords(merchants: DataMerchMerchantPayload[]): DataMerchRecordView[] {
  const views: DataMerchRecordView[] = []
  for (const merchant of merchants) {
    const records: DataMerchRecordPayload[] = Array.isArray(merchant.records) ? merchant.records : [{}]
    for (const record of records) {
      views.push({
        category: typeof record.category === "string" ? record.category : undefined,
        notes: typeof record.notes === "string" ? record.notes : undefined,
        funder: typeof record.funder === "string" ? record.funder : undefined,
        occurredOn: typeof record.created_at === "string" ? record.created_at : typeof record.date === "string" ? record.date : undefined,
        merchantName: typeof merchant.name === "string" ? merchant.name : undefined,
        riskLevel: typeof merchant.risk_level === "string" ? merchant.risk_level : undefined,
      })
    }
  }
  return views
}

function toCheckView(record: StoredDataMerchCheck): DataMerchCheckView {
  return {
    ...toPublicCheck(record),
    records: viewRecords(record.merchants),
    queryKind: record.queryKind,
  }
}

function failureSummary(kind: DataMerchLookupFailureKind | "credential_expired" | "credential_unreadable"): string {
  if (kind === "credential_expired") return "Data Merch credential expired. Update the key and retry."
  if (kind === "unauthorized") return "Data Merch rejected the stored credential. Update the key and retry."
  if (kind === "credential_unreadable") return "The stored Data Merch credential could not be read. Save a new key and retry."
  if (kind === "invalid_response") return "Data Merch returned an unexpected response."
  return "Data Merch could not be reached. Retry after the connection is restored."
}

function recordsSummary(merchants: DataMerchMerchantPayload[], recordCount: number): string {
  const name = merchants.find((merchant) => merchant.name)?.name
  const risk = merchants.find((merchant) => merchant.risk_level)?.risk_level
  const subject = name ? ` for ${name}` : ""
  const riskNote = risk ? ` (risk: ${risk})` : ""
  return `${recordCount} record${recordCount === 1 ? "" : "s"}${subject}${riskNote}`
}

export async function getDataMerchConfig(actor: DealActor): Promise<DataMerchConfig> {
  return publicConfig(await readConfig(actor.workspaceId))
}

export async function saveDataMerchConfig(actor: DealActor, input: SaveDataMerchConfigInput): Promise<DataMerchConfig> {
  assertAdmin(actor)
  const current = await readConfig(actor.workspaceId)
  const enabled = input.enabled ?? current.enabled
  const credential = typeof input.credential === "string" ? input.credential.trim() : undefined
  if (credential !== undefined && (credential.length < 8 || credential.length > 512)) {
    throw new AppError(422, "validation_failed", "Review the highlighted fields.", {
      credential: ["Enter a Data Merch API key between 8 and 512 characters."],
    })
  }
  let credentialExpiresAt: string | null | undefined
  if (input.credentialExpiresAt === null) credentialExpiresAt = null
  else if (typeof input.credentialExpiresAt === "string") {
    const expires = input.credentialExpiresAt.trim()
    if (expires && !Number.isFinite(Date.parse(expires))) {
      throw new AppError(422, "validation_failed", "Review the highlighted fields.", {
        credentialExpiresAt: ["Use a valid credential expiry timestamp."],
      })
    }
    credentialExpiresAt = expires || null
  }
  const hasCredential = Boolean(credential) || current.hasCredential
  if (enabled && !hasCredential) {
    throw new AppError(422, "validation_failed", "Review the highlighted fields.", {
      credential: ["Save a Data Merch API key before enabling the integration."],
    })
  }
  const now = nowIso()
  const stored = await upsertConfig({
    workspaceId: actor.workspaceId,
    enabled,
    credentialCipher: credential ? encryptSensitive(credential, actor.workspaceId) : undefined,
    credentialExpiresAt,
    updatedAt: now,
    updatedByUserId: actor.userId,
  })
  await recordAuditEvent({
    context: actor,
    action: "datamerch.config_updated",
    resourceType: "workspace",
    resourceId: actor.workspaceId,
    metadata: { enabled, hasCredential: stored.hasCredential },
    correlationId: actor.correlationId,
  })
  return publicConfig(stored)
}

export async function getDealDataMerch(actor: DealActor, dealId: string): Promise<DealDataMerch> {
  const deal = await getDealForDocument(actor, dealId)
  const config = await readConfig(actor.workspaceId)
  const stored = await listChecks(actor.workspaceId, deal.id)
  return {
    config: publicConfig(config),
    canRun: canRunConfig(config, deal),
    checks: stored.map(toPublicCheck),
    latest: stored[0] ? toCheckView(stored[0]) : null,
  }
}

export async function runDataMerchCheck(actor: DealActor, dealId: string): Promise<DataMerchCheckView> {
  const deal = await getDealForDocument(actor, dealId)
  const config = await readConfig(actor.workspaceId)
  if (!config.enabled) {
    throw new AppError(409, "datamerch_disabled", "Data Merch is disabled for this workspace.")
  }
  const existing = await findCheckByCorrelation(actor.workspaceId, deal.id, actor.correlationId)
  if (existing && existing.status !== "queued") return toCheckView(existing)

  const identity = merchantQuery(deal)
  if (!identity) {
    throw new AppError(422, "validation_failed", "A deal EIN or legal name is required to run Data Merch.", {
      ein: ["Add an EIN or legal name on the deal before running Data Merch."],
      legalName: ["Add an EIN or legal name on the deal before running Data Merch."],
    })
  }

  const now = nowIso()
  const queued = existing ?? await insertCheck({
    id: newId(),
    workspaceId: actor.workspaceId,
    dealId: deal.id,
    dealVersion: deal.version,
    status: "queued",
    correlationId: actor.correlationId,
    recordCount: 0,
    queryKind: identity.queryKind,
    createdAt: now,
  })
  const leaseToken = newId()
  const claim = await claimCheck({
    id: queued.id,
    workspaceId: actor.workspaceId,
    leaseToken,
    claimedAt: now,
    leaseExpiresAt: new Date(Date.now() + 120_000).toISOString(),
  })
  if (!claim.acquired) return toCheckView(claim.check)

  const finish = (input: {
    status: DataMerchCheck["status"]
    resultSummary: string
    recordCount: number
    merchants?: DataMerchMerchantPayload[]
    diagnostic: string
  }): Promise<DataMerchCheckView> => {
    return withTransaction(async (executor) => {
      const saved = await completeClaimedCheck({
        id: queued.id,
        workspaceId: actor.workspaceId,
        leaseToken,
        status: input.status,
        resultSummary: input.resultSummary,
        recordCount: input.recordCount,
        merchants: input.merchants,
        executor,
      })
      if (!saved) {
        const current = await findCheckByCorrelation(actor.workspaceId, deal.id, actor.correlationId)
        if (!current) throw new Error("Data Merch check not found after losing its claim")
        return toCheckView(current)
      }
      await updateConfigDiagnostic(actor.workspaceId, input.diagnostic, nowIso(), executor)
      await recordAuditEvent({
        context: actor,
        action: "datamerch.check_run",
        resourceType: "deal",
        resourceId: deal.id,
        metadata: { checkId: saved.id, status: saved.status, recordCount: saved.recordCount, queryKind: identity.queryKind, dealVersion: deal.version },
        correlationId: actor.correlationId,
        executor,
      })
      return toCheckView(saved)
    })
  }

  if (credentialExpired(config)) {
    return await finish({
      status: "failed",
      resultSummary: failureSummary("credential_expired"),
      recordCount: 0,
      diagnostic: "credential_expired",
    })
  }
  const credential = revealCredential(config)
  if (!credential) {
    return await finish({
      status: "failed",
      resultSummary: failureSummary("credential_unreadable"),
      recordCount: 0,
      diagnostic: "credential_unreadable",
    })
  }

  const lookup = await lookupMerchants({ credential, query: identity.query })
  if (!lookup.ok) {
    return await finish({
      status: "failed",
      resultSummary: failureSummary(lookup.kind),
      recordCount: 0,
      diagnostic: lookup.kind,
    })
  }
  if (lookup.recordCount === 0) {
    return await finish({
      status: "no_result",
      resultSummary: "No Data Merch records were found.",
      recordCount: 0,
      diagnostic: "connected",
    })
  }
  return await finish({
    status: "records",
    resultSummary: recordsSummary(lookup.merchants, lookup.recordCount),
    recordCount: lookup.recordCount,
    merchants: lookup.merchants,
    diagnostic: "connected",
  })
}

async function completeDiagnostic(stored: StoredDataMerchConfig, presentedCredential?: string): Promise<string> {
  if (credentialExpired(stored)) return "credential_expired"
  const credential = presentedCredential || revealCredential(stored)
  if (!credential) return stored.hasCredential ? "credential_unreadable" : "missing_credential"
  const lookup = await lookupMerchants({ credential, query: "connection-test" })
  if (!lookup.ok) return lookup.kind
  return "connected"
}

export async function saveDataMerchConfigWithDiagnostic(actor: DealActor, input: SaveDataMerchConfigInput): Promise<DataMerchConfig> {
  const saved = await saveDataMerchConfig(actor, { ...input, testConnection: false })
  if (!input.testConnection) return saved
  const stored = await readConfig(actor.workspaceId)
  const credential = typeof input.credential === "string" ? input.credential.trim() : undefined
  const diagnostic = await completeDiagnostic(stored, credential || undefined)
  const now = nowIso()
  await updateConfigDiagnostic(actor.workspaceId, diagnostic, now)
  await recordAuditEvent({
    context: actor,
    action: "datamerch.diagnostic",
    resourceType: "workspace",
    resourceId: actor.workspaceId,
    metadata: { diagnostic },
    correlationId: actor.correlationId,
  })
  return publicConfig(await readConfig(actor.workspaceId))
}
