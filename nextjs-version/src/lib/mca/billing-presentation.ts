import "server-only"
import { getWorkspaceBilling } from "./billing"
import { getDatabase } from "./db"
export async function getCompanyBillingPresentation(workspaceId:string) {
  const [billing,usage]=await Promise.all([getWorkspaceBilling(workspaceId),getDatabase().prepare<{active:number;pending:number}>("SELECT count(*) FILTER (WHERE status='active')::int active,count(*) FILTER (WHERE status='pending')::int pending FROM memberships WHERE workspace_id=?").get(workspaceId)])
  return {...billing,activeSeats:usage?.active??0,pendingInvitationSeats:usage?.pending??0}
}
