import { getDatabase, closeDatabaseForTests } from "../../src/lib/mca/db"
import { decryptSensitive } from "../../src/lib/mca/crypto"

// Run only in the private deployment shell; never capture show output in shared logs.
async function main() {
const [command = "list", id] = process.argv.slice(2)
try {
  if (command === "list") {
    const rows = await getDatabase().query("SELECT request_id, created_at FROM marketing_demo_requests ORDER BY created_at DESC LIMIT 100")
    console.log(JSON.stringify(rows.rows, null, 2))
  } else if ((command === "show" || command === "delete") && /^[a-f0-9]{64}$/.test(id || "")) {
    if (command === "show") {
      const row = await getDatabase().queryOne<{ payload_cipher: string }>("SELECT payload_cipher FROM marketing_demo_requests WHERE request_id = ?", [id])
      if (!row?.payload_cipher) throw new Error("Not found")
      console.log(decryptSensitive(row.payload_cipher, `marketing-demo:${id}`))
    } else {
      // Keep a non-contact tombstone so an old retry cannot recreate a deleted inquiry.
      const count = await getDatabase().execute("UPDATE marketing_demo_requests SET payload_cipher = '' WHERE request_id = ? AND payload_cipher <> ''", [id])
      console.log(JSON.stringify({ deleted: count }))
    }
  } else throw new Error("Usage: inbox.ts list | show <request-id> | delete <request-id>")
} catch {
  console.error("Inbox operation failed. Check the command and private deployment configuration.")
  process.exitCode = 1
} finally { await closeDatabaseForTests() }

}
void main()
