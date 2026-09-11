import { readFileSync } from "node:fs"
import { createHash } from "node:crypto"
import { spawnSync } from "node:child_process"
import { Pool } from "pg"
import { protectedConnections, directUrl } from "../neon/connections"
const target = process.argv.includes("--production")
  ? "production"
  : "verification"
const rehearsal = JSON.parse(
  readFileSync(".neon/assistant-experience-0022.json", "utf8")
)
const connection = directUrl(
  target === "production"
    ? protectedConnections().production
    : rehearsal.connection
)
const db = new Pool({ connectionString: connection, max: 1 })
const tables = [
  "mca_assistant_cleanup",
  "mca_assistant_conversation_meta",
  "mca_assistant_events",
  "mca_assistant_files",
  "mca_assistant_memories",
  "mca_assistant_memory_settings",
  "mca_assistant_message_parts",
  "mca_assistant_questions",
  "mca_assistant_run_meta"
]
async function counts() {
  return (
    await db.query(
      "SELECT (SELECT count(*) FROM deals) AS deals,(SELECT count(*) FROM users) AS users,(SELECT count(*) FROM memberships) AS memberships"
    )
  ).rows[0]
}
async function main() {
  try {
    const before = await counts()
    const result = spawnSync(
      process.execPath,
      ["--import", "tsx", "scripts/neon/migrate.ts", `--target=${target}`],
      {
        env: { ...process.env, DATABASE_URL_UNPOOLED: connection },
        stdio: "pipe"
      }
    )
    if (result.status !== 0)
      throw new Error(
        "The checked Drizzle migration runner failed; inspect the migration against the rehearsal branch."
      )
    const after = await counts()
    if (JSON.stringify(before) !== JSON.stringify(after))
      throw new Error(
        "Business counts changed during migration; investigate concurrent writes."
      )
    const hash = createHash("sha256")
      .update(readFileSync("drizzle/0022_assistant_experience.sql"))
      .digest("hex")
    const applied =
      (
        await db.query(
          "SELECT id FROM drizzle.__drizzle_migrations WHERE hash=$1",
          [hash]
        )
      ).rowCount === 1
    const actual = (
      await db.query(
        "SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename=ANY($1)",
        [tables]
      )
    ).rows.map((r) => r.tablename)
    const index =
      (
        await db.query(
          "SELECT indexdef FROM pg_indexes WHERE indexname='assistant_one_active_run'"
        )
      ).rows[0]?.indexdef ?? ""
    if (
      !applied ||
      actual.length !== tables.length ||
      !index.includes("awaiting_input") ||
      !index.includes("UNIQUE")
    )
      throw new Error("Migration verification failed")
    console.log(
      JSON.stringify({
        target,
        branch:
          target === "production"
            ? protectedConnections().productionBranch
            : rehearsal.branchId,
        migration: "0022",
        applied,
        tables: actual.length,
        oneActiveRun: true,
        businessCountsPreserved: after
      })
    )
  } catch (e) {
    console.error(
      e instanceof Error ? e.message : "Migration verification failed"
    )
    process.exitCode = 1
  } finally {
    await db.end()
  }
}
void main()
