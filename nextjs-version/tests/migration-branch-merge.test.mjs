import test from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import { createPostgresTestDatabase } from "./helpers/postgres-test-db.mjs";

const applicationReviewHash = "eace840adc50c0b66a4203414cd3c6e123474b4e4715cefe6e50e4028e98c49d";
const catchupTimestamp = 1790035200003;
const setupChecklistTimestamp = 1790299200000;
const totpTimestamp = 1790299200001;
const demoSubmissionsTimestamp = 1790385600005;
const trialAbuseTimestamp = 1790385600006;
const billingRecoveryTimestamp = 1790035200002;

async function revertLaterThanCatchup(fixture) {
  await fixture.query("DROP TABLE IF EXISTS marketing_demo_submissions");
  await fixture.query("DROP TABLE IF EXISTS company_trial_grants");
  await fixture.query("DROP TABLE IF EXISTS user_totp_recovery_codes, auth_session_totp, user_totp_factors");
  await fixture.query("ALTER TABLE workspaces DROP COLUMN IF EXISTS require_2fa");
  await fixture.query("ALTER TABLE workspaces DROP COLUMN IF EXISTS setup_checklist_dismissed_at");
  await fixture.query("DELETE FROM drizzle.__drizzle_migrations WHERE created_at IN ($1, $2, $3, $4)", [setupChecklistTimestamp, totpTimestamp, demoSubmissionsTimestamp, trialAbuseTimestamp]);
}

async function withFixture(label, run) {
  const fixture = await createPostgresTestDatabase(label);
  const pool = new pg.Pool({ connectionString: fixture.databaseUrl, max: 1 });
  try { await run(fixture, pool); }
  finally { await pool.end(); await fixture.close(); }
}

test("merged fresh schema includes both migration branches; catch-up does not replay application-review data updates", async () => {
  await withFixture("merge_fresh", async (fixture, pool) => {
    const original = await fixture.query("SELECT hash FROM drizzle.__drizzle_migrations WHERE hash=$1", [applicationReviewHash]);
    assert.equal(original.rows.length, 1);
    // A statement-level trigger detects accidental replay even with no intake rows.
    await fixture.query(`CREATE FUNCTION forbid_review_replay() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'application-review data migration replayed'; END $$;
      CREATE TRIGGER forbid_review_replay BEFORE UPDATE ON intake_integrations
      FOR EACH STATEMENT EXECUTE FUNCTION forbid_review_replay();`);
    await fixture.query("DELETE FROM drizzle.__drizzle_migrations WHERE created_at=$1", [catchupTimestamp]);
    await revertLaterThanCatchup(fixture);
    await migrate(drizzle(pool), { migrationsFolder: resolve("drizzle") });
    assert.equal((await fixture.query("SELECT count(*)::int n FROM drizzle.__drizzle_migrations WHERE created_at=$1", [catchupTimestamp])).rows[0].n, 1);
    assert.equal((await fixture.query("SELECT count(*)::int n FROM drizzle.__drizzle_migrations WHERE created_at=$1", [setupChecklistTimestamp])).rows[0].n, 1);
    assert.equal((await fixture.query("SELECT count(*)::int n FROM drizzle.__drizzle_migrations WHERE created_at=$1", [totpTimestamp])).rows[0].n, 1);
    assert.equal((await fixture.query("SELECT count(*)::int n FROM drizzle.__drizzle_migrations WHERE created_at=$1", [demoSubmissionsTimestamp])).rows[0].n, 1);
    assert.equal((await fixture.query("SELECT count(*)::int n FROM drizzle.__drizzle_migrations WHERE created_at=$1", [trialAbuseTimestamp])).rows[0].n, 1);
  });
});

test("auth-first 0048 deployment receives older application-review schema through additive catch-up", async () => {
  await withFixture("merge_auth_first", async (fixture, pool) => {
    // Reproduce the production branch divergence: auth ledger already at 0048,
    // but the older-timestamp migration and its schema never landed.
    await fixture.query(`DROP TABLE intake_notifications, intake_submission_previews;
      ALTER TABLE intake_events DROP COLUMN answers_cipher;
      ALTER TABLE mca_submission_jobs DROP COLUMN approved_package_cipher;`);
    await fixture.query("DELETE FROM drizzle.__drizzle_migrations WHERE hash=$1 OR created_at=$2", [applicationReviewHash, catchupTimestamp]);
    await revertLaterThanCatchup(fixture);
    assert.equal(Number((await fixture.query("SELECT max(created_at) n FROM drizzle.__drizzle_migrations")).rows[0].n), billingRecoveryTimestamp);
    await migrate(drizzle(pool), { migrationsFolder: resolve("drizzle") });
    const tables = await fixture.query("SELECT relname,relrowsecurity FROM pg_class WHERE oid IN ('intake_notifications'::regclass,'intake_submission_previews'::regclass) ORDER BY relname");
    assert.deepEqual(tables.rows, [{ relname: "intake_notifications", relrowsecurity: true }, { relname: "intake_submission_previews", relrowsecurity: true }]);
    const columns = await fixture.query(`SELECT table_name,column_name FROM information_schema.columns WHERE
      (table_name='intake_events' AND column_name='answers_cipher') OR
      (table_name='mca_submission_jobs' AND column_name='approved_package_cipher') OR
      (table_name='company_subscription_state' AND column_name='processing_extension_granted_at') OR
      (table_name='workspaces' AND column_name='setup_checklist_dismissed_at') OR
      (table_name='workspaces' AND column_name='require_2fa')`);
    assert.equal(columns.rows.length, 5);
    assert.equal((await fixture.query("SELECT count(*)::int n FROM drizzle.__drizzle_migrations WHERE hash=$1", [applicationReviewHash])).rows[0].n, 0, "Drizzle really skipped the older migration");
    const ledger = (await fixture.query("SELECT hash,created_at FROM drizzle.__drizzle_migrations ORDER BY created_at")).rows;
    await migrate(drizzle(pool), { migrationsFolder: resolve("drizzle") });
    assert.deepEqual((await fixture.query("SELECT hash,created_at FROM drizzle.__drizzle_migrations ORDER BY created_at")).rows, ledger);
  });
});
