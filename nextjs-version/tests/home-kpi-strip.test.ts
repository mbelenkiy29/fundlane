import test from "node:test"
import assert from "node:assert/strict"
import type { HomeKpis } from "../src/lib/mca/home/kpi-contracts"
import {
  HOME_KPI_COPY,
  HOME_KPI_NA,
  HOME_KPI_RESTRICTED,
  mapHomeKpiStrip,
} from "../src/lib/mca/home/kpi-strip"

const DUMMY = /54,?230|Olivia Martin|Premium Dashboard/

const sample: HomeKpis = {
  timezone: "America/New_York",
  asOf: "2026-03-15T17:00:00.000Z",
  period: "mtd",
  pipeline: { count: 2, volumeDollars: 150000, dollarsHidden: false },
  newDeals: { count: 4 },
  renewals: { count: 1 },
  funded: { amountCents: 1_000_000, count: 1, dollarsHidden: false },
  commission: { amountCents: 50_000, count: 1, dollarsHidden: false },
  activeMerchants: { count: 3 },
  approvalRate: { numerator: 1, denominator: 2, rate: 0.5 },
  collectionsToday: { expectedCents: 50_000, receivedCents: 25_000, dollarsHidden: false, source: "accounting_payments" },
  empty: false,
  series: {
    fundedByMonth: [
      { month: "2026-01", fundedCents: 100_000, commissionCents: 10_000 },
      { month: "2026-02", fundedCents: 200_000, commissionCents: 20_000 },
    ],
    pipelineByMonth: [
      { month: "2026-01", count: 1, volumeDollars: 50000 },
      { month: "2026-02", count: 2, volumeDollars: 100000 },
    ],
    approvalByMonth: [
      { month: "2026-01", numerator: 1, denominator: 2, rate: 0.5 },
      { month: "2026-02", numerator: 0, denominator: 0, rate: null },
    ],
    collectionsByDay: [
      { day: "2026-03-14", expectedCents: 10_000, receivedCents: 5_000 },
      { day: "2026-03-15", expectedCents: 50_000, receivedCents: 25_000 },
    ],
    revenueBreakdown: [],
    recentActivity: [],
    topFunders: [],
    merchantGrowth: [
      { month: "2026-01", new: 1, renewals: 0, churn: 0 },
      { month: "2026-02", new: 2, renewals: 1, churn: 0 },
    ],
    industries: [],
    states: [],
  },
}

test("maps eight home KPI cards with volume, counts, percent, and collections", () => {
  const cards = mapHomeKpiStrip(sample)
  assert.equal(cards.length, 8)
  assert.deepEqual(cards.map((card) => card.key), [
    "pipeline",
    "newDeals",
    "renewals",
    "funded",
    "commission",
    "activeMerchants",
    "approvalRate",
    "collectionsToday",
  ])
  assert.equal(cards[0]?.title, HOME_KPI_COPY.pipeline)
  assert.equal(cards[0]?.value, "$150,000")
  assert.equal(cards[0]?.detail, "2 deals")
  assert.equal(cards[1]?.title, "New Deals")
  assert.equal(cards[1]?.value, "4")
  assert.equal(cards[1]?.detail, "4 deals · MTD")
  assert.equal(cards[1]?.periodSensitive, true)
  assert.equal(cards[2]?.title, "Renewals")
  assert.equal(cards[2]?.value, "1")
  assert.equal(cards[2]?.detail, "1 renewal · MTD")
  assert.equal(cards[2]?.periodSensitive, true)
  assert.equal(cards[3]?.value, "$10,000")
  assert.equal(cards[3]?.detail, "1 funding · MTD")
  assert.equal(cards[4]?.value, "$500")
  assert.equal(cards[4]?.detail, "1 payment · MTD")
  assert.equal(cards[5]?.value, "3")
  assert.equal(cards[5]?.detail, "3 merchants")
  assert.equal(cards[6]?.value, "50%")
  assert.equal(cards[6]?.detail, "1 / 2 · MTD")
  assert.equal(cards[7]?.value, "$500")
  assert.equal(cards[7]?.detail, "Received $250")
  assert.equal(JSON.stringify(cards).search(DUMMY), -1)
  assert.deepEqual(cards[0]?.sparkline.map((point) => point.v), [50000, 100000])
  assert.equal(cards[0]?.sparklineHidden, false)
  assert.deepEqual(cards[3]?.sparkline.map((point) => point.v), [100_000, 200_000])
  assert.deepEqual(cards[4]?.sparkline.map((point) => point.v), [10_000, 20_000])
  assert.deepEqual(cards[5]?.sparkline.map((point) => point.v), [1, 3])
  assert.deepEqual(cards[7]?.sparkline.map((point) => point.v), [5_000, 25_000])
})

test("empty workspace shows zeros and N/A, never dummy copy", () => {
  const cards = mapHomeKpiStrip(null)
  assert.equal(cards.length, 8)
  assert.equal(cards[0]?.value, "$0")
  assert.equal(cards[0]?.detail, "0 deals")
  assert.equal(cards[1]?.value, "0")
  assert.equal(cards[1]?.detail, "0 deals · MTD")
  assert.equal(cards[2]?.value, "0")
  assert.equal(cards[2]?.detail, "0 renewals · MTD")
  assert.equal(cards[3]?.value, "$0")
  assert.equal(cards[3]?.detail, "0 fundings · MTD")
  assert.equal(cards[4]?.value, "$0")
  assert.equal(cards[5]?.value, "0")
  assert.equal(cards[6]?.value, HOME_KPI_NA)
  assert.equal(cards[7]?.value, "$0")
  assert.equal(cards[7]?.detail, "Received $0")
  assert.equal(JSON.stringify(cards).search(DUMMY), -1)
})

test("YTD period label is shared across funded, commission, and approval", () => {
  const cards = mapHomeKpiStrip({ ...sample, period: "ytd" }, "ytd")
  assert.equal(cards[1]?.detail, "4 deals · YTD")
  assert.equal(cards[2]?.detail, "1 renewal · YTD")
  assert.equal(cards[3]?.detail, "1 funding · YTD")
  assert.equal(cards[4]?.detail, "1 payment · YTD")
  assert.equal(cards[6]?.detail, "1 / 2 · YTD")
  assert.equal(cards[0]?.periodSensitive, false)
  assert.equal(cards[1]?.periodSensitive, true)
  assert.equal(cards[2]?.periodSensitive, true)
  assert.equal(cards[3]?.periodSensitive, true)
  assert.equal(cards[4]?.periodSensitive, true)
  assert.equal(cards[7]?.periodSensitive, false)
})

test("dollarsHidden shows Restricted while counts remain", () => {
  const cards = mapHomeKpiStrip({
    ...sample,
    pipeline: { count: 2, volumeDollars: null, dollarsHidden: true },
    funded: { amountCents: null, count: 1, dollarsHidden: true },
    commission: { amountCents: null, count: 1, dollarsHidden: true },
    collectionsToday: { expectedCents: null, receivedCents: null, dollarsHidden: true, source: "accounting_payments" },
  })
  assert.equal(cards[0]?.value, HOME_KPI_RESTRICTED)
  assert.equal(cards[0]?.detail, "2 deals")
  assert.equal(cards[1]?.value, "4")
  assert.equal(cards[2]?.value, "1")
  assert.equal(cards[3]?.value, HOME_KPI_RESTRICTED)
  assert.equal(cards[3]?.detail, "1 funding · MTD")
  assert.equal(cards[4]?.value, HOME_KPI_RESTRICTED)
  assert.equal(cards[4]?.detail, "1 payment · MTD")
  assert.equal(cards[5]?.value, "3")
  assert.equal(cards[7]?.value, HOME_KPI_RESTRICTED)
  assert.equal(cards[7]?.detail, `Received ${HOME_KPI_RESTRICTED}`)
  assert.equal(cards[0]?.sparklineHidden, false)
  assert.deepEqual(cards[0]?.sparkline.map((point) => point.v), [1, 2])
  assert.equal(cards[3]?.sparklineHidden, true)
  assert.deepEqual(cards[3]?.sparkline, [])
  assert.equal(cards[4]?.sparklineHidden, true)
  assert.equal(cards[7]?.sparklineHidden, true)
})

test("approval rate null is N/A even when deals exist", () => {
  const cards = mapHomeKpiStrip({
    ...sample,
    approvalRate: { numerator: 0, denominator: 0, rate: null },
  })
  assert.equal(cards[6]?.value, HOME_KPI_NA)
  assert.equal(cards[6]?.detail, "MTD")
})
