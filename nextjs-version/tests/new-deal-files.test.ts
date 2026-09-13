import test from "node:test"
import assert from "node:assert/strict"
import { classifyNewDealFilename, classifyNewDealFiles } from "../src/lib/mca/documents/new-deal-files"

test("classifies supporting filenames and the first unclassified PDF as application", () => {
  assert.equal(classifyNewDealFilename("bank-statement.pdf"), "statement")
  assert.equal(classifyNewDealFilename("voided-check.png"), "voided_check")
  assert.equal(classifyNewDealFilename("drivers-license.jpg"), "driver_license")
  assert.equal(classifyNewDealFilename("passport.pdf"), "driver_license")
  assert.equal(classifyNewDealFilename("owner-id.png"), "driver_license")
  assert.equal(classifyNewDealFilename("Merchant Application.pdf"), undefined)

  assert.deepEqual(
    classifyNewDealFiles([
      { name: "Merchant Application.pdf", type: "application/pdf" },
      { name: "Jan-statement.pdf", type: "application/pdf" },
      { name: "voided-check.png", type: "image/png" },
      { name: "license.jpg", type: "image/jpeg" },
    ]),
    ["application", "statement", "voided_check", "driver_license"],
  )
  assert.deepEqual(
    classifyNewDealFiles([{ name: "statement-only.pdf", type: "application/pdf" }]),
    ["statement"],
  )
})
