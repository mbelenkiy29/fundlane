import { getDatabase, closeDatabaseForTests } from "../../src/lib/mca/db"
import { decryptSensitive } from "../../src/lib/mca/crypto"
import { listDemoSubmissions, retryUnsentDemoSubmissions, demoVisibilityEnabled } from "../../src/lib/marketing/demo-storage"

// Run only in the private deployment shell; never capture show output in shared logs.
async function main() {
const [command = "list", id] = process.argv.slice(2)
try {
  if (command === "list") {
    const [legacy, submissions] = await Promise.all([
      getDatabase().query("SELECT request_id, created_at FROM marketing_demo_requests ORDER BY created_at DESC LIMIT 100"),
      listDemoSubmissions(),
    ])
    console.log(JSON.stringify([
      ...submissions.map(row => ({ source: "database", request_id: row.request_id, created_at: row.created_at, brokerage: row.contact.brokerage, notification_status: row.notification_status, notification_attempts: row.notification_attempts })),
      ...legacy.rows.map(row => ({ ...row, source: "legacy", notification_status: "unknown" })),
    ].sort((a, b) => new Date(b.created_at as string).getTime() - new Date(a.created_at as string).getTime()), null, 2))
  } else if ((command === "show" && (/^[a-f0-9]{64}$/.test(id || "") || /^[a-f0-9-]{36}$/.test(id || ""))) || (command === "delete" && /^[a-f0-9]{64}$/.test(id || ""))) {
    if (command === "show") {
      const row = await getDatabase().queryOne<{ payload_cipher: string }>("SELECT payload_cipher FROM marketing_demo_submissions WHERE request_id = ?", [id])
      if (row) console.log(decryptSensitive(row.payload_cipher, `marketing-demo-submission:${id}`))
      else {
        const legacy = await getDatabase().queryOne<{ payload_cipher: string }>("SELECT payload_cipher FROM marketing_demo_requests WHERE request_id = ?", [id])
        if (!legacy?.payload_cipher) throw new Error("Not found")
        console.log(decryptSensitive(legacy.payload_cipher, `marketing-demo:${id}`))
      }
    } else {
      // Keep a non-contact tombstone so an old retry cannot recreate a deleted inquiry.
      const count = await getDatabase().execute("UPDATE marketing_demo_requests SET payload_cipher = '' WHERE request_id = ? AND payload_cipher <> ''", [id])
      console.log(JSON.stringify({ deleted: count }))
    }
  } else if (command === "retry" && !id && demoVisibilityEnabled()) {
    console.log(JSON.stringify({ sent: await retryUnsentDemoSubmissions() }))
  } else throw new Error("Usage: inbox.ts list | show <request-id> | delete <legacy-request-id> | retry (when MCA_DEMO_VISIBILITY_ENABLED=true)")
} catch {
  console.error("Inbox operation failed. Check the command and private deployment configuration.")
  process.exitCode = 1
} finally { await closeDatabaseForTests() }

}
void main()
