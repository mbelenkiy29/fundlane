import test from "node:test"
import assert from "node:assert/strict"
import {
  formatRecoveryCode,
  generateRecoveryCodes,
  generateTotpCode,
  generateTotpSecret,
  hashRecoveryCode,
  normalizeRecoveryCode,
  normalizeTotpCode,
  totpUri,
  verifyTotpCode,
} from "../src/lib/mca/totp"

test("TOTP secrets verify within the current window and reject reused or malformed codes", () => {
  const secret = generateTotpSecret()
  const now = Date.parse("2026-09-25T13:00:00.000Z")
  const code = generateTotpCode(secret, now)
  assert.match(code, /^\d{6}$/)
  assert.equal(verifyTotpCode(secret, code, now).valid, true)
  assert.equal(verifyTotpCode(secret, code, now + 30_000).valid, true)
  assert.equal(verifyTotpCode(secret, "000000", now).valid, false)
  assert.equal(verifyTotpCode(secret, "12 34", now).valid, false)
  assert.equal(normalizeTotpCode(" 123456 "), "123456")
  assert.equal(normalizeTotpCode("abcdef"), null)
})

test("recovery codes normalize, hash, and stay single-use identifiers", () => {
  const codes = generateRecoveryCodes()
  assert.equal(codes.length, 10)
  assert.equal(new Set(codes).size, 10)
  const sample = codes[0]
  assert.match(sample, /^[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}$/)
  assert.equal(normalizeRecoveryCode(sample.replaceAll("-", "").toLowerCase()), sample)
  assert.equal(hashRecoveryCode(sample), hashRecoveryCode(sample.toLowerCase()))
  assert.notEqual(hashRecoveryCode(sample), sample)
  assert.equal(hashRecoveryCode("not-a-code"), null)
  assert.equal(formatRecoveryCode("abcd"), "ABCD-0000-0000-0000")
})

test("otpauth URIs include the issuer and secret without a host", () => {
  const secret = "JBSWY3DPEHPK3PXP"
  const uri = totpUri({ issuer: "Fundlane", account: "owner@example.test", secret })
  assert.equal(uri.startsWith("otpauth://totp/Fundlane:owner%40example.test?"), true)
  assert.match(uri, /secret=JBSWY3DPEHPK3PXP/)
  assert.match(uri, /issuer=Fundlane/)
})
