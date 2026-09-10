import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { randomUUID } from "node:crypto"
import { createClerkClient } from "@clerk/backend"
import { createPostgresTestDatabase } from "./postgres-test-db.mjs"
const run = promisify(execFile)
if (!process.env.CLERK_SECRET_KEY?.startsWith("sk_test_"))
  throw new Error("Development Clerk instance required.")
const db = await createPostgresTestDatabase("clerk_migration")
const client = createClerkClient({ secretKey: process.env.CLERK_SECRET_KEY })
const uid = randomUUID(),
  wid = randomUUID(),
  mid = randomUUID(),
  now = new Date().toISOString()
try {
  await db.query(
    "INSERT INTO users (id,email,password_hash,name,application_identifier,created_at,updated_at) VALUES ($1,$2,'never-export-this-hash','Migration test',$3,$4,$4)",
    [uid, `migration-${uid}+clerk_test@example.com`, `MCA-${uid}`, now]
  )
  await db.query(
    "INSERT INTO workspaces (id,name,timezone,seat_limit,feature_flags,page_visibility,action_visibility,created_at,updated_at) VALUES ($1,'Migration rehearsal','America/New_York',5,'{}','{}','{}',$2,$2)",
    [wid, now]
  )
  await db.query(
    "INSERT INTO memberships (id,workspace_id,user_id,role,status,created_at,updated_at) VALUES ($1,$2,$3,'manager','active',$4,$4)",
    [mid, wid, uid, now]
  )
  const invoke = async (args) =>
    run(
      process.execPath,
      [
        "--conditions=react-server",
        "--import",
        "tsx",
        "scripts/clerk/migrate.ts",
        ...args,
      ],
      { env: db.env(), timeout: 60000 }
    )
  const dry = await invoke([])
  assert.match(dry.stdout, /dry-run/)
  assert.equal(
    (await db.query("SELECT clerk_user_id FROM users WHERE id=$1", [uid]))
      .rows[0].clerk_user_id,
    null
  )
  await invoke(["--apply"])
  const first = (
    await db.query("SELECT clerk_user_id FROM users WHERE id=$1", [uid])
  ).rows[0].clerk_user_id
  await invoke(["--apply"])
  assert.equal(
    (await db.query("SELECT clerk_user_id FROM users WHERE id=$1", [uid]))
      .rows[0].clerk_user_id,
    first
  )
  const remote = await client.users.getUser(first)
  assert.equal(remote.passwordEnabled, false)
  assert.equal(remote.externalId, uid)
  assert.equal(
    (await db.query("SELECT role FROM memberships WHERE id=$1", [mid])).rows[0]
      .role,
    "manager"
  )
  console.log(
    "PASS: dry-run has no mutations; two imports preserve IDs and roles; old passwords are not imported."
  )
} finally {
  const org = (
    await db.query("SELECT clerk_organization_id FROM workspaces WHERE id=$1", [
      wid,
    ])
  ).rows[0]?.clerk_organization_id
  const user = (
    await db.query("SELECT clerk_user_id FROM users WHERE id=$1", [uid])
  ).rows[0]?.clerk_user_id
  if (org) await client.organizations.deleteOrganization(org)
  if (user) await client.users.deleteUser(user)
  await db.close()
}
