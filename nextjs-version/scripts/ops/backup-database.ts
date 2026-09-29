import { spawn } from "node:child_process"
import { chmod, lstat, mkdir, open, rename, unlink } from "node:fs/promises"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { commandEnv, connectionEnv, isLoopback, option, parseDatabaseUrl, pruneArchives, requireSwitch, sha256 } from "./safety"

export type CommandRunner = (command: string, args: string[], env: Record<string, string | undefined>, output?: string) => Promise<void>

export const runCommand: CommandRunner = (command, args, env, output) => new Promise((resolveRun, reject) => {
  const child = spawn(command, output ? args.slice(0, -1) : args, { env: commandEnv(env), stdio: ["ignore", output ? "pipe" : "ignore", "ignore"] })
  if (output) {
    const age = spawn("age", ["-r", output, "-o", args.at(-1)!], { stdio: ["pipe", "ignore", "ignore"] })
    age.stdin!.on("error", () => undefined)
    child.stdout!.pipe(age.stdin!)
    const results = Promise.all([new Promise<number>((ok, fail) => { child.on("error", fail); child.on("close", (code) => ok(code ?? 1)) }), new Promise<number>((ok, fail) => { age.on("error", fail); age.on("close", (code) => ok(code ?? 1)) })])
    results.then(([dumpCode, ageCode]) => dumpCode === 0 && ageCode === 0 ? resolveRun() : reject(new Error(`Backup tools failed (${dumpCode}, ${ageCode}).`)), reject)
  } else {
    child.on("error", reject)
    child.on("close", (code) => code === 0 ? resolveRun() : reject(new Error(`Database tool failed (${code}).`)))
  }
})

export async function backup(args: string[], env: Record<string, string | undefined> = process.env, runner: CommandRunner = runCommand): Promise<string> {
  requireSwitch(env, "MCA_OPS_BACKUP_ENABLED", args)
  const source = parseDatabaseUrl(env.MCA_OPS_SOURCE_DATABASE_URL)
  const directory = resolve(option(args, "--directory"))
  const kind = option(args, "--kind")
  if (kind !== "weekly" && kind !== "pre-migration") throw new Error("--kind must be weekly or pre-migration.")
  const recipient = args.includes("--recipient") ? option(args, "--recipient") : undefined
  if (!isLoopback(source) && !recipient) throw new Error("Non-loopback backup sources require an age recipient.")
  if (!recipient && !args.includes("--synthetic")) throw new Error("Unencrypted backups require --synthetic for a loopback test source.")
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const directoryStat = await lstat(directory)
  if (!directoryStat.isDirectory() || (directoryStat.mode & 0o077) !== 0) throw new Error("Backup directory must be private (mode 0700).")
  const stamp = new Date().toISOString().replace(/[-:.]/g, "")
  const final = join(directory, `mca-${kind}-${stamp}.dump${recipient ? ".age" : ""}`)
  const temporary = `${final}.tmp-${process.pid}`
  const handle = await open(temporary, "wx", 0o600)
  await handle.close()
  try {
    if (recipient) {
      await unlink(temporary)
      await runner("pg_dump", ["--format=custom", "--no-owner", "--no-acl", "--file=-", temporary], connectionEnv(source), recipient)
    }
    else await runner("pg_dump", ["--format=custom", "--no-owner", "--no-acl", `--file=${temporary}`], connectionEnv(source))
    const completedAt = new Date().toISOString()
    await chmod(temporary, 0o600)
    const existing = await lstat(final).then(() => true, (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return false
      throw error
    })
    if (existing) throw new Error("Archive name already exists; retry after the timestamp changes.")
    await rename(temporary, final)
    const hash = await sha256(final)
    await pruneArchives(directory)
    return `Archive: ${final}\nSHA-256: ${hash}\nDump completed: ${completedAt}`
  } catch (error) {
    await unlink(temporary).catch(() => undefined)
    throw error
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  backup(process.argv.slice(2)).then(console.log).catch((error: Error) => { console.error(error.message); process.exitCode = 1 })
}
