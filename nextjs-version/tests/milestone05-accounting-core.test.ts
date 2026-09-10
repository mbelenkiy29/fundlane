import test from "node:test"
import assert from "node:assert/strict"
import { allocateCents, multiplyCentsByDecimal, parseDecimal } from "../src/lib/mca/accounting/money"
import { calculateOffer } from "../src/lib/mca/accounting/calculations"
import { estimateScheduledPaidIn } from "../src/lib/mca/advances/performance"

test("MIC-161 calculates payback and principal-based commission with exact decimal math", () => {
  const decimal = parseDecimal("1.25")
  assert.equal(decimal.numerator, BigInt(125))
  assert.equal(decimal.denominator, BigInt(100))
  assert.equal(multiplyCentsByDecimal(4_000_000, "1.25"), 5_000_000)
  const result = calculateOffer({
    principalCents: 4_000_000,
    factorRate: "1.25",
    commissionBasis: "principal",
    commissionPointsBasisPoints: 800,
  })
  assert.equal(result.paybackCents, 5_000_000)
  assert.equal(result.commissionCents, 320_000)
  assert.equal(result.periodicPaymentEstimateCents, null)
  assert.match(result.warnings[0], /unknown/i)
})

test("MIC-161 rejects float-prone decimal forms and a runtime commission base change", () => {
  assert.throws(() => parseDecimal("1e-3"), /base-10 decimal/)
  assert.throws(() => parseDecimal("1.1234567"), /at most 6/)
  assert.throws(() => calculateOffer({ principalCents: 100, factorRate: "1.2", commissionBasis: "payback", commissionPointsBasisPoints: 100 } as never), /principal/)
})

test("MIC-103 33.33/33.33/33.34 split reconciles exactly", () => {
  const result = allocateCents(10_000, [
    { recipientMembershipId: "a", percentageBasisPoints: 3333 },
    { recipientMembershipId: "b", percentageBasisPoints: 3333 },
    { recipientMembershipId: "c", percentageBasisPoints: 3334 },
  ])
  assert.deepEqual(result.map((item) => item.amountCents), [3333, 3333, 3334])
  assert.equal(result.reduce((sum, item) => sum + item.amountCents, 0), 10_000)
  assert.throws(() => allocateCents(100, [{ recipientMembershipId: "a", percentageBasisPoints: 10_001 }]), /exactly 10000/)
})

test("MIC-107 future dates stay zero and first payment is due after one period", () => {
  const base = { fundedAt: "2026-09-08", paybackCents: 10_000, periodicPaymentCents: 1000, paymentCount: 10,
    paymentFrequency: "daily", calendarConvention: "calendar_days" }
  assert.deepEqual(estimateScheduledPaidIn({ ...base, asOf: "2026-09-07" }), { paidInCents: 0, paidInBasisPoints: 0, elapsedPayments: 0, label: "scheduled_estimate" })
  assert.equal(estimateScheduledPaidIn({ ...base, asOf: "2026-09-08" }).elapsedPayments, 0)
  assert.equal(estimateScheduledPaidIn({ ...base, asOf: "2026-09-09" }).elapsedPayments, 1)
})

test("MIC-107 monthly anniversaries clamp month-end without counting crossed boundaries", () => {
  const base = { fundedAt: "2026-01-31", paybackCents: 12_000, periodicPaymentCents: 1000, paymentCount: 12,
    paymentFrequency: "monthly", calendarConvention: "calendar_days" }
  assert.equal(estimateScheduledPaidIn({ ...base, asOf: "2026-02-01" }).elapsedPayments, 0)
  assert.equal(estimateScheduledPaidIn({ ...base, asOf: "2026-02-27" }).elapsedPayments, 0)
  assert.equal(estimateScheduledPaidIn({ ...base, asOf: "2026-02-28" }).elapsedPayments, 1)
  assert.equal(estimateScheduledPaidIn({ ...base, asOf: "2026-03-31" }).elapsedPayments, 2)
})

test("MIC-107 arbitrary and missing calendars remain unknown", () => {
  const base = { fundedAt: "2026-01-01", asOf: "2026-02-01", paybackCents: 1000, periodicPaymentCents: 100,
    paymentCount: 10, paymentFrequency: "daily" }
  assert.equal(estimateScheduledPaidIn({ ...base, calendarConvention: "merchant_guess" }).label, "unknown")
  assert.equal(estimateScheduledPaidIn({ ...base, calendarConvention: null }).paidInCents, null)
})
