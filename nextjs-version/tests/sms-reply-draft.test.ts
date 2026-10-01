import test from "node:test"
import assert from "node:assert/strict"

// Changing an uncertain attempt's body/key would make these assertions fail.
test("SMS reply drafts freeze an uncertain attempt and reset only after confirmed acceptance", async () => {
  const contract = await import("../src/lib/mca/sms/reply-draft").catch(() => null)
  assert.equal(typeof contract?.reserveSmsReplyDraft, "function")
  const draft = { body: "Application update" }
  const reserved = contract!.reserveSmsReplyDraft(draft, "first-key")
  assert.deepEqual(contract!.reserveSmsReplyDraft(reserved, "new-key"), reserved)
  assert.deepEqual(contract!.editSmsReplyDraft(reserved, "Changed payload"), reserved)
  assert.deepEqual(contract!.settleSmsReplyDraft(reserved, "unknown"), reserved)
  assert.deepEqual(contract!.settleSmsReplyDraft(reserved, "failed"), reserved)
  assert.deepEqual(contract!.settleSmsReplyDraft(reserved, "accepted"), { body: "" })
  assert.deepEqual(contract!.editSmsReplyDraft(draft, "New text"), { body: "New text" })
})

test("SMS connection status uses number readiness instead of number presence", async () => {
  const { smsChannelStatus } = await import("../src/lib/mca/integrations/connection-status")
  const onboarding = { registrationState: "approved", reviewState: "approved", platformReady: true, optOutReady: true,
    numbers: [{ readiness: { ready: false, blockers: [{ code: "assignment_inactive", message: "Assign this number to an active employee." }] } }] }
  const blocked = smsChannelStatus({ onboarding })
  assert.equal(blocked.ready, false)
  assert.match(blocked.detail, /active employee/)
  const ready = smsChannelStatus({ onboarding: { ...onboarding, numbers: [{ readiness: { ready: true, blockers: [] } }] } })
  assert.equal(ready.ready, true)
})
