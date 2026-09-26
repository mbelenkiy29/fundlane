import test from "node:test"
import assert from "node:assert/strict"
import { RUNTIME_KINDS, runtimeKinds } from "../src/lib/mca/jobs/runtime-kinds"

test("unset kind override preserves the export and gated auto-submit defaults", () => {
  assert.deepEqual(runtimeKinds({}), ["export_create", "export"])
  assert.deepEqual(runtimeKinds({ MCA_AUTO_SUBMIT_ENABLED: "true" }), ["export_create", "export", "auto_submit"])
  assert.deepEqual(runtimeKinds({ MCA_AUTO_SUBMIT_ENABLED: "TRUE" }), ["export_create", "export"])
})

test("explicit kinds are validated, deduplicated and auto-submit stays gated", () => {
  assert.deepEqual(runtimeKinds({ MCA_JOB_RUNTIME_KINDS: " submission_delivery, import_commit,submission_delivery,auto_submit" }), ["submission_delivery", "import_commit"])
  assert.ok(RUNTIME_KINDS.includes("application_invitation_email"))
  assert.throws(() => runtimeKinds({ MCA_JOB_RUNTIME_KINDS: "document_scan" }), { code: "job_runtime_kinds_invalid" })
  assert.throws(() => runtimeKinds({ MCA_JOB_RUNTIME_KINDS: "export,unknown" }), { code: "job_runtime_kinds_invalid" })
})
