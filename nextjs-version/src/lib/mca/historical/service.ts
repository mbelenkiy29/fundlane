import "server-only"

import { createHash } from "node:crypto"
import { reconcilePayment } from "../accounting/service"
import { getDatabase, newId, nowIso, parseJson, recordAuditEvent, withImmediateTransaction } from "../db"
import { createDeal, getDealForDocument } from "../deals/service"
import type { DealActor } from "../deals/schema"
import { AppError } from "../errors"
import { confirmOfferFunding } from "../funding/service"
import { writeFundingAccounting } from "../accounting/funding-writer"
import type { FundingAccountingWriter } from "../funding/contracts"
import { approveManualSubmission, createManualSubmission } from "../offers/manual-submissions"
import type { HistoricalFundingRowInput, HistoricalImportPreview, HistoricalImportResult, HistoricalRowPreview } from "./contracts"

type RunRow = { id: string; source_id: string; state: "preview" | "committed" | "failed"; preview_revision: number; totals_json: string; reconciliation_json: string }
type StoredRow = { id: string; row_number: number; normalized_json: string; validation_errors_json: string; duplicate: number; outcome: string; funding_event_id: string | null }

function requireImportPermission(actor: DealActor): void {
  if (actor.source !== "user" || !["admin", "super_admin"].includes(actor.role ?? "")) throw new AppError(403, "historical_import_permission_required", "Historical funding imports require a workspace administrator session.")
}

function dateValid(value: unknown): value is string { return typeof value === "string" && /^\d{4}-\d{2}-\d{2}(?:T.*Z)?$/.test(value) && !Number.isNaN(Date.parse(value)) }
function centsValid(value: unknown, positive = false): value is number { return Number.isSafeInteger(value) && (positive ? Number(value) > 0 : Number(value) >= 0) }

async function validateRow(actor: DealActor, sourceId: string, raw: HistoricalFundingRowInput, rowNumber: number, seen: Set<string>): Promise<HistoricalRowPreview> {
  const errors: string[] = []
  const externalId = typeof raw.externalId === "string" ? raw.externalId.trim() : ""
  if (!externalId || externalId.length > 160) errors.push("External ID is required and must be at most 160 characters.")
  if (!raw.dealId && !(typeof raw.legalName === "string" && raw.legalName.trim())) errors.push("Provide an existing deal ID or a legal name for a new historical deal.")
  if (raw.dealId) { try { await getDealForDocument(actor, raw.dealId) } catch { errors.push("Deal ID was not found or is not accessible.") } }
  if (typeof raw.funderName !== "string" || !raw.funderName.trim()) errors.push("Funder name is required.")
  if (!dateValid(raw.fundedAt)) errors.push("Funding date must be a valid ISO date or UTC timestamp.")
  if (!centsValid(raw.amountCents, true)) errors.push("Amount must be positive integer cents.")
  for (const [name, value] of [["commission", raw.commissionCents], ["paid commission", raw.paidCommissionCents], ["fee", raw.feeCents]] as const) if (value !== undefined && !centsValid(value)) errors.push(`${name} must be non-negative integer cents.`)
  if ((raw.paidCommissionCents ?? 0) > (raw.commissionCents ?? 0)) errors.push("Paid commission cannot exceed expected commission.")
  if ((raw.paidCommissionCents ?? 0) > 0 && !dateValid(raw.paidCommissionAt)) errors.push("Paid commission date is required when paid commission is present.")
  if (raw.expectedCommissionAt && !dateValid(raw.expectedCommissionAt)) errors.push("Expected commission date is invalid.")
  if (raw.expectedFeeAt && !dateValid(raw.expectedFeeAt)) errors.push("Expected fee date is invalid.")
  const schedule = [raw.paymentCount, raw.paymentFrequency, raw.calendarConvention]
  if (schedule.some((item) => item !== undefined) && schedule.some((item) => item === undefined)) errors.push("Payment count, frequency, and calendar convention must be supplied together.")
  if (raw.paidSplits?.length) {
    const expectedRecipients = new Set((raw.splits ?? []).map((item) => item.recipientMembershipId))
    const paidRecipients = new Set<string>()
    let paidTotal = 0
    for (const split of raw.paidSplits) {
      if (!expectedRecipients.has(split.recipientMembershipId) || paidRecipients.has(split.recipientMembershipId)) errors.push("Paid split recipients must be unique and present in the expected split configuration.")
      paidRecipients.add(split.recipientMembershipId)
      if (!centsValid(split.amountCents) || !dateValid(split.paidAt)) errors.push("Paid split history requires integer cents and a valid paid date.")
      paidTotal += centsValid(split.amountCents) ? split.amountCents : 0
    }
    if (paidTotal !== (raw.paidCommissionCents ?? 0)) errors.push("Paid split amounts must total paid commission cents.")
  }
  const persisted = Boolean(externalId && await getDatabase().prepare("SELECT id FROM mca_historical_import_rows WHERE workspace_id = ? AND source_id = ? AND external_id = ?").get(actor.workspaceId, sourceId, externalId))
  const duplicate = persisted || seen.has(externalId)
  if (externalId) seen.add(externalId)
  return { ...raw, externalId, legalName: raw.legalName?.trim() || undefined, funderName: raw.funderName?.trim() ?? "", rowNumber, duplicate, errors }
}

function totals(rows: HistoricalRowPreview[]) {
  const included = rows.filter((row) => !row.duplicate && row.errors.length === 0)
  return { rows: rows.length, valid: included.length, invalid: rows.filter((row) => row.errors.length > 0).length, duplicates: rows.filter((row) => row.duplicate).length, principalCents: included.reduce((sum, row) => sum + row.amountCents, 0), expectedCommissionCents: included.reduce((sum, row) => sum + (row.commissionCents ?? 0), 0), paidCommissionCents: included.reduce((sum, row) => sum + (row.paidCommissionCents ?? 0), 0), feeCents: included.reduce((sum, row) => sum + (row.feeCents ?? 0), 0) }
}

function historicalIdentity(sourceId: string, externalId: string): string {
  return createHash("sha256").update(JSON.stringify([sourceId, externalId])).digest("hex")
}

export async function previewHistoricalImport(actor: DealActor, input: { sourceId: string; batchId: string; rows: HistoricalFundingRowInput[] }): Promise<HistoricalImportPreview> {
  requireImportPermission(actor)
  if (!input.sourceId?.trim() || !input.batchId?.trim()) throw new AppError(422, "validation_failed", "Source and batch IDs are required.")
  if (!Array.isArray(input.rows) || !input.rows.length || input.rows.length > 5000) throw new AppError(422, "validation_failed", "Provide 1 to 5,000 historical rows.")
  const prior = await getDatabase().prepare<RunRow>("SELECT * FROM mca_historical_import_runs WHERE workspace_id = ? AND source_id = ? AND batch_id = ?").get(actor.workspaceId, input.sourceId.trim(), input.batchId.trim())
  if (prior) return getHistoricalImport(actor, prior.id)
  const rows: HistoricalRowPreview[] = []
  const seen = new Set<string>()
  for (const [index, row] of input.rows.entries()) rows.push(await validateRow(actor, input.sourceId.trim(), row, index + 2, seen))
  const summary = totals(rows), runId = newId(), createdAt = nowIso()
  const concurrentRunId = await withImmediateTransaction(async (database) => {
    await database.prepare("SELECT pg_advisory_xact_lock(hashtext(?))").get(`${actor.workspaceId}:${input.sourceId.trim()}:${input.batchId.trim()}`)
    const existing = await database.prepare<RunRow>("SELECT * FROM mca_historical_import_runs WHERE workspace_id = ? AND source_id = ? AND batch_id = ? FOR UPDATE").get(actor.workspaceId, input.sourceId.trim(), input.batchId.trim())
    if (existing) return existing.id
    await database.prepare(`INSERT INTO mca_historical_import_runs
      (id, workspace_id, source_id, batch_id, state, preview_revision, totals_json, reconciliation_json, created_by_user_id, created_at)
      VALUES (?, ?, ?, ?, 'preview', 1, ?, '{}', ?, ?)`).run(runId, actor.workspaceId, input.sourceId.trim(), input.batchId.trim(), JSON.stringify(summary), actor.userId, createdAt)
    for (const row of rows) {
      if (row.duplicate) continue
      await database.prepare(`INSERT INTO mca_historical_import_rows
        (id, workspace_id, run_id, source_id, external_id, row_number, normalized_json, validation_errors_json, duplicate, outcome, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
        ON CONFLICT (workspace_id, source_id, external_id) DO NOTHING`).run(newId(), actor.workspaceId, runId, input.sourceId.trim(), row.externalId, row.rowNumber, JSON.stringify(row), JSON.stringify(row.errors), row.errors.length ? "invalid" : "pending", createdAt)
    }
    await recordAuditEvent({ context: actor, action: "historical.preview_created", resourceType: "historical_import", resourceId: runId, metadata: summary, correlationId: actor.correlationId, executor: database })
    return undefined
  })
  if (concurrentRunId) return getHistoricalImport(actor, concurrentRunId)
  return { runId, state: "preview", previewRevision: 1, rows, totals: summary }
}

export async function getHistoricalImport(actor: DealActor, runId: string): Promise<HistoricalImportPreview & { reconciliation?: HistoricalImportResult }> {
  requireImportPermission(actor)
  const run = await getDatabase().prepare<RunRow>("SELECT * FROM mca_historical_import_runs WHERE workspace_id = ? AND id = ?").get(actor.workspaceId, runId)
  if (!run) throw new AppError(404, "historical_import_not_found", "The historical import was not found.")
  const stored = await getDatabase().prepare<StoredRow>("SELECT * FROM mca_historical_import_rows WHERE workspace_id = ? AND run_id = ? ORDER BY row_number").all(actor.workspaceId, runId)
  return { runId, state: run.state, previewRevision: Number(run.preview_revision), rows: stored.map((row) => ({ ...parseJson<HistoricalRowPreview>(row.normalized_json, {} as HistoricalRowPreview), rowNumber: Number(row.row_number), duplicate: Boolean(row.duplicate), errors: parseJson(row.validation_errors_json, []) })), totals: parseJson(run.totals_json, totals([])), reconciliation: parseJson<HistoricalImportResult | undefined>(run.reconciliation_json, undefined) }
}

export async function commitHistoricalImport(
  actor: DealActor,
  input: { runId: string; expectedPreviewRevision: number },
  accountingWriter: FundingAccountingWriter = writeFundingAccounting,
): Promise<HistoricalImportResult> {
  requireImportPermission(actor)
  return withImmediateTransaction(async (database) => {
    await database.prepare("SELECT pg_advisory_xact_lock(hashtext(?))").get(`${actor.workspaceId}:${input.runId}`)
    const run = await database.prepare<RunRow>("SELECT * FROM mca_historical_import_runs WHERE workspace_id = ? AND id = ? FOR UPDATE").get(actor.workspaceId, input.runId)
    if (!run) throw new AppError(404, "historical_import_not_found", "The historical import was not found.")
    if (run.state === "committed") return parseJson(run.reconciliation_json, { runId: input.runId, state: "committed", created: 0, duplicates: 0, invalid: 0, failed: 0, principalCents: 0, expectedCommissionCents: 0, paidCommissionCents: 0, fundingEventIds: [] })
    if (Number(run.preview_revision) !== input.expectedPreviewRevision) throw new AppError(409, "historical_preview_stale", "The import preview changed. Refresh before committing.")
    const rows = await database.prepare<StoredRow>("SELECT * FROM mca_historical_import_rows WHERE workspace_id = ? AND run_id = ? ORDER BY row_number").all(actor.workspaceId, input.runId)
    let created = 0, invalid = 0, failed = 0, principalCents = 0, expectedCommissionCents = 0, paidCommissionCents = 0
    const fundingEventIds: string[] = []
    for (const stored of rows) {
      const row = parseJson<HistoricalRowPreview>(stored.normalized_json, {} as HistoricalRowPreview)
      if (stored.outcome === "created") {
        created += 1; principalCents += row.amountCents ?? 0; expectedCommissionCents += row.commissionCents ?? 0; paidCommissionCents += row.paidCommissionCents ?? 0
        if (stored.funding_event_id) fundingEventIds.push(stored.funding_event_id)
        continue
      }
      if (row.errors?.length) { invalid += 1; continue }
      await database.execute("SAVEPOINT historical_row")
      try {
        const identity = historicalIdentity(run.source_id, row.externalId)
        const dealId = row.dealId ?? (await createDeal(actor, { legalName: row.legalName, idempotencyKey: `historical:${identity}`, fieldSource: "import" })).deal.id
        const manual = await createManualSubmission(actor, { dealId, funderId: row.funderId, funderName: row.funderName, historicalAt: row.fundedAt, reason: `Historical import ${input.runId}`, idempotencyKey: `historical-submission:${identity}`, source: "historical" })
        const approved = await approveManualSubmission(actor, { submissionId: manual.submission.id, terms: { amountCents: row.amountCents, factorRate: row.factorRate, termMonths: row.termMonths, paymentAmountCents: row.paymentAmountCents, paymentFrequency: row.paymentFrequency, commissionCents: row.commissionCents, feeCents: row.feeCents, effectiveAt: row.fundedAt } })
        const funding = await confirmOfferFunding(actor, { dealId, offerId: approved.offer.id, offerRevisionId: approved.offer.currentRevisionId, manualSubmissionId: manual.submission.id, idempotencyKey: `historical-funding:${identity}`, fundedAt: row.fundedAt, amountCents: row.amountCents, commissionCents: row.commissionCents, feeCents: row.feeCents, expectedCommissionAt: row.expectedCommissionAt, expectedFeeAt: row.expectedFeeAt, paymentCount: row.paymentCount, paymentFrequency: row.paymentFrequency, calendarConvention: row.calendarConvention, splits: row.splits, source: "historical" }, accountingWriter)
        if ((row.paidCommissionCents ?? 0) > 0) {
          const payment = await database.prepare<{ id: string }>("SELECT id FROM mca_accounting_payments WHERE workspace_id = ? AND advance_id = ? AND type = 'commission'").get(actor.workspaceId, funding.advanceId)
          if (!payment) throw new Error("Historical commission payment record was not created")
          await reconcilePayment(actor, payment.id, { receivedAmountCents: row.paidCommissionCents!, receivedAt: row.paidCommissionAt! })
          for (const paid of row.paidSplits ?? []) {
            const updated = await database.prepare(`UPDATE mca_payment_distributions SET status = 'paid', paid_at = ?, updated_at = ?
              WHERE workspace_id = ? AND payment_id = ? AND recipient_membership_id = ? AND amount_cents = ? AND status = 'expected'`).run(paid.paidAt, nowIso(), actor.workspaceId, payment.id, paid.recipientMembershipId, paid.amountCents)
            if (updated.changes !== 1) throw new AppError(422, "historical_paid_split_mismatch", "Paid split history must match the immutable expected allocation exactly.")
          }
        }
        await database.prepare("UPDATE mca_historical_import_rows SET outcome = 'created', funding_event_id = ?, validation_errors_json = '[]' WHERE workspace_id = ? AND id = ?").run(funding.fundingEventId, actor.workspaceId, stored.id)
        await database.execute("RELEASE SAVEPOINT historical_row")
        created += 1; principalCents += row.amountCents; expectedCommissionCents += row.commissionCents ?? 0; paidCommissionCents += row.paidCommissionCents ?? 0; fundingEventIds.push(funding.fundingEventId)
      } catch (error) {
        await database.execute("ROLLBACK TO SAVEPOINT historical_row")
        await database.execute("RELEASE SAVEPOINT historical_row")
        failed += 1
        await database.prepare("UPDATE mca_historical_import_rows SET outcome = 'pending', validation_errors_json = ? WHERE workspace_id = ? AND id = ?").run(JSON.stringify([error instanceof Error ? error.message : "Historical row failed."]), actor.workspaceId, stored.id)
      }
    }
    const previewTotals = parseJson<ReturnType<typeof totals>>(run.totals_json, totals([]))
    const result: HistoricalImportResult = { runId: input.runId, state: failed ? "failed" : "committed", created, duplicates: previewTotals.duplicates, invalid, failed, principalCents, expectedCommissionCents, paidCommissionCents, fundingEventIds }
    await database.prepare("UPDATE mca_historical_import_runs SET state = ?, reconciliation_json = ?, committed_at = ? WHERE workspace_id = ? AND id = ?").run(result.state, JSON.stringify(result), nowIso(), actor.workspaceId, input.runId)
    await recordAuditEvent({ context: actor, action: "historical.import_committed", resourceType: "historical_import", resourceId: input.runId, metadata: { ...result, fundingEventIds: undefined }, correlationId: actor.correlationId, executor: database })
    return result
  })
}
