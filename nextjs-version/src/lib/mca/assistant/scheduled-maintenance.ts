import "server-only"
import { withTransaction } from "../db"
import { releaseExpiredReservations } from "./credits"
import { processCreditAlerts, deliverCreditAlerts } from "./alerts"
import { maintainAssistantExperience } from "./maintenance"

/** Only one cron tick processes assistant maintenance at a time. The email outbox
 * claims each delivery separately, so provider I/O stays outside this transaction. */
export async function runAssistantMaintenance() {
  const claimed = await withTransaction(async db => {
    const lock = await db.prepare<{ locked: boolean }>("SELECT pg_try_advisory_xact_lock(hashtext(?)) AS locked")
      .get("mca-assistant-maintenance")
    if (!lock?.locked) return false
    await releaseExpiredReservations()
    await maintainAssistantExperience()
    await processCreditAlerts()
    return true
  })
  if (claimed) await deliverCreditAlerts()
  return { claimed }
}
