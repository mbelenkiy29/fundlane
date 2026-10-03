import { createHash } from "node:crypto"
import { createReadStream } from "node:fs"
import { lstat, readdir, unlink } from "node:fs/promises"
import { join } from "node:path"

const productionRef = "drubsfvhlggmtyiigwxy"
const archiveName = /^mca-(weekly|pre-migration)-(\d{8}T\d{6}(?:\d{3})?Z)\.dump(?:\.age)?$/

export function requireSwitch(env: Record<string, string | undefined>, flag: "MCA_OPS_BACKUP_ENABLED" | "MCA_OPS_RESTORE_DRILL_ENABLED", args: string[]) {
  if (env[flag] !== "true" || !args.includes("--confirm")) {
    throw new Error(flag === "MCA_OPS_BACKUP_ENABLED"
      ? "Backup is disabled. Set MCA_OPS_BACKUP_ENABLED=true and pass --confirm."
      : "Restore drill is disabled. Set MCA_OPS_RESTORE_DRILL_ENABLED=true and pass --confirm.")
  }
}

export function option(args: string[], name: string): string {
  const index = args.indexOf(name)
  if (index < 0 || !args[index + 1] || args[index + 1].startsWith("--") || args.indexOf(name, index + 1) !== -1) {
    throw new Error(`Specify ${name} exactly once.`)
  }
  return args[index + 1]
}

export function parseDatabaseUrl(value: string | undefined): URL {
  if (!value) throw new Error("An explicit MCA_OPS database URL is required.")
  let url: URL
  try { url = new URL(value) } catch { throw new Error("Invalid MCA_OPS database URL.") }
  if (!(["postgres:", "postgresql:"].includes(url.protocol)) || !url.hostname || !url.pathname || url.pathname === "/") {
    throw new Error("Invalid MCA_OPS database URL.")
  }
  return url
}

export function isLoopback(url: URL): boolean {
  return ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname.toLowerCase())
}

export function assertRestoreTarget(target: URL, source?: URL): void {
  if (!isLoopback(target) || target.hostname.toLowerCase().includes(productionRef) || decodeURIComponent(target.username).toLowerCase().includes(productionRef)) {
    throw new Error("Restore target must be a disposable loopback database; production and hosted targets are refused.")
  }
  if (source && isLoopback(source) && source.port === target.port && source.pathname === target.pathname) {
    throw new Error("Restore target must differ from the source database.")
  }
}

export function connectionEnv(url: URL): Record<string, string | undefined> {
  return {
    PGHOST: url.hostname.replace(/^\[|\]$/g, ""), PGPORT: url.port || "5432",
    PGUSER: decodeURIComponent(url.username), PGPASSWORD: decodeURIComponent(url.password),
    PGDATABASE: decodeURIComponent(url.pathname.slice(1)),
    ...(url.searchParams.get("sslmode") ? { PGSSLMODE: url.searchParams.get("sslmode")! } : {}),
  }
}

export function commandEnv(connection: Record<string, string | undefined>): NodeJS.ProcessEnv {
  const env = { ...process.env, ...connection }
  delete env.DATABASE_URL
  delete env.DATABASE_URL_UNPOOLED
  delete env.MCA_OPS_SOURCE_DATABASE_URL
  delete env.MCA_OPS_TARGET_DATABASE_URL
  return env
}

// Keeps the last 2 KB of a tool's stderr so failures explain themselves without unbounded logs.
export function captureStderr(stream: NodeJS.ReadableStream | null): () => string {
  let text = ""
  stream?.on("data", (chunk: Buffer) => { text = (text + chunk.toString()).slice(-2048) })
  return () => text.trim()
}

export function toolFailure(message: string, stderr: string, env: Record<string, string | undefined>): Error {
  const detail = env.PGPASSWORD ? stderr.split(env.PGPASSWORD).join("[redacted]") : stderr
  return new Error(detail ? `${message}: ${detail}` : message)
}

export async function sha256(path: string): Promise<string> {
  const hash = createHash("sha256")
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest("hex")
}

export async function pruneArchives(directory: string): Promise<void> {
  const names = await readdir(directory)
  for (const [kind, keep] of [["weekly", 4], ["pre-migration", 3]] as const) {
    const candidates = names.filter((name) => archiveName.exec(name)?.[1] === kind).sort().reverse()
    const regular: string[] = []
    for (const name of candidates) if ((await lstat(join(directory, name))).isFile()) regular.push(name)
    for (const name of regular.slice(keep)) await unlink(join(directory, name))
  }
}
