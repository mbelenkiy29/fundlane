import test from "node:test"
import assert from "node:assert/strict"
import { dollarsToCents, sanitizeAnswers, stepError, visibleSteps, DEFAULT_OPTIONAL_FIELDS } from "../src/lib/mca/applications/form-schema"

test("sanitizeAnswers keeps MCA fields and drops assignments", () => {
  const answers = sanitizeAnswers({
    legalName: " Harbor ",
    requestedAmount: "75,000",
    assignments: [{ membershipId: "x", kind: "originator" }],
    owners: [{ firstName: "Ada", lastName: "Chen", ownershipPercent: "60", identityLast4: "12-34" }],
  })
  assert.equal(answers.legalName, "Harbor")
  assert.equal(answers.requestedAmount, 75000)
  assert.equal(answers.assignments, undefined)
  assert.equal(answers.owners?.[0].identityLast4, "1234")
})

test("visibleSteps hides optional extras", () => {
  const hidden = visibleSteps({ ...DEFAULT_OPTIONAL_FIELDS, dbaName: false, fundingPurpose: false, driversLicense: false, voidedCheck: false })
  assert.equal(hidden.some(step => step.id === "dbaName"), false)
  assert.equal(hidden.some(step => step.id === "extras"), false)
  assert.equal(hidden.some(step => step.id === "legalName"), true)
})

test("stepError and cents conversion", () => {
  assert.equal(dollarsToCents(75_000), 7_500_000)
  assert.equal(dollarsToCents(undefined), null)
  assert.match(stepError("ein", { ein: "12" }) ?? "", /EIN/)
  assert.equal(stepError("ein", { ein: "12-3456789" }), undefined)
  assert.match(stepError("owners", { owners: [{ firstName: "A", lastName: "B", ownershipPercent: 40 }] }) ?? "", /100/)
})

test("required business fields reject impossible dates and malformed US contact details", () => {
  for (const startDate of ["2025-02-29", "2024-02-30", "2025-13-01", "2999-01-01"]) {
    assert.match(stepError("startDate", { startDate }) ?? "", /date/i)
  }
  assert.equal(stepError("startDate", { startDate: "2024-02-29" }), undefined)
  for (const postalCode of ["abc", "1234", "123456"]) {
    assert.match(stepError("address", { address: { line1: "1 Main", city: "Austin", state: "TX", postalCode } }) ?? "", /ZIP/)
  }
  assert.equal(stepError("address", { address: { line1: "1 Main", city: "Austin", state: "TX", postalCode: "78701-1234" } }), undefined)
  for (const contactPhone of ["hello", "123", "12345678901234"]) {
    assert.match(stepError("contact", { contactName: "Alex", contactPhone }) ?? "", /phone/i)
  }
  assert.equal(stepError("contact", { contactName: "Alex", contactPhone: "+1 (512) 555-0100" }), undefined)
})

test("financial and ownership requirements reject nonfinite and out-of-range values", () => {
  for (const monthlyRevenue of [NaN, Infinity, -1]) assert.ok(stepError("monthlyRevenue", { monthlyRevenue }))
  for (const requestedAmount of [NaN, Infinity, 0, -1]) assert.ok(stepError("requestedAmount", { requestedAmount }))
  assert.equal(stepError("monthlyRevenue", { monthlyRevenue: 0 }), undefined)
  assert.ok(stepError("owners", { owners: [{ firstName: "A", lastName: "B", ownershipPercent: -10 }, { firstName: "C", lastName: "D", ownershipPercent: 110 }] }))
  assert.ok(stepError("owners", { owners: [{ firstName: "A", lastName: "B", ownershipPercent: NaN }] }))
  assert.ok(stepError("owners", { owners: [{ firstName: "A", lastName: "B", ownershipPercent: undefined }, { firstName: "C", lastName: "D", ownershipPercent: 100 }] }))
  assert.equal(stepError("owners", { owners: [{ firstName: "A", lastName: "B", ownershipPercent: 0 }, { firstName: "C", lastName: "D", ownershipPercent: 100 }] }), undefined)
})
