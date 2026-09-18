import test from "node:test"
import assert from "node:assert/strict"
import { notificationLabel, suggestedActions } from "../src/lib/mca/home/outreach"

test("renewal is Eligible for Renewal with Call Immediately", () => {
  assert.equal(notificationLabel({ code: "renewal", fallback: "Renewal follow-up" }), "Eligible for Renewal")
  const actions = suggestedActions({ code: "renewal", phone: "+15551212" })
  assert.deepEqual(actions.map((a) => a.label), ["Call Immediately"])
  assert.equal(actions[0]?.href, "tel:+15551212")
  assert.equal(actions[0]?.enabled, true)
})

test("call is disabled without a phone", () => {
  const actions = suggestedActions({ code: "renewal" })
  assert.equal(actions[0]?.enabled, false)
  assert.equal(actions[0]?.href, undefined)
})

test("missing statements use count and SMS | Email", () => {
  assert.equal(
    notificationLabel({ code: "missing_doc", fallback: "Collect missing docs", missingStatementMonths: 3 }),
    "Missing 3 months of Statements",
  )
  assert.equal(
    notificationLabel({ code: "missing_doc", fallback: "Collect missing docs", missingStatementMonths: 1 }),
    "Missing 1 month of Statements",
  )
  assert.deepEqual(
    suggestedActions({ code: "missing_doc" }).map((a) => a.label),
    ["SMS", "Email"],
  )
})
