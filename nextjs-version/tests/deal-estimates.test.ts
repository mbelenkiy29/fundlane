import test from "node:test"
import assert from "node:assert/strict"
import { clampLenderTermMonths, estimateDeal, lenderTermRuleMonths, lenderTermRuleWholeMonths, type EstimateDealInput } from "../src/lib/mca/underwriting/estimates"
import type { EligibilityRule } from "../src/lib/mca/funders/contracts"

const rule = (field: string, operator: EligibilityRule["operator"], value: number, unit: EligibilityRule["unit"] = field === "term" ? "months" : "usd"): EligibilityRule => ({ id:`${field}:${operator}`, funderId:"f", field, operator, unit, value, unspecified:false })
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

test("lender term uses its rule unit, is clamped, and never yields zero payments or infinite amounts", () => {
  const days = one({}, [rule("term","eq",180,"days")])
  assert.equal(days.termMonths, 6)
  assert.equal(days.assumptionsSource.termMonths, "lender")
  assert.equal(one({}, [rule("term","eq",1,"years")]).termMonths, 12)
  const tiny = one({}, [rule("term","eq",1,"days")])
  assert.equal(tiny.status, "estimate")
  assert.equal(tiny.termMonths, 2)
  assert.ok(tiny.payments! > 0 && Number.isFinite(tiny.advanceHigh!) && Number.isFinite(tiny.paymentHigh!))
  assert.ok(tiny.warnings.some((warning) => warning.includes("clamped to 2")))
  assert.equal(one({}, [rule("term","eq",600)]).termMonths, 18)
  const unknown = one({}, [rule("term","eq",180,"count")])
  assert.equal(unknown.termMonths, 6)
  assert.equal(unknown.assumptionsSource.termMonths, "default")
  assert.ok(unknown.warnings.some((warning) => warning.includes("unknown unit")))
})

test("negative existing payments do not raise capacity", () => {
  const none = one()
  const negative = one({ positions:[{ estimatedPayment:-5000 }] })
  assert.equal(negative.inputs.existingDailyPayments, 0)
  assert.equal(negative.advanceHigh, none.advanceHigh)
})

test("shared lender term helpers: days convert to months, clamp at both ends, months unchanged", () => {
  assert.equal(clampLenderTermMonths(lenderTermRuleMonths({ value:180, unit:"days" })!), 6)
  assert.equal(lenderTermRuleMonths({ value:12, unit:"months" }), 12)
  assert.equal(clampLenderTermMonths(lenderTermRuleMonths({ value:12, unit:"months" })!), 12)
  assert.equal(lenderTermRuleMonths({ value:1, unit:"years" }), 12)
  const warnings: string[] = []
  assert.equal(clampLenderTermMonths(lenderTermRuleMonths({ value:30, unit:"days" })!, warnings), 2)
  assert.equal(clampLenderTermMonths(lenderTermRuleMonths({ value:3, unit:"years" })!, warnings), 18)
  assert.deepEqual(warnings, ["Lender term 1 months clamped to 2", "Lender term 36 months clamped to 18"])
  assert.equal(lenderTermRuleMonths({ value:180, unit:"count" }), null)
  assert.equal(lenderTermRuleMonths({ value:0, unit:"days" }), null)
  assert.equal(lenderTermRuleMonths({ value:-30, unit:"months" }), null)
  // Scoring's hard-rule helper rounds a max down and a min up and never clamps; estimates still read 180 days as 6 (above).
  assert.equal(lenderTermRuleWholeMonths({ value:200, unit:"days", operator:"max" }), 6)
  assert.equal(lenderTermRuleWholeMonths({ value:200, unit:"days", operator:"min" }), 7)
  assert.equal(lenderTermRuleWholeMonths({ value:180, unit:"days", operator:"max" }), 5)
  assert.equal(lenderTermRuleWholeMonths({ value:180, unit:"days", operator:"min" }), 6)
  assert.equal(lenderTermRuleWholeMonths({ value:180, unit:"days", operator:"eq" }), 6)
  assert.equal(lenderTermRuleWholeMonths({ value:365, unit:"days", operator:"max" }), 12)
  assert.equal(lenderTermRuleWholeMonths({ value:365, unit:"days", operator:"min" }), 12)
  assert.equal(lenderTermRuleWholeMonths({ value:24, unit:"months", operator:"max" }), 24)
  assert.equal(lenderTermRuleWholeMonths({ value:3, unit:"years", operator:"min" }), 36)
  assert.equal(lenderTermRuleWholeMonths({ value:0, unit:"days", operator:"max" }), null)
  assert.equal(lenderTermRuleWholeMonths({ value:180, unit:"count", operator:"max" }), null)
})

test("zero or negative lender term is ignored with a warning, not clamped up to 2 months", () => {
  for (const value of [0, -90]) {
    const estimate = one({}, [rule("term","eq",value,"days")])
    assert.equal(estimate.termMonths, 6)
    assert.equal(estimate.assumptionsSource.termMonths, "default")
    assert.ok(estimate.warnings.includes(`Lender term rule ignored: invalid value ${value}`))
    assert.ok(!estimate.warnings.some((warning) => warning.includes("clamped")))
  }
})

test("repeated warnings are de-duplicated so the panel's keys stay unique", () => {
  const estimate = one({}, [rule("term","eq",6,"count"), rule("term","min",4,"count"), rule("term","max",9,"count")])
  assert.equal(estimate.warnings.filter((warning) => warning === 'Lender term rule ignored: unknown unit "count"').length, 1)
  assert.equal(new Set(estimate.warnings).size, estimate.warnings.length)
})

test("a lender maximum under the $500 rounding step reports the lender maximum, not holdback capacity", () => {
  const estimate = one({}, [rule("requested_amount","max",400)])
  assert.equal(estimate.status, "no_capacity")
  assert.equal(estimate.reason, "Lender maximum of $400 is below the $500 estimate rounding step")
  assert.ok(nulls(estimate).every((value) => value === null))
  const exhausted = one({ positions:[{ estimatedPayment:1000 }] })
  assert.equal(exhausted.reason, "Existing payments already use the holdback capacity")
})
