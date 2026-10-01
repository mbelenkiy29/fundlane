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

test("known first-attempt rejection unlocks a draft while lost responses and uncertain retries retain the key", async () => {
  const contract = await import("../src/lib/mca/sms/reply-draft")
  assert.equal(typeof contract.rejectSmsReplyDraft, "function")
  const reserved = contract.reserveSmsReplyDraft({ body: "Application update" }, "reserved-key")
  assert.deepEqual(contract.rejectSmsReplyDraft(reserved, "sms_recipient_opted_out", false), { body: "Application update" })
  assert.deepEqual(contract.rejectSmsReplyDraft(reserved, "sms_recipient_opted_out", true), reserved)
  assert.deepEqual(contract.rejectSmsReplyDraft(reserved, undefined, false), reserved)
  assert.deepEqual(contract.rejectSmsReplyDraft(reserved, "idempotency_conflict", false), reserved)
})

test("changing inbox context during read acknowledgement cannot refresh the old deal's conversation list", async () => {
  const contract = await import("../src/lib/mca/sms/inbox-refresh").catch(() => null)
  assert.equal(typeof contract?.refreshSmsConversation, "function")
  let current = true
  let shownDetail = ""
  let threads = "new-deal"
  let release!: () => void
  let acknowledgeStarted!: () => void
  const pending = new Promise<void>(resolve => { release = resolve })
  const started = new Promise<void>(resolve => { acknowledgeStarted = resolve })
  const refresh = contract!.refreshSmsConversation({
    read: async () => "old-conversation",
    isCurrent: () => current,
    show: detail => { shownDetail = detail },
    acknowledge: async () => { acknowledgeStarted(); await pending },
    refreshList: async () => { threads = "old-deal" },
  })
  await started
  current = false
  shownDetail = ""
  release()
  await refresh
  assert.equal(shownDetail, "")
  assert.equal(threads, "new-deal")
})
