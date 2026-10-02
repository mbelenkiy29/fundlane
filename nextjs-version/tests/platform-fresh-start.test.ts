import test from "node:test"
import assert from "node:assert/strict"
import { chmod, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createHash, randomUUID } from "node:crypto"
import pg from "pg"
import { createPostgresTestDatabase } from "./helpers/postgres-test-db.mjs"
import { COMPANY_MANIFEST, PROTECTED_USERS, TEST_USERS, PRODUCTION_REF, inventorySql, deletionSql, freshStart, reviewStripeCustomer, verifyPrivateBackup } from "../scripts/ops/platform-fresh-start"

test("recovery copies must be private, regular files with verified contents before deletion", async () => {
  const directory = await mkdtemp(join(tmpdir(), "fresh-start-backup-"))
  const path = join(directory, "copy.bin")
  const checksum = createHash("sha256").update("recovery").digest("hex")
  try {
    await writeFile(path, "recovery", { mode: 0o600 })
    await verifyPrivateBackup(path, checksum)
    await writeFile(path, "corrupt")
    await assert.rejects(verifyPrivateBackup(path, checksum), /checksum failed/)
    await writeFile(path, "recovery")
    await chmod(path, 0o644)
    await assert.rejects(verifyPrivateBackup(path, checksum), /not private/)
    await chmod(path, 0o600)
    await symlink(path, join(directory, "link.bin"))
    await assert.rejects(verifyPrivateBackup(join(directory, "link.bin"), checksum), /not private/)
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test("fresh start inventories dependencies, fails closed, rolls back and resumes without touching new companies", async () => {
  const db = await createPostgresTestDatabase("fresh_start")
  const directory = await mkdtemp(join(tmpdir(), "fresh-start-test-"))
  const client = new pg.Client(db.databaseUrl)
  await client.connect()
  const previousUrl = process.env.MCA_OPS_SOURCE_DATABASE_URL
  try {
    for (const [index, id] of [...PROTECTED_USERS, ...TEST_USERS].entries()) {
      const email = index === 0 ? "mike@sentineltechsolutions.io" : index === 1 ? "ben@sentineltechsolutions.io" : `synthetic-${index}@example.test`
      await client.query("INSERT INTO users(id,email,name,application_identifier,created_at,updated_at) VALUES ($1,$2,'Synthetic',$1,now()::text,now()::text)", [id, email])
      await client.query("INSERT INTO user_totp_factors(user_id,status,secret_cipher,created_at,updated_at) VALUES ($1,'enabled','synthetic-cipher',now()::text,now()::text)", [id])
      await client.query("INSERT INTO auth_session_totp(session_id,user_id,method,created_at) VALUES ($1,$1,'totp',now()::text)", [id])
    }
    for (const id of PROTECTED_USERS) await client.query("INSERT INTO platform_admin_grants(user_id,granted_at,granted_by,reason) VALUES ($1,now()::text,'operator','Preserved owner')", [id])
    for (const [index, [id, name]] of COMPANY_MANIFEST.entries()) {
      await client.query("INSERT INTO workspaces(id,name,feature_flags,page_visibility,created_at,updated_at) VALUES ($1,$2,'{}','{}',now()::text,now()::text)", [id, name])
      const user = TEST_USERS[index % TEST_USERS.length]
      await client.query("INSERT INTO memberships(id,workspace_id,user_id,role,status,created_at,updated_at) VALUES ($1,$2,$3,'admin','active',now()::text,now()::text)", [id, id, user])
      await client.query("INSERT INTO workspace_owners(workspace_id,membership_id,updated_at) VALUES ($1,$1,now()::text)", [id])
    }
    for (const id of PROTECTED_USERS) await client.query("INSERT INTO memberships(id,workspace_id,user_id,role,status,created_at,updated_at) VALUES ($1,$2,$1,'admin','active',now()::text,now()::text)", [id, COMPANY_MANIFEST[0][0]])
    await client.query("INSERT INTO platform_admin_audit(id,actor_user_id,actor_email,action) VALUES ('existing-owner-history',$1,'mike@sentineltechsolutions.io','super_admin.first_access')", [PROTECTED_USERS[0]])
    // Includes a workspace-scoped row without a workspace FK and its composite-key dependency.
    await client.query("CREATE TABLE cleanup_parent (id text PRIMARY KEY,workspace_id text NOT NULL); CREATE TABLE cleanup_child(parent_id text REFERENCES cleanup_parent(id),part integer,PRIMARY KEY(parent_id,part)); INSERT INTO cleanup_parent VALUES ('parent','" + COMPANY_MANIFEST[0][0] + "'); INSERT INTO cleanup_child VALUES ('parent',1)")
    const inventory = async () => {
      const results = await client.query(inventorySql())
      return (Array.isArray(results) ? results : [results]).flatMap(result => result.rows).find(row => row.inventory).inventory
    }
    const blocked = async (sql: string, undo: string, message: RegExp) => {
      await client.query(sql)
      await assert.rejects(inventory(), message)
      await client.query("ROLLBACK")
      await client.query(undo)
      assert.equal((await client.query("SELECT count(*)::int n FROM workspaces")).rows[0].n, 6)
    }
    const baseline = await inventory()
    assert.equal(baseline.rows.filter((row: { table: string }) => row.table === "cleanup_child").length, 1)
    process.env.MCA_OPS_SOURCE_DATABASE_URL = db.databaseUrl
    const args = [`--expected-project-ref=${PRODUCTION_REF}`, "--synthetic"]
    const dryRun = await freshStart(args)
    assert.equal(dryRun.companies, 6)
    assert.equal(dryRun.testUsers, 5)
    assert.equal((await inventory()).fingerprint, baseline.fingerprint)
    await blocked("INSERT INTO workspaces SELECT 'new-company','Real signup',logo_url,timezone,seat_limit,feature_flags,page_visibility,action_visibility,created_at,updated_at,require_2fa FROM workspaces LIMIT 1", "DELETE FROM workspaces WHERE id='new-company'", /New company/)
    await blocked(`INSERT INTO platform_admin_audit(id,actor_user_id,actor_email,action,target_workspace_id) VALUES ('blocking-audit','${PROTECTED_USERS[0]}','mike@sentineltechsolutions.io','support','${COMPANY_MANIFEST[0][0]}')`, "ALTER TABLE platform_admin_audit DISABLE TRIGGER platform_admin_audit_append_only; DELETE FROM platform_admin_audit WHERE id='blocking-audit'; ALTER TABLE platform_admin_audit ENABLE TRIGGER platform_admin_audit_append_only", /audit/)
    await blocked(`INSERT INTO company_billing_invoices(stripe_invoice_id,workspace_id,status,currency,amount_due,amount_paid,amount_remaining,created_at,synced_at) VALUES ('paid-block','${COMPANY_MANIFEST[0][0]}','paid','usd',100,100,0,now()::text,now()::text)`, "DELETE FROM company_billing_invoices WHERE stripe_invoice_id='paid-block'", /Paid activity/)
    await client.query("CREATE TABLE cleanup_delivery(id text PRIMARY KEY,workspace_id text,state text,lease_until text)")
    await blocked(`INSERT INTO cleanup_delivery VALUES ('active','${COMPANY_MANIFEST[0][0]}','sending','2099-01-01')`, "DELETE FROM cleanup_delivery", /Active job/)
    await blocked(`INSERT INTO retention_holds(id,workspace_id,reason,note,placed_by,placed_at) VALUES ('hold','${COMPANY_MANIFEST[0][0]}','dispute','Synthetic hold','${PROTECTED_USERS[0]}',now())`, "DELETE FROM retention_holds WHERE id='hold'", /Active retention/)
    await client.query("INSERT INTO users(id,email,name,application_identifier,created_at,updated_at) VALUES ('unreviewed','unreviewed@example.test','New identity','unreviewed',now()::text,now()::text)")
    await blocked(`INSERT INTO memberships(id,workspace_id,user_id,role,status,created_at,updated_at) VALUES ('outside','${COMPANY_MANIFEST[0][0]}','unreviewed','admin','active',now()::text,now()::text)`, "DELETE FROM memberships WHERE id='outside'", /Unreviewed company member/)
    await client.query("DELETE FROM users WHERE id='unreviewed'")
    // A concurrent data change invalidates the recovery fingerprint before any deletion.
    const beforeChange = await inventory()
    await client.query("INSERT INTO cleanup_child VALUES ('parent',2)")
    await assert.rejects(client.query(deletionSql(beforeChange.fingerprint)), /Inventory changed/)
    await client.query("ROLLBACK")
    assert.equal((await client.query("SELECT count(*)::int n FROM users")).rows[0].n, 7)
    // An unexpected trigger error after earlier deletes must roll back the entire transaction.
    await client.query("CREATE FUNCTION cleanup_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'forced rollback'; END $$; CREATE TRIGGER cleanup_fail BEFORE DELETE ON workspaces FOR EACH ROW EXECUTE FUNCTION cleanup_fail()")
    await assert.rejects(client.query(deletionSql((await inventory()).fingerprint)), /forced rollback/)
    await client.query("ROLLBACK")
    assert.equal((await client.query("SELECT count(*)::int n FROM cleanup_child")).rows[0].n, 2)
    await client.query("DROP TRIGGER cleanup_fail ON workspaces")
    const ownersBefore = (await client.query("SELECT to_jsonb(u) u,to_jsonb(g) g,to_jsonb(f) f,to_jsonb(s) s FROM users u JOIN platform_admin_grants g ON g.user_id=u.id JOIN user_totp_factors f ON f.user_id=u.id JOIN auth_session_totp s ON s.user_id=u.id ORDER BY u.id")).rows
    await freshStart([...args, "--apply", "--confirm", `--directory=${directory}`])
    assert.equal((await client.query("SELECT count(*)::int n FROM workspaces")).rows[0].n, 0)
    assert.equal((await client.query("SELECT count(*)::int n FROM memberships")).rows[0].n, 0)
    assert.equal((await client.query("SELECT count(*)::int n FROM cleanup_child")).rows[0].n, 0)
    assert.deepEqual((await client.query("SELECT to_jsonb(u) u,to_jsonb(g) g,to_jsonb(f) f,to_jsonb(s) s FROM users u JOIN platform_admin_grants g ON g.user_id=u.id JOIN user_totp_factors f ON f.user_id=u.id JOIN auth_session_totp s ON s.user_id=u.id ORDER BY u.id")).rows, ownersBefore)
    assert.equal((await client.query("SELECT count(*)::int n FROM platform_admin_audit")).rows[0].n, 7)
    assert.equal((await client.query("SELECT count(*)::int n FROM platform_admin_audit WHERE target_workspace_id IS NOT NULL")).rows[0].n, 0)
    assert.equal((await stat(join(directory, "progress.json"))).mode & 0o077, 0)
    assert.equal(JSON.parse(await readFile(join(directory, "progress.json"), "utf8")).dbComplete, true)
    const newId = randomUUID()
    await client.query("INSERT INTO workspaces(id,name,feature_flags,page_visibility,created_at,updated_at) VALUES ($1,'First real company','{}','{}',now()::text,now()::text)", [newId])
    await freshStart([...args, "--apply", "--confirm", `--directory=${directory}`])
    assert.deepEqual((await client.query("SELECT id FROM workspaces")).rows, [{ id: newId }])
    assert.equal((await client.query("SELECT count(*)::int n FROM platform_admin_audit")).rows[0].n, 7)
    await assert.rejects(freshStart(["--expected-project-ref=wrong", "--synthetic"]), /reviewed/)
  } finally {
    if (previousUrl === undefined) delete process.env.MCA_OPS_SOURCE_DATABASE_URL
    else process.env.MCA_OPS_SOURCE_DATABASE_URL = previousUrl
    await client.end()
    await db.close()
    await rm(directory, { recursive: true, force: true })
  }
})


test("Stripe cleanup accepts only the reviewed live customer with no payment history", () => {
  const customer = { id: "cus_VLVSq1hL2JtKtA", livemode: true, balance: 0, metadata: { workspace_id: COMPANY_MANIFEST[5][0] } }
  const empty = { data: [], has_more: false }
  const history = { invoices: empty, payments: empty, subscriptions: empty, sessions: { data: [{ id: "cs_unused", status: "open" }], has_more: false }, charges: empty, balance: empty }
  assert.deepEqual(reviewStripeCustomer(customer, history).sessions, ["cs_unused"])
  assert.equal(reviewStripeCustomer({ id: customer.id, deleted: true }, {}).deleted, true)
  assert.throws(() => reviewStripeCustomer({ ...customer, livemode: false }, history), /mode/)
  assert.throws(() => reviewStripeCustomer({ ...customer, id: "cus_wrong" }, history), /identity/)
  assert.throws(() => reviewStripeCustomer({ ...customer, metadata: {} }, history), /identity/)
  for (const key of ["invoices", "charges", "balance", "subscriptions"]) {
    assert.throws(() => reviewStripeCustomer(customer, { ...history, [key]: { data: [{ amount: 1 }], has_more: false } }), /activity/)
  }
  assert.throws(() => reviewStripeCustomer(customer, { ...history, payments: { data: [{ amount_received: 0, status: "processing" }], has_more: false } }), /activity/)
  assert.throws(() => reviewStripeCustomer(customer, { ...history, sessions: { data: [{ status: "complete" }], has_more: false } }), /activity/)
  assert.throws(() => reviewStripeCustomer(customer, { ...history, invoices: { ...empty, has_more: true } }), /limit/)
})
