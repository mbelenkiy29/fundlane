import "server-only"
import { getDatabase, nowIso } from "../db"
import type { StripeBillingClient } from "../billing"
import { enrollmentRuntimeEnabled } from "./config"
import { reconcileEnrollment } from "./reconcile"
import { compensateEnrollment } from "./billing"
import { findEnrollment } from "./store"
export async function runEnrollmentMaintenance(
  options: {
    limit?: number
    deadlineMs?: number
    client?: StripeBillingClient
  } = {}
): Promise<{
  checked: number
  repaired: number
  operatorRequired: number
  errors: string[]
}> {
  const result = {
    checked: 0,
    repaired: 0,
    operatorRequired: 0,
    errors: [] as string[],
  }
  if (!enrollmentRuntimeEnabled()) return result
  const limit = Math.min(100, Math.max(0, options.limit ?? 25)),
    deadline = Date.now() + (options.deadlineMs ?? 20000)
  const rows = (
    await getDatabase().query<{ id: string; recovery_state: string }>(
      `SELECT id,recovery_state FROM mca_enrollments WHERE workspace_id IS NULL AND next_reconcile_at<=? AND (lease_until IS NULL OR lease_until<?) AND recovery_state<>'operator_required' ORDER BY next_reconcile_at,id LIMIT ?`,
      [nowIso(), nowIso(), limit]
    )
  ).rows
  for (const row of rows) {
    if (Date.now() >= deadline) break
    result.checked++
    try {
      if (["pending", "canceling", "uncertain"].includes(row.recovery_state))
        await compensateEnrollment(row.id, options.client)
      else await reconcileEnrollment(row.id, options.client)
      if ((await findEnrollment(row.id))?.recoveryState === "operator_required")
        result.operatorRequired++
      else result.repaired++
    } catch {
      result.errors.push(`${row.id}:enrollment_reconciliation_failed`)
    }
  }
  return result
}
