// Run with: node --conditions=react-server --import tsx scripts/database/backfill-merchant-hashes.ts
// Hosted runs also need --confirm-backfill after MCA_DATA_ENCRYPTION_KEY is confirmed.
import { closeDatabaseForTests } from "../../src/lib/mca/db"
import { backfillMerchantHashes } from "../../src/lib/mca/merchants/backfill"
import { assertMigrationDestination, requiredUrl } from "./connections"

async function main() {
  const destination = requiredUrl("DATABASE_URL")
  assertMigrationDestination(destination)
  const hosted = !["localhost", "127.0.0.1", "[::1]"].includes(new URL(destination).hostname)
  if (hosted && !process.argv.includes("--confirm-backfill")) {
    throw new Error("Hosted merchant hash backfill requires --confirm-backfill after MCA_DATA_ENCRYPTION_KEY is confirmed.")
  }
  const result = await backfillMerchantHashes()
  console.log(JSON.stringify(result))
  await closeDatabaseForTests()
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : "Merchant hash backfill failed.")
  process.exitCode = 1
})
