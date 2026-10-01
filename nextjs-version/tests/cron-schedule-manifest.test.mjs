import assert from "node:assert/strict"
import { readdir, readFile } from "node:fs/promises"
import test from "node:test"
import ts from "typescript"

const read = path => readFile(new URL(`../${path}`, import.meta.url), "utf8")
const parse = source => ts.createSourceFile("inventory.ts", source, ts.ScriptTarget.Latest, true)
const sorted = values => [...new Set(values)].sort()

function walk(node, visit) {
  visit(node)
  ts.forEachChild(node, child => walk(child, visit))
}

function strings(node) {
  const values = []
  walk(node, child => { if (ts.isStringLiteral(child)) values.push(child.text) })
  return sorted(values)
}

function declaration(source, name) {
  let found
  walk(parse(source), node => {
    if ((ts.isTypeAliasDeclaration(node) || ts.isVariableDeclaration(node)) && node.name.getText() === name) found = node
  })
  assert.ok(found, `Source registry ${name} must remain discoverable`)
  return found
}

// Read both early-return handlers and switch cases, ignoring comments/payload strings.
function handledKinds(source) {
  const kinds = []
  const isKind = node => ts.isPropertyAccessExpression(node) && node.expression.getText() === "job" && node.name.text === "kind"
  walk(parse(source), node => {
    if (ts.isSwitchStatement(node) && isKind(node.expression)) {
      for (const clause of node.caseBlock.clauses) {
        if (ts.isCaseClause(clause) && ts.isStringLiteral(clause.expression)) kinds.push(clause.expression.text)
      }
    }
    if (ts.isBinaryExpression(node) && [ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.EqualsEqualsToken].includes(node.operatorToken.kind)) {
      if (isKind(node.left) && ts.isStringLiteral(node.right)) kinds.push(node.right.text)
      if (isKind(node.right) && ts.isStringLiteral(node.left)) kinds.push(node.left.text)
    }
  })
  assert.ok(kinds.length, "Worker dispatch kinds must remain discoverable")
  return sorted(kinds)
}

function tableKeys(markdown, section) {
  const body = section ? markdown.split(`## ${section}\n`)[1]?.split("\n## ")[0] : markdown
  assert.ok(body, `Missing inventory section: ${section}`)
  return [...body.matchAll(/^\| `([^`]+)` \|/gm)].map(match => match[1]).sort()
}

function assertCovered(expected, entries) {
  for (const kind of expected) assert.ok(entries.includes(kind), `Missing inventory entry: ${kind}`)
}

test("schedule manifest and runtime inventory cover every cron route without installing Vercel crons", async () => {
  const files = await readdir(new URL("../src/app/api/cron/", import.meta.url), { recursive: true })
  const routeNames = files.filter(path => /(?:^|\/)route\.[cm]?[jt]sx?$/.test(path))
    .map(path => `/api/cron/${path.replace(/\/route\.[cm]?[jt]sx?$/, "")}`).sort()
  assert.ok(routeNames.length)
  const manifest = JSON.parse(await read("docs/ops/cron-schedules.json"))
  assert.deepEqual(manifest.map(entry => entry.path).sort(), routeNames)
  const inventory = await read("docs/background-job-runtime.md")
  assert.deepEqual(tableKeys(inventory, "Cron route inventory"), routeNames)
  for (const entry of manifest) {
    for (const field of ["cron", "enqueuePath", "sideEffect", "leaseRetry", "productionStatus", "inventoryAsOf"]) {
      assert.equal(typeof entry[field], "string", `${entry.path}: ${field}`)
      assert.match(entry[field], /\S/, `${entry.path}: ${field}`)
    }
    assert.ok(Array.isArray(entry.requiredFlags))
    assert.ok(Array.isArray(entry.optionalFlags))
    assert.match(entry.ownerIssue, /#\d+/)
  }
  const vercel = JSON.parse(await read("vercel.json"))
  assert.equal(Object.hasOwn(vercel, "crons"), false)
})

test("runtime inventory covers every worker and registered queue kind", async () => {
  const [worker, queue, inventory, comms, notifications] = await Promise.all([
    read("src/lib/mca/jobs/worker.ts"), read("src/lib/mca/jobs/queue.ts"), read("docs/background-job-runtime.md"),
    read("src/lib/mca/comms/contracts.ts"), read("src/lib/mca/notifications/contracts.ts"),
  ])
  const handled = handledKinds(worker)
  const registered = strings(declaration(queue, "BackgroundJobKind"))
  assert.deepEqual(handled, registered, "Every registered generic queue kind must have a worker handler")
  // Billing shares the table but has its own consumer and is intentionally outside BackgroundJobKind.
  assert.deepEqual(tableKeys(inventory, "Queue inventory"), sorted([...handled, "billing_reconcile"]))
  const otherEntries = tableKeys(inventory, "Additional registries, producers and scheduler handoffs (2026-10-01)")
  assertCovered(strings(declaration(comms, "COMMS_JOB_KINDS")).map(kind => `comms:${kind}`), otherEntries)
  let notificationKinds
  walk(parse(notifications), node => {
    if (ts.isPropertyAssignment(node) && node.name.getText() === "kind") notificationKinds = strings(node.initializer)
  })
  assert.ok(notificationKinds?.length, "Notification kind registry must remain discoverable")
  assertCovered(notificationKinds.map(kind => `notification:${kind}`), otherEntries)
})

test("inventory covers local Edge functions and retained source entrypoints", async () => {
  const [local, sources, inventory] = await Promise.all([
    readdir(new URL("../supabase/functions/", import.meta.url), { withFileTypes: true }),
    readdir(new URL("../scripts/supabase/entries/", import.meta.url)),
    read("docs/background-job-runtime.md"),
  ])
  const names = sorted([...local.filter(entry => entry.isDirectory()).map(entry => entry.name),
    ...sources.filter(name => name.endsWith(".ts")).map(name => name.slice(0, -3))])
  assertCovered(names.map(name => `edge:${name}`), tableKeys(inventory))
})

test("coverage rejects new early-return, switch and registry kinds without inventory rows", () => {
  const source = `function dispatch(job) {
    // case "not_a_job":
    if (job.kind === 'early_return') return "not_a_kind";
    switch (job.kind) { case "switch_handler": return {}; }
  }`
  assert.deepEqual(handledKinds(source), ["early_return", "switch_handler"])
  for (const missing of handledKinds(source)) {
    assert.throws(() => assertCovered(handledKinds(source), handledKinds(source).filter(kind => kind !== missing)), /Missing inventory entry/)
  }
  assert.throws(() => assertCovered(["notification:new_kind"], ["notification:document"]), /Missing inventory entry/)
  assert.throws(() => assertCovered(["/api/cron/nested/new"], ["/api/cron/jobs"]), /Missing inventory entry/)
})
