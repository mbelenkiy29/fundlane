import test from "node:test"
import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { createPostgresTestDatabase } from "./helpers/postgres-test-db.mjs"

test("MIC-120 migration preserves existing import source identity and permits separate source records", async () => {
  const fixture = await createPostgresTestDatabase("milestone05_upgrade")
  try {
    // Recreate the pre-0009 shape in this disposable database to exercise an
    // upgrade with existing data, not just empty-schema migration success.
    await fixture.query(`SELECT set_config('mca.historical_writer','2',false);
      DROP TRIGGER historical_runs_writer_version ON mca_historical_import_runs;
      DROP TRIGGER historical_rows_writer_version ON mca_historical_import_rows;
      DROP INDEX mca_historical_import_rows_created_key;
      ALTER TABLE mca_historical_import_rows DROP COLUMN source_id;
      ALTER TABLE mca_historical_import_rows ADD CONSTRAINT mca_historical_import_rows_external_key UNIQUE(workspace_id,external_id);
      ALTER TABLE mca_closing_previews DROP COLUMN attachment_document_refs_json;`)
    await fixture.query(`INSERT INTO mca_historical_import_runs
      (id,workspace_id,source_id,batch_id,state,totals_json,reconciliation_json,created_at)
      VALUES ('run','workspace','legacy-ledger','batch','preview','{}','{}','2026-09-08')`)
    await fixture.query(`INSERT INTO mca_historical_import_rows
      (id,workspace_id,run_id,external_id,row_number,normalized_json,validation_errors_json,duplicate,outcome,created_at)
      VALUES ('row','workspace','run','external-17',1,'{}','[]',0,'pending','2026-09-08')`)
    await fixture.query(await readFile(new URL("../drizzle/0009_material_kid_colt.sql", import.meta.url), "utf8"))
    const saved = await fixture.query("SELECT source_id FROM mca_historical_import_rows WHERE id='row'")
    assert.equal(saved.rows[0].source_id, "legacy-ledger")
    await fixture.query(`INSERT INTO mca_historical_import_runs
      (id,workspace_id,source_id,batch_id,state,totals_json,reconciliation_json,created_at)
      VALUES ('run-2','workspace','second-ledger','batch','preview','{}','{}','2026-09-08')`)
    await fixture.query(`INSERT INTO mca_historical_import_rows
      (id,workspace_id,source_id,run_id,external_id,row_number,normalized_json,validation_errors_json,duplicate,outcome,created_at)
      VALUES ('other','workspace','second-ledger','run-2','external-17',2,'{}','[]',0,'pending','2026-09-08')`)
    await assert.rejects(fixture.query(`INSERT INTO mca_historical_import_rows
      (id,workspace_id,source_id,run_id,external_id,row_number,normalized_json,validation_errors_json,duplicate,outcome,created_at)
      VALUES ('duplicate','workspace','legacy-ledger','run','external-17',3,'{}','[]',0,'pending','2026-09-08')`), (error) => error.code === "23505")
  } finally { await fixture.close() }
})

test("historical preview migration preserves legacy rows and only constrains created identities", async () => {
  const fixture = await createPostgresTestDatabase("historical_upgrade")
  try {
    await fixture.query(`SELECT set_config('mca.historical_writer','2',false);
      DROP TRIGGER historical_runs_writer_version ON mca_historical_import_runs;
      DROP TRIGGER historical_rows_writer_version ON mca_historical_import_rows;
      DROP INDEX mca_historical_import_rows_created_key;
      ALTER TABLE mca_historical_import_runs DROP CONSTRAINT mca_historical_import_runs_request_key;
      ALTER TABLE mca_historical_import_runs DROP COLUMN request_id, DROP COLUMN input_hash;
      ALTER TABLE mca_historical_import_runs ADD CONSTRAINT mca_historical_import_runs_batch_key UNIQUE(workspace_id,source_id,batch_id);
      ALTER TABLE mca_historical_import_rows ADD CONSTRAINT mca_historical_import_rows_external_key UNIQUE(workspace_id,source_id,external_id);
      INSERT INTO mca_historical_import_runs(id,workspace_id,source_id,batch_id,state,created_at)
        VALUES('legacy','workspace','source','batch','preview','2026-09-14');
      INSERT INTO mca_historical_import_rows(id,workspace_id,source_id,run_id,external_id,row_number,normalized_json,outcome,created_at)
        VALUES('pending','workspace','source','legacy','pending',2,'{}','pending','2026-09-14'),
              ('invalid','workspace','source','legacy','invalid',3,'{}','invalid','2026-09-14'),
              ('created','workspace','source','legacy','created',4,'{}','created','2026-09-14');`)
    const before = (await fixture.query("SELECT * FROM mca_historical_import_rows ORDER BY id")).rows
    await fixture.query("BEGIN;" + await readFile(new URL("../drizzle/0038_historical_preview_identity.sql", import.meta.url), "utf8") + "COMMIT;")
    await fixture.query("BEGIN;" + await readFile(new URL("../drizzle/0038_historical_preview_identity.sql", import.meta.url), "utf8") + "COMMIT;")
    assert.deepEqual((await fixture.query("SELECT * FROM mca_historical_import_rows ORDER BY id")).rows, before)
    await fixture.query("SELECT set_config('mca.historical_writer','',false)")
    await assert.rejects(fixture.query("UPDATE mca_historical_import_runs SET state='preview' WHERE id='legacy'"), (error) => error.code === "55000")
    await fixture.query("SELECT set_config('mca.historical_writer','2',false)")
    await fixture.query(`INSERT INTO mca_historical_import_runs(id,workspace_id,source_id,batch_id,state,created_at,request_id,input_hash)
      VALUES('fresh','workspace','source','batch','preview','2026-09-15','request','hash');
      INSERT INTO mca_historical_import_rows(id,workspace_id,source_id,run_id,external_id,row_number,normalized_json,outcome,created_at)
        VALUES('fresh-pending','workspace','source','fresh','pending',2,'{}','pending','2026-09-15'),
              ('fresh-created','workspace','source','fresh','created',3,'{}','pending','2026-09-15');`)
    await assert.rejects(fixture.query("UPDATE mca_historical_import_rows SET outcome='created' WHERE id='fresh-created'"), (error) => error.code === "23505")
    await assert.rejects(fixture.query(`SELECT set_config('mca.historical_writer','2',false); INSERT INTO mca_historical_import_runs(id,workspace_id,source_id,batch_id,state,created_at,request_id)
      VALUES('retry','workspace','other','other','preview','2026-09-15','request')`), (error) => error.code === "23505")
  } finally { await fixture.close() }
})
