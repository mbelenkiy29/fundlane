import "server-only"
import { getWorkspaceBilling } from "./billing"
import { getDatabase } from "./db"
export async function getCompanyBillingPresentation(workspaceId:string) {
  const [billing,usage,actionRequired,paymentFailed]=await Promise.all([getWorkspaceBilling(workspaceId),getDatabase().prepare<{active:number;pending:number}>("SELECT count(*) FILTER (WHERE status='active')::int active,count(*) FILTER (WHERE status='pending')::int pending FROM memberships WHERE workspace_id=?").get(workspaceId),getDatabase().prepare<{invoice_id:string;invoice_url:string|null}>(`SELECT n.data::jsonb->>'invoiceId' invoice_id,n.data::jsonb->>'invoiceUrl' invoice_url FROM company_billing_notifications n
    LEFT JOIN company_billing_invoices i ON i.stripe_invoice_id=n.data::jsonb->>'invoiceId' AND i.workspace_id=n.workspace_id
    WHERE n.workspace_id=? AND n.kind='payment_action_required' AND COALESCE(i.status,'open') NOT IN ('paid','void','uncollectible')
      AND (?=0 OR (i.status='open' AND i.amount_remaining>0 AND i.synced_at::timestamptz>=COALESCE((n.data::jsonb->>'receivedAt')::timestamptz,n.created_at::timestamptz)))
    ORDER BY n.created_at DESC LIMIT 1`).get(workspaceId,process.env.MCA_BILLING_VERIFIED_INVOICE_NOTICES === "true" ? 1 : 0),process.env.MCA_BILLING_VERIFIED_INVOICE_NOTICES === "true" ? getDatabase().prepare<{invoice_id:string}>(`SELECT n.data::jsonb->>'invoiceId' invoice_id FROM company_billing_notifications n
    JOIN company_billing_invoices i ON i.stripe_invoice_id=n.data::jsonb->>'invoiceId' AND i.workspace_id=n.workspace_id
    WHERE n.workspace_id=? AND n.kind='payment_failed' AND i.status='open' AND i.amount_remaining>0
      AND i.synced_at::timestamptz>=COALESCE((n.data::jsonb->>'receivedAt')::timestamptz,n.created_at::timestamptz)
    ORDER BY n.created_at DESC LIMIT 1`).get(workspaceId) : Promise.resolve(undefined)])
  return {...billing,activeSeats:usage?.active??0,pendingInvitationSeats:usage?.pending??0,actionRequiredInvoice:actionRequired?{id:actionRequired.invoice_id,url:actionRequired.invoice_url}:null,paymentFailedInvoice:paymentFailed?{id:paymentFailed.invoice_id}:null}
}
