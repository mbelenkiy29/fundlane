import test from "node:test"
import assert from "node:assert/strict"
import { estimateDeal, type EstimateDealInput } from "../src/lib/mca/underwriting/estimates"
import type { EligibilityRule } from "../src/lib/mca/funders/contracts"

const rule = (field: string, operator: EligibilityRule["operator"], value: number): EligibilityRule => ({ id:`${field}:${operator}`, funderId:"f", field, operator, unit:"usd", value, unspecified:false })
const month = (period: string, deposits: number | null, warnings: string[] = []) => ({ period, deposits, warnings })
const base: EstimateDealInput = {
  asOf:"2026-10-01T12:00:00Z",
  months:[month("2026-07",60000), month("2026-08",50000), month("2026-08",10000), month("2026-09",60000)],
  positions:[], lenders:[{ funderId:"f", name:"Fixture", rules:[] }], assumptions:{},
}
const one = (input: Partial<EstimateDealInput> = {}, rules: EligibilityRule[] = []) => estimateDeal({ ...base, lenders:[{ funderId:"f", name:"Fixture", rules }], ...input }).lenders[0]
const nulls = (estimate: ReturnType<typeof one>) => [estimate.advanceLow, estimate.advanceHigh, estimate.factor, estimate.termMonths, estimate.payments, estimate.paymentLow, estimate.paymentHigh, estimate.paybackLow, estimate.paybackHigh]

test("worked example with defaults", () => {
  const result = estimateDeal(base)
  assert.equal(result.label, "Estimate — not an offer")
  assert.equal(result.formulaVersion, 1)
  const estimate = result.lenders[0]
  assert.equal(estimate.status, "estimate")
  assert.deepEqual(estimate.inputs, { avgMonthlyDeposits:60000, monthsUsed:3, existingDailyPayments:0, holdbackPct:0.12 })
  assert.deepEqual([estimate.advanceLow, estimate.advanceHigh, estimate.factor, estimate.termMonths, estimate.frequency, estimate.payments], [30000, 32000, 1.35, 6, "daily", 126])
  assert.deepEqual([estimate.paybackLow, estimate.paybackHigh, estimate.paymentLow, estimate.paymentHigh], [40500, 43200, 321.43, 342.86])
  assert.deepEqual(estimate.assumptionsSource, { factor:"default", termMonths:"default", frequency:"default", holdbackPct:"default" })
  assert.deepEqual(estimate.warnings, ["Existing positions not detected; estimate assumes none"])
})

test("lender min/max funding clamps the range", () => {
  const capped = one({}, [rule("requested_amount","max",25000)])
  assert.deepEqual([capped.advanceLow, capped.advanceHigh], [25000, 25000])
  const raised = one({}, [rule("requested_amount","min",31000)])
  assert.deepEqual([raised.advanceLow, raised.advanceHigh], [31000, 32000])
  const below = one({}, [rule("requested_amount","min",40000)])
  assert.equal(below.status, "below_lender_minimum")
  assert.ok(nulls(below).every((value) => value === null))
})

test("existing positions reduce capacity and can exhaust it", () => {
  const reduced = one({ positions:[{ estimatedPayment:100 }, {}] })
  assert.equal(reduced.inputs.existingDailyPayments, 100)
  assert.deepEqual([reduced.advanceLow, reduced.advanceHigh], [22500, 22500])
  assert.ok(reduced.warnings.includes("1 existing position(s) have no payment amount and are excluded"))
  assert.ok(reduced.warnings.includes("Existing position payments assumed daily"))
  const exhausted = one({ positions:[{ estimatedPayment:400 }] })
  assert.equal(exhausted.status, "no_capacity")
  assert.equal(exhausted.reason, "Existing payments already use the holdback capacity")
  assert.ok(nulls(exhausted).every((value) => value === null))
})

test("missing or non-positive deposits are insufficient_data with no numbers", () => {
  for (const months of [[], [month("2026-09",null)], [month("2026-09",60000), month("2026-09",null)], [month("2026-09",0)]]) {
    const estimate = one({ months })
    assert.equal(estimate.status, "insufficient_data")
    assert.equal(estimate.reason, "No analyzed bank statements")
    assert.ok(nulls(estimate).every((value) => value === null))
  }
  assert.equal(one({ months:[] }).inputs.avgMonthlyDeposits, null)
})

test("weekly spreads the same payback over fewer payments", () => {
  const weekly = one({ assumptions:{ frequency:"weekly" } })
  assert.equal(weekly.payments, 26)
  assert.equal(weekly.paybackHigh, 43200)
  assert.equal(weekly.paymentHigh, 1661.54)
  assert.equal(weekly.assumptionsSource.frequency, "broker")
})

test("only the latest three months are used", () => {
  const estimate = one({ months:[10000,20000,30000,60000,90000].map((deposits, index) => month(`2026-0${index + 1}`, deposits, index === 0 ? ["transfer: old"] : [])) })
  assert.equal(estimate.inputs.monthsUsed, 3)
  assert.equal(estimate.inputs.avgMonthlyDeposits, 60000)
  assert.ok(!estimate.warnings.includes("Deposits may include transfers or funding credits"))
  assert.ok(one({ months:[month("2026-09",60000,["mca_credit: funding"])] }).warnings.includes("Deposits may include transfers or funding credits"))
})

test("assumptions recalculate and record their source", () => {
  const broker = one({ assumptions:{ factor:1.5 } })
  assert.equal(broker.advanceHigh, 28500)
  assert.equal(broker.assumptionsSource.factor, "broker")
  const lender = one({}, [rule("term","min",4), rule("term","max",9)])
  assert.equal(lender.termMonths, 7)
  assert.equal(lender.assumptionsSource.termMonths, "lender")
  assert.equal(one({ assumptions:{ termMonths:3 } }, [rule("term","eq",12)]).termMonths, 3)
  const clamped = one({ assumptions:{ factor:2, holdbackPct:0.01 } })
  assert.equal(clamped.factor, 1.6)
  assert.equal(clamped.inputs.holdbackPct, 0.05)
  assert.ok(clamped.warnings.includes("Broker factor 2 clamped to 1.6"))
})

test("deterministic output", () => {
  assert.deepEqual(estimateDeal(base), estimateDeal(structuredClone(base)))
})
