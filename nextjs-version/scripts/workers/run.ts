import { setTimeout } from "node:timers/promises"
import { closeDatabaseForTests } from "../../src/lib/mca/db"
import { runNextBackgroundJob } from "../../src/lib/mca/jobs/worker"
import { runDueAttachmentJobs } from "../../src/lib/mca/intake/service"
import { cleanupWorkerStorage } from "../../src/lib/mca/jobs/cleanup"
let stopped = false
process.on("SIGTERM", () => { stopped = true })
process.on("SIGINT", () => { stopped = true })
async function main() {
  let maintenanceAt = 0
  let intakeAt = 0
  try {
    while (!stopped) {
      try {
        if (Date.now() >= intakeAt) {
          await runDueAttachmentJobs(5)
          intakeAt = Date.now() + 5000
        }
        const worked = await runNextBackgroundJob()
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
