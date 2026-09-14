import test from "node:test"
import assert from "node:assert/strict"
import {
  filterSubmissionRows,
  dealSubmissionHref,
  groupSubmissionDeals,
  pageSubmissionDeals,
  submissionGuidance,
  type SubmissionRow,
} from "../src/lib/mca/submissions/dashboard-view"
const row = (
  id: string,
  patch: Partial<SubmissionRow> = {}
): SubmissionRow => ({
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
  submittedAt: "2026-09-09T10:00:00.000Z",
  updatedAt: null,
  ...patch,
})
test("combined filters include inclusive dates and exclude unknown dates", () => {
  const result = filterSubmissionRows(
    [
      row("a"),
      row("b", { submittedAt: null }),
      row("c", { delivery: "failed" }),
    ],
    new URLSearchParams(
      "q=coffee&delivery=sent&response=unknown&funder=f1&rep=rep&from=2026-09-09&to=2026-09-09"
    )
  )
  assert.deepEqual(
    result.rows.map((r) => r.id),
    ["a"]
  )
  assert.equal(result.choices.delivery.length, 2)
  assert.equal(
    filterSubmissionRows([row("a")], new URLSearchParams("q=missing")).total,
    0
  )
})
test("pagination is deterministic across ties and missing dates", () => {
  const rows = Array.from({ length: 27 }, (_, i) =>
    row(String(i).padStart(2, "0"))
  )
  rows.push(row("legacy", { submittedAt: null }))
  const first = filterSubmissionRows(rows, new URLSearchParams()),
    second = filterSubmissionRows(
      [...rows].reverse(),
      new URLSearchParams("page=2")
    )
  assert.equal(first.rows.length, 25)
  assert.deepEqual(
    second.rows.map((r) => r.id),
    ["25", "26", "legacy"]
  )
  assert.equal(
    filterSubmissionRows(rows, new URLSearchParams("page=99")).page,
    2
  )
})
test("deal links escape identifiers and failed deliveries provide next steps", () => {
  assert.equal(
    dealSubmissionHref("a&tab=bad"),
    "/deals?deal=a%26tab%3Dbad&tab=submissions"
  )
  assert.match(dealSubmissionHref("a", "offers"), /tab=offers$/)
  assert.match(submissionGuidance("failed")!, /retry/)
  assert.equal(submissionGuidance("sent"), null)
})
test("groups funder sends into one deal row with derived status and outcome", () => {
  const grouped = groupSubmissionDeals(
    [
      row("a", { funder: "Rapid", funderId: "r1", delivery: "sent" }),
      row("b", { funder: "Kapitus", funderId: "k1", delivery: "sent", submittedAt: "2026-09-10T10:00:00.000Z" }),
    ],
    new Map([["deal", { funded: false, fundedAmountCents: null, fundedFunder: null, offerFunders: ["Rapid"] }]])
  )
  assert.equal(grouped.length, 1)
  assert.equal(grouped[0]?.business, "Coffee Shop")
  assert.equal(grouped[0]?.amountRequested, 50000)
  assert.equal(grouped[0]?.lenders.length, 2)
  assert.equal(grouped[0]?.status, "offer_received")
  assert.equal(grouped[0]?.outcome, "Offer from Rapid")
})
test("funded deal status wins over live sends", () => {
  const [deal] = groupSubmissionDeals(
    [row("a", { dealStatus: "submitted", delivery: "sent" })],
    new Map([["deal", { funded: true, fundedAmountCents: 2500000, fundedFunder: "Rapid", offerFunders: ["Rapid"] }]])
  )
  assert.equal(deal?.status, "funded")
  assert.equal(deal?.outcome, "Funded $25,000 with Rapid")
})
test("deal pagination counts businesses, not funder sends", () => {
  const rows = [
    row("a1", { dealId: "d1", business: "Alpha", submittedAt: "2026-09-10T10:00:00.000Z" }),
    row("a2", { dealId: "d1", business: "Alpha", funder: "Other", funderId: "o1", submittedAt: "2026-09-10T11:00:00.000Z" }),
    row("b1", { dealId: "d2", business: "Beta", displayId: "MCA-2", submittedAt: "2026-09-08T10:00:00.000Z" }),
  ]
  const result = pageSubmissionDeals(rows, new URLSearchParams())
  assert.equal(result.total, 2)
  assert.equal(result.deals.length, 2)
  assert.equal(result.deals[0]?.business, "Alpha")
})
