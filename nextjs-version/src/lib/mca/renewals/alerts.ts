import "server-only"

import { getDatabase } from "../db"
import type { DealActor } from "../deals/schema"
import { liveEmailActor } from "../email-conversations/service"
import { enqueueNotification } from "../notifications/service"
import { registerNotificationCondition } from "../notifications/conditions"
import { listAdvanceRows } from "../advances/repository"
import { runRenewalEligibility } from "./service"

/** Dispatch-time guard (key = action id, version = policy version): the action must still be eligible under the current policy and its advance not reversed. Register in each process that enqueues or dispatches. */
export function registerRenewalNotificationCondition() {
  registerNotificationCondition("renewal", async (actor, condition) => !!(await getDatabase().prepare(
    `SELECT 1 FROM mca_renewal_actions a JOIN mca_renewal_policies p ON p.workspace_id=a.workspace_id AND p.version=a.policy_version
     JOIN mca_advances v ON v.workspace_id=a.workspace_id AND v.id=a.source_advance_id AND v.reversed_at IS NULL
     WHERE a.workspace_id=? AND a.id=? AND a.policy_version=? AND a.state='eligible'`).get(actor.workspaceId, condition.key, Number(condition.version))))
}

/** Scheduled pass: eligibility per company with a policy, then one broker email per advance, policy version and assigned broker. */
export async function runRenewalAlerts(clock: string, deadlineMs = Infinity) {
  const result = { companies: 0, enqueued: 0, failed: 0 }
  const db = getDatabase()
  registerRenewalNotificationCondition()
  for (const { workspace_id: workspaceId } of await db.prepare<{ workspace_id: string }>("SELECT workspace_id FROM mca_renewal_policies ORDER BY workspace_id").all()) {
    if (Date.now() >= deadlineMs) break
    result.companies++
    try {
      const system: DealActor = { workspaceId, userId: null, membershipId: null, role: "admin", managedMembershipIds: [],
        activeMembershipIds: [], source: "system", correlationId: `cron-renewals:${workspaceId}:${clock}` }
      const { eligible } = await runRenewalEligibility(system, clock)
      const dealByAdvance = new Map((await listAdvanceRows(workspaceId)).map((row) => [row.id, row.deal_id]))
      for (const item of eligible) {
        if (Date.now() >= deadlineMs) break // unmarked items are picked up next tick
        const dealId = dealByAdvance.get(item.sourceAdvanceId)
        if (!dealId) continue
        const brokers = await db.prepare<{ membershipId: string; userId: string }>(`SELECT DISTINCT m.id AS "membershipId", m.user_id AS "userId" FROM deal_assignments a JOIN memberships m ON m.workspace_id=a.workspace_id AND m.id=a.membership_id WHERE a.workspace_id=? AND a.deal_id=? AND a.kind IN ('originator','closer') AND m.status='active' ORDER BY m.user_id`).all(workspaceId, dealId)
        for (const broker of brokers) {
          if (Date.now() >= deadlineMs) break
          const eventKey = `renewal:v${item.policyVersion}:${item.sourceAdvanceId}`
          // Already alerted: skip, so later edits to the action text neither conflict nor re-run preflight.
          if (await db.prepare("SELECT 1 FROM mca_notifications WHERE workspace_id=? AND event_key=? AND audience='broker' AND channel='email' AND recipient_key=?").get(workspaceId, eventKey, broker.userId)) continue
          try {
            // Each broker enqueues as themselves (deal access is re-checked); times come from the stored action so replays are identical.
            await enqueueNotification(await liveEmailActor(workspaceId, broker.membershipId), {
              kind: "renewal", eventKey, dealId, condition: { type: "renewal", key: item.id, version: String(item.policyVersion) }, audience: "broker", channel: "email",
              recipientUserId: broker.userId, scheduledFor: item.eligibleAt, approvedAt: item.eligibleAt,
              // Action text is editable beyond the notification schema limits.
              payload: { title: item.messageSubject.replace(/\s+/g, " ").trim().slice(0, 200), message: item.messageBody.trim().slice(0, 2000) },
            })
            result.enqueued++
          } catch { result.failed++ }
        }
      }
    } catch { result.failed++ }
  }
  return result
}
