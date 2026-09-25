import "server-only"

import { timeHistoricalPhase } from "./telemetry"

import { createHash } from "node:crypto"
import { reconcilePayment } from "../accounting/service"
import { withoutWorkflowWebhooks } from "../comms/workflow-events"
import { getDatabase, newId, nowIso, parseJson, recordAuditEvent, withImmediateTransaction } from "../db"
import { createDeal, getDealForDocument } from "../deals/service"
import type { DealActor } from "../deals/schema"
import { AppError } from "../errors"
import { confirmOfferFunding } from "../funding/service"
import { writeFundingAccounting } from "../accounting/funding-writer"
import type { FundingAccountingWriter } from "../funding/contracts"
import { approveManualSubmission, createManualSubmission } from "../offers/manual-submissions"
import type { HistoricalFundingRowInput, HistoricalImportPreview, HistoricalImportResult, HistoricalRowPreview } from "./contracts"

type RunRow = { input_hash: string | null; id: string; source_id: string; state: "preview" | "committed" | "failed"; preview_revision: number; totals_json: string; reconciliation_json: string }
type StoredRow = { id: string; row_number: number; normalized_json: string; validation_errors_json: string; duplicate: number; outcome: string; funding_event_id: string | null }

function requireImportPermission(actor: DealActor): void {
  if (actor.source !== "user" || !["admin", "super_admin", "manager"].includes(actor.role ?? "")) throw new AppError(403, "historical_import_permission_required", "Historical funding imports require a manager or administrator session.")
}

function dateValid(value: unknown): value is string { return typeof value === "string" && /^\d{4}-\d{2}-\d{2}(?:T.*Z)?$/.test(value) && !Number.isNaN(Date.parse(value)) }
function centsValid(value: unknown, positive = false): value is number { return Number.isSafeInteger(value) && (positive ? Number(value) > 0 : Number(value) >= 0) }

async function validateRow(actor: DealActor, raw: HistoricalFundingRowInput, rowNumber: number, seen: Set<string>, persistedIds: Set<string>, dealAccess: Map<string, Promise<boolean>>): Promise<HistoricalRowPreview> {
  const errors: string[] = []
  const externalId = typeof raw.externalId === "string" ? raw.externalId.trim() : ""
  if (!externalId || externalId.length > 160) errors.push("External ID is required and must be at most 160 characters.")
  if (!raw.dealId && !(typeof raw.legalName === "string" && raw.legalName.trim())) errors.push("Provide an existing deal ID or a legal name for a new historical deal.")
  if (raw.dealId) {
    if (!dealAccess.has(raw.dealId)) dealAccess.set(raw.dealId, getDealForDocument(actor, raw.dealId).then(() => true).catch((error) => {
      if (error instanceof AppError && [403, 404].includes(error.status)) return false
      throw error
    }))
    if (!await dealAccess.get(raw.dealId)) errors.push("Deal ID was not found or is not accessible.")
  }
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
  const persisted = persistedIds.has(externalId)
  const duplicate = persisted || seen.has(externalId)
  const duplicateReason = persisted ? "already_imported" as const : duplicate ? "repeated_in_file" as const : undefined
  if (externalId) seen.add(externalId)
  return { ...raw, externalId, legalName: raw.legalName?.trim() || undefined, funderName: raw.funderName?.trim() ?? "", rowNumber, duplicate, duplicateReason, errors }
}

function totals(rows: HistoricalRowPreview[]) {
  const included = rows.filter((row) => !row.duplicate && row.errors.length === 0)
  return { rows: rows.length, valid: included.length, invalid: rows.filter((row) => row.errors.length > 0).length, duplicates: rows.filter((row) => row.duplicate).length, principalCents: included.reduce((sum, row) => sum + row.amountCents, 0), expectedCommissionCents: included.reduce((sum, row) => sum + (row.commissionCents ?? 0), 0), paidCommissionCents: included.reduce((sum, row) => sum + (row.paidCommissionCents ?? 0), 0), feeCents: included.reduce((sum, row) => sum + (row.feeCents ?? 0), 0) }
}

function historicalIdentity(sourceId: string, externalId: string): string {
  return createHash("sha256").update(JSON.stringify([sourceId, externalId])).digest("hex")
}

export async function previewHistoricalImport(actor: DealActor, input: { sourceId: string; batchId: string; requestId?: string; rows: HistoricalFundingRowInput[] }): Promise<HistoricalImportPreview> {
  requireImportPermission(actor)
  if (!input.sourceId?.trim() || !input.batchId?.trim()) throw new AppError(422, "validation_failed", "Source and batch IDs are required.")
  if (!Array.isArray(input.rows) || !input.rows.length || input.rows.length > 5000) throw new AppError(422, "validation_failed", "Provide 1 to 5,000 historical rows.")
  const sourceId = input.sourceId.trim(), batchId = input.batchId.trim()
  const requestId = input.requestId?.trim() ?? null
  if (input.requestId !== undefined && (!requestId || requestId.length > 160)) throw new AppError(422, "validation_failed", "Request ID must contain 1 to 160 characters.")
  const inputHash = createHash("sha256").update(JSON.stringify({ sourceId, batchId, rows: input.rows }, (_key, value) => {
    if (value && typeof value === "object" && !Array.isArray(value)) return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)))
    return value
  })).digest("hex")
  try {
    return await withImmediateTransaction(async (database) => {
      await database.execute("SET LOCAL mca.historical_writer = '2'")
      // Scope wait limits to this preview; they reset at transaction completion.
      await database.execute("SET LOCAL lock_timeout = '10s'")
      await database.execute("SET LOCAL statement_timeout = '30s'")
      if (requestId) {
        await database.prepare("SELECT pg_advisory_xact_lock(hashtextextended(?, 0))").get(JSON.stringify(["historical-preview", actor.workspaceId, requestId]))
        const prior = await database.prepare<RunRow>("SELECT * FROM mca_historical_import_runs WHERE workspace_id = ? AND request_id = ?").get(actor.workspaceId, requestId)
        if (prior) {
          if (prior.input_hash !== inputHash) throw new AppError(409, "historical_request_conflict", "This request ID was used for different input. Start a new preview.")
          return getHistoricalImport(actor, prior.id)
        }
      }
      const rows = await timeHistoricalPhase(actor.correlationId, "validation", async () => {
        const externalIds = [...new Set(input.rows.map((row) => typeof row.externalId === "string" ? row.externalId.trim() : "").filter(Boolean))]
        const persisted = await database.prepare<{ external_id: string }>("SELECT external_id FROM mca_historical_import_rows WHERE workspace_id = ? AND source_id = ? AND outcome = 'created' AND external_id = ANY(?::text[])").all(actor.workspaceId, sourceId, externalIds)
        const persistedIds = new Set(persisted.map((row) => row.external_id))
        const seen = new Set<string>(), dealAccess = new Map<string, Promise<boolean>>()
        const validated: HistoricalRowPreview[] = []
        for (const [index, row] of input.rows.entries()) validated.push(await validateRow(actor, row, index + 2, seen, persistedIds, dealAccess))
        return validated
      })
      return timeHistoricalPhase(actor.correlationId, "persistence", async () => {
        const runId = newId(), createdAt = nowIso()
        await database.prepare(`INSERT INTO mca_historical_import_runs
          (id, workspace_id, source_id, batch_id, state, preview_revision, totals_json, reconciliation_json, created_by_user_id, created_at, request_id, input_hash)
          VALUES (?, ?, ?, ?, 'preview', 1, '{}', '{}', ?, ?, ?, ?)`).run(runId, actor.workspaceId, sourceId, batchId, actor.userId, createdAt, requestId, inputHash)
        for (let offset = 0; offset < rows.length; offset += 250) {
          const chunk = rows.slice(offset, offset + 250)
          await database.prepare(`INSERT INTO mca_historical_import_rows
            (id, workspace_id, run_id, source_id, external_id, row_number, normalized_json, validation_errors_json, duplicate, outcome, created_at)
            VALUES ${chunk.map(() => "(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").join(", ")}`)
            .run(...chunk.flatMap((row) => [newId(), actor.workspaceId, runId, sourceId, row.externalId, row.rowNumber, JSON.stringify(row), JSON.stringify(row.errors), Number(row.duplicate), row.duplicate ? "duplicate" : row.errors.length ? "invalid" : "pending", createdAt]))
        }
        const summary = totals(rows)
        await database.prepare("UPDATE mca_historical_import_runs SET totals_json = ? WHERE workspace_id = ? AND id = ?").run(JSON.stringify(summary), actor.workspaceId, runId)
        await recordAuditEvent({ context: actor, action: "historical.preview_created", resourceType: "historical_import", resourceId: runId, metadata: summary, correlationId: actor.correlationId, executor: database })
        return { runId, state: "preview" as const, previewRevision: 1, rows, totals: summary }
      })
    })
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && ["55P03", "57014"].includes(String(error.code))) {
      throw new AppError(503, "historical_preview_timeout", "Preview preparation timed out. Retry with the same file, source and batch IDs.")
    }
    throw error
  }
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
    await database.execute("SET LOCAL mca.historical_writer = '2'")
    await database.prepare("SELECT pg_advisory_xact_lock(hashtext(?))").get(`${actor.workspaceId}:${input.runId}`)
    const run = await database.prepare<RunRow>("SELECT * FROM mca_historical_import_runs WHERE workspace_id = ? AND id = ? FOR UPDATE").get(actor.workspaceId, input.runId)
    if (!run) throw new AppError(404, "historical_import_not_found", "The historical import was not found.")
    if (run.state === "committed") return parseJson(run.reconciliation_json, { runId: input.runId, state: "committed", created: 0, duplicates: 0, invalid: 0, failed: 0, principalCents: 0, expectedCommissionCents: 0, paidCommissionCents: 0, fundingEventIds: [] })
    if (Number(run.preview_revision) !== input.expectedPreviewRevision) throw new AppError(409, "historical_preview_stale", "The import preview changed. Refresh before committing.")
    const rows = await database.prepare<StoredRow>("SELECT * FROM mca_historical_import_rows WHERE workspace_id = ? AND run_id = ? ORDER BY row_number").all(actor.workspaceId, input.runId)
    let created = 0, invalid = 0, failed = 0, duplicates = 0, principalCents = 0, expectedCommissionCents = 0, paidCommissionCents = 0
    // Use a consistent identity order, not file order, for overlapping runs.
    const identities = [...new Set(rows.map((stored) => historicalIdentity(run.source_id, parseJson<HistoricalRowPreview>(stored.normalized_json, {} as HistoricalRowPreview).externalId)))].sort()
    for (const identity of identities) await database.prepare("SELECT pg_advisory_xact_lock(hashtextextended(?, 0))").get(JSON.stringify(["historical-funding", actor.workspaceId, identity]))
    const fundingEventIds: string[] = []
    for (const stored of rows) {
      const row = parseJson<HistoricalRowPreview>(stored.normalized_json, {} as HistoricalRowPreview)
      if (stored.outcome === "created") {
        created += 1; principalCents += row.amountCents ?? 0; expectedCommissionCents += row.commissionCents ?? 0; paidCommissionCents += row.paidCommissionCents ?? 0
        if (stored.funding_event_id) fundingEventIds.push(stored.funding_event_id)
        continue
      }
      if (stored.duplicate || stored.outcome === "duplicate") { duplicates += 1; if (row.errors?.length) invalid += 1; continue }
      if (row.errors?.length) { invalid += 1; continue }
      const imported = await database.prepare<{ id: string }>("SELECT id FROM mca_historical_import_rows WHERE workspace_id = ? AND source_id = ? AND external_id = ? AND outcome = 'created'").get(actor.workspaceId, run.source_id, row.externalId)
      if (imported) {
        duplicates += 1
        await database.prepare("UPDATE mca_historical_import_rows SET outcome = 'duplicate', duplicate = 1, normalized_json = ?, validation_errors_json = '[]' WHERE workspace_id = ? AND id = ?")
          .run(JSON.stringify({ ...row, duplicate: true, duplicateReason: "already_imported" }), actor.workspaceId, stored.id)
        continue
      }
      await database.execute("SAVEPOINT historical_row")
      try {
        const identity = historicalIdentity(run.source_id, row.externalId)
        const funding = await withoutWorkflowWebhooks(async () => {
          const dealId = row.dealId ?? (await createDeal(actor, { legalName: row.legalName, idempotencyKey: `historical:${identity}`, fieldSource: "import" })).deal.id
          const manual = await createManualSubmission(actor, { dealId, funderId: row.funderId, funderName: row.funderName, historicalAt: row.fundedAt, reason: `Historical import ${input.runId}`, idempotencyKey: `historical-submission:${identity}`, source: "historical" })
          const approved = await approveManualSubmission(actor, { submissionId: manual.submission.id, terms: { amountCents: row.amountCents, factorRate: row.factorRate, termMonths: row.termMonths, paymentAmountCents: row.paymentAmountCents, paymentFrequency: row.paymentFrequency, commissionCents: row.commissionCents, feeCents: row.feeCents, effectiveAt: row.fundedAt } })
          return confirmOfferFunding(actor, { dealId, offerId: approved.offer.id, offerRevisionId: approved.offer.currentRevisionId, manualSubmissionId: manual.submission.id, idempotencyKey: `historical-funding:${identity}`, fundedAt: row.fundedAt, amountCents: row.amountCents, commissionCents: row.commissionCents, feeCents: row.feeCents, expectedCommissionAt: row.expectedCommissionAt, expectedFeeAt: row.expectedFeeAt, paymentCount: row.paymentCount, paymentFrequency: row.paymentFrequency, calendarConvention: row.calendarConvention, splits: row.splits, source: "historical" }, accountingWriter)
        })
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
    // Older previews omitted duplicate rows entirely; retain their reported count.
    const previewTotals = parseJson<ReturnType<typeof totals>>(run.totals_json, totals([]))
    duplicates += Math.max(0, previewTotals.rows - rows.length)
    const result: HistoricalImportResult = { runId: input.runId, state: failed ? "failed" : "committed", created, duplicates, invalid, failed, principalCents, expectedCommissionCents, paidCommissionCents, fundingEventIds }
    await database.prepare("UPDATE mca_historical_import_runs SET state = ?, reconciliation_json = ?, committed_at = ? WHERE workspace_id = ? AND id = ?").run(result.state, JSON.stringify(result), nowIso(), actor.workspaceId, input.runId)
    await recordAuditEvent({ context: actor, action: "historical.import_committed", resourceType: "historical_import", resourceId: input.runId, metadata: { ...result, fundingEventIds: undefined }, correlationId: actor.correlationId, executor: database })
    return result
  })
}
