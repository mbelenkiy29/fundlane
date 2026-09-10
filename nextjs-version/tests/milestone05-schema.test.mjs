import test from "node:test"
import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { createPostgresTestDatabase } from "./helpers/postgres-test-db.mjs"

test("MIC-120 migration preserves existing import source identity and permits separate source records", async () => {
  const fixture = await createPostgresTestDatabase("milestone05_upgrade")
  try {
    // Recreate the pre-0009 shape in this disposable database to exercise an
    // upgrade with existing data, not just empty-schema migration success.
    await fixture.query(`ALTER TABLE mca_historical_import_rows DROP CONSTRAINT mca_historical_import_rows_external_key;
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
