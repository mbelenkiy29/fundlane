import assert from "node:assert/strict"
import { readFile, readdir } from "node:fs/promises"
import test from "node:test"

import {
  ARGUMENT_MESSAGE,
  DECISION,
  DISABLED_MESSAGE,
  assertReleaseEvidenceEnabled,
  buildReleaseEvidence,
  compareMigrations,
  main,
  readEnvInventory,
  readIntegrationLedger,
  renderReleaseEvidenceMarkdown,
  validateCronManifest,
} from "../scripts/ops/release-evidence"

const appUrl = new URL("../", import.meta.url)

test("guard permits only the exact true value", () => {
  for (const value of [undefined, "false", "TRUE"]) {
    assert.throws(() => assertReleaseEvidenceEnabled({ MCA_RELEASE_EVIDENCE_ENABLED: value }), { message: DISABLED_MESSAGE })
  }
  assert.doesNotThrow(() => assertReleaseEvidenceEnabled({ MCA_RELEASE_EVIDENCE_ENABLED: "true" }))
})

test("environment inventory preserves order/defaults, classifies strictly, and rejects duplicates", () => {
  process.env.MCA_SECRET_ENABLED = "true"
  const inventory = readEnvInventory("MCA_ALPHA_ENABLED=false\nMCA_SECRET_ENABLED=\nMCA_SIGNUP_MODE=open\nMCA_LOOSE_ENABLED=FALSE\n")
  assert.deepEqual(inventory.map(({ name, defaultValue, defaultOff }) => ({ name, defaultValue, defaultOff })), [
    { name: "MCA_ALPHA_ENABLED", defaultValue: "false", defaultOff: true },
    { name: "MCA_SECRET_ENABLED", defaultValue: "", defaultOff: true },
    { name: "MCA_SIGNUP_MODE", defaultValue: "open", defaultOff: false },
    { name: "MCA_LOOSE_ENABLED", defaultValue: "FALSE", defaultOff: false },
  ])
  assert.equal(inventory[1].defaultValue, "")
  assert.throws(() => readEnvInventory("MCA_DUP=false\nMCA_DUP=true\n"), /Duplicate environment declaration/)
})

test("migration comparison reports parity failures, duplicates, invalid journals, and permits numbering gaps", () => {
  assert.deepEqual(compareMigrations(["0001_one.sql", "0003_three.sql"], { entries: [{ tag: "0001_one" }, { tag: "0003_three" }] }).consistent, true)
  const mismatch = compareMigrations(["0001_one.sql", "0002_two.sql"], { entries: [{ tag: "0001_one" }, { tag: "0003_three" }, { tag: "0003_three" }] })
  assert.deepEqual(mismatch.sqlMissingFromJournal, ["0002_two"])
  assert.deepEqual(mismatch.journalMissingSql, ["0003_three", "0003_three"])
  assert.deepEqual(mismatch.duplicateTags, ["0003_three"])
  assert.throws(() => compareMigrations([], {}), /expected an entries array/)
})

test("real migration fixture is consistent at 0067_retention_holds", async () => {
  const files = await readdir(new URL("../drizzle/", import.meta.url))
  const journal = JSON.parse(await readFile(new URL("../drizzle/meta/_journal.json", import.meta.url), "utf8"))
  const result = compareMigrations(files, journal)
  assert.equal(result.consistent, true)
  assert.equal(result.journalHead, "0067_retention_holds")
})

test("cron validation covers routes, checked defaults, and schedule-free Vercel config", async () => {
  const manifest = JSON.parse(await readFile(new URL("../docs/ops/cron-schedules.json", import.meta.url), "utf8"))
  const routePaths = (await readdir(new URL("../src/app/api/cron/", import.meta.url), { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => `/api/cron/${entry.name}`).sort()
  const env = readEnvInventory(await readFile(new URL("../.env.example", import.meta.url), "utf8"))
  const result = validateCronManifest(manifest, routePaths, {}, env)
  assert.equal(result.consistent, true)
  assert.equal(result.vercelCronsAbsent, true)
  assert.deepEqual(result.routesMissingFromManifest, [])
  assert.ok(result.entries.flatMap((entry) => entry.requiredFlags).every((flag) => flag.checkedInDefault !== null))
  assert.equal(validateCronManifest(manifest, [...routePaths, "/api/cron/drift"], {}, env).consistent, false)
  assert.equal(validateCronManifest(manifest, routePaths, { crons: [] }, env).consistent, false)
})

test("every integration ledger row is mapped without upgrading readiness", async () => {
  const markdown = await readFile(new URL("../docs/release-acceptance.md", import.meta.url), "utf8")
  const env = readEnvInventory(await readFile(new URL("../.env.example", import.meta.url), "utf8"))
  const integrations = readIntegrationLedger(markdown, env)
  assert.equal(integrations.length, 10)
  assert.deepEqual(integrations[0], { name: "Supabase Auth, Postgres, private Storage", status: "required / not flag-gated", gates: [], allMappedGatesDefaultOff: false })
  assert.ok(integrations.slice(1).every((entry) => entry.status === "needed" && entry.gates.length > 0))
  assert.ok(integrations.slice(1).every((entry) => entry.allMappedGatesDefaultOff))
  assert.deepEqual(readIntegrationLedger("# no exact heading", env), [])
})

async function realReport() {
  const [envText, journalText, cronText, vercelText, releaseMarkdown, migrationFiles, routeEntries] = await Promise.all([
    readFile(new URL("../.env.example", import.meta.url), "utf8"), readFile(new URL("../drizzle/meta/_journal.json", import.meta.url), "utf8"),
    readFile(new URL("../docs/ops/cron-schedules.json", import.meta.url), "utf8"), readFile(new URL("../vercel.json", import.meta.url), "utf8"),
    readFile(new URL("../docs/release-acceptance.md", import.meta.url), "utf8"), readdir(new URL("../drizzle/", import.meta.url)),
    readdir(new URL("../src/app/api/cron/", import.meta.url), { withFileTypes: true }),
  ])
  return buildReleaseEvidence({ sha: "abc123", dirty: true, envText, migrationFiles, journal: JSON.parse(journalText), cronManifest: JSON.parse(cronText), routePaths: routeEntries.filter((entry) => entry.isDirectory()).map((entry) => `/api/cron/${entry.name}`).sort(), vercelConfig: JSON.parse(vercelText), releaseMarkdown })
}

test("Markdown and JSON share stable candidate, inventory, proofs, issues, dirty state, and NO-GO decision", async () => {
  const report = await realReport()
  const markdown = renderReleaseEvidenceMarkdown(report)
  const json = JSON.parse(JSON.stringify(report))
  assert.match(markdown, /^# Fundlane release evidence skeleton/)
  assert.match(markdown, /Working tree: dirty/)
  assert.equal(json.candidate.sha, "abc123")
  assert.equal(json.environment.length, report.environment.length)
  assert.equal(report.hostedProofs.length, 10)
  assert.ok(report.hostedProofs.every((proof) => proof.status === "needed"))
  assert.ok(report.ownerIssuesToRecheck.includes("#36"))
  assert.ok(report.ownerIssuesToRecheck.includes("#48"))
  assert.ok(report.ownerIssuesToRecheck.includes("MIC-102"))
  assert.equal(report.decision, DECISION)
  assert.equal(markdown.endsWith("\n"), true)
})

test("main rejects malformed options and writes only the selected format", async () => {
  await assert.rejects(() => main({ env: { MCA_RELEASE_EVIDENCE_ENABLED: "true" }, args: ["--wat"], stdout: { write: () => undefined } }), { message: ARGUMENT_MESSAGE })
  const report = await realReport()
  const files: Record<string, string> = {
    ".env.example": (await readFile(new URL("../.env.example", import.meta.url), "utf8")),
    "drizzle/meta/_journal.json": JSON.stringify(report.migrations.migrationTags.length ? JSON.parse(await readFile(new URL("../drizzle/meta/_journal.json", import.meta.url), "utf8")) : {}),
    "docs/ops/cron-schedules.json": await readFile(new URL("../docs/ops/cron-schedules.json", import.meta.url), "utf8"),
    "vercel.json": "{}", "docs/release-acceptance.md": await readFile(new URL("../docs/release-acceptance.md", import.meta.url), "utf8"),
  }
  let output = ""
  await main({
    env: { MCA_RELEASE_EVIDENCE_ENABLED: "true" }, args: ["--", "--format=json"], root: appUrl.pathname,
    stdout: { write: (value) => { output += value; return true } }, readText: async (file) => files[file],
    listDirectory: async () => (await readdir(new URL("../drizzle/", import.meta.url))),
    listCronRoutes: async () => report.cron.entries.map((entry) => entry.path),
    git: async (args) => args[0] === "rev-parse" ? "abc123\n" : " M file\n",
  })
  assert.equal(JSON.parse(output).decision, DECISION)
  assert.equal(output.trimStart().startsWith("{"), true)
})
