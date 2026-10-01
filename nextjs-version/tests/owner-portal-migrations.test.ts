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

test("SMS ledger upgrade from main 0075 preserves voice, document notifications, company, audit and AI records; runtime privileges stay restricted", async () => {
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
    const journal = JSON.parse(await readFile("drizzle/meta/_journal.json", "utf8")) as { entries: {tag: string; idx: number; when: number; version: string; breakpoints: boolean}[] }
    const prior = journal.entries.filter(e => e.idx < 67)
    assert.deepEqual(prior.slice(-5), [
      { idx: 62, version: "7", when: 1790385600020, tag: "0071_notification_foundation", breakpoints: true },
      { idx: 63, version: "7", when: 1790385600021, tag: "0072_browser_voice", breakpoints: true },
      { idx: 64, version: "7", when: 1790819000072, tag: "0073_document_notification_discovery", breakpoints: true },
      { idx: 65, version: "7", when: 1790819000073, tag: "0074_submission_previews", breakpoints: true },
      { idx: 66, version: "7", when: 1790819000074, tag: "0075_lender_criteria_provenance", breakpoints: true },
    ])
    const ledger = journal.entries.find(e => e.tag === "0076_sms_credit_ledger")!
    assert.deepEqual(ledger, { idx: 67, version: "7", when: 1790819000075, tag: "0076_sms_credit_ledger", breakpoints: true })
    assert.equal(new Set(journal.entries.map(e => e.idx)).size, journal.entries.length)
    assert.equal(new Set(journal.entries.map(e => e.tag)).size, journal.entries.length)
    assert.ok(ledger.when > prior.at(-1)!.when, "ledger must execute after the exact main 0075 baseline")
    assert.equal(new Set(journal.entries.map(e => e.when)).size, journal.entries.length)
    for (let i = 1; i < journal.entries.length; i++) {
      assert.ok(journal.entries[i].idx > journal.entries[i - 1].idx)
      assert.ok(journal.entries[i].when > journal.entries[i - 1].when)
    }
    await mkdir(join(folder, "meta"))
    await writeFile(join(folder, "meta/_journal.json"), JSON.stringify({ ...journal, entries: prior }))
    for (const entry of prior) await writeFile(join(folder, `${entry.tag}.sql`), await sql(entry.tag))
    await migrate(drizzle(client), { migrationsFolder: folder })
    await client.query(`
      INSERT INTO workspaces(id,name,feature_flags,page_visibility,created_at,updated_at) VALUES ('legacy','Legacy synthetic','{}','{}','2026-01-01','2026-01-01');
      INSERT INTO users(id,email,name,application_identifier,created_at,updated_at) VALUES ('legacy-user','legacy@example.test','Synthetic','legacy','2026-01-01','2026-01-01');
      INSERT INTO memberships(id,workspace_id,user_id,role,status,created_at,updated_at) VALUES ('legacy-member','legacy','legacy-user','admin','active','2026-01-01','2026-01-01');
      INSERT INTO sms_companies(workspace_id,owner_user_id,provider_cipher,created_at,updated_at) VALUES ('legacy','legacy-user','opaque-provider-cipher','2026-01-01','2026-01-01');
      INSERT INTO sms_numbers(id,workspace_id,account_id,provider_sid,phone,state,monthly_cents,created_at,updated_at) VALUES ('legacy-number','legacy','legacy-account','PNsynthetic','+12125550100','active',100,'2026-01-01','2026-01-01');
      INSERT INTO voice_config(workspace_id,number_id,application_sid,callbacks_confirmed,updated_at) VALUES ('legacy','legacy-number','APsynthetic',1,'2026-01-01');
      INSERT INTO voice_calls(id,workspace_id,number_id,account_sid,provider_call_sid,membership_id,direction,state,phone_cipher,company_phone_cipher,created_at) VALUES ('legacy-call','legacy','legacy-number','ACsynthetic','CAsynthetic','legacy-member','inbound','completed','opaque-phone','opaque-company-phone','2026-01-01');
      INSERT INTO mca_document_notification_discovery(workspace_id,enabled,reasons_json,local_schedule,channel,approval_version,approved_by_membership_id,approved_at,updated_at) VALUES ('legacy',0,'["missing"]','{"timezone":"UTC","frequency":"daily","hour":0,"minute":0}','email',1,'legacy-member','2026-01-01','2026-01-01');
      INSERT INTO sms_registrations(id,workspace_id,kind,attempt,provider_sid,status,created_at,updated_at) VALUES ('legacy-registration','legacy','brand',1,'BNsynthetic','approved','2026-01-01','2026-01-01');
      INSERT INTO sms_meter_events(id,workspace_id,message_id,segments,occurred_at,state,created_at,updated_at) VALUES ('legacy-meter','legacy','legacy-message',4,'2026-01-01','sent','2026-01-01','2026-01-01');
      INSERT INTO mca_credit_accounts(id,workspace_id,user_id,purchased_balance,created_at) VALUES ('legacy-ai','legacy','legacy-user',37,'2026-01-01');
      INSERT INTO mca_notification_preferences(workspace_id,channel,recipient_hash,consented,suppressed,updated_at) VALUES ('legacy','sms','synthetic-recipient',1,0,'2026-01-01');
      INSERT INTO platform_admin_audit(id,actor_user_id,actor_email,action,target_workspace_id) VALUES ('legacy-audit','legacy-user','legacy@example.test','synthetic','legacy');
    `)
    const tables = ['workspaces','sms_companies','sms_numbers','sms_registrations','sms_meter_events','mca_credit_accounts','platform_admin_audit','mca_notification_preferences','voice_config','voice_calls','mca_document_notification_discovery']
    const before = []
    for (const table of tables) before.push(await client.query(`SELECT * FROM ${table}`))
    const appliedBefore = (await client.query("SELECT * FROM drizzle.__drizzle_migrations ORDER BY id")).rows
    assert.equal(appliedBefore.length, prior.length)
    assert.equal((await client.query("SELECT max(created_at)::text latest FROM drizzle.__drizzle_migrations")).rows[0].latest, "1790819000074")
    assert.equal((await client.query("SELECT to_regclass('sms_credit_accounts') ledger")).rows[0].ledger, null)
    await migrate(drizzle(client), { migrationsFolder: "drizzle" })
    assert.equal((await client.query("SELECT to_regclass('sms_credit_accounts') ledger")).rows[0].ledger, "sms_credit_accounts")
    const applied = await client.query("SELECT count(*)::int count FROM drizzle.__drizzle_migrations WHERE created_at=1790819000075")
    assert.equal(applied.rows[0].count, 1)
    const history = (await client.query("SELECT * FROM drizzle.__drizzle_migrations ORDER BY id")).rows
    assert.deepEqual(history.slice(0, appliedBefore.length), appliedBefore)
    assert.equal(history.length, appliedBefore.length + 1)
    await migrate(drizzle(client), { migrationsFolder: "drizzle" })
    assert.deepEqual((await client.query("SELECT * FROM drizzle.__drizzle_migrations ORDER BY id")).rows, history)
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
      (has_table_privilege('mca_app','sms_credit_accounts','DELETE,TRUNCATE') OR has_table_privilege('mca_app','sms_credit_reservations','DELETE,TRUNCATE')) can_delete_credit_state,
      has_table_privilege('mca_app','mca_notification_receipts','UPDATE,DELETE,TRUNCATE') can_rewrite_notification_receipts,
      (has_table_privilege('mca_app','voice_calls','SELECT') AND has_table_privilege('mca_app','voice_calls','INSERT') AND has_table_privilege('mca_app','voice_calls','UPDATE')) can_use_voice,
      has_table_privilege('mca_app','voice_calls','DELETE,TRUNCATE') can_delete_voice,
      (has_table_privilege('mca_app','mca_document_notification_discovery','SELECT') AND has_table_privilege('mca_app','mca_document_notification_discovery','INSERT') AND has_table_privilege('mca_app','mca_document_notification_discovery','UPDATE')) can_use_discovery,
      has_table_privilege('mca_app','platform_admin_grants','INSERT,UPDATE,DELETE') can_grant_admin,
      has_table_privilege('anon','sms_credit_ledger','SELECT') anon_read,
      has_table_privilege('authenticated','sms_credit_accounts','SELECT') authenticated_read`)
    assert.deepEqual(privileges.rows[0], {can_append:true,can_rewrite:false,can_balance:true,can_reserve:true,can_delete_credit_state:false,can_grant_admin:false,can_use_voice:true,can_delete_voice:false,can_use_discovery:true,can_rewrite_notification_receipts:false,anon_read:false,authenticated_read:false})
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
