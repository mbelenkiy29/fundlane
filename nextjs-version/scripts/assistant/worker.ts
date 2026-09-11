import { maintainCreditAlerts } from "../../src/lib/mca/assistant/alerts"
import { releaseExpiredReservations } from "../../src/lib/mca/assistant/credits"
import { closeDatabaseForTests } from "../../src/lib/mca/db"
import { maintainAssistantExperience } from "../../src/lib/mca/assistant/maintenance"
let stopped = false
process.on("SIGTERM", () => {
  stopped = true
})
process.on("SIGINT", () => {
  stopped = true
})
async function main() {
  do {
    try {
      await releaseExpiredReservations()
      await maintainAssistantExperience()
      await maintainCreditAlerts()
    } catch {
      console.error(
        "Assistant account maintenance will retry; no sensitive details recorded."
      )
    }
    if (process.argv.includes("--once")) break
    for (let i = 0; i < 30 && !stopped; i++)
      await new Promise((resolve) => setTimeout(resolve, 1000))
  } while (!stopped)
  await closeDatabaseForTests()
}
void main()
