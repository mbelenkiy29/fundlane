import assert from "node:assert/strict"
import test from "node:test"
import Stripe from "stripe"
import { describeUnexpectedError, redactDiagnosticText } from "../src/lib/mca/error-diagnostics"

test("describes Stripe errors with safe provider metadata", () => {
  const error = new Stripe.errors.StripeInvalidRequestError({ type: "invalid_request_error", message: "No such price: 'price_123'; a similar object exists in live mode", code: "resource_missing", param: "price", requestId: "req_abc123", statusCode: 404 } as never)
  const d = describeUnexpectedError(error)
  assert.equal(d.errorClass, "StripeInvalidRequestError")
  assert.equal(d.errorMessage, "[excluded]")
  assert.equal(d.errorCode, "resource_missing")
  assert.equal(d.providerType, "invalid_request_error")
  assert.equal(d.providerStatus, 404)
  assert.equal("providerRequestId" in d, false)
  assert.equal("providerParam" in d, false)
})

test("excludes arbitrary diagnostic text, including keys, tokens and credentials", () => {
  const liveKey = ["sk", "live", "abcDEF123456"].join("_")
  const text = redactDiagnosticText(`Invalid API Key provided: ${liveKey} whsec_abc123 postgres://user:pw@db.example.com eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig for a@b.co`)
  assert.doesNotMatch(text, /abcDEF123456|whsec_abc|user:pw|eyJhbGci|a@b\.co/)
  assert.equal(redactDiagnosticText("x".repeat(500)), "[excluded]")
})

test("describes Postgres-style errors and non-errors", () => {
  const pg = Object.assign(new Error('column "foo" does not exist'), { code: "42703" })
  assert.deepEqual(describeUnexpectedError(pg), { errorClass: "Error", errorMessage: "[excluded]", errorCode: "42703" })
  assert.deepEqual(describeUnexpectedError("boom"), { errorClass: "string", errorMessage: "non-error value thrown" })
})

test("apiError logs the redacted cause of an unexpected 500 without exposing it", async () => {
  const { apiError, AppError } = await import("../src/lib/mca/errors")
  const lines: string[] = []
  const original = console.error
  console.error = (line: unknown) => { lines.push(String(line)) }
  try {
    const response = apiError(Object.assign(new TypeError(`bad ${["rk", "live", "zzz999"].join("_")}`), { code: "E1" }))
    assert.equal(response.status, 500)
    const body = await response.json()
    assert.equal(body.error.code, "internal_error")
    assert.doesNotMatch(JSON.stringify(body), /TypeError|bad/)
    apiError(new AppError(503, "billing_disabled", "off"))
  } finally { console.error = original }
  const logged = lines.map(line => JSON.parse(line)).filter(entry => entry.event === "operational_error")
  assert.equal(logged.length, 2)
  assert.equal(logged[1].cause, undefined)
  assert.equal(logged[0].cause.errorClass, "TypeError")
  assert.equal(logged[0].cause.errorCode, undefined)
  assert.equal(logged[0].cause.errorMessage, "[excluded]")
})
