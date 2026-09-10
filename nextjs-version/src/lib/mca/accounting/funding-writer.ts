import "server-only"

import { newId, nowIso, type DbExecutor } from "../db"
import type { FundingAccountingInput, FundingAccountingWriter } from "../funding/contracts"
import { calculateSplitSnapshot } from "./calculations"
import { assertCents } from "./money"
import { AppError } from "../errors"

type IdRow = { id: string }

async function paymentIdFor(
  database: DbExecutor,
  input: FundingAccountingInput,
  type: "commission" | "fee",
  amountCents: number,
  originatorMembershipId: string | null,
): Promise<string> {
  const idempotencyKey = `${input.idempotencyKey}:${type}`
  const id = newId()
  const timestamp = nowIso()
  const origin = input.source === "historical" ? "historical" : "automatic"
  const expectedAt = type === "commission" ? (input.expectedCommissionAt ?? input.fundedAt) : (input.expectedFeeAt ?? input.fundedAt)
  const inserted = await database.prepare<IdRow>(`INSERT INTO mca_accounting_payments
    (id, workspace_id, advance_id, funding_event_id, type, origin, originator_membership_id,
     expected_amount_cents, received_amount_cents, expected_at, received_at, status,
     idempotency_key, created_by_user_id, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, NULL, 'expected', ?, NULL, ?, ?)
    ON CONFLICT (workspace_id, advance_id, type, idempotency_key) DO NOTHING
    RETURNING id`).get(
      id, input.workspaceId, input.advanceId, input.fundingEventId, type,
      origin, originatorMembershipId, amountCents, expectedAt,
      idempotencyKey, timestamp, timestamp,
    )
  if (inserted) return inserted.id
  const replay = await database.prepare<IdRow & { expected_amount_cents: number; expected_at: string | null; origin: string; originator_membership_id: string | null }>(`SELECT id,expected_amount_cents,expected_at,origin,originator_membership_id FROM mca_accounting_payments
    WHERE workspace_id = ? AND advance_id = ? AND type = ? AND idempotency_key = ?`)
    .get(input.workspaceId, input.advanceId, type, idempotencyKey)
  if (!replay) throw new Error("Accounting payment conflicted without a replayable row.")
  if (Number(replay.expected_amount_cents) !== amountCents || replay.expected_at !== expectedAt || replay.origin !== origin
    || replay.originator_membership_id !== originatorMembershipId) {
    throw new AppError(409, "idempotency_conflict", "That funding retry key already identifies different accounting terms.")
  }
  return replay.id
}

async function validateRecipients(database: DbExecutor, workspaceId: string, recipientIds: string[]): Promise<void> {
  if (!recipientIds.length) return
  const rows = await database.prepare<{ id: string }>(`SELECT id FROM memberships
    WHERE workspace_id = ? AND status = 'active' AND id = ANY(?::text[])`).all(workspaceId, recipientIds)
  if (rows.length !== new Set(recipientIds).size) throw new TypeError("Every split recipient must be an active membership in this workspace.")
}

/**
 * Writes accounting children using the caller's transaction executor. It never
 * commits, opens another transaction, sends money, or mutates the advance row.
 */
export const writeFundingAccounting: FundingAccountingWriter = async (database, input) => {
  assertCents(input.amountCents, "amountCents")
  assertCents(input.commissionCents, "commissionCents")
  assertCents(input.feeCents, "feeCents")
  await validateRecipients(database, input.workspaceId, input.splits.map((split) => split.recipientMembershipId))
  const originator = await database.prepare<{ membership_id: string }>(`SELECT membership_id FROM deal_assignments
    WHERE workspace_id = ? AND deal_id = ? AND kind = 'originator'
    ORDER BY is_primary DESC, assigned_at, id LIMIT 1`).get(input.workspaceId, input.dealId)
  const originatorMembershipId = originator?.membership_id ?? null

  const recordIds: string[] = []
  if (input.commissionCents > 0) {
    const paymentId = await paymentIdFor(database, input, "commission", input.commissionCents, originatorMembershipId)
    recordIds.push(paymentId)
    if (input.splits.length) {
      const snapshot = calculateSplitSnapshot(input.commissionCents, input.splits)
      for (const allocation of snapshot.allocations) {
        const idempotencyKey = `${input.idempotencyKey}:commission:${allocation.recipientMembershipId}`
        const timestamp = nowIso()
        const inserted = await database.prepare<IdRow>(`INSERT INTO mca_payment_distributions
          (id, workspace_id, payment_id, recipient_membership_id, template_id, template_version,
           percentage_basis_points, amount_cents, status, expected_at, paid_at, snapshot_json,
           idempotency_key, created_at, updated_at)
          VALUES (?, ?, ?, ?, NULL, NULL, ?, ?, 'expected', ?, NULL, ?, ?, ?, ?)
          ON CONFLICT (workspace_id, payment_id, recipient_membership_id, idempotency_key) DO NOTHING
          RETURNING id`).get(
            newId(), input.workspaceId, paymentId, allocation.recipientMembershipId,
            allocation.percentageBasisPoints, allocation.amountCents,
            input.expectedCommissionAt ?? input.fundedAt, JSON.stringify(snapshot), idempotencyKey, timestamp, timestamp,
          )
        const replay = inserted ? undefined : await database.prepare<IdRow & { percentage_basis_points: number; amount_cents: number }>(`SELECT id,percentage_basis_points,amount_cents FROM mca_payment_distributions
          WHERE workspace_id = ? AND payment_id = ? AND recipient_membership_id = ? AND idempotency_key = ?`)
          .get(input.workspaceId, paymentId, allocation.recipientMembershipId, idempotencyKey)
        if (replay && (Number(replay.percentage_basis_points) !== allocation.percentageBasisPoints || Number(replay.amount_cents) !== allocation.amountCents)) {
          throw new AppError(409, "idempotency_conflict", "That funding retry key already identifies different split terms.")
        }
        const distributionId = inserted?.id ?? replay?.id
        if (!distributionId) throw new Error("Distribution conflicted without a replayable row.")
        recordIds.push(distributionId)
      }
    }
  }
  if (input.feeCents > 0) recordIds.push(await paymentIdFor(database, input, "fee", input.feeCents, originatorMembershipId))
  return { recordIds }
}
