import test from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"

test("Restricted and N/A stay labeled and have explanations", () => {
  const hints = readFileSync(new URL("../src/components/mca/reports/report-ui.tsx", import.meta.url), "utf8")
  assert.match(hints, /not shown as \$0/)
  assert.match(hints, /denominator is zero/)
  assert.match(hints, /ROI cannot be computed/)
  assert.match(hints, /ExplainedValue/)
  assert.match(hints, /aria-label/)

  for (const file of [
    "../src/components/mca/reports/funder-analytics.tsx",
    "../src/components/mca/reports/rep-funnel.tsx",
    "../src/components/mca/reports/lead-roi.tsx",
  ]) {
    const source = readFileSync(new URL(file, import.meta.url), "utf8")
    assert.match(source, /if \(rate == null\) return "N\/A"/)
    assert.match(source, /Restricted/)
    assert.match(source, /explainedReportValue/)
  }
})

test("reports page contains scrolling, explanations, and empty states", () => {
  const page = readFileSync(new URL("../src/app/(dashboard)/reports/page.tsx", import.meta.url), "utf8")
  assert.match(page, /min-w-0/)
  assert.match(page, /overflow-x-hidden/)
  assert.match(page, /Hover Restricted or N\/A/)

  const table = readFileSync(new URL("../src/components/ui/table.tsx", import.meta.url), "utf8")
  assert.match(table, /min-w-0/)
  assert.match(table, /overflow-auto/)

  const chrome = readFileSync(new URL("../src/components/mca/dashboard-chrome.tsx", import.meta.url), "utf8")
  assert.match(chrome, /min-w-0/)
  assert.match(chrome, /overflow-x-clip/)

  for (const file of [
    "../src/components/mca/reports/funder-analytics.tsx",
    "../src/components/mca/reports/team-profit.tsx",
    "../src/components/mca/reports/rep-funnel.tsx",
    "../src/components/mca/reports/lead-roi.tsx",
    "../src/components/mca/applications/outreach-report.tsx",
  ]) {
    const source = readFileSync(new URL(file, import.meta.url), "utf8")
    assert.match(source, /explainedReportValue|ExplainedValue/)
    assert.match(source, /ReportEmptyState/)
    assert.match(source, /min-w-0/)
  }
})
