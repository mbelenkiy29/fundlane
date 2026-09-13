/** Assistant experience schema is applied through `pnpm db:migrate`. */
import { spawnSync } from "node:child_process"
import { requiredUrl, assertMigrationDestination } from "../database/connections"

const url = requiredUrl("DATABASE_URL_UNPOOLED")
assertMigrationDestination(url)
const result = spawnSync(
  process.execPath,
  ["--import", "tsx", "scripts/database/migrate.ts", ...process.argv.slice(2)],
  { env: { ...process.env, DATABASE_URL_UNPOOLED: url }, stdio: "inherit" },
)
process.exit(result.status ?? 1)
