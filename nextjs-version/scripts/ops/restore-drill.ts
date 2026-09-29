import { spawn } from "node:child_process"
import { chmod, mkdtemp, open, readFile, rm } from "node:fs/promises"
import { basename, join, resolve } from "node:path"
import { tmpdir } from "node:os"
import { fileURLToPath, pathToFileURL } from "node:url"
import { assertRestoreTarget, commandEnv, connectionEnv, option, parseDatabaseUrl, requireSwitch, sha256 } from "./safety"

export type RestoreRunner = (command: string, args: string[], env: Record<string, string | undefined>) => Promise<string>

export const runRestoreCommand: RestoreRunner = (command, args, env) => new Promise((resolveRun, reject) => {
  const child = spawn(command, args, { env: commandEnv(env), stdio: ["ignore", "pipe", "ignore"] })
  let output = ""
  child.stdout.on("data", (chunk: Buffer) => { output += chunk.toString() })
  child.on("error", reject)
  child.on("close", (code) => code === 0 ? resolveRun(output) : reject(new Error(`${command} failed (${code}).`)))
})

export async function restoreDrill(args: string[], env: Record<string, string | undefined> = process.env, runner: RestoreRunner = runRestoreCommand): Promise<string> {
  requireSwitch(env, "MCA_OPS_RESTORE_DRILL_ENABLED", args)
  const target = parseDatabaseUrl(env.MCA_OPS_TARGET_DATABASE_URL)
  const source = env.MCA_OPS_SOURCE_DATABASE_URL ? parseDatabaseUrl(env.MCA_OPS_SOURCE_DATABASE_URL) : undefined
  assertRestoreTarget(target, source)
  const archive = resolve(option(args, "--archive"))
  const expected = option(args, "--sha256").toLowerCase()
  if (!/^[a-f0-9]{64}$/.test(expected) || await sha256(archive) !== expected) throw new Error("Archive SHA-256 mismatch.")
  const encrypted = basename(archive).endsWith(".age")
  const identity = encrypted ? resolve(option(args, "--identity")) : undefined
  const connection = connectionEnv(target)
  const start = performance.now()
  const empty = await runner("psql", ["-X", "-A", "-t", "-v", "ON_ERROR_STOP=1", "-c", "SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname NOT LIKE 'pg_toast%' AND c.relkind IN ('r','p');"], connection)
  if (empty.trim() !== "0") throw new Error("Restore target must contain no user tables.")
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "mca-restore-"))
  const dump = join(temporaryDirectory, "archive.dump")
  try {
    if (encrypted) {
      await runner("age", ["--decrypt", "--identity", identity!, "--output", dump, archive], {})
      await chmod(dump, 0o600)
    }
    await runner("pg_restore", ["--exit-on-error", "--no-owner", "--no-acl", "--dbname=" + connection.PGDATABASE, encrypted ? dump : archive], connection)
    const sql = await readFile(fileURLToPath(new URL("./verify-restore.sql", import.meta.url)), "utf8")
    const verificationFile = join(temporaryDirectory, "verify.sql")
    const handle = await open(verificationFile, "wx", 0o600)
    await handle.writeFile(sql)
    await handle.close()
    const result = await runner("psql", ["-X", "-v", "ON_ERROR_STOP=1", "-f", verificationFile], connection)
    return `${result.trim()}\nRestore and verification RTO: ${((performance.now() - start) / 1000).toFixed(1)} seconds`
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true })
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  restoreDrill(process.argv.slice(2)).then(console.log).catch((error: Error) => { console.error(error.message); process.exitCode = 1 })
}
