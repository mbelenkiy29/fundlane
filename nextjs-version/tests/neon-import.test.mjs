import test from "node:test"
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { copyFileSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { createCipheriv, randomBytes } from "node:crypto"
import { createPostgresTestDatabase } from "./helpers/postgres-test-db.mjs"
import { APP_TABLES } from "../scripts/neon/table-inventory.ts"

const root = new URL("../", import.meta.url).pathname

function runScript(name, source, env) {
  return spawnSync("pnpm", [name, "--target=verification", `--source=${source}`], {
    cwd: root,
    env,
    encoding: "utf8",
  })
}

function encrypt(value, workspaceId, key) {
  const nonce = randomBytes(12)
  const cipher = createCipheriv("aes-256-gcm", key, nonce)
  cipher.setAAD(Buffer.from(workspaceId))
  const payload = Buffer.concat([cipher.update(value, "utf8"), cipher.final()])
  return ["v1", nonce.toString("base64url"), cipher.getAuthTag().toString("base64url"), payload.toString("base64url")].join(".")
}

test("SQLite import includes committed WAL data, replays matching snapshots, and refuses a changed snapshot", async () => {
  const temp = mkdtempSync(join(tmpdir(), "fundlane-neon-import-"))
  const source = join(temp, "source.sqlite")
  copyFileSync(join(root, "data/mca-pre-neon-20260908T164321Z.sqlite"), source)
  const sqlite = new DatabaseSync(source)
  sqlite.exec("PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0")
  sqlite.prepare("INSERT INTO request_rate_windows (rate_key, bucket_start, request_count) VALUES (?, ?, ?)")
    .run("wal-preservation-probe", 999999, 1)
  const workspaceId = sqlite.prepare("SELECT id FROM workspaces ORDER BY id LIMIT 1").get().id
  const encryptionKey = randomBytes(32)
  const now = new Date().toISOString()
  sqlite.prepare(`INSERT INTO deals
    (id,workspace_id,display_id,legal_name,ein_cipher,address_json,status,pipeline_version,draft_state,
     missing_required_json,field_sources_json,version,created_at,updated_at)
    VALUES (?,?,?,?,?,?,'lead',1,'incomplete','[]','{}',1,?,?)`).run(
      "wal-encrypted-deal", workspaceId, "WAL-ENCRYPTED-1", "Encrypted WAL Probe",
      encrypt("12-3456789", workspaceId, encryptionKey), "{}", now, now,
    )
  const fixture = await createPostgresTestDatabase("neon_import")
  const env = fixture.env({ MCA_DATA_ENCRYPTION_KEY: encryptionKey.toString("base64url") })
  try {
    const imported = runScript("db:import", source, env)
    assert.equal(imported.status, 0, imported.stderr)
    assert.match(imported.stdout, new RegExp(`Imported 9 rows across ${APP_TABLES.length} mapped tables`))

    const replay = runScript("db:import", source, env)
    assert.equal(replay.status, 0, replay.stderr)
    assert.match(replay.stdout, /Snapshot already imported/)

    const parity = runScript("db:parity", source, env)
    assert.equal(parity.status, 0, parity.stderr)
    assert.match(parity.stdout, new RegExp(`Parity passed for ${APP_TABLES.length} mapped tables and 9 rows`))
    assert.match(parity.stdout, /1 encrypted values authenticated/)

    sqlite.prepare("UPDATE request_rate_windows SET request_count = 2 WHERE rate_key = ? AND bucket_start = ?")
      .run("wal-preservation-probe", 999999)
    const changed = runScript("db:import", source, env)
    assert.notEqual(changed.status, 0)
    assert.match(changed.stderr, /different completed data migration/)
  } finally {
    sqlite.close()
    await fixture.close()
    rmSync(temp, { recursive: true, force: true })
  }
})
