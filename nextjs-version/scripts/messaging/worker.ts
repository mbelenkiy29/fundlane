import { runMessagingWorkerOnce } from "../../src/lib/mca/email-conversations/worker"
import { closeDatabaseForTests } from "../../src/lib/mca/db"
let stopping = false
process.on("SIGTERM", () => {
  stopping = true
})
process.on("SIGINT", () => {
  stopping = true
})
async function main() {
  try {
    do {
      try {
        console.log(
          JSON.stringify({
            event: "messaging_worker_tick",
            ...(await runMessagingWorkerOnce(() => stopping)),
          })
        )
      } catch {
        console.error(JSON.stringify({ event: "messaging_worker_failed" }))
        if (process.argv.includes("--once")) process.exitCode = 1
      }
      if (process.argv.includes("--once")) break
      if (!stopping) await new Promise((resolve) => setTimeout(resolve, 5000))
    } while (!stopping)
  } finally {
    await closeDatabaseForTests()
  }
}
void main().catch(() => {
  process.exitCode = 1
})
