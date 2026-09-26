import "server-only"
import { billingEnabled, syncWorkspaceBilling, type StripeBillingClient } from "../billing"
import {
  getDatabase,
  newId,
  nowIso,
  withTransaction,
  type DbExecutor
} from "../db"
import { AppError } from "../errors"

export const CREDIT_ALLOWANCES: Record<string, number> = {
  free_org: 10,
  mca_starter_test: 100,
  mca_team_test: 250,
  // Preserve the existing highest-tier included allowance for the unified plan.
  fundlane: 250
}
export interface CreditOwner {
  workspace_id: string
  user_id: string
}
export interface CreditAccount extends CreditOwner {
  id: string
  purchased_balance: number
  purchased_reserved: number
  alert_episode: number
  low_sent: number
  exhausted_sent: number
}
interface Month {
  month: string
  allowance: number
  effective_allowance: number
  remaining: number
  reserved: number
}
interface Reservation {
  run_id: string
  account_id: string
  month: string
  source: "included" | "purchased"
  state: string
}
const includedBalance = (m: Month) =>
  Math.max(0, m.remaining - (m.allowance - m.effective_allowance))
export const creditMonth = (date = new Date()) => date.toISOString().slice(0, 7)
export function nextReset(date = new Date()) {
  return new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1)
  ).toISOString()
}
export async function resolveCreditAllowance(workspaceId: string, client?: StripeBillingClient) {
  if (!billingEnabled()) return 10
  const plan = await syncWorkspaceBilling(workspaceId, client)
  // Payment trouble never removes records or purchased credits, but cannot issue
  // additional paid-tier monthly allowances before current payment is verified.
  const allowance = CREDIT_ALLOWANCES[plan.paymentPastDue ? "free_org" : plan.planSlug]
  if (!allowance)
    throw new AppError(
      503,
      "credit_plan_unknown",
      "Your company’s AI allowance could not be verified."
    )
  return allowance
}
export async function creditEntry(
  db: DbExecutor,
  accountId: string,
  key: string,
  kind: string,
  amount: number,
  source: string,
  at = nowIso()
) {
  return db
    .prepare(
      "INSERT INTO mca_credit_ledger (id,account_id,event_key,kind,amount,source,created_at) VALUES (?,?,?,?,?,?,?) ON CONFLICT(event_key) DO NOTHING RETURNING id"
    )
    .get(newId(), accountId, key, kind, amount, source, at)
}
export async function lockCreditAccount(
  db: DbExecutor,
  owner: CreditOwner
): Promise<CreditAccount> {
  const active = await db
    .prepare(
      "SELECT id FROM memberships WHERE workspace_id=? AND user_id=? AND status='active'"
    )
    .get(owner.workspace_id, owner.user_id)
  if (!active)
    throw new AppError(
      403,
      "membership_inactive",
      "This company membership is inactive."
    )
  await db
    .prepare(
      "INSERT INTO mca_credit_accounts (id,workspace_id,user_id,created_at) VALUES (?,?,?,?) ON CONFLICT(workspace_id,user_id) DO NOTHING"
    )
    .run(newId(), owner.workspace_id, owner.user_id, nowIso())
  return (await db
    .prepare<CreditAccount>(
      "SELECT * FROM mca_credit_accounts WHERE workspace_id=? AND user_id=? FOR UPDATE"
    )
    .get(owner.workspace_id, owner.user_id))!
}
export async function ensureCreditMonth(
  db: DbExecutor,
  account: CreditAccount,
  allowance: number,
  date = new Date()
) {
  const month = creditMonth(date)
  const inserted = await db
    .prepare(
      "INSERT INTO mca_credit_months (id,account_id,month,allowance,effective_allowance,remaining) VALUES (?,?,?,?,?,?) ON CONFLICT(account_id,month) DO NOTHING RETURNING id"
    )
    .get(newId(), account.id, month, allowance, allowance, allowance)
  if (inserted) {
    await creditEntry(
      db,
      account.id,
      `grant:${account.id}:${month}:${allowance}`,
      "monthly_grant",
      allowance,
      "included"
    )
    await db
      .prepare("UPDATE mca_credit_accounts SET alert_dirty=1 WHERE id=?")
      .run(account.id)
  }
  const row = (await db
    .prepare<Month>(
      "SELECT * FROM mca_credit_months WHERE account_id=? AND month=?"
    )
    .get(account.id, month))!
  // The highest granted tier for a month prevents upgrade/downgrade refill loops.
  if (allowance > row.allowance) {
    await db
      .prepare(
        "UPDATE mca_credit_months SET allowance=?,remaining=remaining+? WHERE account_id=? AND month=?"
      )
      .run(allowance, allowance - row.allowance, account.id, month)
    await creditEntry(
      db,
      account.id,
      `grant:${account.id}:${month}:${allowance}`,
      "upgrade_grant",
      allowance - row.allowance,
      "included"
    )
    await db
      .prepare("UPDATE mca_credit_accounts SET alert_dirty=1 WHERE id=?")
      .run(account.id)
  }
  if (row.effective_allowance !== allowance) {
    const grant = Math.max(0, allowance - row.allowance)
    const restoredOrRemoved =
      Math.max(0, allowance - (row.allowance - row.remaining)) -
      includedBalance(row) -
      grant
    await db
      .prepare(
        "UPDATE mca_credit_months SET effective_allowance=? WHERE account_id=? AND month=?"
      )
      .run(allowance, account.id, month)
    if (restoredOrRemoved)
      await creditEntry(
        db,
        account.id,
        `effective-plan:${account.id}:${newId()}`,
        restoredOrRemoved > 0
          ? "plan_allowance_restored"
          : "plan_allowance_reduced",
        restoredOrRemoved,
        "included"
      )
  }
  if (
    inserted ||
    allowance !== row.effective_allowance ||
    allowance > row.allowance
  )
    await recordCreditBalanceChange(db, account.id, date)
  return (await db
    .prepare<Month>(
      "SELECT * FROM mca_credit_months WHERE account_id=? AND month=?"
    )
    .get(account.id, month))!
}
export async function reserveCredit(
  db: DbExecutor,
  owner: CreditOwner,
  runId: string,
  allowance: number
) {
  const account = await lockCreditAccount(db, owner),
    month = await ensureCreditMonth(db, account, allowance)
  const source =
    includedBalance(month) > month.reserved ? "included" : "purchased"
  if (
    source === "purchased" &&
    account.purchased_balance <= account.purchased_reserved
  )
    throw new AppError(
      402,
      "credits_exhausted",
      "You have no AI credits left. Ask a company admin about your plan or wait for the monthly reset."
    )
  await db
    .prepare(
      "INSERT INTO mca_credit_reservations (run_id,account_id,month,source,state,created_at) VALUES (?,?,?,?,'reserved',?)"
    )
    .run(runId, account.id, month.month, source, nowIso())
  if (source === "included")
    await db
      .prepare(
        "UPDATE mca_credit_months SET reserved=reserved+1 WHERE account_id=? AND month=?"
      )
      .run(account.id, month.month)
  else
    await db
      .prepare(
        "UPDATE mca_credit_accounts SET purchased_reserved=purchased_reserved+1 WHERE id=?"
      )
      .run(account.id)
  await creditEntry(
    db,
    account.id,
    `reserve:${runId}`,
    "reservation",
    0,
    source
  )
}
/** Locked on the run, then account, in the same order as run creation/cancellation. */
export async function settleCredit(
  runId: string,
  mode: "charge" | "release" | "refund"
) {
  return withTransaction(async (db) => {
    await db
      .prepare("SELECT id FROM mca_assistant_runs WHERE id=? FOR UPDATE")
      .get(runId)
    const r = await db
      .prepare<Reservation>(
        "SELECT * FROM mca_credit_reservations WHERE run_id=?"
      )
      .get(runId)
    if (
      !r ||
      r.state === "released" ||
      r.state === "refunded" ||
      (mode === "charge" && r.state === "charged") ||
      (mode === "release" && r.state !== "reserved")
    )
      return
    await db
      .prepare("SELECT id FROM mca_credit_accounts WHERE id=? FOR UPDATE")
      .get(r.account_id)
    if (r.state === "reserved") {
      if (r.source === "included")
        await db
          .prepare(
            "UPDATE mca_credit_months SET reserved=reserved-1,remaining=remaining-? WHERE account_id=? AND month=?"
          )
          .run(mode === "charge" ? 1 : 0, r.account_id, r.month)
      else
        await db
          .prepare(
            "UPDATE mca_credit_accounts SET purchased_reserved=purchased_reserved-1,purchased_balance=purchased_balance-? WHERE id=?"
          )
          .run(mode === "charge" ? 1 : 0, r.account_id)
    } else if (r.state === "charged" && mode === "refund") {
      if (r.source === "included")
        await db
          .prepare(
            "UPDATE mca_credit_months SET remaining=remaining+1 WHERE account_id=? AND month=?"
          )
          .run(r.account_id, r.month)
      else
        await db
          .prepare(
            "UPDATE mca_credit_accounts SET purchased_balance=purchased_balance+1 WHERE id=?"
          )
          .run(r.account_id)
    }
    const state =
      mode === "charge"
        ? "charged"
        : mode === "refund"
          ? "refunded"
          : "released"
    await db
      .prepare("UPDATE mca_credit_reservations SET state=? WHERE run_id=?")
      .run(state, runId)
    await creditEntry(
      db,
      r.account_id,
      `${state}:${runId}`,
      state,
      mode === "charge" ? -1 : r.state === "charged" ? 1 : 0,
      r.source
    )
    if (mode === "charge" || (mode === "refund" && r.state === "charged"))
      await recordCreditBalanceChange(db, r.account_id)
  })
}
export async function getCreditBalance(
  owner: CreditOwner,
  allowance?: number,
  date = new Date()
) {
  const effective =
    allowance ?? (await resolveCreditAllowance(owner.workspace_id))
  return withTransaction(async (db) => {
    const account = await lockCreditAccount(db, owner),
      m = await ensureCreditMonth(db, account, effective, date)
    return {
      allowance: m.effective_allowance,
      included: Math.max(0, includedBalance(m) - m.reserved),
      purchased: Math.max(
        0,
        account.purchased_balance - account.purchased_reserved
      ),
      reserved: m.reserved + account.purchased_reserved,
      debt: Math.max(0, -account.purchased_balance),
      total:
        Math.max(0, includedBalance(m) - m.reserved) +
        Math.max(0, account.purchased_balance - account.purchased_reserved),
      resetAt: nextReset(date)
    }
  })
}
export async function releaseExpiredReservations() {
  const rows = await getDatabase()
    .prepare<{
      run_id: string
    }>("SELECT q.run_id FROM mca_credit_reservations q JOIN mca_assistant_runs r ON r.id=q.run_id WHERE q.state='reserved' AND (r.status IN ('failed','cancelled','completed') OR r.expires_at<?) LIMIT 100")
    .all(nowIso())
  for (const r of rows) await settleCredit(r.run_id, "release")
}

/** Runs under the account lock, alongside the balance update; delivery is independent. */
export async function recordCreditBalanceChange(
  db: DbExecutor,
  accountId: string,
  date = new Date()
) {
  await db
    .prepare(
      `INSERT INTO mca_credit_balance_events
    (account_id,month,allowance,included,purchased,threshold_mode,threshold_value,created_at)
    SELECT a.id,m.month,m.effective_allowance,GREATEST(0,m.remaining-(m.allowance-m.effective_allowance)),GREATEST(0,a.purchased_balance),COALESCE(s.mode,'percent'),COALESCE(s.threshold,20),?
    FROM mca_credit_accounts a JOIN mca_credit_months m ON m.account_id=a.id AND m.month=?
    LEFT JOIN mca_credit_alert_settings s ON s.workspace_id=a.workspace_id WHERE a.id=?`
    )
    .run(nowIso(), creditMonth(date), accountId)
  await db
    .prepare("UPDATE mca_credit_accounts SET alert_dirty=1 WHERE id=?")
    .run(accountId)
}
