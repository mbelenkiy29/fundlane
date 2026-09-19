import test from "node:test"
import assert from "node:assert/strict"
import { generateExpectedInstallments } from "../src/lib/mca/advances/performance"
import {
  assignAdvanceNumbers,
  calendarDateInZone,
  calendarWindow,
  collectedTowardInstallment,
  completedReceipts,
  installmentSatisfied,
  merchantIdentity,
  missedInstallments,
  nextPaymentDate,
  ordinal,
  paidDown,
  servicingStatus,
} from "../src/lib/mca/deals/book-math"

test("expected daily installments start after the funded date", () => {
  const rows = generateExpectedInstallments({
    fundedAt: "2026-09-08", paymentCount: 3, paymentFrequency: "daily", calendarConvention: "calendar_days",
    periodicPaymentCents: 1000, paybackCents: 3000,
  })
  assert.deepEqual(rows.map((row) => row.occurrenceDate), ["2026-09-09", "2026-09-10", "2026-09-11"])
  assert.deepEqual(rows.map((row) => row.amountCents), [1000, 1000, 1000])
})

test("monthly installments clamp month-end the same way as scheduled paid-in", () => {
  const rows = generateExpectedInstallments({
    fundedAt: "2026-01-31", paymentCount: 2, paymentFrequency: "monthly", calendarConvention: "calendar_days",
    periodicPaymentCents: 1000, paybackCents: 2000,
  })
  assert.deepEqual(rows.map((row) => row.occurrenceDate), ["2026-02-28", "2026-03-31"])
})

test("business-day daily installments skip weekends", () => {
  const rows = generateExpectedInstallments({
    fundedAt: "2026-09-11", paymentCount: 2, paymentFrequency: "daily", calendarConvention: "business_days",
    periodicPaymentCents: 500, paybackCents: 1000,
  })
  assert.deepEqual(rows.map((row) => row.occurrenceDate), ["2026-09-14", "2026-09-15"])
})

test("unknown calendars produce no installments", () => {
  assert.deepEqual(generateExpectedInstallments({
    fundedAt: "2026-01-01", paymentCount: 2, paymentFrequency: "daily", calendarConvention: "merchant_guess",
    periodicPaymentCents: 100, paybackCents: 200,
  }), [])
})

test("payback 9000 over 10x1000 leaves last installment 0 and sums to 9000", () => {
  const rows = generateExpectedInstallments({
    fundedAt: "2026-09-08", paymentCount: 10, paymentFrequency: "daily", calendarConvention: "calendar_days",
    periodicPaymentCents: 1000, paybackCents: 9000,
  })
  assert.equal(rows.length, 10)
  assert.equal(rows[9]?.amountCents, 0)
  assert.equal(rows.reduce((sum, row) => sum + row.amountCents, 0), 9000)
})

test("calendar windows use workspace timezone and Monday weeks", () => {
  assert.deepEqual(calendarWindow("2026-09-13T06:00:00.000Z", "America/New_York", "today"), { from: "2026-09-13", to: "2026-09-13" })
  assert.deepEqual(calendarWindow("2026-09-13T06:00:00.000Z", "America/New_York", "week"), { from: "2026-09-07", to: "2026-09-13" })
  assert.deepEqual(calendarWindow("2026-09-13T06:00:00.000Z", "America/New_York", "month"), { from: "2026-09-01", to: "2026-09-30" })
})

test("2026-09-13T02:00:00.000Z is the previous calendar day in New York", () => {
  assert.equal(calendarDateInZone("2026-09-13T02:00:00.000Z", "America/New_York"), "2026-09-12")
  assert.equal(calendarDateInZone("2026-09-13T02:00:00.000Z", "UTC"), "2026-09-13")
})

test("expected installments use workspace timezone for funded timestamps", () => {
  const input = {
    fundedAt: "2026-09-13T02:00:00.000Z", paymentCount: 1, paymentFrequency: "daily",
    calendarConvention: "calendar_days", periodicPaymentCents: 1000, paybackCents: 1000,
  }
  assert.equal(generateExpectedInstallments({ ...input, timeZone: "UTC" })[0]?.occurrenceDate, "2026-09-14")
  assert.equal(generateExpectedInstallments({ ...input, timeZone: "America/New_York" })[0]?.occurrenceDate, "2026-09-13")
})

test("missed installments are due in-window without a matching receipt", () => {
  const missed = missedInstallments(
    [{ occurrenceDate: "2026-09-11" }, { occurrenceDate: "2026-09-12" }, { occurrenceDate: "2026-09-14" }],
    new Set(["2026-09-11"]),
    { from: "2026-09-07", to: "2026-09-13" },
    "2026-09-13",
  )
  assert.deepEqual(missed.map((item) => item.occurrenceDate), ["2026-09-12"])
})

test("$1 does not satisfy a $1,000 installment and voided receipts do not collect", () => {
  const installment = { id: "inst-1", occurrenceDate: "2026-09-12" }
  assert.equal(collectedTowardInstallment(installment, [
    { amountCents: 100, receivedOn: "2026-09-12", installmentId: "inst-1", status: "received" },
  ]), 100)
  assert.equal(installmentSatisfied(100_000, 100), false)
  assert.equal(installmentSatisfied(100_000, 100_000), true)
  assert.equal(collectedTowardInstallment(installment, [
    { amountCents: 100_000, receivedOn: "2026-09-12", installmentId: "inst-1", status: "void" },
  ]), 0)
  const paid = installmentSatisfied(100_000, 100) ? new Set(["2026-09-12"]) : new Set<string>()
  assert.deepEqual(
    missedInstallments([{ occurrenceDate: "2026-09-12", amountCents: 100_000 }], paid, { from: "2026-09-07", to: "2026-09-13" }, "2026-09-13")
      .map((item) => item.occurrenceDate),
    ["2026-09-12"],
  )
})

test("$0 last installment is satisfied with nothing collected and is never missed", () => {
  assert.equal(installmentSatisfied(0, 0), true)
  assert.equal(collectedTowardInstallment({ occurrenceDate: "2026-09-18" }, []), 0)
  assert.deepEqual(
    missedInstallments([{ occurrenceDate: "2026-09-18", amountCents: 0 }], new Set(), { from: "2026-09-07", to: "2026-09-18" }, "2026-09-18"),
    [],
  )
})

test("completed receipts count by received date in the window", () => {
  const completed = completedReceipts(
    [{ receivedDate: "2026-09-12" }, { receivedDate: "2026-09-01" }],
    { from: "2026-09-07", to: "2026-09-13" },
  )
  assert.equal(completed.length, 1)
})

test("next payment is the earliest unpaid occurrence on or after as-of", () => {
  assert.equal(nextPaymentDate([{ occurrenceDate: "2026-09-10" }, { occurrenceDate: "2026-09-14" }], new Set(["2026-09-10"]), "2026-09-13"), "2026-09-14")
  assert.equal(nextPaymentDate([{ occurrenceDate: "2026-09-10" }], new Set(["2026-09-10"]), "2026-09-13"), null)
})

test("advance numbers increment per merchant identity in funded order", () => {
  const numbers = assignAdvanceNumbers([
    { id: "b", identity: "name:harbor bakery", fundedAt: "2026-02-01", createdAt: "2026-02-01T00:00:00.000Z" },
    { id: "a", identity: "name:harbor bakery", fundedAt: "2026-01-01", createdAt: "2026-01-01T00:00:00.000Z" },
    { id: "c", identity: "name:other", fundedAt: "2026-03-01", createdAt: "2026-03-01T00:00:00.000Z" },
  ])
  assert.equal(numbers.get("a"), 1)
  assert.equal(numbers.get("b"), 2)
  assert.equal(numbers.get("c"), 1)
  assert.equal(ordinal(1), "1st")
  assert.equal(ordinal(2), "2nd")
  assert.equal(ordinal(3), "3rd")
  assert.equal(ordinal(11), "11th")
})

test("merchant identity prefers EIN then legal name", () => {
  assert.equal(merchantIdentity({ ein: "12-3456789", legalName: "Harbor", dealId: "d1" }), "ein:123456789")
  assert.equal(merchantIdentity({ legalName: " Harbor Bakery ", dealId: "d1" }), "name:harbor bakery")
  assert.equal(merchantIdentity({ dealId: "d1" }), "deal:d1")
})

test("paid down prefers receipts over scheduled estimates", () => {
  const actual = paidDown({ paybackCents: 10_000, receivedCents: 2_500, scheduledPaidInCents: 4_000, scheduledPaidInBasisPoints: 4000 })
  assert.equal(actual.paidDownBasisPoints, 2500)
  assert.equal(actual.balanceRemainingCents, 7_500)
  assert.equal(actual.paidDownEstimated, false)
  const estimate = paidDown({ paybackCents: 10_000, receivedCents: 0, scheduledPaidInCents: 4_000, scheduledPaidInBasisPoints: 4000 })
  assert.equal(estimate.paidDownEstimated, true)
  assert.equal(estimate.paidDownBasisPoints, 4000)
})

test("servicing status maps performance without using missed_payment as the row badge", () => {
  assert.equal(servicingStatus("on_track"), "active")
  assert.equal(servicingStatus("missed_payment"), "active")
  assert.equal(servicingStatus("renewed"), "active")
  assert.equal(servicingStatus("closed"), "paid_off")
  assert.equal(servicingStatus("default"), "defaulted")
  assert.equal(servicingStatus("in_collections"), "in_collections")
})
