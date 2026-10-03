import test from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { stripTypeScriptTypes } from "node:module"
import vm from "node:vm"

test("an expired manual writer cannot erase a reclaimed scheduler cursor or pending preview", async () => {
  const source = readFileSync(new URL("../src/lib/mca/submissions/replies.ts", import.meta.url), "utf8")
  const now = "2026-10-02T21:00:00.000Z"
  let row = { kind: "checkpoint", optedIn: true, cursor: "initial", scheduledClaimToken: "manual-old", scheduledLeaseUntil: "2099-01-01T00:00:00Z", claimMode: "manual" }
  let entered, release
  const started = new Promise(resolve => { entered = resolve })
  const gate = new Promise(resolve => { release = resolve })
  class AppError extends Error { constructor(status, code, message) { super(message); Object.assign(this, { status, code }) } }
  const context = vm.createContext({
    AppError, Date, process: { env: { MCA_FUNDER_REPLY_LIVE_INGEST_ENABLED: "true", MCA_FUNDER_REPLY_SCHEDULED_INGEST_ENABLED: "true" } },
    CHECKPOINT_PROVIDER_MESSAGE_ID: "mca:mailbox-checkpoint:v1", REPLY_INGEST_INTERVAL_MS: 900000, nowIso: () => now,
    db: () => ({ prepare: () => ({
      get: async (...values) => row.scheduledClaimToken === values.at(-1) && row.optedIn ? { claim_mode: row.claimMode } : undefined,
      run: async (...values) => { if (row.scheduledClaimToken !== values.at(-1) || !row.optedIn) return { changes: 0 }; row = JSON.parse(values[0]); return { changes: 1 } },
    }) }),
    activeMailbox: () => ({ async listMessages() { entered(); await gate; return { messages: [{ providerMessageId: "shared" }], nextCursor: "manual-completed-window" } } }),
    mailboxUnavailable: () => { throw new Error("Unexpected missing mailbox") },
    loadAnchors: async () => [], listFunders: async () => [], sanitizeMessage: message => message,
    correlate: () => ({ state: "matched", evidence: {}, matchedDealId: "deal", matchedJobId: "job" }),
    persistReply: async () => ({ created: false, reply: { id: "reclaimed-pending-preview", providerMessageId: "shared", state: "matched", evidence: { method: "message_id" } } }), audit: async () => {},
  })
  for (const [start, end] of [
    ["function encodeCheckpoint", "function decryptBody"],
    ["async function assertReplyClaim", "async function releaseReplyClaim"],
    ["async function saveClaimedCheckpoint", "/** Pending intent"],
    ["async function ingestSender", "async function senderHealth"],
  ]) {
    const startIndex = source.indexOf(start), endIndex = source.indexOf(end)
    assert.ok(startIndex >= 0 && endIndex > startIndex, `Missing source fixture bounds: ${start} -> ${end}`)
    vm.runInContext(stripTypeScriptTypes(source.slice(startIndex, endIndex), { mode: "transform" }), context)
  }
  const manual = context.ingestSender({ workspaceId: "synthetic" }, { workspaceId: "synthetic", id: "sender" }, { ...row }, { deadlineMs: Date.now() + 20000, messageLimit: 100 })
  await started
  // A crashed/expired manual lease is replaced while its old request completes.
  row = { ...row, cursor: "scheduler-next-page", scheduledClaimToken: "scheduler-new", claimMode: "scheduled", pendingReplyIds: ["reclaimed-pending-preview"] }
  const rejected = assert.rejects(manual, error => error.code === "reply_ingest_claim_lost")
  release()
  await rejected
  assert.equal(row.cursor, "scheduler-next-page")
  assert.equal(row.scheduledClaimToken, "scheduler-new")
  assert.deepEqual(row.pendingReplyIds, ["reclaimed-pending-preview"])
})
