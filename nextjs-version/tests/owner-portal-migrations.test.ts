import test from "node:test"
import assert from "node:assert/strict"
import { readFile, mkdtemp, mkdir, writeFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Client } from "pg"
import { drizzle } from "drizzle-orm/node-postgres"
import { migrate } from "drizzle-orm/node-postgres/migrator"
import { postgresConnection } from "../src/lib/mca/db-connection"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { createPostgresTestDatabase } from "./helpers/postgres-test-db.mjs"

const run = promisify(execFile)
const sql = (tag: string) => readFile(`drizzle/${tag}.sql`, "utf8")

test("SMS ledger upgrade preserves legacy company, provider, audit and AI records; runtime privileges stay restricted", async () => {
  const fixture = await createPostgresTestDatabase("sms_credit_upgrade", { migrateSchema: false })
  const client = new Client(postgresConnection(fixture.databaseUrl))
  await client.connect()
  const folder = await mkdtemp(join(tmpdir(), "sms-credit-migrations-"))
  try {
    await client.query("CREATE SCHEMA mca_private")
    // These shared cluster roles carry no test data. Do not alter or drop existing roles.
    await client.query(`DO $$ BEGIN
      IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon NOLOGIN; END IF;
      IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
    END $$`)
    const journal = JSON.parse(await readFile("drizzle/meta/_journal.json", "utf8")) as { entries: {tag: string; idx: number}[] }
    const prior = journal.entries.filter(e => e.idx < 62)
    await mkdir(join(folder, "meta"))
    await writeFile(join(folder, "meta/_journal.json"), JSON.stringify({ ...journal, entries: prior }))
    for (const entry of prior) await writeFile(join(folder, `${entry.tag}.sql`), await sql(entry.tag))
    await migrate(drizzle(client), { migrationsFolder: folder })
    await client.query(`
      INSERT INTO workspaces(id,name,feature_flags,page_visibility,created_at,updated_at) VALUES ('legacy','Legacy synthetic','{}','{}','2026-01-01','2026-01-01');
      INSERT INTO users(id,email,name,application_identifier,created_at,updated_at) VALUES ('legacy-user','legacy@example.test','Synthetic','legacy','2026-01-01','2026-01-01');
      INSERT INTO sms_companies(workspace_id,owner_user_id,provider_cipher,created_at,updated_at) VALUES ('legacy','legacy-user','opaque-provider-cipher','2026-01-01','2026-01-01');
      INSERT INTO sms_numbers(id,workspace_id,account_id,provider_sid,phone,state,monthly_cents,created_at,updated_at) VALUES ('legacy-number','legacy','legacy-account','PNsynthetic','+12125550100','active',100,'2026-01-01','2026-01-01');
      INSERT INTO sms_registrations(id,workspace_id,kind,attempt,provider_sid,status,created_at,updated_at) VALUES ('legacy-registration','legacy','brand',1,'BNsynthetic','approved','2026-01-01','2026-01-01');
      INSERT INTO sms_meter_events(id,workspace_id,message_id,segments,occurred_at,state,created_at,updated_at) VALUES ('legacy-meter','legacy','legacy-message',4,'2026-01-01','sent','2026-01-01','2026-01-01');
      INSERT INTO mca_credit_accounts(id,workspace_id,user_id,purchased_balance,created_at) VALUES ('legacy-ai','legacy','legacy-user',37,'2026-01-01');
      INSERT INTO platform_admin_audit(id,actor_user_id,actor_email,action,target_workspace_id) VALUES ('legacy-audit','legacy-user','legacy@example.test','synthetic','legacy');
    `)
    const tables = ['workspaces','sms_companies','sms_numbers','sms_registrations','sms_meter_events','mca_credit_accounts','platform_admin_audit']
    const before = []
    for (const table of tables) before.push(await client.query(`SELECT * FROM ${table}`))
    await client.query(await sql("0071_sms_credit_ledger"))
    for (const [i,t] of tables.entries()) assert.deepEqual((await client.query(`SELECT * FROM ${t}`)).rows, before[i].rows, t)
    assert.equal((await client.query("SELECT count(*)::int count FROM sms_credit_accounts")).rows[0].count, 0)
    await assert.rejects(client.query(`INSERT INTO sms_numbers(id,workspace_id,account_id,provider_sid,phone,state,monthly_cents,created_at,updated_at) VALUES ('second','legacy','second-account','PNsecond','+12125550101','active',100,'2026-01-01','2026-01-01')`), {code:'23505'})
    const { stdout } = await run(process.execPath, ['--import','tsx','scripts/database/secure-runtime.ts'], { env: fixture.env({ MCA_DB_RUNTIME_PASSWORD: 'synthetic_disposable_password_123456789' }) })
    assert.match(stdout, /Application RLS, browser restrictions, and server role configured/)
    const privileges = await client.query(`SELECT
      has_table_privilege('mca_app','sms_credit_ledger','INSERT') can_append,
      has_table_privilege('mca_app','sms_credit_ledger','UPDATE,DELETE,TRUNCATE') can_rewrite,
      has_table_privilege('mca_app','sms_credit_accounts','UPDATE') can_balance,
      has_table_privilege('mca_app','sms_credit_reservations','UPDATE') can_reserve,
      has_table_privilege('mca_app','platform_admin_grants','INSERT,UPDATE,DELETE') can_grant_admin,
      has_table_privilege('anon','sms_credit_ledger','SELECT') anon_read,
      has_table_privilege('authenticated','sms_credit_accounts','SELECT') authenticated_read`)
    assert.deepEqual(privileges.rows[0], {can_append:true,can_rewrite:false,can_balance:true,can_reserve:true,can_grant_admin:false,anon_read:false,authenticated_read:false})
    await client.query(`SET ROLE mca_app;
      INSERT INTO sms_credit_accounts(workspace_id,updated_at) VALUES ('legacy','2026-01-01');
      INSERT INTO sms_credit_ledger(id,workspace_id,purchase_id,provider_payment_id,kind,segments,balance_delta,reserved_delta,created_at) VALUES ('grant','legacy','purchase','payment','grant',5,5,0,'2026-01-01');
      RESET ROLE;`)
    for (const mutation of ["UPDATE sms_credit_ledger SET segments=6", "DELETE FROM sms_credit_ledger", "TRUNCATE sms_credit_ledger", "INSERT INTO platform_admin_grants(user_id,granted_at,granted_by,reason) VALUES ('legacy-user','2026-01-01','runtime','test')"]) {
      // SET ROLE and mutation use one checked-out query/connection; reset even after failure.
      await assert.rejects(client.query(`BEGIN; SET LOCAL ROLE mca_app; ${mutation}; COMMIT`), {code:'42501'})
      await client.query("ROLLBACK")
    }
    // Even the table owner cannot rewrite an entry accidentally.
    await assert.rejects(client.query("UPDATE sms_credit_ledger SET segments=6"), /append-only/)
    await assert.rejects(client.query("DELETE FROM sms_credit_ledger"), /append-only/)
    for (const role of ['anon','authenticated']) {
      await assert.rejects(client.query(`BEGIN; SET LOCAL ROLE ${role}; SELECT * FROM sms_credit_ledger; COMMIT`), {code:'42501'})
      await client.query("ROLLBACK")
    }
    assert.equal((await client.query("SELECT count(*)::int count FROM sms_credit_ledger")).rows[0].count, 1)
  } finally { await client.end(); await fixture.close(); await rm(folder, { recursive: true, force: true }) }
})
