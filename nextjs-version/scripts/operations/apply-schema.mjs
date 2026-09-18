import { readFile } from "node:fs/promises"
import { createHash } from "node:crypto"
import pg from "pg"
const expected = "drubsfvhlggmtyiigwxy"
if (process.argv[2] !== `--expected-project-ref=${expected}`)
  throw new Error("Explicit Fundlane project reference required.")
if (
  new URL(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "https://invalid")
    .hostname !== `${expected}.supabase.co`
)
  throw new Error("Supabase URL does not match expected project.")
const url = new URL(process.env.DATABASE_URL_UNPOOLED ?? "")
if (
  !url.hostname.includes(expected) &&
  !decodeURIComponent(url.username).endsWith(`.${expected}`)
)
  throw new Error("Database connection must identify expected project.")
// Use the existing app connection policy (including Supabase CA verification).
const { postgresConnection } =
  await import("../../src/lib/mca/db-connection.ts")
const client = new pg.Client(postgresConnection(url.href))
await client.connect()
try {
  await client.query("BEGIN")
  const last = await client.query(
    "SELECT created_at FROM drizzle.__drizzle_migrations ORDER BY created_at DESC LIMIT 1"
  )
  const journal = JSON.parse(
    await readFile("drizzle/meta/_journal.json", "utf8")
  ).entries
  const target = journal.find((x) => x.tag === "0037_platform_status"),
    prior = journal[journal.indexOf(target) - 1]
  if (Number(last.rows[0]?.created_at) === target.when) {
    console.log("Operations schema already applied.")
    await client.query("ROLLBACK")
    process.exitCode = 0
  } else {
    if (Number(last.rows[0]?.created_at) !== prior.when)
      throw new Error(
        "Apply preceding app migrations first; refusing to skip migration history."
      )
    const sql = await readFile(`drizzle/${target.tag}.sql`, "utf8")
    await client.query(sql)
    await client.query(
      "INSERT INTO drizzle.__drizzle_migrations(hash,created_at) VALUES($1,$2)",
      [createHash("sha256").update(sql).digest("hex"), target.when]
    )
    await client.query("COMMIT")
    console.log("Applied only operations migration 0037.")
  }
} catch (error) {
  await client.query("ROLLBACK")
  throw error
} finally {
  await client.end()
}
