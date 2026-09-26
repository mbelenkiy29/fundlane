import { setTimeout } from "node:timers/promises"
import { closeDatabaseForTests } from "../../src/lib/mca/db"
import { recoverSubmissionOutbox, runNextBackgroundJob, touchDocumentWorkerHeartbeat } from "../../src/lib/mca/jobs/worker"
import { scheduleIntakeProcessing } from "../../src/lib/mca/intake/processing"
import { scheduleDueInvitationReminders } from "../../src/lib/mca/applications/reminders"
import { runDueAttachmentJobs } from "../../src/lib/mca/intake/service"
import { cleanupWorkerStorage } from "../../src/lib/mca/jobs/cleanup"
import type { BackgroundJobKind } from "../../src/lib/mca/jobs/queue"
const nativeKinds: readonly BackgroundJobKind[] = ["document_upload", "document_scan", "draft_scan", "assistant_scan", "intake_process"]
let stopped = false
process.on("SIGTERM", () => { stopped = true })
process.on("SIGINT", () => { stopped = true })
async function main() {
  const nativeOnly = process.env.MCA_NATIVE_DOCUMENT_EXECUTOR === "true"
  let maintenanceAt = 0
  let intakeAt = 0
  try {
    while (!stopped) {
      try {
        if (!nativeOnly && Date.now() >= intakeAt) {
          await runDueAttachmentJobs(5)
          await scheduleIntakeProcessing(25)
          await scheduleDueInvitationReminders(process.env.MCA_APP_ORIGIN ?? "")
          intakeAt = Date.now() + 5000
        }
        await touchDocumentWorkerHeartbeat()
        if (!nativeOnly) await recoverSubmissionOutbox()
        const worked = await runNextBackgroundJob(nativeOnly ? nativeKinds : undefined)
        if (Date.now() >= maintenanceAt) {
          await cleanupWorkerStorage()
          maintenanceAt = Date.now() + 60_000
        }
        if (process.argv.includes("--once")) break
        if (!worked) await setTimeout(1000)
      } catch {
        console.error(JSON.stringify({ event: "document_worker_tick_failed", message: "Check database, storage, scanner, and provider configuration." }))
        if (process.argv.includes("--once")) { process.exitCode = 1; break }
        await setTimeout(5000)
      }
    }
  } finally { await closeDatabaseForTests() }
}
void main()
