import { execFile as execFileCallback } from "node:child_process"
import { readdir, readFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"

const execFile = promisify(execFileCallback)

export const DISABLED_MESSAGE = "Set MCA_RELEASE_EVIDENCE_ENABLED=true to generate offline release evidence."
export const ARGUMENT_MESSAGE = "Use --format=markdown or --format=json."
export const DECISION = "NO-GO — hosted evidence required"

export type EnvEntry = { name: string; defaultValue: string; activationGate: boolean; defaultOff: boolean }

export function assertReleaseEvidenceEnabled(env: Record<string, string | undefined>): void {
  if (env.MCA_RELEASE_EVIDENCE_ENABLED !== "true") throw new Error(DISABLED_MESSAGE)
}

export function readEnvInventory(text: string): EnvEntry[] {
  const entries: EnvEntry[] = []
  const seen = new Set<string>()
  for (const line of text.split(/\r?\n/)) {
    if (!line || line.trimStart().startsWith("#")) continue
    const match = line.match(/^([A-Z][A-Z0-9_]*)=(.*)$/)
    if (!match) continue
    const [, name, defaultValue] = match
    if (seen.has(name)) throw new Error(`Duplicate environment declaration: ${name}`)
    seen.add(name)
    const activationGate = name.endsWith("_ENABLED")
    entries.push({ name, defaultValue, activationGate, defaultOff: activationGate && (defaultValue === "false" || defaultValue === "") })
  }
  return entries
}

type Journal = { entries: Array<{ tag: string }> }
export function compareMigrations(fileNames: string[], journal: unknown) {
  if (!journal || typeof journal !== "object" || !Array.isArray((journal as Journal).entries)) {
    throw new Error("Invalid Drizzle journal: expected an entries array.")
  }
  const tags = (journal as Journal).entries.map((entry) => {
    if (!entry || typeof entry.tag !== "string" || !entry.tag) throw new Error("Invalid Drizzle journal entry.")
    return entry.tag
  })
  const sqlTags = fileNames.filter((name) => name.endsWith(".sql")).map((name) => path.basename(name, ".sql")).sort()
  const counts = new Map<string, number>()
  for (const tag of tags) counts.set(tag, (counts.get(tag) ?? 0) + 1)
  const duplicateTags = [...counts].filter(([, count]) => count > 1).map(([tag]) => tag)
  const sqlSet = new Set(sqlTags)
  const journalSet = new Set(tags)
  const sqlMissingFromJournal = sqlTags.filter((tag) => !journalSet.has(tag))
  const journalMissingSql = tags.filter((tag) => !sqlSet.has(tag))
  return {
    journalHead: tags.at(-1) ?? null,
    migrationTags: tags,
    sqlMissingFromJournal,
    journalMissingSql,
    duplicateTags,
    consistent: sqlMissingFromJournal.length === 0 && journalMissingSql.length === 0 && duplicateTags.length === 0,
  }
}

function envMap(entries: EnvEntry[]) {
  return new Map(entries.map((entry) => [entry.name, entry.defaultValue]))
}

type CronEntry = { path: string; cron: string; requiredFlags: string[]; ownerIssue: string }
export function validateCronManifest(manifest: unknown, routePaths: string[], vercelConfig: unknown, envDefaults: EnvEntry[]) {
  if (!Array.isArray(manifest)) throw new Error("Invalid cron manifest: expected an array.")
  const defaults = envMap(envDefaults)
  const entries = (manifest as CronEntry[]).map((entry) => {
    if (!entry || typeof entry.path !== "string" || typeof entry.cron !== "string" || !Array.isArray(entry.requiredFlags) || typeof entry.ownerIssue !== "string") {
      throw new Error("Invalid cron manifest entry.")
    }
    const requiredFlags = entry.requiredFlags.map((requirement) => {
      const separator = requirement.indexOf("=")
      if (separator < 1) throw new Error(`Invalid cron flag requirement: ${requirement}`)
      const name = requirement.slice(0, separator)
      const requiredValue = requirement.slice(separator + 1)
      const checkedInDefault = defaults.get(name)
      return { name, requiredValue, checkedInDefault: checkedInDefault ?? null, defaultMatchesRequired: checkedInDefault === requiredValue }
    })
    return { ...entry, requiredFlags }
  })
  const manifestPaths = entries.map((entry) => entry.path)
  const routesMissingFromManifest = routePaths.filter((route) => !manifestPaths.includes(route)).sort()
  const manifestRoutesMissingFromDisk = manifestPaths.filter((route) => !routePaths.includes(route)).sort()
  const missingFlagDeclarations = entries.flatMap((entry) => entry.requiredFlags).filter((flag) => flag.checkedInDefault === null).map((flag) => flag.name)
  const vercelCronsAbsent = !vercelConfig || typeof vercelConfig !== "object" || !Object.hasOwn(vercelConfig, "crons")
  return {
    entries,
    routesMissingFromManifest,
    manifestRoutesMissingFromDisk,
    missingFlagDeclarations,
    vercelCronsAbsent,
    consistent: routesMissingFromManifest.length === 0 && manifestRoutesMissingFromDisk.length === 0 && missingFlagDeclarations.length === 0 && vercelCronsAbsent,
  }
}

const INTEGRATION_GATES: Record<string, string[] | null> = {
  "Supabase Auth, Postgres, private Storage": null,
  "Stripe billing": ["MCA_STRIPE_BILLING_ENABLED"],
  "Intake providers, transactional email, Postmark/UseSend": ["MCA_PRIVATE_EMAIL_INTAKE_ENABLED", "MCA_PRIVATE_EMAIL_DELIVERY_ENABLED", "MCA_APPLICATION_INVITATION_EMAIL_ENABLED"],
  "Google/Microsoft mailbox and Google Calendar": ["MCA_CALENDAR_GOOGLE_ENABLED"],
  "Funder APIs/DataMerch": ["MCA_FUNDER_READINESS_INVENTORY_ENABLED", "MCA_FUNDER_REPLY_LIVE_INGEST_ENABLED"],
  "Twilio SMS": ["MCA_SMS_CRON_ENABLED"],
  "DocuSeal signature": ["MCA_CLOSING_DOCUSEAL_CONTRACT_ENABLED", "MCA_CLOSING_DOCUSEAL_CONTRACT_SEND_ENABLED", "MCA_CLOSING_DOCUSEAL_CONTRACT_VERIFY_ENABLED"],
  "AI/model and document analysis": ["MCA_ASSISTANT_ENABLED"],
  "Background consumers, cron and alerts": ["MCA_OPERATIONS_ENABLED", "MCA_OPERATIONS_ALERTS_ENABLED"],
  "Marketing demo receiver and outbound webhooks": ["MCA_DEMO_DB_SUBMISSIONS_ENABLED"],
}

export function readIntegrationLedger(markdown: string, envDefaults: EnvEntry[]) {
  const heading = "## Integration readiness ledger"
  const start = markdown.indexOf(heading)
  if (start < 0) return []
  const end = markdown.indexOf("\n## ", start + heading.length)
  const section = markdown.slice(start, end < 0 ? undefined : end)
  const names = section.split(/\r?\n/).flatMap((line) => {
    const match = line.match(/^\| ([^|]+?) \|/)
    if (!match || match[1] === "Integration" || /^-+$/.test(match[1].trim())) return []
    return [match[1].trim()]
  })
  const defaults = envMap(envDefaults)
  return names.map((name) => {
    if (!(name in INTEGRATION_GATES)) throw new Error(`Missing integration gate mapping: ${name}`)
    const mapped = INTEGRATION_GATES[name]
    if (mapped === null) return { name, status: "required / not flag-gated", gates: [], allMappedGatesDefaultOff: false }
    const gates = mapped.map((gate) => {
      if (!defaults.has(gate)) throw new Error(`Missing environment declaration for integration gate: ${gate}`)
      const checkedInDefault = defaults.get(gate)!
      return { name: gate, checkedInDefault, defaultOff: checkedInDefault === "false" || checkedInDefault === "" }
    })
    return { name, status: "needed", gates, allMappedGatesDefaultOff: gates.every((gate) => gate.defaultOff) }
  })
}

export function buildHostedProofChecklist(releaseMarkdown: string, cronManifest: CronEntry[]) {
  const headings = [...releaseMarkdown.matchAll(/^\d+\. \*\*(.+?)\.\*\*/gm)].map((match) => match[1])
  if (headings.length !== 10) throw new Error(`Expected 10 hosted proof headings; found ${headings.length}.`)
  const ownerByHeading: Record<string, string> = {
    "Intake and private files": "#36",
    "Close and fund": "#41",
    "Billing and providers": "#43",
  }
  const cronOwners = [...new Set(cronManifest.map((entry) => entry.ownerIssue.match(/#\d+/)?.[0]).filter(Boolean))].join(", ")
  const proofs = headings.map((heading) => ({ heading, status: "needed", owner: ownerByHeading[heading] ?? (heading === "Presentation and operations" && cronOwners ? cronOwners : "Michael / assign") }))
  const linearIssues = [...releaseMarkdown.matchAll(/MIC-(92|99|100|102)/g)].map((match) => `MIC-${match[1]}`)
  const ownerIssuesToRecheck = [...new Set([...Array.from({ length: 13 }, (_, index) => `#${index + 36}`), ...linearIssues])]
  return { proofs, ownerIssuesToRecheck }
}

export function buildReleaseEvidence(inputs: {
  sha: string; dirty: boolean; envText: string; migrationFiles: string[]; journal: unknown; cronManifest: unknown; routePaths: string[]; vercelConfig: unknown; releaseMarkdown: string
}) {
  let environment = readEnvInventory(inputs.envText)
  if (!Array.isArray(inputs.cronManifest)) throw new Error("Invalid cron manifest: expected an array.")
  const runtimeSelectors = new Set((inputs.cronManifest as CronEntry[]).flatMap((entry) => entry.requiredFlags.map((flag) => flag.split("=", 1)[0])))
  environment = environment.map((entry) => runtimeSelectors.has(entry.name)
    ? { ...entry, activationGate: true, defaultOff: entry.defaultValue === "false" || entry.defaultValue === "" }
    : entry)
  const migrations = compareMigrations(inputs.migrationFiles, inputs.journal)
  const cron = validateCronManifest(inputs.cronManifest, inputs.routePaths, inputs.vercelConfig, environment)
  const integrations = readIntegrationLedger(inputs.releaseMarkdown, environment)
  const hosted = buildHostedProofChecklist(inputs.releaseMarkdown, inputs.cronManifest as CronEntry[])
  const localConsistent = migrations.consistent && cron.consistent
  return {
    title: "Fundlane release evidence skeleton",
    boundary: "NO-GO — hosted evidence required. This offline source inventory is not a release certificate.",
    decision: DECISION,
    localConsistency: localConsistent ? "PASS — local source inventory is internally consistent" : "BLOCKED — local source inventory drift must be resolved",
    candidate: { sha: inputs.sha.trim(), dirty: inputs.dirty },
    migrations,
    environment,
    cron,
    integrations,
    hostedProofs: hosted.proofs,
    ownerIssuesToRecheck: hosted.ownerIssuesToRecheck,
  }
}

export function renderReleaseEvidenceMarkdown(report: ReturnType<typeof buildReleaseEvidence>): string {
  const lines = [
    "# Fundlane release evidence skeleton", "", `**${report.boundary}**`, "",
    "## Candidate checkout", `- Git SHA: \`${report.candidate.sha}\``, `- Working tree: ${report.candidate.dirty ? "dirty" : "clean"}`, "",
    "## Migration consistency", `- ${report.localConsistency}`, `- Journal head: \`${report.migrations.journalHead ?? "none"}\``, `- SQL missing from journal: ${report.migrations.sqlMissingFromJournal.join(", ") || "none"}`, `- Journal entries missing SQL: ${report.migrations.journalMissingSql.join(", ") || "none"}`, `- Duplicate journal tags: ${report.migrations.duplicateTags.join(", ") || "none"}`, "",
    "## Environment flag inventory",
    ...report.environment.filter((entry) => entry.activationGate).map((entry) => `- \`${entry.name}\`: \`${entry.defaultValue || "(blank)"}\` (${entry.defaultOff ? "default off" : "not default off"})`), "",
    "## Cron manifest",
    ...report.cron.entries.map((entry) => `- \`${entry.path}\` — \`${entry.cron}\`; ${entry.requiredFlags.map((flag) => `${flag.name}=${flag.requiredValue} (checked in: ${flag.checkedInDefault ?? "missing"})`).join(", ") || "no feature flag"}; owner ${entry.ownerIssue}`),
    `- Repository-declared Vercel crons absent: ${report.cron.vercelCronsAbsent ? "yes" : "no"}`, "",
    "## Advertised integration gates",
    ...(report.integrations.length ? report.integrations.map((entry) => `- ${entry.name}: ${entry.status}; ${entry.gates.map((gate) => `${gate.name}=${gate.checkedInDefault || "(blank)"}`).join(", ") || "no activation gate"}`) : ["- Ledger heading not present; parsing skipped."]), "",
    "## Hosted proofs still needed", ...report.hostedProofs.map((proof, index) => `${index + 1}. ${proof.heading} — ${proof.status}; owner: ${proof.owner}`), "",
    "## Owner issues to recheck", report.ownerIssuesToRecheck.join(", "), "",
    "## Decision", report.decision, "",
  ]
  return lines.join("\n")
}

type MainDependencies = {
  env?: Record<string, string | undefined>; args?: string[]; stdout?: { write(value: string): unknown };
  readText?: (file: string) => Promise<string>; listDirectory?: (directory: string) => Promise<string[]>;
  listCronRoutes?: () => Promise<string[]>; git?: (args: string[], cwd: string) => Promise<string>; root?: string
}

export async function main(dependencies: MainDependencies = {}): Promise<void> {
  const env = dependencies.env ?? process.env
  assertReleaseEvidenceEnabled(env)
  const rawArgs = dependencies.args ?? process.argv.slice(2)
  const args = rawArgs[0] === "--" ? rawArgs.slice(1) : rawArgs
  if (args.length > 1 || (args[0] !== undefined && !args[0].startsWith("--format="))) throw new Error(ARGUMENT_MESSAGE)
  const format = args[0]?.slice("--format=".length) ?? "markdown"
  if (format !== "markdown" && format !== "json") throw new Error(ARGUMENT_MESSAGE)
  const root = dependencies.root ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")
  const readText = dependencies.readText ?? ((file) => readFile(path.join(root, file), "utf8"))
  const listDirectory = dependencies.listDirectory ?? (async (directory) => (await readdir(path.join(root, directory), { withFileTypes: true })).filter((entry) => entry.isFile()).map((entry) => entry.name))
  const git = dependencies.git ?? (async (args, cwd) => (await execFile("git", args, { cwd })).stdout)
  const cronRouteDirectories = dependencies.listCronRoutes
    ? await dependencies.listCronRoutes()
    : (await readdir(path.join(root, "src/app/api/cron"), { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => `/api/cron/${entry.name}`).sort()
  const [sha, status, envText, journalText, cronText, vercelText, releaseMarkdown, migrationFiles] = await Promise.all([
    git(["rev-parse", "HEAD"], root), git(["status", "--porcelain"], root), readText(".env.example"), readText("drizzle/meta/_journal.json"), readText("docs/ops/cron-schedules.json"), readText("vercel.json"), readText("docs/release-acceptance.md"), listDirectory("drizzle"),
  ])
  const report = buildReleaseEvidence({ sha, dirty: status.trim().length > 0, envText, migrationFiles, journal: JSON.parse(journalText), cronManifest: JSON.parse(cronText), routePaths: cronRouteDirectories, vercelConfig: JSON.parse(vercelText), releaseMarkdown })
  const output = format === "json" ? `${JSON.stringify(report, null, 2)}\n` : renderReleaseEvidenceMarkdown(report)
  ;(dependencies.stdout ?? process.stdout).write(output)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  })
}
