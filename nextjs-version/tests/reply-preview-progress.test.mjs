import test from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { stripTypeScriptTypes } from "node:module"
import vm from "node:vm"

function previewFixture(count = 2) {
  const source = readFileSync(new URL("../src/lib/mca/submissions/replies.ts", import.meta.url), "utf8")
  const sender = { workspaceId: "synthetic", id: "sender", purpose: "submission", state: "verified" }
  let checkpoint = { optedIn: true, cursor: "before", scheduledClaimToken: "manual", scheduledLeaseUntil: "2099-01-01T00:00:00Z", claimMode: "manual", pendingReplyIds: ["denied", "eligible"] }
  const rows = Array.from({ length: count }, (_, i) => ({ id: i === 0 ? "denied" : i === 1 ? "eligible" : `denied-${i}`, evidence: { automaticExtractionPending: true } }))
  const audits = [], extracted = []
  let mailboxCalls = 0
  class AppError extends Error { constructor(status, code, message) { super(message); Object.assign(this, { status, code }) } }
  const database = { prepare: sql => ({
    all: async () => rows.filter(row => row.evidence.automaticExtractionPending && !row.evidence.extraction)
      .sort((a, b) => (a.evidence.automaticExtractionAttemptAt ?? "").localeCompare(b.evidence.automaticExtractionAttemptAt ?? ""))
      .slice(0, 2).map(row => ({ id: row.id })),
    get: async (...values) => checkpoint.scheduledClaimToken === values.at(-1) && checkpoint.optedIn ? { claim_mode: "manual" } : undefined,
    run: async (...values) => {
      if (sql.includes("SET match_evidence=?")) checkpoint = JSON.parse(values[0])
      else if (sql.includes("|| ?::jsonb")) Object.assign(rows.find(row => row.id === values[3]).evidence, JSON.parse(values[0]))
      return { changes: 1 }
    },
  }) }
  const context = vm.createContext({
    AppError, Date, process: { env: {} }, CHECKPOINT_PROVIDER_MESSAGE_ID: "mca:mailbox-checkpoint:v1", REPLY_INGEST_INTERVAL_MS: 900000, SCHEDULED_INGEST_SLICE_MS: 25000,
    db: () => database, nowIso: () => new Date().toISOString(), withTransaction: async run => run(database),
    assertExecutionActive: () => {}, executionSignal: () => undefined, withExecutionDeadline: async run => run(),
    audit: async (_actor, _action, id, evidence) => { audits.push({ id, ...evidence }) },
    extractionModule: {
      getReplyExtraction: async (actor, id) => { if (id !== "eligible" && actor.role !== "admin") throw new AppError(404, "deal_not_found", "Inaccessible deal"); return { extraction: rows.find(row => row.id === id).evidence.extraction } },
      previewReplyExtraction: async (_actor, { replyId }, beforeClassify, beforePersist) => { await beforeClassify?.(); await beforePersist?.(); extracted.push(replyId); rows.find(row => row.id === replyId).evidence.extraction = { preview: true } },
    },
    companyModule: { assertCompanyOperational: async () => {} },
    asEnabled: value => value, asSenderId: value => value, assertSubmissionSender: value => value,
    listSendersByWorkspace: async () => [sender], findSenderById: async () => sender, loadCheckpoint: async () => checkpoint,
    replyMailboxMode: () => "fixture", senderHealth: async () => [],
    claimReplySender: async () => ({ sender, checkpoint: { ...checkpoint } }), releaseReplyClaim: async () => {},
    ingestSender: async (_actor, _sender, current) => { mailboxCalls++; return { ingested: [], checkpoint: current } },
  })
  for (const [start, end] of [
    ["function encodeCheckpoint", "function decryptBody"],
    ["async function assertReplyClaim", "async function releaseReplyClaim"],
    ["async function saveClaimedCheckpoint", "/** Pending intent"],
    ["async function updateReplyExtractionMarker", "function healthFor"],
    ["export async function runReplyIngest", "const SCHEDULED_INGEST_MIN_BUDGET_MS"],
  ]) {
    const startIndex = source.indexOf(start), endIndex = source.indexOf(end)
    assert.ok(startIndex >= 0 && endIndex > startIndex, `Missing source fixture bounds: ${start} -> ${end}`)
    const excerpt = source.slice(startIndex, endIndex)
      .replaceAll('await import("./extract-outcomes")', "extractionModule").replaceAll('await import("../company-access")', "companyModule")
    vm.runInContext(stripTypeScriptTypes(excerpt, { mode: "transform" }).replace(/^export /gm, ""), context)
  }
  return { context, sender, rows, audits, extracted, checkpoint: () => checkpoint, mailboxCalls: () => mailboxCalls }
}

test("a broker's inaccessible preview stays durable while later previews and inbox polling progress", async () => {
  const f = previewFixture(), broker = { workspaceId: "synthetic", role: "rep" }
  await f.context.runReplyIngest(broker, { senderId: "sender" })
  await f.context.runReplyIngest(broker, { senderId: "sender" })
  assert.equal(f.mailboxCalls(), 2)
  assert.deepEqual(f.extracted, ["eligible"])
  assert.ok(f.audits.every(event => event.code === "deal_not_found"))
  assert.equal(f.rows[0].evidence.automaticExtractionPending, true)
  await f.context.runReplyIngest({ workspaceId: "synthetic", role: "admin" }, { senderId: "sender" })
  assert.deepEqual(f.extracted, ["eligible", "denied"])
  assert.equal(f.rows[0].evidence.automaticExtractionPending, false)
})

test("failed preview backlog is bounded per pass without truncating durable reply intent", async () => {
  const f = previewFixture(100)
  await f.context.drainReplyExtractions({ workspaceId: "synthetic", role: "rep" }, f.sender, f.checkpoint(), Date.now() + 20_000)
  assert.equal(f.audits.length + f.extracted.length, 2)
  assert.equal(f.rows.filter(row => row.evidence.automaticExtractionPending).length, 99)
  assert.ok(f.checkpoint().pendingReplyIds.length <= 2)
})

test("an interrupted preview rotates before IO and a stale owner cannot mutate durable markers", async () => {
  const f = previewFixture(4), actor = { workspaceId: "synthetic", role: "admin" }
  f.context.extractionModule.previewReplyExtraction = async () => { throw new f.context.AppError(503, "execution_expired", "Interrupted") }
  await f.context.drainReplyExtractions(actor, f.sender, f.checkpoint(), Date.now() + 20_000)
  assert.ok(f.rows[0].evidence.automaticExtractionAttemptAt)
  assert.equal(f.rows[0].evidence.automaticExtractionPending, true)
  f.context.extractionModule.previewReplyExtraction = async (_actor, { replyId }) => { f.extracted.push(replyId); f.rows.find(row => row.id === replyId).evidence.extraction = { preview: true } }
  await f.context.drainReplyExtractions(actor, f.sender, f.checkpoint(), Date.now() + 20_000)
  assert.deepEqual(f.extracted, ["eligible", "denied-2"])
  f.checkpoint().scheduledClaimToken = "new-owner"
  await assert.rejects(f.context.updateReplyExtractionMarker(f.sender, "manual", "denied", { automaticExtractionPending: false }), error => error.code === "reply_ingest_claim_lost")
  assert.equal(f.rows[0].evidence.automaticExtractionPending, true)
})

test("automatic preview rechecks its claim inside the persistence transaction after classification", async () => {
  const source = readFileSync(new URL("../src/lib/mca/submissions/extract-outcomes.ts", import.meta.url), "utf8")
  const start = source.indexOf("async function runExtract"), end = source.indexOf("export async function previewReplyExtraction")
  assert.ok(start >= 0 && end > start)
  let active = true, transactionStarted = false, replyLocked = false, written = false
  const reply = { id: "reply", matchedDealId: "deal", matchedJobId: "job" }
  const row = { match_evidence: "{}", matched_deal_id: "deal", matched_job_id: "job" }
  const context = vm.createContext({
    AppError: class extends Error {}, getReply: async () => reply, getDealForDocument: async () => {}, loadReplyRow: async () => row,
    extractionFromEvidence: () => undefined,
    classifyReply: async () => { active = false; return {} }, normalizeClassified: () => ({}),
    withImmediateTransaction: async run => { transactionStarted = true; return run() },
    db: () => ({ prepare: () => ({ get: async () => { replyLocked = true } }) }),
    writeSnapshot: async () => { written = true },
  })
  vm.runInContext(stripTypeScriptTypes(source.slice(start, end), { mode: "transform" }), context)
  await assert.rejects(context.runExtract({ workspaceId: "synthetic" }, "reply", {
    preview: true, beforeClassify: async () => { assert.ok(active) },
    beforePersist: async () => { assert.ok(transactionStarted); if (!active) throw new Error("claim revoked") },
  }), /claim revoked/)
  assert.equal(replyLocked, false, "checkpoint fence precedes reply lock to preserve lock ordering")
  assert.equal(written, false)
})

test("automatic preview preserves a broker snapshot or ignored state written while classification is in flight", async () => {
  const source = readFileSync(new URL("../src/lib/mca/submissions/extract-outcomes.ts", import.meta.url), "utf8")
  const start = source.indexOf("async function runExtract"), end = source.indexOf("export async function previewReplyExtraction")
  assert.ok(start >= 0 && end > start)
  for (const current of [
    { state: "matched", extraction: { preview: false, corrected: true, committedAt: "broker-confirmed" } },
    { state: "ignored", extraction: undefined },
  ]) {
    let loads = 0, writes = 0
    const reply = { id: "reply", matchedDealId: "deal", matchedJobId: "job" }
    const base = { matched_deal_id: "deal", matched_job_id: "job" }
    const existingView = { replyState: current.state, extraction: current.extraction }
    const context = vm.createContext({
      AppError: class extends Error {}, getReply: async () => reply, getDealForDocument: async () => {},
      loadReplyRow: async () => ++loads === 1 ? { ...base, match_evidence: "{}", state: "matched" } : { ...base, match_evidence: JSON.stringify({ extraction: current.extraction }), state: current.state },
      extractionFromEvidence: value => JSON.parse(value).extraction,
      classifyReply: async () => ({}), normalizeClassified: () => ({}),
      withImmediateTransaction: async run => run(), db: () => ({ prepare: () => ({ get: async () => ({ id: "reply" }) }) }),
      getReplyExtraction: async () => existingView, writeSnapshot: async () => { writes++ },
    })
    vm.runInContext(stripTypeScriptTypes(source.slice(start, end), { mode: "transform" }), context)
    assert.equal(await context.runExtract({ workspaceId: "synthetic" }, "reply", { preview: true, beforePersist: async () => {} }), existingView)
    assert.equal(writes, 0)
  }
})
