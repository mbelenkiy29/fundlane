import "server-only"
import { withTransaction } from "../db"
import { releaseExpiredReservations } from "./credits"
import { processCreditAlerts, deliverCreditAlerts } from "./alerts"
import { maintainAssistantExperience } from "./maintenance"

const CRON_CLEANUP_BATCH_SIZE = 10

/** Only one cron tick processes credit maintenance at a time. Commit credits and
 * alerts before any provider I/O; the email and cleanup outboxes claim separately. */
export async function runAssistantMaintenance() {
  const claimed = await withTransaction(async db => {
    const lock = await db.prepare<{ locked: boolean }>("SELECT pg_try_advisory_xact_lock(hashtext(?)) AS locked")
      .get("mca-assistant-maintenance")
    if (!lock?.locked) return false
    await releaseExpiredReservations()
    await processCreditAlerts()
    return true
  })
  if (claimed) {
    await deliverCreditAlerts()
    await maintainAssistantExperience(CRON_CLEANUP_BATCH_SIZE)
  }
  return { claimed }
}
