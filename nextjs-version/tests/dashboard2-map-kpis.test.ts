import test from "node:test"
import assert from "node:assert/strict"
import type { HomeKpis } from "../src/lib/mca/home/kpi-contracts"
import {
  EMPTY_DASHBOARD2,
  NA_LABEL,
  NO_ACTIVITY_YET,
  RESTRICTED_LABEL,
  formatPercent,
  formatRelativeTimestamp,
  mapDashboard2,
  mapSalesChart,
  monthWindowForDateRange,
  periodForDateRange,
  salesChartCsv,
} from "../src/lib/mca/dashboard2/map-kpis"

const DUMMY = /54,?230|Olivia Martin|Premium Dashboard|2,350|1,247|3\.24%/

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
      { month: "2026-03", fundedCents: 700_000, commissionCents: 20_000 },
    ],
    revenueBreakdown: [
      { key: "funded", amountCents: 1_000_000 },
      { key: "commission", amountCents: 50_000 },
      { key: "fees", amountCents: 5_000 },
    ],
    recentActivity: [
      {
        id: "fun-1",
        kind: "funding",
        title: "Acme LLC",
        subtitle: "Rapid Finance",
        amountCents: 1_000_000,
        status: "committed",
        at: "2026-03-15T15:00:00.000Z",
      },
    ],
    topFunders: [{ name: "Rapid Finance", fundedCents: 1_000_000, dealCount: 2 }],
    pipelineByMonth: [
      { month: "2026-01", count: 1, volumeDollars: 50000 },
      { month: "2026-02", count: 1, volumeDollars: 100000 },
      { month: "2026-03", count: 2, volumeDollars: 150000 },
    ],
    approvalByMonth: [
      { month: "2026-01", numerator: 0, denominator: 1, rate: 0 },
      { month: "2026-02", numerator: 1, denominator: 2, rate: 0.5 },
      { month: "2026-03", numerator: 1, denominator: 2, rate: 0.5 },
    ],
    collectionsByDay: [
      { day: "2026-03-14", expectedCents: 10_000, receivedCents: 5_000 },
      { day: "2026-03-15", expectedCents: 50_000, receivedCents: 25_000 },
    ],
    merchantGrowth: [
      { month: "2026-01", new: 1, renewals: 0, churn: 0 },
      { month: "2026-02", new: 0, renewals: 1, churn: 0 },
      { month: "2026-03", new: 2, renewals: 0, churn: 1 },
    ],
    industries: [{ label: "Retail", count: 3, fundedCents: 1_000_000 }],
    states: [{ label: "NY", count: 2, fundedCents: 800_000 }],
  },
}

test("empty workspace maps to zeros and No activity yet, never dummy template copy", () => {
  const view = mapDashboard2(null)
  assert.equal(view.empty, true)
  assert.equal(view.metrics.length, 4)
  assert.equal(view.metrics[0]?.title, "Pipeline")
  assert.equal(view.metrics[0]?.value, "0")
  assert.equal(view.metrics[0]?.footer, NO_ACTIVITY_YET)
  assert.equal(view.metrics[1]?.value, "$0")
  assert.equal(view.metrics[2]?.value, "$0")
  assert.equal(view.metrics[3]?.value, NA_LABEL)
  assert.equal(view.sales.empty, true)
  assert.equal(view.sales.restricted, false)
  assert.equal(view.revenue.empty, true)
  assert.equal(view.activity.length, 0)
  assert.equal(view.funders.length, 0)
  assert.equal(view.growthMetrics.totalCustomers, "0")
  assert.match(JSON.stringify(view), new RegExp(NO_ACTIVITY_YET))
  assert.doesNotMatch(JSON.stringify(view), DUMMY)
  assert.doesNotMatch(JSON.stringify(EMPTY_DASHBOARD2), DUMMY)
})

test("live KPIs map onto dashboard 2 widgets", () => {
  const view = mapDashboard2(sample, { dateRange: "90d", salesRange: "3m" })
  assert.equal(view.metrics[0]?.value, "2")
  assert.equal(view.metrics[0]?.footer, "$150,000")
  assert.equal(view.metrics[0]?.subfooter, "3 active merchants")
  assert.equal(view.metrics[1]?.value, "$10,000")
  assert.equal(view.metrics[2]?.value, "$500")
  assert.equal(view.metrics[3]?.value, "50%")
  assert.equal(view.metrics[3]?.footer, "1 / 2")
  assert.deepEqual(view.sales.points.map((row) => row.month), ["Jan", "Feb", "Mar"])
  assert.equal(view.sales.points[2]?.sales, 7000)
  assert.equal(view.sales.points[2]?.target, 200)
  assert.equal(view.revenue.slices[0]?.label, "Funded")
  assert.equal(view.revenue.slices[0]?.amount, 10000)
  assert.equal(view.activity[0]?.customer.name, "Acme LLC")
  assert.equal(view.activity[0]?.amount, "$10,000")
  assert.equal(view.activity[0]?.status, "completed")
  assert.equal(view.activity[0]?.date, "2 hours ago")
  assert.equal(view.funders[0]?.name, "Rapid Finance")
  assert.equal(view.funders[0]?.revenue, "$10,000")
  assert.equal(view.funders[0]?.sales, 2)
  assert.equal(view.growth.length, 3)
  assert.equal(view.growth[1]?.renewals, 1)
  assert.equal("renewals" in (view.growth[0] ?? {}), true)
  assert.equal("returning" in (view.growth[0] ?? {}), false)
  assert.equal(view.industries[0]?.label, "Retail")
  assert.equal(view.industries[0]?.revenue, "$10,000")
  assert.equal(view.states[0]?.label, "NY")
  assert.equal(view.growthMetrics.collections, "$250 / $500")
  assert.doesNotMatch(JSON.stringify(view), DUMMY)
})

test("dollarsHidden zero-filled series render Restricted instead of fake revenue", () => {
  const hidden: HomeKpis = {
    ...sample,
    pipeline: { ...sample.pipeline, volumeDollars: null, dollarsHidden: true },
    funded: { ...sample.funded, amountCents: null, dollarsHidden: true },
    commission: { ...sample.commission, amountCents: null, dollarsHidden: true },
    collectionsToday: { ...sample.collectionsToday, expectedCents: null, receivedCents: null, dollarsHidden: true },
    series: {
      ...sample.series,
      fundedByMonth: sample.series.fundedByMonth.map((row) => ({ ...row, fundedCents: 0, commissionCents: 0 })),
      revenueBreakdown: sample.series.revenueBreakdown.map((row) => ({ ...row, amountCents: 0 })),
      recentActivity: sample.series.recentActivity.map((row) => ({ ...row, amountCents: null })),
      topFunders: sample.series.topFunders.map((row) => ({ ...row, fundedCents: 0 })),
      industries: sample.series.industries.map((row) => ({ ...row, fundedCents: null })),
      states: sample.series.states.map((row) => ({ ...row, fundedCents: null })),
    },
  }
  const view = mapDashboard2(hidden)
  assert.equal(view.empty, false)
  assert.equal(view.metrics[0]?.footer, RESTRICTED_LABEL)
  assert.equal(view.metrics[1]?.value, RESTRICTED_LABEL)
  assert.equal(view.metrics[2]?.value, RESTRICTED_LABEL)
  assert.equal(view.metrics[1]?.footer, "1 fundings")
  assert.equal(view.sales.restricted, true)
  assert.equal(view.sales.empty, false)
  assert.equal(view.sales.plotSales, false)
  assert.equal(view.sales.plotTarget, false)
  assert.equal(view.revenue.restricted, true)
  assert.equal(view.revenue.totalDisplay, RESTRICTED_LABEL)
  assert.equal(view.activity[0]?.amount, RESTRICTED_LABEL)
  assert.equal(view.funders[0]?.revenue, RESTRICTED_LABEL)
  assert.equal(view.industries[0]?.revenue, RESTRICTED_LABEL)
  assert.equal(view.states[0]?.revenue, RESTRICTED_LABEL)
  assert.equal(view.growthMetrics.collections, RESTRICTED_LABEL)
  assert.doesNotMatch(JSON.stringify(view), DUMMY)
  assert.equal(salesChartCsv(view.sales.points, true), "month,funded,commission")
})

test("header range maps 30d to mtd and 1y to ytd; 7d/90d only change series window", () => {
  assert.equal(periodForDateRange("7d"), "mtd")
  assert.equal(periodForDateRange("30d"), "mtd")
  assert.equal(periodForDateRange("90d"), "mtd")
  assert.equal(periodForDateRange("1y"), "ytd")
  assert.equal(monthWindowForDateRange("7d"), 1)
  assert.equal(monthWindowForDateRange("30d"), 1)
  assert.equal(monthWindowForDateRange("90d"), 3)
  assert.equal(monthWindowForDateRange("1y"), 12)
  const month = mapDashboard2(sample, { dateRange: "30d" })
  assert.equal(month.growth.length, 1)
  assert.equal(month.growth[0]?.month, "Mar")
})

test("sales chart 3m window and approval rate N/A stay numeric-safe", () => {
  const sales = mapSalesChart(sample, "3m")
  assert.equal(sales.points.length, 3)
  assert.equal(formatPercent(null), NA_LABEL)
  assert.equal(formatPercent(0.5), "50%")
  assert.equal(formatRelativeTimestamp("2026-03-15T15:00:00.000Z", "2026-03-15T17:00:00.000Z"), "2 hours ago")
})
