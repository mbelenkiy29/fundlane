import "server-only"

import { createHash } from "node:crypto"
import { getDatabase, newId, parseJson, recordAuditEvent, withTransaction, type DbExecutor } from "../db"
import type { DealActor } from "../deals/schema"
import type { AdapterStatusResult, SubmissionJob } from "./contracts"
import { nowIso } from "./clock"
import { insertAttempt, insertDealSubmissionCache } from "./repository"

export const STATUS_MAPPING_VERSION = 1 as const

export const NORMALIZED_STATUSES = ["submitted", "pending", "approved", "declined", "funded", "unknown"] as const
export type NormalizedProviderStatus = (typeof NORMALIZED_STATUSES)[number]

export const OFFER_ROW_STATUSES = ["received", "presented", "accepted", "declined", "expired"] as const
export type OfferRowStatus = (typeof OFFER_ROW_STATUSES)[number]

const STATUS_ALIASES_V1: Record<string, Exclude<NormalizedProviderStatus, "unknown">> = {
  submitted: "submitted",
  received: "submitted",
  sent: "submitted",
  accepted: "submitted",
  pending: "pending",
  inreview: "pending",
  in_review: "pending",
  underreview: "pending",
  under_review: "pending",
  processing: "pending",
  review: "pending",
  approved: "approved",
  offered: "approved",
  offer: "approved",
  preapproved: "approved",
  pre_approved: "approved",
  declined: "declined",
  rejected: "declined",
  deny: "declined",
  denied: "declined",
  funded: "funded",
  funding: "funded",
  disbursed: "funded",
}

const STATUS_RANK: Record<NormalizedProviderStatus, number> = {
  unknown: 0,
  submitted: 1,
  pending: 2,
  approved: 3,
  declined: 3,
  funded: 4,
}

type OfferRow = {
  id: string
  workspace_id: string
  deal_id: string
  submission_id: string
  status: string
  amount: number | null
  rate: number | null
  term: number | null
  frequency: string | null
  commission: number | null
  fees_json: string | null
  offer_link: string | null
  source: string | null
  raw_status: string | null
  evidence_json: string | null
  terms_unknown: number | string
}

type SubmissionRow = {
  id: string
  status: string
}

export interface OfferEvidence {
  mappingVersion: number
  rawStatus: string
  normalized: NormalizedProviderStatus
  unknown: boolean
  rank: number
  source: "poll" | "webhook"
  eventId?: string
  correlationId: string
  processedEventKeys: string[]
}

export interface MappedProviderStatus {
  mappingVersion: typeof STATUS_MAPPING_VERSION
  rawStatus: string
  normalized: NormalizedProviderStatus
  unknown: boolean
  rank: number
}

export interface ReconcileProviderStatusInput {
  job: SubmissionJob
  status: AdapterStatusResult
  source: "poll" | "webhook"
  eventKey?: string
  actor?: DealActor
}

export interface ReconciledOfferView {
  id: string
  status: OfferRowStatus
  created: boolean
  updated: boolean
  amount?: number
  rate?: number
  term?: number
  frequency?: string
  commission?: number
  offerLink?: string
  rawStatus?: string
  termsUnknown: boolean
}

export interface ReconcileProviderStatusResult {
  ok: true
  jobId: string
  dealId: string
  funderId: string
  duplicate: boolean
  ignored: boolean
  ignoredReason?: "funded_terminal" | "stale_rank" | "replay"
  unknown: boolean
  rawStatus: string
  normalized: NormalizedProviderStatus
  mappingVersion: number
  offer?: ReconciledOfferView
  submissionStatus: string
  correlationId: string
  eventId?: string
}

function db(): DbExecutor {
  return getDatabase()
}

function token(raw: string): string {
  return raw.trim().toLowerCase().replace(/[\s-]+/g, "_").replace(/[^a-z0-9_]/g, "")
}

function asNormalized(value: unknown): NormalizedProviderStatus | undefined {
  if (typeof value !== "string") return undefined
  return NORMALIZED_STATUSES.includes(value as NormalizedProviderStatus) ? value as NormalizedProviderStatus : undefined
}

export function mapProviderStatus(rawStatus: string, adapter?: Pick<AdapterStatusResult, "normalized" | "unknown">): MappedProviderStatus {
  const raw = rawStatus.trim()
  const fromTable = STATUS_ALIASES_V1[token(raw)]
  const adapterNormalized = asNormalized(adapter?.normalized)
  let normalized: NormalizedProviderStatus
  if (fromTable) normalized = fromTable
  else if (adapterNormalized && adapterNormalized !== "unknown" && adapter?.unknown !== true) normalized = adapterNormalized
  else normalized = "unknown"
  if (adapter?.unknown === true && !fromTable) normalized = "unknown"
  const unknown = normalized === "unknown"
  return {
    mappingVersion: STATUS_MAPPING_VERSION,
    rawStatus: raw,
    normalized,
    unknown,
    rank: STATUS_RANK[normalized],
  }
}

export function hasFinancialTerms(terms?: AdapterStatusResult["terms"]): boolean {
  if (!terms) return false
  return [terms.amount, terms.rate, terms.term, terms.commission].some((value) => typeof value === "number" && Number.isFinite(value))
}

function offerRowStatus(normalized: NormalizedProviderStatus): OfferRowStatus {
  if (normalized === "funded") return "accepted"
  if (normalized === "declined") return "declined"
  if (normalized === "approved") return "presented"
  return "received"
}

function cacheStatus(mapped: MappedProviderStatus, current?: string): string {
  if (mapped.unknown) {
    if (current === "approved" || current === "declined") return current
    return mapped.rawStatus || current || "sent"
  }
  if (mapped.normalized === "declined") return "declined"
  if (mapped.normalized === "approved" || mapped.normalized === "funded") return "approved"
  return "sent"
}

export function eventAttemptKey(eventKey: string): string {
  return `evt:${createHash("sha256").update(eventKey).digest("hex")}`
}

function evidenceFrom(row: OfferRow | undefined): OfferEvidence | undefined {
  if (!row?.evidence_json) return undefined
  const parsed = parseJson<Partial<OfferEvidence>>(row.evidence_json, {})
  const normalized = asNormalized(parsed.normalized) ?? mapProviderStatus(row.raw_status ?? row.status).normalized
  return {
    mappingVersion: typeof parsed.mappingVersion === "number" ? parsed.mappingVersion : STATUS_MAPPING_VERSION,
    rawStatus: typeof parsed.rawStatus === "string" ? parsed.rawStatus : row.raw_status ?? "",
    normalized,
    unknown: parsed.unknown === true || normalized === "unknown",
    rank: typeof parsed.rank === "number" ? parsed.rank : STATUS_RANK[normalized],
    source: parsed.source === "webhook" ? "webhook" : "poll",
    eventId: parsed.eventId,
    correlationId: parsed.correlationId ?? "",
    processedEventKeys: Array.isArray(parsed.processedEventKeys) ? parsed.processedEventKeys.filter((item): item is string => typeof item === "string") : [],
  }
}

function viewFromRow(row: OfferRow, created: boolean, updated: boolean): ReconciledOfferView {
  return {
    id: row.id,
    status: OFFER_ROW_STATUSES.includes(row.status as OfferRowStatus) ? row.status as OfferRowStatus : "received",
    created,
    updated,
    amount: row.amount ?? undefined,
    rate: row.rate ?? undefined,
    term: row.term ?? undefined,
    frequency: row.frequency ?? undefined,
    commission: row.commission ?? undefined,
    offerLink: row.offer_link ?? undefined,
    rawStatus: row.raw_status ?? undefined,
    termsUnknown: Number(row.terms_unknown) !== 0,
  }
}

async function submissionForJob(job: SubmissionJob, executor: DbExecutor): Promise<SubmissionRow> {
  const existing = await executor.prepare<SubmissionRow>(
    "SELECT id, status FROM deal_submissions WHERE workspace_id = ? AND job_id = ? FOR UPDATE",
  ).get(job.workspaceId, job.id)
  if (existing) return existing
  await insertDealSubmissionCache({
    workspaceId: job.workspaceId,
    dealId: job.dealId,
    funderName: job.displayFunderName,
    status: "sent",
    funderId: job.funderId,
    jobId: job.id,
    routeKind: job.routeKind,
  }, executor)
  const created = await executor.prepare<SubmissionRow>(
    "SELECT id, status FROM deal_submissions WHERE workspace_id = ? AND job_id = ? FOR UPDATE",
  ).get(job.workspaceId, job.id)
  if (!created) throw new Error("Deal submission cache was not found after insert.")
  return created
}

async function offerForSubmission(workspaceId: string, submissionId: string, executor: DbExecutor): Promise<OfferRow | undefined> {
  return executor.prepare<OfferRow>(
    "SELECT * FROM deal_offers WHERE workspace_id = ? AND submission_id = ? AND COALESCE(source, 'api') = 'api' ORDER BY id ASC LIMIT 1 FOR UPDATE",
  ).get(workspaceId, submissionId)
}

function termsUnknown(terms: NonNullable<AdapterStatusResult["terms"]>): boolean {
  return ![terms.amount, terms.rate, terms.term].every((value) => typeof value === "number" && Number.isFinite(value))
}

function currentRank(row: OfferRow | undefined, evidence?: OfferEvidence): number {
  if (row?.status === "accepted") return STATUS_RANK.funded
  if (evidence) return evidence.rank
  if (!row) return -1
  if (row.status === "declined") return STATUS_RANK.declined
  if (row.status === "presented") return STATUS_RANK.approved
  return STATUS_RANK.pending
}

function shouldIgnore(row: OfferRow | undefined, mapped: MappedProviderStatus, evidence?: OfferEvidence): ReconcileProviderStatusResult["ignoredReason"] | undefined {
  if (!row) return undefined
  const rank = currentRank(row, evidence)
  if (row.status === "accepted" && mapped.normalized !== "funded") return "funded_terminal"
  if (mapped.unknown) return rank > 0 ? "stale_rank" : undefined
  if (mapped.rank < rank) return rank >= STATUS_RANK.funded ? "funded_terminal" : "stale_rank"
  return undefined
}

function snapshotEvidence(input: {
  mapped: MappedProviderStatus
  status: AdapterStatusResult
  source: "poll" | "webhook"
  eventKey?: string
  previous?: OfferEvidence
}): OfferEvidence {
  const keys = new Set(input.previous?.processedEventKeys ?? [])
  if (input.eventKey) keys.add(input.eventKey)
  return {
    mappingVersion: input.mapped.mappingVersion,
    rawStatus: input.mapped.rawStatus,
    normalized: input.mapped.normalized,
    unknown: input.mapped.unknown,
    rank: input.mapped.rank,
    source: input.source,
    eventId: input.status.eventId,
    correlationId: input.status.correlationId,
    processedEventKeys: [...keys],
  }
}

async function writeOffer(input: {
  job: SubmissionJob
  submissionId: string
  mapped: MappedProviderStatus
  status: AdapterStatusResult
  source: "poll" | "webhook"
  eventKey?: string
  current?: OfferRow
  executor: DbExecutor
}): Promise<{ row: OfferRow; created: boolean; updated: boolean }> {
  const terms = input.status.terms ?? {}
  const evidence = snapshotEvidence({
    mapped: input.mapped,
    status: input.status,
    source: input.source,
    eventKey: input.eventKey,
    previous: evidenceFrom(input.current),
  })
  const nextStatus = input.current?.status === "accepted" ? "accepted" : offerRowStatus(input.mapped.normalized)
  const amount = typeof terms.amount === "number" && Number.isFinite(terms.amount) ? terms.amount : input.current?.amount ?? null
  const rate = typeof terms.rate === "number" && Number.isFinite(terms.rate) ? terms.rate : input.current?.rate ?? null
  const term = typeof terms.term === "number" && Number.isFinite(terms.term) ? Math.trunc(terms.term) : input.current?.term ?? null
  const frequency = terms.frequency?.trim() || input.current?.frequency || null
  const commission = typeof terms.commission === "number" && Number.isFinite(terms.commission) ? terms.commission : input.current?.commission ?? null
  const offerLink = terms.offerLink?.trim() || input.current?.offer_link || null
  const unknownTerms = termsUnknown({ amount: amount ?? undefined, rate: rate ?? undefined, term: term ?? undefined, frequency: frequency ?? undefined, commission: commission ?? undefined })
  if (!input.current) {
    const id = newId()
    await input.executor.prepare(`INSERT INTO deal_offers
      (id, workspace_id, deal_id, submission_id, status, amount, rate, term, frequency, commission, fees_json, offer_link, source, raw_status, evidence_json, terms_unknown)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, 'api', ?, ?, ?)`).run(
      id,
      input.job.workspaceId,
      input.job.dealId,
      input.submissionId,
      nextStatus,
      amount,
      rate,
      term,
      frequency,
      commission,
      offerLink,
      input.mapped.rawStatus,
      JSON.stringify(evidence),
      unknownTerms ? 1 : 0,
    )
    const created = await input.executor.prepare<OfferRow>("SELECT * FROM deal_offers WHERE workspace_id = ? AND id = ?").get(input.job.workspaceId, id)
    if (!created) throw new Error("Deal offer was not found after insert.")
    return { row: created, created: true, updated: false }
  }
  await input.executor.prepare(`UPDATE deal_offers SET
    status = ?, amount = ?, rate = ?, term = ?, frequency = ?, commission = ?, offer_link = ?, source = 'api', raw_status = ?, evidence_json = ?, terms_unknown = ?
    WHERE workspace_id = ? AND id = ?`).run(
    nextStatus,
    amount,
    rate,
    term,
    frequency,
    commission,
    offerLink,
    input.mapped.unknown ? input.current.raw_status ?? input.mapped.rawStatus : input.mapped.rawStatus,
    JSON.stringify(evidence),
    unknownTerms ? 1 : 0,
    input.job.workspaceId,
    input.current.id,
  )
  const updated = await input.executor.prepare<OfferRow>("SELECT * FROM deal_offers WHERE workspace_id = ? AND id = ?").get(input.job.workspaceId, input.current.id)
  if (!updated) throw new Error("Deal offer was not found after update.")
  return { row: updated, created: false, updated: true }
}

function resultOf(input: {
  job: SubmissionJob
  mapped: MappedProviderStatus
  status: AdapterStatusResult
  duplicate: boolean
  ignored: boolean
  ignoredReason?: ReconcileProviderStatusResult["ignoredReason"]
  offer?: ReconciledOfferView
  submissionStatus: string
}): ReconcileProviderStatusResult {
  return {
    ok: true,
    jobId: input.job.id,
    dealId: input.job.dealId,
    funderId: input.job.funderId,
    duplicate: input.duplicate,
    ignored: input.ignored,
    ignoredReason: input.ignoredReason,
    unknown: input.mapped.unknown,
    rawStatus: input.mapped.rawStatus,
    normalized: input.mapped.normalized,
    mappingVersion: input.mapped.mappingVersion,
    offer: input.offer,
    submissionStatus: input.submissionStatus,
    correlationId: input.status.correlationId,
    eventId: input.status.eventId,
  }
}

export async function reconcileProviderStatus(input: ReconcileProviderStatusInput): Promise<ReconcileProviderStatusResult> {
  const mapped = mapProviderStatus(input.status.rawStatus, input.status)
  const eventKey = input.eventKey?.trim() || (input.status.eventId ? `${input.source}:${input.status.eventId}` : undefined)

  return withTransaction(async (executor) => {
    const submission = await submissionForJob(input.job, executor)
    const currentOffer = await offerForSubmission(input.job.workspaceId, submission.id, executor)
    const evidence = evidenceFrom(currentOffer)

    if (eventKey) {
      const reserved = await insertAttempt({
        workspaceId: input.job.workspaceId,
        jobId: input.job.id,
        attemptKey: eventAttemptKey(eventKey),
        transport: "api",
        state: "sent",
        correlationId: input.status.correlationId,
        externalRef: input.status.eventId,
        errorCode: "provider_status",
        errorMessage: JSON.stringify({
          mappingVersion: mapped.mappingVersion,
          rawStatus: mapped.rawStatus,
          normalized: mapped.normalized,
          unknown: mapped.unknown,
          source: input.source,
        }),
      }, executor)
      if (!reserved.created) {
        return resultOf({
          job: input.job,
          mapped: currentOffer?.raw_status
            ? { ...mapped, rawStatus: currentOffer.raw_status, normalized: evidence?.normalized ?? mapped.normalized, unknown: evidence?.unknown ?? mapped.unknown, rank: evidence?.rank ?? mapped.rank }
            : mapped,
          status: input.status,
          duplicate: true,
          ignored: false,
          ignoredReason: "replay",
          offer: currentOffer ? viewFromRow(currentOffer, false, false) : undefined,
          submissionStatus: submission.status,
        })
      }
    }

    const ignoreReason = shouldIgnore(currentOffer, mapped, evidence)
    const nextCache = ignoreReason ? submission.status : cacheStatus(mapped, submission.status)
    if (!ignoreReason) {
      await insertDealSubmissionCache({
        workspaceId: input.job.workspaceId,
        dealId: input.job.dealId,
        funderName: input.job.displayFunderName,
        status: nextCache,
        funderId: input.job.funderId,
        jobId: input.job.id,
        routeKind: input.job.routeKind,
      }, executor)
    }

    let offerView: ReconciledOfferView | undefined
    if (!ignoreReason && hasFinancialTerms(input.status.terms)) {
      const saved = await writeOffer({
        job: input.job,
        submissionId: submission.id,
        mapped,
        status: input.status,
        source: input.source,
        eventKey,
        current: currentOffer,
        executor,
      })
      offerView = viewFromRow(saved.row, saved.created, saved.updated)
    } else if (currentOffer) {
      offerView = viewFromRow(currentOffer, false, false)
    }

    const result = resultOf({
      job: input.job,
      mapped,
      status: input.status,
      duplicate: false,
      ignored: Boolean(ignoreReason),
      ignoredReason: ignoreReason,
      offer: offerView,
      submissionStatus: ignoreReason ? submission.status : nextCache,
    })

    const actor = input.actor ?? {
      workspaceId: input.job.workspaceId,
      userId: null,
      membershipId: null,
      role: null,
      managedMembershipIds: [],
      activeMembershipIds: [],
      source: "system" as const,
      correlationId: input.status.correlationId,
    }
    await recordAuditEvent({
      context: actor,
      action: ignoreReason ? "submission.status_ignored" : offerView?.created ? "submission.offer_reconciled" : "submission.status_updated",
      resourceType: offerView ? "deal_offer" : "submission_job",
      resourceId: offerView?.id ?? input.job.id,
      metadata: {
        jobId: input.job.id,
        dealId: input.job.dealId,
        funderId: input.job.funderId,
        source: input.source,
        rawStatus: mapped.rawStatus,
        normalized: mapped.normalized,
        unknown: mapped.unknown,
        mappingVersion: mapped.mappingVersion,
        duplicate: false,
        ignored: Boolean(ignoreReason),
        ignoredReason: ignoreReason,
        offerId: offerView?.id,
        eventId: input.status.eventId,
      },
      correlationId: input.status.correlationId,
      executor,
    })
    return result
  })
}

export async function listApiOffersForDeal(workspaceId: string, dealId: string, executor: DbExecutor = db()): Promise<ReconciledOfferView[]> {
  const rows = await executor.prepare<OfferRow>(
    "SELECT * FROM deal_offers WHERE workspace_id = ? AND deal_id = ? AND COALESCE(source, 'api') = 'api' ORDER BY id ASC",
  ).all(workspaceId, dealId)
  return rows.map((row) => viewFromRow(row, false, false))
}
