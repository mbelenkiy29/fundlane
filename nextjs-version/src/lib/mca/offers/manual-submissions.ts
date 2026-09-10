import "server-only"

import { getDatabase, newId, nowIso, recordAuditEvent, withImmediateTransaction } from "../db"
import { getDealForDocument } from "../deals/service"
import type { DealActor } from "../deals/schema"
import { AppError } from "../errors"
import type { OfferRecord, OfferTermsInput } from "./contracts"
import { createOffer, selectOfferRevision } from "./service"
import { findOffer } from "./repository"

export interface ManualSubmission {
  id: string
  dealId: string
  funderId?: string
  funderName: string
  historicalAt: string
  reason: string
  state: "submitted" | "approved" | "funded"
  offerId?: string
  source: "manual" | "historical"
  idempotencyKey: string
  createdAt: string
  updatedAt: string
}

type Row = {
  id: string; deal_id: string; funder_id: string | null; funder_name: string; historical_at: string
  reason: string; state: ManualSubmission["state"]; offer_id: string | null; source: ManualSubmission["source"]
  idempotency_key: string; created_at: string; updated_at: string
}

const fromRow = (row: Row): ManualSubmission => ({ id: row.id, dealId: row.deal_id, funderId: row.funder_id ?? undefined, funderName: row.funder_name, historicalAt: row.historical_at, reason: row.reason, state: row.state, offerId: row.offer_id ?? undefined, source: row.source, idempotencyKey: row.idempotency_key, createdAt: row.created_at, updatedAt: row.updated_at })

function requireManualPermission(actor: DealActor): void {
  if (actor.source !== "user" || !["admin", "super_admin"].includes(actor.role ?? "")) throw new AppError(403, "manual_submission_permission_required", "Manual submissions require a workspace administrator session.")
}

function text(value: string, field: string, max: number): string {
  if (typeof value !== "string" || !value.trim() || value.trim().length > max) throw new AppError(422, "validation_failed", "Review the highlighted fields.", { [field]: [`Use 1 to ${max} characters.`] })
  return value.trim()
}

function historicalDate(value: string): string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}(?:T.*Z)?$/.test(value) || Number.isNaN(Date.parse(value))) throw new AppError(422, "validation_failed", "Review the highlighted fields.", { historicalAt: ["Use a valid ISO date or UTC timestamp."] })
  return value
}

async function findByKey(workspaceId: string, idempotencyKey: string): Promise<Row | undefined> {
  return getDatabase().prepare<Row>("SELECT * FROM mca_manual_submissions WHERE workspace_id = ? AND idempotency_key = ?").get(workspaceId, idempotencyKey)
}

export async function listManualSubmissions(actor: DealActor, dealId: string): Promise<ManualSubmission[]> {
  requireManualPermission(actor)
  await getDealForDocument(actor, dealId)
  const rows = await getDatabase().prepare<Row>("SELECT * FROM mca_manual_submissions WHERE workspace_id = ? AND deal_id = ? ORDER BY historical_at, created_at, id").all(actor.workspaceId, dealId)
  return rows.map(fromRow)
}

/** Creates local history only. This path never imports or invokes a delivery adapter. */
export async function createManualSubmission(actor: DealActor, input: {
  dealId: string; funderId?: string; funderName: string; historicalAt: string; reason: string
  idempotencyKey: string; source?: "manual" | "historical"
}): Promise<{ submission: ManualSubmission; replayed: boolean }> {
  requireManualPermission(actor)
  await getDealForDocument(actor, input.dealId)
  const idempotencyKey = text(input.idempotencyKey, "idempotencyKey", 160)
  const replay = await findByKey(actor.workspaceId, idempotencyKey)
  if (replay) return { submission: fromRow(replay), replayed: true }
  return withImmediateTransaction(async (database) => {
    const lockedReplay = await database.prepare<Row>("SELECT * FROM mca_manual_submissions WHERE workspace_id = ? AND idempotency_key = ? FOR UPDATE").get(actor.workspaceId, idempotencyKey)
    if (lockedReplay) return { submission: fromRow(lockedReplay), replayed: true }
    if (input.funderId && !await database.prepare("SELECT id FROM mca_funders WHERE workspace_id = ? AND id = ?").get(actor.workspaceId, input.funderId)) throw new AppError(422, "funder_not_found", "The selected funder does not belong to this workspace.")
    const id = newId(), now = nowIso(), source = input.source ?? "manual"
    if (!(["manual", "historical"] as const).includes(source)) throw new AppError(422, "validation_failed", "Choose a supported manual submission source.")
    await database.prepare(`INSERT INTO mca_manual_submissions
      (id, workspace_id, deal_id, funder_id, funder_name, historical_at, reason, state, offer_id, source,
       idempotency_key, created_by_user_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'submitted', NULL, ?, ?, ?, ?, ?)`).run(
      id, actor.workspaceId, input.dealId, input.funderId ?? null, text(input.funderName, "funderName", 200),
      historicalDate(input.historicalAt), text(input.reason, "reason", 500), source, idempotencyKey, actor.userId, now, now,
    )
    await recordAuditEvent({ context: actor, action: "submission.manual_created", resourceType: "manual_submission", resourceId: id, metadata: { dealId: input.dealId, source, historicalAt: input.historicalAt, outboundJobCreated: false }, correlationId: actor.correlationId, executor: database })
    const saved = await database.prepare<Row>("SELECT * FROM mca_manual_submissions WHERE workspace_id = ? AND id = ?").get(actor.workspaceId, id)
    if (!saved) throw new Error("Manual submission was not persisted")
    return { submission: fromRow(saved), replayed: false }
  })
}

export async function approveManualSubmission(actor: DealActor, input: { submissionId: string; terms: OfferTermsInput }): Promise<{ submission: ManualSubmission; offer: OfferRecord; replayed: boolean }> {
  requireManualPermission(actor)
  const initial = await getDatabase().prepare<Row>("SELECT * FROM mca_manual_submissions WHERE workspace_id = ? AND id = ?").get(actor.workspaceId, input.submissionId)
  if (!initial) throw new AppError(404, "manual_submission_not_found", "The requested manual submission was not found.")
  await getDealForDocument(actor, initial.deal_id)
  return withImmediateTransaction(async (database) => {
    const row = await database.prepare<Row>("SELECT * FROM mca_manual_submissions WHERE workspace_id = ? AND id = ? FOR UPDATE").get(actor.workspaceId, input.submissionId)
    if (!row) throw new AppError(404, "manual_submission_not_found", "The requested manual submission was not found.")
    if (row.offer_id) {
      const offer = await findOffer(actor.workspaceId, row.offer_id, database)
      if (!offer) throw new Error("Manual submission points to a missing offer")
      return { submission: fromRow(row), offer, replayed: true }
    }
    const offer = await createOffer(actor, { dealId: row.deal_id, funderId: row.funder_id ?? undefined, funderName: row.funder_name, source: row.source, externalId: `manual-submission:${row.id}`, terms: { ...input.terms, effectiveAt: input.terms.effectiveAt ?? row.historical_at } })
    await selectOfferRevision(actor, { dealId: row.deal_id, offerId: offer.id, revisionId: offer.currentRevisionId, selected: true, reason: "manual_approval" })
    const now = nowIso()
    await database.prepare("UPDATE mca_manual_submissions SET state = 'approved', offer_id = ?, updated_at = ? WHERE workspace_id = ? AND id = ?").run(offer.id, now, actor.workspaceId, row.id)
    await recordAuditEvent({ context: actor, action: "submission.manual_approved", resourceType: "manual_submission", resourceId: row.id, metadata: { dealId: row.deal_id, offerId: offer.id, revisionId: offer.currentRevisionId }, correlationId: actor.correlationId, executor: database })
    return { submission: { ...fromRow(row), state: "approved", offerId: offer.id, updatedAt: now }, offer: { ...offer, selectedRevisionIds: [offer.currentRevisionId] }, replayed: false }
  })
}
