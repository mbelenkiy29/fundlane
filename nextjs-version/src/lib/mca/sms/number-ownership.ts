import "server-only"
import { getDatabase } from "../db"
import { company, provider } from "./onboarding"

/** Internal read-only contract. Callers must authorize workspace access first.
 * Ownership/configuration data does not establish Voice capability or activation.
 */
export interface CompanyNumberOwnership {
  numberId: string
  accountId: string
  providerSid: string
  phone: string
  state: string
  assignedMembershipId: string | null
  assignedMembershipActive: boolean
  companySuspended: boolean
  providerAccountSid: string | null
  providerConfigured: boolean
}

export async function getCompanyNumberOwnership(
  workspaceId: string,
  numberId: string
): Promise<CompanyNumberOwnership | undefined> {
  const n = await getDatabase().prepare<{
    id: string; account_id: string; provider_sid: string; phone: string
    state: string; membership_id: string | null; membership_status: string | null
  }>(`SELECT n.*,m.status AS membership_status FROM sms_numbers n
    LEFT JOIN memberships m ON m.workspace_id=n.workspace_id AND m.id=n.membership_id
    WHERE n.workspace_id=? AND n.id=?`).get(workspaceId, numberId)
  if (!n) return undefined
  const c = await company(workspaceId)
  const p = c ? provider(c) : undefined
  return {
    numberId: n.id,
    accountId: n.account_id,
    providerSid: n.provider_sid,
    phone: n.phone,
    state: n.state,
    assignedMembershipId: n.membership_id,
    assignedMembershipActive: n.membership_status === "active",
    companySuspended: !!c?.suspended,
    providerAccountSid: p?.accountSid ?? null,
    providerConfigured: !!(p?.accountSid && p.authToken),
  }
}
