import assert from "node:assert/strict"
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { createHash } from "node:crypto"
import { spawnSync } from "node:child_process"
import { backup, type CommandRunner } from "../scripts/ops/backup-database"
import { restoreDrill, type RestoreRunner } from "../scripts/ops/restore-drill"
import { pruneArchives, sha256 } from "../scripts/ops/safety"
import { createPostgresTestDatabase } from "./helpers/postgres-test-db.mjs"

const source = "postgresql://test:synthetic@127.0.0.1:5432/source"
const target = "postgresql://test:synthetic@127.0.0.1:5432/disposable"
const backupArgs = ["--confirm", "--kind", "weekly", "--directory"]
const restoreArgs = ["--confirm", "--archive", "/synthetic/archive.dump", "--sha256", "a".repeat(64)]
let commands = 0
const noBackup: CommandRunner = async () => { commands++; return 0 }
const noRestore: RestoreRunner = async () => { commands++; return "0" }

test("backup refuses unset/false flags and missing confirmation before invoking tools", async () => {
  commands = 0
  for (const flag of [undefined, "false", "TRUE"]) {
    await assert.rejects(backup([...backupArgs, "/tmp/synthetic"], { MCA_OPS_BACKUP_ENABLED: flag, MCA_OPS_SOURCE_DATABASE_URL: source }, noBackup), /Backup is disabled/)
  }
  await assert.rejects(backup(["--kind", "weekly", "--directory", "/tmp/synthetic"], { MCA_OPS_BACKUP_ENABLED: "true", MCA_OPS_SOURCE_DATABASE_URL: source }, noBackup), /Backup is disabled/)
  assert.equal(commands, 0)
})

test("hosted source requires encryption before invoking a runner", async () => {
  commands = 0
  await assert.rejects(backup([...backupArgs, "/tmp/synthetic"], {
    MCA_OPS_BACKUP_ENABLED: "true", MCA_OPS_SOURCE_DATABASE_URL: "postgresql://operator:secret@hosted.example/source",
  }, noBackup), /require an age recipient/)
  assert.equal(commands, 0)
})

test("restore refuses unset/false flags and missing confirmation before invoking tools", async () => {
  commands = 0
  for (const flag of [undefined, "false", "TRUE"]) {
    await assert.rejects(restoreDrill(restoreArgs, { MCA_OPS_RESTORE_DRILL_ENABLED: flag, MCA_OPS_TARGET_DATABASE_URL: target }, noRestore), /Restore drill is disabled/)
  }
  await assert.rejects(restoreDrill(restoreArgs.slice(1), { MCA_OPS_RESTORE_DRILL_ENABLED: "true", MCA_OPS_TARGET_DATABASE_URL: target }, noRestore), /Restore drill is disabled/)
  assert.equal(commands, 0)
})

test("restore rejects production direct/pooler, hosted and source-equal targets", async () => {
  commands = 0
  for (const unsafe of [
    "postgresql://postgres:secret@db.drubsfvhlggmtyiigwxy.supabase.co/postgres",
    "postgresql://postgres.drubsfvhlggmtyiigwxy:secret@127.0.0.1/postgres",
    "postgresql://test:secret@hosted.example/postgres",
    source,
  ]) {
    await assert.rejects(restoreDrill(restoreArgs, { MCA_OPS_RESTORE_DRILL_ENABLED: "true", MCA_OPS_TARGET_DATABASE_URL: unsafe, MCA_OPS_SOURCE_DATABASE_URL: source }, noRestore), /Restore target|differ/)
  }
  assert.equal(commands, 0)
})

test("retention keeps newest four weekly and three pre-migration regular archives only", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mca-retention-test-"))
  try {
    for (const [kind, count] of [["weekly", 6], ["pre-migration", 5]] as const) {
      for (let n = 1; n <= count; n++) await writeFile(join(directory, `mca-${kind}-202609${String(n).padStart(2, "0")}T010000Z.dump.age`), "synthetic")
    }
    await writeFile(join(directory, "unrelated.dump.age"), "synthetic")
    await pruneArchives(directory)
    const names = await readdir(directory)
    assert.equal(names.filter((name) => name.startsWith("mca-weekly-")).length, 4)
    assert.equal(names.filter((name) => name.startsWith("mca-pre-migration-")).length, 3)
    assert.ok(names.includes("unrelated.dump.age"))
    assert.ok(names.includes("mca-weekly-20260906T010000Z.dump.age"))
    assert.ok(names.includes("mca-pre-migration-20260905T010000Z.dump.age"))
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test("synthetic backup publishes only after runner success and reports its checksum", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mca-backup-test-"))
  try {
    await rm(directory, { recursive: true })
    const calls: string[] = []
    const runner: CommandRunner = async (command, args, connection) => {
      calls.push(command)
      assert.equal(connection.PGDATABASE, "source")
      assert.deepEqual(args.slice(0, 3), ["--format=custom", "--no-owner", "--no-acl"])
      assert.equal(args.length, 4)
      await writeFile(args.find((arg) => arg.startsWith("--file="))!.slice(7), "PGDMP synthetic archive")
      return 0
    }
    const result = await backup([...backupArgs, directory, "--synthetic"], { MCA_OPS_BACKUP_ENABLED: "true", MCA_OPS_SOURCE_DATABASE_URL: source }, runner)
    assert.deepEqual(calls, ["pg_dump"])
    assert.match(result, new RegExp(createHash("sha256").update("PGDMP synthetic archive").digest("hex")))
    assert.equal((await readdir(directory)).length, 1)
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test("encrypted backup passes pg_dump stdout to age and refuses empty stdout", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mca-backup-empty-"))
  const args = [...backupArgs, directory, "--recipient", "age1synthetic"]
  const env = { MCA_OPS_BACKUP_ENABLED: "true", MCA_OPS_SOURCE_DATABASE_URL: source }
  try {
    const runner: CommandRunner = async (command, commandArgs, connection, encryption) => {
      assert.equal(command, "pg_dump")
      assert.deepEqual(commandArgs, ["--format=custom", "--no-owner", "--no-acl"])
      assert.equal(connection.PGDATABASE, "source")
      assert.equal(encryption?.recipient, "age1synthetic")
      await writeFile(encryption!.output, "age header")
      return 0
    }
    await assert.rejects(backup(args, env, runner), /empty or invalid/)
    assert.deepEqual(await readdir(directory), [])
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test("unencrypted backup rejects a non-PGDMP archive", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mca-backup-magic-"))
  try {
    const runner: CommandRunner = async (_command, args) => {
      await writeFile(args.at(-1)!.slice(7), "not a custom dump")
      return 0
    }
    await assert.rejects(backup([...backupArgs, directory, "--synthetic"], { MCA_OPS_BACKUP_ENABLED: "true", MCA_OPS_SOURCE_DATABASE_URL: source }, runner), /empty or invalid/)
    assert.deepEqual(await readdir(directory), [])
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test("real pg_dump archives restore from unencrypted and encrypted paths", async (t) => {
  for (const command of ["pg_dump", "pg_restore", "psql"]) {
    if (spawnSync(command, ["--version"]).error) return t.skip(`${command} is not on PATH`)
  }
  const sourceDb = await createPostgresTestDatabase("backup_source")
  const targetDb = await createPostgresTestDatabase("backup_target", { migrateSchema: false })
  const directory = await mkdtemp(join(tmpdir(), "mca-backup-e2e-"))
  const bin = join(directory, "bin")
  const oldPath = process.env.PATH
  try {
    await chmod(directory, 0o700)
    await mkdir(bin)
    await writeFile(join(bin, "age"), `#!/bin/sh
output=
input=
while [ "$#" -gt 0 ]; do
  case "$1" in
    -o|--output) output="$2"; shift 2 ;;
    -r|--identity) shift 2 ;;
    --decrypt) shift ;;
    *) input="$1"; shift ;;
  esac
done
if [ -n "$input" ]; then cat "$input" > "$output"; else cat > "$output"; fi
`, { mode: 0o700 })
    process.env.PATH = `${bin}:${oldPath}`
    const env = { MCA_OPS_BACKUP_ENABLED: "true", MCA_OPS_SOURCE_DATABASE_URL: sourceDb.databaseUrl }
    const plain = await backup([...backupArgs, directory, "--synthetic"], env)
    const plainPath = plain.match(/^Archive: (.+)$/m)![1]
    assert.equal((await readFile(plainPath)).subarray(0, 5).toString(), "PGDMP")
    assert.equal(spawnSync("pg_restore", ["-l", plainPath]).status, 0)
    assert.equal(await stat(join(process.cwd(), "-")).then(() => true, () => false), false)

    const encrypted = await backup([...backupArgs, directory, "--recipient", "age1synthetic"], env)
    const encryptedPath = encrypted.match(/^Archive: (.+)$/m)![1]
    assert.equal((await readFile(encryptedPath)).subarray(0, 5).toString(), "PGDMP")
    assert.ok((await stat(encryptedPath)).size > 5)
    assert.equal(await stat(join(process.cwd(), "-")).then(() => true, () => false), false)
    const identity = join(directory, "identity.txt")
    await writeFile(identity, "synthetic")
    const result = await restoreDrill(["--confirm", "--archive", encryptedPath, "--sha256", await sha256(encryptedPath), "--identity", identity], {
      MCA_OPS_RESTORE_DRILL_ENABLED: "true", MCA_OPS_TARGET_DATABASE_URL: targetDb.databaseUrl, MCA_OPS_SOURCE_DATABASE_URL: sourceDb.databaseUrl,
    })
    assert.match(result, /integrity_ok/)
    assert.match(result, /Restore and verification RTO:/)
  } finally {
    process.env.PATH = oldPath
    await sourceDb.close()
    await targetDb.close()
    await rm(directory, { recursive: true, force: true })
  }
})

test("synthetic restore checks hash, empty target and verification through injected runner", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mca-restore-test-"))
  try {
    const archive = join(directory, "synthetic.dump")
    await writeFile(archive, "synthetic archive")
    const hash = createHash("sha256").update("synthetic archive").digest("hex")
    const calls: string[] = []
    const runner: RestoreRunner = async (command, args, connection) => {
      calls.push(command)
      assert.equal(connection.PGDATABASE, "disposable")
      assert.ok(!args.join(" ").includes("synthetic@"))
      return command === "psql" && args.includes("-c") ? "0\n" : "integrity_ok: 1\n"
    }
    const result = await restoreDrill(["--confirm", "--archive", archive, "--sha256", hash], { MCA_OPS_RESTORE_DRILL_ENABLED: "true", MCA_OPS_TARGET_DATABASE_URL: target, MCA_OPS_SOURCE_DATABASE_URL: source }, runner)
    assert.deepEqual(calls, ["psql", "pg_restore", "psql"])
    assert.match(result, /Restore and verification RTO:/)
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test("restore rejects a wrong digest before contacting the target", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mca-restore-hash-test-"))
  try {
    const archive = join(directory, "synthetic.dump")
    await writeFile(archive, "synthetic archive")
    commands = 0
    await assert.rejects(restoreDrill(["--confirm", "--archive", archive, "--sha256", "a".repeat(64)], {
      MCA_OPS_RESTORE_DRILL_ENABLED: "true", MCA_OPS_TARGET_DATABASE_URL: target,
    }, noRestore), /SHA-256 mismatch/)
    assert.equal(commands, 0)
  } finally { await rm(directory, { recursive: true, force: true }) }
})
