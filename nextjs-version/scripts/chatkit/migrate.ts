/** Additive ChatKit schema is applied through `pnpm db:migrate`. */
import { requiredUrl, assertMigrationDestination } from "../database/connections"

const url = requiredUrl("DATABASE_URL_UNPOOLED")
assertMigrationDestination(url)
console.log(JSON.stringify({
  result: "use_pnpm_db_migrate",
  command: "pnpm db:migrate --expected-project-ref=REF",
}))
