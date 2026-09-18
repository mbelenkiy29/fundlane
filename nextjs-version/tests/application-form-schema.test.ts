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
