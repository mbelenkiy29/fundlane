import test from "node:test"
import assert from "node:assert/strict"
import { readFileSync, readdirSync } from "node:fs"
import { FUNDER_ROUTE_KINDS } from "../src/lib/mca/funders/contracts"
import { listAdapters, adapterReadiness } from "../src/lib/mca/submissions/adapters/registry"
import { providerReadiness, providerReadinessLabel, providerReadinessView } from "../src/lib/mca/submissions/provider-readiness"

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8")

test("matrix covers every registered adapter, implementation and destination with evidence fields", () => {
  const matrix = read("docs/funder-provider-matrix.md")
  function rows(section: string) {
    return matrix.split(`## ${section}\n`)[1].split("\n## ")[0].split("\n")
      .filter(line => line.startsWith("| ")).slice(2).map(line => line.split("|").slice(1, -1).map(cell => cell.trim()))
  }
  const adapters = listAdapters()
  const registered = adapters.map(adapter => adapter.slug).sort()
  const implementations = readdirSync(new URL("../src/lib/mca/submissions/adapters/", import.meta.url), { withFileTypes: true })
    .filter(entry => entry.isDirectory()).map(entry => entry.name).concat("sandbox").sort()
  assert.deepEqual(registered, implementations)
  const providerRows = rows("Registered API adapters")
  assert.deepEqual(providerRows.map(row => row[0]).sort(), registered)
  for (const row of providerRows) {
    assert.equal(row.length, 9, row[0])
    assert.ok(row.every(Boolean), row[0])
    assert.equal(row[4], row[0] === "sandbox" ? "Sandbox verified locally" : "Untested")
    assert.equal(adapterReadiness(row[0]), row[0] === "sandbox" ? "sandbox" : "unavailable")
    assert.equal(providerReadiness({ kind: "api", destination: row[0] }), row[0] === "sandbox" ? "sandbox verified" : "untested")
  }
  const destinations = rows("Destination types")
  assert.deepEqual(destinations.map(row => row[0]).sort(), [...FUNDER_ROUTE_KINDS].sort())
  for (const row of destinations) {
    assert.equal(row.length, 9)
    assert.ok(row.every(Boolean))
    assert.equal(row[4], "Untested")
  }
  assert.match(destinations.find(row => row[0] === "email")!.join(" "), /Michael-controlled.*pilot pending/)
})

test("readiness is fail-closed evidence, independent of configured destination names", () => {
  for (const kind of FUNDER_ROUTE_KINDS) {
    assert.equal(providerReadiness({ kind, destination: "configured-provider" }), "untested")
    assert.match(providerReadinessLabel({ kind, destination: "configured-provider" }), /^Untested/)
    assert.equal(providerReadiness({ kind, destination: "sandbox" }), kind === "api" ? "sandbox verified" : "untested")
  }
  assert.match(providerReadinessLabel({ kind: "api", destination: "sandbox" }), /unavailable in production/)
  assert.equal(providerReadiness({ kind: "api", destination: "fundlane-sandbox" }), "sandbox verified")
  assert.match(providerReadinessLabel({ kind: "api", destination: "fundlane-sandbox" }), /never delivers to a real provider/)
  assert.match(providerReadinessLabel(null), /Unavailable/)
})

test("destination verification fields are absent by default and only enabled by exact true", () => {
  const previous = process.env.MCA_FUNDER_READINESS_INVENTORY_ENABLED
  try {
    for (const value of [undefined, "false", "TRUE", "1"]) {
      if (value === undefined) delete process.env.MCA_FUNDER_READINESS_INVENTORY_ENABLED
      else process.env.MCA_FUNDER_READINESS_INVENTORY_ENABLED = value
      assert.deepEqual(providerReadinessView({ kind: "email", destination: "pilot@example.test" }), {})
    }
    process.env.MCA_FUNDER_READINESS_INVENTORY_ENABLED = "true"
    assert.deepEqual(providerReadinessView({ kind: "email", destination: "pilot@example.test" }), {
      providerReadiness: providerReadinessLabel({ kind: "email", destination: "pilot@example.test" }),
    })
  } finally {
    if (previous === undefined) delete process.env.MCA_FUNDER_READINESS_INVENTORY_ENABLED
    else process.env.MCA_FUNDER_READINESS_INVENTORY_ENABLED = previous
  }
})

test("destination APIs and UI keep shared verification labels wired through", () => {
  for (const path of ["submissions/queue.ts", "submissions/broker-preview.ts", "intake/submission-review.ts", "submissions/email-templates.ts"]) {
    assert.match(read(`src/lib/mca/${path}`), /\.\.\.providerReadinessView\(/, path)
  }
  assert.match(read("src/app/api/mca/underwriting/auto-submit/route.ts"), /\.\.\.providerReadinessView\(/)
  for (const [path, object] of [
    ["submissions/selection-panel.tsx", "funder"],
    ["submissions/selection-panel.tsx", "destination"],
    ["intake/application-review.tsx", "destination"],
    ["submissions/email-preview.tsx", "preview"],
    ["underwriting/auto-submit-settings.tsx", "funder"],
    ["submissions/adapter-credentials-panel.tsx", "route"],
  ]) {
    assert.ok(read(`src/components/mca/${path}`).includes(`{${object}.providerReadiness}`), path)
  }
  assert.match(read("src/components/mca/funders/funder-directory-panel.tsx"), /providerReadinessEnabled &&.*providerReadinessLabel\(route\)/)
  assert.match(read("src/app/api/mca/funders/route.ts"), /MCA_FUNDER_READINESS_INVENTORY_ENABLED === "true"/)
  assert.match(read("src/lib/mca/submissions/adapters/credentials.ts"), /readiness: providerReadiness\(/)
})
