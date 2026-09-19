import "./helpers/business-auth"
import test from "node:test"
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { einLookupHash } from "../src/lib/mca/merchants/lookup-hash"
import { packageFingerprint, submissionMerchantIdentityKey } from "../src/lib/mca/submissions/identity"
import { displayCacheStatus } from "../src/lib/mca/submissions/repository"

const workspaceId = "workspace-identity"

test("submissionMerchantIdentityKey prefers EIN hash over merchantId and dealId", () => {
  const ein = "12-3456789"
  const expected = `ein:${einLookupHash(workspaceId, ein)}`
  assert.equal(
    submissionMerchantIdentityKey({
      workspaceId,
      ein,
      merchantId: "merchant-1",
      dealId: "deal-1",
    }),
    expected,
  )
})

test("submissionMerchantIdentityKey uses merchantId when EIN is missing", () => {
  assert.equal(
    submissionMerchantIdentityKey({
      workspaceId,
      ein: null,
      merchantId: "merchant-42",
      dealId: "deal-1",
    }),
    "merchant:merchant-42",
  )
})

test("submissionMerchantIdentityKey falls back to dealId", () => {
  assert.equal(
    submissionMerchantIdentityKey({
      workspaceId,
      ein: "not-an-ein",
      merchantId: "  ",
      dealId: "deal-99",
    }),
    "deal:deal-99",
  )
})

test("packageFingerprint is order-independent and dedupes checksums", () => {
  const a = "aaa111"
  const b = "bbb222"
  const left = packageFingerprint([b, a, a])
  const right = packageFingerprint([a, b])
  assert.equal(left, right)
  assert.equal(
    left,
    createHash("sha256").update([a, b].join("\0")).digest("hex"),
  )
})

test("displayCacheStatus maps declined and funded terminal states", () => {
  assert.equal(displayCacheStatus("declined"), "declined")
  assert.equal(displayCacheStatus("funded"), "approved")
  assert.equal(displayCacheStatus("sent"), "sent")
  assert.equal(displayCacheStatus("queued"), "queued")
})
