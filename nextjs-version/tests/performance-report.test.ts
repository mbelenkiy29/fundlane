import test from "node:test"
import assert from "node:assert/strict"
import { parseReportFilters } from "../src/lib/mca/reports/rep-funnel"
import { conversionForDealIds } from "../src/lib/mca/reports/performance"

test("report dates reject impossible Gregorian dates", () => {
  for (const value of ["2026-02-30", "2026-13-01", "2026-00-01", "2026-04-31"]) {
    assert.throws(() => parseReportFilters(new URLSearchParams({ basis: "event", from: value })), /real calendar date/)
  }
  assert.equal(parseReportFilters(new URLSearchParams("basis=event&from=2024-02-29")).from, "2024-02-29")
})
test("cohort conversion intersects IDs and deduplicates while event ratio compares activity", () => {
  assert.deepEqual(conversionForDealIds(["a", "a", "b"], ["a", "c", "a"], "cohort"), { numerator: 1, denominator: 2, rate: 0.5 })
  assert.deepEqual(conversionForDealIds(["a"], ["b", "c"], "event"), { numerator: 2, denominator: 1, rate: 2 })
  assert.equal(conversionForDealIds([], ["a"], "cohort").rate, null)
})
