import "server-only"
import { getWorkspaceBilling } from "./billing"
import { getDatabase } from "./db"
export async function getCompanyBillingPresentation(workspaceId:string) {
  const [billing,usage,actionRequired]=await Promise.all([getWorkspaceBilling(workspaceId),getDatabase().prepare<{active:number;pending:number}>("SELECT count(*) FILTER (WHERE status='active')::int active,count(*) FILTER (WHERE status='pending')::int pending FROM memberships WHERE workspace_id=?").get(workspaceId),getDatabase().prepare<{invoice_id:string;invoice_url:string|null}>(`SELECT n.data::jsonb->>'invoiceId' invoice_id,n.data::jsonb->>'invoiceUrl' invoice_url FROM company_billing_notifications n
    LEFT JOIN company_billing_invoices i ON i.stripe_invoice_id=n.data::jsonb->>'invoiceId' AND i.workspace_id=n.workspace_id
    WHERE n.workspace_id=? AND n.kind='payment_action_required' AND COALESCE(i.status,'open') NOT IN ('paid','void','uncollectible')
    ORDER BY n.created_at DESC LIMIT 1`).get(workspaceId)])
  return {...billing,activeSeats:usage?.active??0,pendingInvitationSeats:usage?.pending??0,actionRequiredInvoice:actionRequired?{id:actionRequired.invoice_id,url:actionRequired.invoice_url}:null}
}
