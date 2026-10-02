import test from "node:test"
import assert from "node:assert/strict"
import { readFile, readdir } from "node:fs/promises"

test("selected onboarding migrations follow the competing allocation without rewriting historical journal ordinals", async () => {
  const journal = JSON.parse(await readFile("drizzle/meta/_journal.json", "utf8"))
  const files = await readdir("drizzle")
  assert.ok(files.includes("0080_stripe_first_onboarding.sql"))
  assert.ok(files.includes("0081_enrollment_billing_evidence.sql"))
  assert.ok(!files.includes("0078_stripe_first_onboarding.sql"))
  assert.ok(!files.includes("0079_enrollment_billing_evidence.sql"))
  const onboarding = journal.entries.find((entry: { tag: string }) => entry.tag === "0080_stripe_first_onboarding")
  const evidence = journal.entries.find((entry: { tag: string }) => entry.tag === "0081_enrollment_billing_evidence")
  assert.deepEqual([onboarding?.idx, evidence?.idx], [69, 70])
  assert.deepEqual([onboarding?.when, evidence?.when], [1790819000079, 1790819000080])
  assert.ok(onboarding.when > 1790819000078, "Drizzle must see the selected migration after the competing branch's timestamp")
  assert.equal(journal.entries[68].tag, "0077_email_sync_error_time")
  assert.equal(journal.entries[68].when, 1790819000076)
  for (let i = 1; i < journal.entries.length; i++) {
    assert.equal(journal.entries[i].idx, journal.entries[i - 1].idx + 1)
    assert.ok(journal.entries[i].when > journal.entries[i - 1].when)
  }
})
