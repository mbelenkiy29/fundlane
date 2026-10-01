import test from "node:test"
import assert from "node:assert/strict"
import * as funnel from "../src/lib/mca/applications/funnel-session"
import type { ApplicationSession, InvitationFileView } from "../src/lib/mca/applications/contracts"
import { parseMoneyInput } from "../src/lib/mca/applications/form-schema"

const session: ApplicationSession = {
  provider: "fundlane", formId: "fundlane", clientName: "Test bakery", employeeName: "Test rep", contactEmail: "merchant@example.test",
  submitted: false, expiresAt: "2099-01-01T00:00:00Z", step: "legalName", answers: { legalName: "Unsaved bakery" }, files: [], requiredStatementMonths: 1,
  branding: { accent: null, welcomeTitle: "Welcome", welcomeBody: "Details", thankYouTitle: "Received", optionalFields: {} },
}
const file = (processingState: string, category: InvitationFileView["category"] = "statement"): InvitationFileView => ({ id: processingState, filename: "statement.pdf", processingState, category, byteLength: 10, createdAt: "2026-01-01" })

test("save failure prevents submission of stale answers", async () => {
  let submitted = false
  await assert.rejects(funnel.saveThenSubmit(session, async () => { throw new Error("offline") }, async () => { submitted = true; return session }), /offline/)
  assert.equal(submitted, false)
})

test("submission waits for the review draft to save", async () => {
  const calls: string[] = []
  const received = await funnel.saveThenSubmit(session, async (step, answers) => { calls.push(step); assert.equal(answers.legalName, "Unsaved bakery"); return session }, async () => { calls.push("submit"); return { ...session, submitted: true } })
  assert.deepEqual(calls, ["review", "submit"])
  assert.equal(received.submitted, true)
})

test("upload session keeps the unsaved draft and current step while refreshing files", () => {
  const result = funnel.mergeUploadedSession(session, { ...session, step: "welcome", answers: { legalName: "Older name" }, files: [file("ready")] })
  assert.equal(result.answers.legalName, "Unsaved bakery")
  assert.equal(result.step, "legalName")
  assert.equal(result.files.length, 1)
})

test("only ready scanned files enable progression and submission", () => {
  assert.ok(funnel.applicationFileError([file("pending_scan")], 1))
  assert.ok(funnel.applicationFileError([file("quarantined")], 1))
  assert.ok(funnel.applicationFileError([file("ready"), file("scan_failed", "voided_check")], 1))
  assert.ok(funnel.applicationFileError([file("ready"), file("unknown", "driver_license")], 1))
  assert.ok(funnel.applicationFileError([], 1))
  assert.equal(funnel.applicationFileError([file("ready"), file("clean")], 2), undefined)
})

test("money input retains zero and rejects nonnumeric values", () => {
  assert.equal(parseMoneyInput("0"), 0)
  assert.equal(parseMoneyInput("$1,234.50"), 1234.5)
  assert.equal(parseMoneyInput(""), undefined)
  assert.equal(parseMoneyInput("nope"), undefined)
  assert.equal(parseMoneyInput("Infinity"), undefined)
})
