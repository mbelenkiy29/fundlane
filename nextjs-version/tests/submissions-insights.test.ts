import test from "node:test"
import assert from "node:assert/strict"
import { buildSubmissionInsights } from "../src/lib/mca/submissions/insights"
import type { SubmissionRow } from "../src/lib/mca/submissions/dashboard-view"

const row = (id: string, patch: Partial<SubmissionRow> = {}): SubmissionRow => ({
  id,
  source: "automated",
  dealId: "deal",
  displayId: "MCA-1",
  business: "Coffee Shop",
  funderId: "f1",
  funder: "Capital",
  reps: [{ id: "rep", name: "Alex" }],
  originatorId: "rep",
  originatorName: "Alex",
  requestedAmount: 50000,
  amountHidden: false,
  dealStatus: "submitted",
  delivery: "sent",
  response: "unknown",
  route: "email",
  submittedAt: "2026-09-09T14:00:00.000Z",
  updatedAt: null,
  ...patch,
})

test("counts successful sends in the selected calendar window", () => {
  const insights = buildSubmissionInsights({
    timezone: "UTC",
    window: "today",
    nowIso: "2026-09-09T18:00:00.000Z",
    rows: [
      row("in"),
      row("failed", { id: "failed", delivery: "failed" }),
      row("yesterday", { id: "yesterday", submittedAt: "2026-09-08T14:00:00.000Z" }),
    ],
  })
  assert.equal(insights.submissions.count, 1)
  assert.equal(insights.submissions.dealCount, 1)
  assert.equal(insights.brokers[0]?.name, "Alex")
  assert.equal(insights.brokers[0]?.count, 1)
  assert.equal(insights.lenders[0]?.name, "Capital")
})

test("week window includes Monday through today and ranks brokers", () => {
  const insights = buildSubmissionInsights({
    timezone: "UTC",
    window: "week",
    nowIso: "2026-09-09T18:00:00.000Z",
    rows: [
      row("a", { dealId: "d1" }),
      row("b", { id: "b", dealId: "d2", originatorId: "rep-2", originatorName: "Blair", funder: "Rapid", funderId: "r1" }),
      row("c", { id: "c", dealId: "d3", originatorId: "rep-2", originatorName: "Blair", funder: "Rapid", funderId: "r1" }),
    ],
  })
  assert.equal(insights.submissions.count, 3)
  assert.equal(insights.brokers[0]?.name, "Blair")
  assert.equal(insights.brokers[0]?.count, 2)
  assert.equal(insights.lenders[0]?.name, "Rapid")
  assert.equal(insights.lenders[0]?.count, 2)
})
