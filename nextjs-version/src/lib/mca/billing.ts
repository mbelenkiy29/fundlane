import "server-only"
import { getClerkClient } from "./clerk-client"
import { getDatabase, nowIso, withImmediateTransaction } from "./db"
import { AppError } from "./errors"
import type { BillingSubscription } from "@clerk/backend"

export const billingEnabled = () => process.env.MCA_CLERK_BILLING_ENABLED === "true"
export const BILLING_ADMIN_ROLE = "org:mca_billing_admin"
export const BILLING_EMPLOYEE_ROLE = "org:mca_employee"
export const billingRole = (role: string) => ["admin", "super_admin"].includes(role) ? BILLING_ADMIN_ROLE : BILLING_EMPLOYEE_ROLE
const seats: Record<string, number> = { free_org: 1, mca_starter_test: 5, mca_team_test: 20 }

export function subscriptionEntitlement(subscription: BillingSubscription, now = Date.now()) {
  const eligible = subscription.subscriptionItems.filter(item => item.status === "active" || item.status === "past_due" || (item.status === "canceled" && item.periodEnd !== null && item.periodEnd > now))
  if (!eligible.length) throw new AppError(503, "billing_unavailable", "Your company plan is being updated. Please retry.")
  for (const item of eligible) if (!item.plan || !seats[item.plan.slug]) throw new AppError(503, "billing_plan_unknown", "This company plan needs administrator configuration.")
  const item = eligible.sort((a, b) => seats[b.plan!.slug] - seats[a.plan!.slug])[0]
  return { subscriptionId: subscription.id, planId: item.planId ?? item.plan!.id, planSlug: item.plan!.slug, planName: item.plan!.name, status: item.status, periodStart: item.periodStart, periodEnd: item.periodEnd, seatLimit: seats[item.plan!.slug], paymentPastDue: subscription.status === "past_due" || eligible.some(i => i.status === "past_due") }
}

export async function syncWorkspaceBilling(workspaceId: string, client = getClerkClient()) {
  if (!billingEnabled()) throw new AppError(503, "billing_disabled", "Company billing is not enabled in this environment.")
  return withImmediateTransaction(async db => {
    const workspace = await db.prepare<{ clerk_organization_id: string | null }>("SELECT clerk_organization_id FROM workspaces WHERE id = ? FOR UPDATE").get(workspaceId)
    if (!workspace?.clerk_organization_id) throw new AppError(409, "billing_company_required", "Complete company setup before choosing a plan.")
    let subscription
    try { subscription = await client.billing.getOrganizationBillingSubscription(workspace.clerk_organization_id) }
    catch { throw new AppError(503, "billing_unavailable", "Company billing verification is temporarily unavailable. Existing access is unchanged; please retry.") }
    const current = subscriptionEntitlement(subscription)
    const syncedAt = nowIso()
    await db.prepare(`INSERT INTO workspace_billing (workspace_id, clerk_subscription_id, clerk_plan_id, plan_slug, plan_name, status, period_start, period_end, seat_limit, payment_past_due, synced_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (workspace_id) DO UPDATE SET clerk_subscription_id=EXCLUDED.clerk_subscription_id, clerk_plan_id=EXCLUDED.clerk_plan_id, plan_slug=EXCLUDED.plan_slug, plan_name=EXCLUDED.plan_name, status=EXCLUDED.status, period_start=EXCLUDED.period_start, period_end=EXCLUDED.period_end, seat_limit=EXCLUDED.seat_limit, payment_past_due=EXCLUDED.payment_past_due, synced_at=EXCLUDED.synced_at`)
      .run(workspaceId, current.subscriptionId, current.planId, current.planSlug, current.planName, current.status, new Date(current.periodStart).toISOString(), current.periodEnd ? new Date(current.periodEnd).toISOString() : null, current.seatLimit, current.paymentPastDue ? 1 : 0, syncedAt)
    await db.prepare("UPDATE workspaces SET seat_limit = ?, updated_at = ? WHERE id = ?").run(current.seatLimit, syncedAt, workspaceId)
    return { ...current, syncedAt }
  })
}

export async function assertBillingCapacity(workspaceId: string, additionalSeats = 1, client = getClerkClient()) {
  if (!billingEnabled()) return
  const plan = await syncWorkspaceBilling(workspaceId, client)
  if (plan.paymentPastDue) throw new AppError(409, "billing_payment_required", "Update the company payment method before sending invitations.")
  const usage = await getDatabase().prepare<{ count: number }>("SELECT count(*)::int count FROM memberships WHERE workspace_id = ? AND status IN ('active','pending')").get(workspaceId)
  if ((usage?.count ?? 0) + additionalSeats > plan.seatLimit) throw new AppError(409, "seat_limit_reached", "Your company has used its plan's seats. Upgrade in Plans & Billing or free a reserved seat.")
}

export async function getWorkspaceBilling(workspaceId: string) {
  const billing = await getDatabase().prepare("SELECT clerk_subscription_id AS \"subscriptionId\", clerk_plan_id AS \"planId\", plan_slug AS \"planSlug\", plan_name AS \"planName\", status, period_start AS \"periodStart\", period_end AS \"periodEnd\", seat_limit AS \"seatLimit\", payment_past_due AS \"paymentPastDue\", synced_at AS \"syncedAt\" FROM workspace_billing WHERE workspace_id = ?").get(workspaceId)
  const usage = await getDatabase().prepare<{ count: number }>("SELECT count(*)::int count FROM memberships WHERE workspace_id=? AND status IN ('active','pending')").get(workspaceId)
  return { enabled: billingEnabled(), billing: billing ?? null, occupiedSeats: usage?.count ?? 0 }
}
