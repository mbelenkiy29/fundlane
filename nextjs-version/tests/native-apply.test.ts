import test from "node:test"
import assert from "node:assert/strict"
import { AppError } from "../src/lib/mca/errors"
import { hmacScopedToken } from "../src/lib/mca/crypto"
import { parseNativeApplication } from "../src/lib/mca/intake/native-apply"

test("native apply HMAC tokens are stable for a workspace member", () => {
  const first = hmacScopedToken("native-apply", "ws-1", "member-1")
  const second = hmacScopedToken("native-apply", "ws-1", "member-1")
  const other = hmacScopedToken("native-apply", "ws-1", "member-2")
  assert.equal(first, second)
  assert.notEqual(first, other)
  assert.match(first, /^[A-Za-z0-9_-]{32,128}$/)
})

test("parseNativeApplication requires a business name and rejects full identity numbers", () => {
  assert.equal(parseNativeApplication({ legalName: "Acme LLC", requestedAmount: 25000 }).legalName, "Acme LLC")
  assert.throws(
    () => parseNativeApplication({}),
    (error: unknown) => error instanceof AppError && error.code === "invalid_application"
  )
  assert.throws(
    () => parseNativeApplication({ legalName: "Acme", owners: [{ identityLast4: "123456789" }] }),
    (error: unknown) => error instanceof AppError && error.code === "invalid_application"
  )
})
