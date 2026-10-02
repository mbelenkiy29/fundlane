import "server-only"

import { getDatabase } from "../db"
import type { DealActor } from "../deals/schema"
import { AppError } from "../errors"
import { liveEmailActor } from "../email-conversations/service"
import { enqueueNotification } from "../notifications/service"
import { listAdvanceRows } from "../advances/repository"
import { runRenewalEligibility } from "./service"

export const renewalAlertsEnabled = (): boolean => process.env.MCA_RENEWAL_ALERTS_ENABLED === "true"

/** Scheduled pass: eligibility per company with a policy, then one broker email per advance, policy version and assigned broker. */
export async function runRenewalAlerts(clock: string) {
  const result = { companies: 0, enqueued: 0, failed: 0 }
  const db = getDatabase()
  for (const { workspace_id: workspaceId } of await db.prepare<{ workspace_id: string }>("SELECT workspace_id FROM mca_renewal_policies ORDER BY workspace_id").all()) {
    result.companies++
    try {
      const system: DealActor = { workspaceId, userId: null, membershipId: null, role: "admin", managedMembershipIds: [],
        activeMembershipIds: [], source: "system", correlationId: `cron-renewals:${workspaceId}:${clock}` }
      const { eligible } = await runRenewalEligibility(system, clock)
      const dealByAdvance = new Map((await listAdvanceRows(workspaceId)).map((row) => [row.id, row.deal_id]))
      for (const item of eligible) {
        const dealId = dealByAdvance.get(item.sourceAdvanceId)
        if (!dealId) continue
        const brokers = await db.prepare<{ membershipId: string; userId: string }>(`SELECT DISTINCT m.id AS "membershipId", m.user_id AS "userId" FROM deal_assignments a JOIN memberships m ON m.workspace_id=a.workspace_id AND m.id=a.membership_id WHERE a.workspace_id=? AND a.deal_id=? AND a.kind IN ('originator','closer') AND m.status='active' ORDER BY m.user_id`).all(workspaceId, dealId)
        for (const broker of brokers) {
          try {
            // Each broker enqueues as themselves (deal access is re-checked); times come from the stored action so replays are identical.
            await enqueueNotification(await liveEmailActor(workspaceId, broker.membershipId), {
              kind: "renewal", eventKey: `renewal:v${item.policyVersion}:${item.sourceAdvanceId}`, dealId, audience: "broker", channel: "email",
              recipientUserId: broker.userId, scheduledFor: item.eligibleAt, approvedAt: item.eligibleAt,
              payload: { title: item.messageSubject, message: item.messageBody },
            })
            result.enqueued++
          } catch (error) { if (!(error instanceof AppError)) throw error; result.failed++ }
        }
      }
    } catch (error) { if (!(error instanceof AppError)) throw error; result.failed++ }
  }
  return result
}
