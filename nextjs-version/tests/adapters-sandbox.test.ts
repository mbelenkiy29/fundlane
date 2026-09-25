import test from "node:test"
import assert from "node:assert/strict"
import { sandboxAdapter } from "../src/lib/mca/submissions/adapters/sandbox"
import { adapterReadiness, getAdapter } from "../src/lib/mca/submissions/adapters/registry"
import type { SubmissionJob } from "../src/lib/mca/submissions/contracts"

const job = {
  id: "job-sandbox",
  workspaceId: "workspace-sandbox",
  dealId: "deal-sandbox",
  funderId: "funder-sandbox",
  attemptKey: "attempt-sandbox",
} as SubmissionJob

test("sandbox adapter maps an application, validates it and normalizes status", async () => {
  assert.equal(getAdapter("sandbox"), sandboxAdapter)
  assert.equal(adapterReadiness("sandbox"), "sandbox")
  assert.equal(adapterReadiness("credibly"), "unavailable")
  assert.equal(adapterReadiness("missing-adapter"), "unavailable")
  assert.deepEqual(sandboxAdapter.validateConfig({}), { ok: true })
  assert.deepEqual(sandboxAdapter.validate({}), { ok: false, fields: { applicationId: "Enter an application ID." } })
  assert.deepEqual(sandboxAdapter.mapSubmission(job, { applicationId: "app-sandbox" }), {
    dealId: "deal-sandbox",
    applicationId: "app-sandbox",
    funderId: "funder-sandbox",
    attemptKey: "attempt-sandbox",
  })
  assert.equal(sandboxAdapter.normalizeStatus("accepted"), "submitted")
  assert.equal(sandboxAdapter.normalizeStatus("rejected"), "declined")
  assert.equal(sandboxAdapter.normalizeStatus("unrecognized"), "unknown")
  const result = await sandboxAdapter.submit(job)
  assert.equal(result.ok, true)
  assert.equal((await sandboxAdapter.getStatus!(job)).normalized, "submitted")
})
