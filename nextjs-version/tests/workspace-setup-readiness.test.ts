import test from "node:test"
import assert from "node:assert/strict"
import { deriveReadiness, makeDiagnosticBundle, type ReadinessFacts } from "../src/lib/mca/setup/readiness"

const empty: ReadinessFacts = {
  companyNamed: false, teamMembers: 1, pendingInvitations: 0, enabledForms: 0, brokenForms: 0, createdIntakes: 0, failedIntakes: 0,
  readyDocuments: 0, failedDocuments: 0, verifiedSenders: 0, brokenSenders: 0, activeFunders: 0, sandboxFunders: 0,
  billingStatus: null, billingExempt: false, billingAccessAllowed: false, syntheticDeals: 0, sandboxSentJobs: 0, sandboxFailedJobs: 0, processingAvailable: false,
}

test("readiness derives each phase from existing state and does not equate saved connections with live delivery", () => {
  const fresh = deriveReadiness(empty, "admin")
  assert.equal(fresh.length, 7)
  assert.ok(fresh.every((item) => item.phase === "needs_setup"))
  const configured = deriveReadiness({ ...empty, companyNamed: true, teamMembers: 2, enabledForms: 1,
    processingAvailable: true, verifiedSenders: 1, activeFunders: 1, billingStatus: "trialing", billingAccessAllowed: true, syntheticDeals: 1, sandboxFunders: 1 }, "admin")
  assert.deepEqual(configured.map((item) => item.phase), ["live_ready", "configured", "configured", "configured", "configured", "configured", "configured"])
  assert.equal(deriveReadiness({ ...empty, billingStatus: "active", billingAccessAllowed: true }, "admin")[5].phase, "live_ready")
  assert.equal(deriveReadiness({ ...empty, billingExempt: true, billingAccessAllowed: true }, "admin")[5].phase, "live_ready")
  const tested = deriveReadiness({ ...empty, enabledForms: 1, createdIntakes: 1, readyDocuments: 1, processingAvailable: true, sandboxSentJobs: 1 }, "admin")
  assert.deepEqual(tested.filter((item) => item.phase === "tested").map((item) => item.id), ["form_intake", "documents", "synthetic_deal"])
  assert.match(deriveReadiness({ ...empty, brokenSenders: 1 }, "admin")[3].detail, /Reconnect/)
  assert.match(deriveReadiness({ ...empty, brokenForms: 1 }, "admin")[1].detail, /Reconnect/)
  assert.match(deriveReadiness({ ...empty, failedIntakes: 1 }, "admin")[1].detail, /retry/)
})

test("ready documents require currently available automatic processing before marking the worker tested", () => {
  const historical = { ...empty, readyDocuments: 1 }
  assert.equal(deriveReadiness(historical, "admin")[2].phase, "needs_setup")
  assert.equal(deriveReadiness({ ...historical, enabledForms: 1 }, "admin")[2].phase, "needs_setup")
  assert.match(deriveReadiness({ ...historical, failedDocuments: 1 }, "admin")[2].detail, /Enable automatic processing/)
  assert.equal(deriveReadiness({ ...historical, processingAvailable: true }, "admin")[2].phase, "tested")
})

test("historical intake cannot hide a broken current form", () => {
  const broken = deriveReadiness({ ...empty, createdIntakes: 1, brokenForms: 1 }, "admin")[1]
  assert.equal(broken.phase, "needs_setup")
  assert.equal(broken.href, "/settings/connections")
  const anotherForm = deriveReadiness({ ...empty, createdIntakes: 1, enabledForms: 1, brokenForms: 1 }, "admin")[1]
  assert.equal(anotherForm.phase, "configured")
  assert.equal(anotherForm.href, "/settings/connections")
  assert.equal(deriveReadiness({ ...empty, createdIntakes: 1, enabledForms: 1 }, "admin")[1].phase, "tested")
})

test("billing is live ready only when the access policy permits it", () => {
  for (const facts of [{ billingStatus: "active" }, { billingExempt: true }]) {
    const item = deriveReadiness({ ...empty, ...facts, billingAccessAllowed: false }, "admin")[5]
    assert.equal(item.phase, "needs_setup")
    assert.match(item.detail, /paused or expired/)
  }
})

test("non-admin roles only see workflow steps and not workspace financial or connection administration", () => {
  for (const role of ["rep", "manager"] as const) {
    assert.deepEqual(deriveReadiness(empty, role).map((item) => item.id), ["form_intake", "documents", "synthetic_deal"])
  }
})

test("diagnostic bundle uses only allowlisted states and safe local identifiers", () => {
  const bundle = makeDiagnosticBundle({ workspaceId: "ws-safe", generatedAt: "2026-09-26T00:00:00Z",
    items: deriveReadiness(empty, "admin"), requests: [
      { kind: "intake", id: "intake-123", state: "error", secret: "password=abc", bankAccount: "123456" },
      { kind: "submission", id: "merchant@example.test", state: "token=abc" },
      { kind: "submission", id: "job-declined", state: "declined" },
      { kind: "submission", id: "job-funded", state: "funded" },
    ] as Array<{ kind: "intake" | "submission"; id: string; state: string }>,
  })
  assert.deepEqual(bundle.requests, [
    { kind: "intake", requestId: "intake-123", state: "error" },
    { kind: "submission", requestId: "redacted", state: "unknown" },
    { kind: "submission", requestId: "job-declined", state: "declined" },
    { kind: "submission", requestId: "job-funded", state: "funded" },
  ])
  assert.doesNotMatch(JSON.stringify(bundle), /password|bankAccount|123456|merchant@|token=abc/)
})
