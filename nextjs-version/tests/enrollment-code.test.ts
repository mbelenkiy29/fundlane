import assert from "node:assert/strict"
import test from "node:test"
import { enrollmentCodeError, normalizeEnrollmentCode } from "../src/lib/mca/onboarding/enrollment-code"

test("pasted enrollment codes lose separators but keep letters", () => {
  for (const raw of ["5948 0900", "5948-0900", "5948–0900", "5948—0900", " 59480900\n", "59480900"])
    assert.equal(normalizeEnrollmentCode(raw), "59480900", JSON.stringify(raw))
  assert.equal(normalizeEnrollmentCode("12ab 5678"), "12ab5678")
})

test("enrollment code validation accepts 6-10 digits only", () => {
  for (const ok of ["123456", "5948 0900", "1234567890"]) assert.equal(enrollmentCodeError(ok), null)
  for (const bad of ["12345", "12345678901", "12ab5678", "", "   "])
    assert.equal(enrollmentCodeError(bad), "Enter the 6–10 digit code from your email.")
})
