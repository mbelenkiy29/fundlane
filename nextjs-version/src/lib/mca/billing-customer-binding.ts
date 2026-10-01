import "server-only"
import type Stripe from "stripe"
import { getDatabase, type DbExecutor } from "./db"
/** Metadata remains authoritative for legacy customers; only a committed claim can replace it. */
export async function workspaceOwnsStripeCustomer(
  workspaceId: string,
  customer: Stripe.Customer | Stripe.DeletedCustomer,
  livemode: boolean,
  db: DbExecutor = getDatabase()
): Promise<boolean> {
  if (customer.deleted || customer.livemode !== livemode) return false
  if (customer.metadata.workspace_id)
    return customer.metadata.workspace_id === workspaceId
  return !!(await db.queryOne(
    `SELECT e.id FROM mca_enrollments e JOIN workspace_stripe_customers c ON c.workspace_id=e.workspace_id AND c.stripe_customer_id=e.customer_id
    WHERE e.workspace_id=? AND e.customer_id=? AND e.claim_state='claimed' AND e.finalization_state='complete' AND e.provider_account_id=? AND c.livemode=? AND (e.offer_json::jsonb->>'livemode')::boolean=?`,
    [
      workspaceId,
      customer.id,
      process.env.MCA_STRIPE_EXPECTED_ACCOUNT_ID ?? "",
      livemode ? 1 : 0,
      livemode,
    ]
  ))
}
