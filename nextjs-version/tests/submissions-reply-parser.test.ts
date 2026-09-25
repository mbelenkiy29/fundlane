import test from "node:test"
import assert from "node:assert/strict"
import { parseReplyDeterministically } from "../src/lib/mca/submissions/deterministic-reply-parser"
import { OpenAiReplyOutcomeClassifier } from "../src/lib/mca/submissions/extract-outcomes"

const base = { replyId: "reply-1", providerMessageId: "message-1", fromAddress: "underwriting@example.test", subject: "", body: "" }

test("labeled offer terms parse locally and unclear mail stays in manual review", () => {
  const offer = parseReplyDeterministically({ ...base, subject: "Offer", body: "Approved for $25,000. Factor rate 1.35. Term 10 months. Daily payment $120." })
  assert.equal(offer.classification, "approval")
  assert.equal(offer.amount.value, 25_000)
  assert.equal(offer.rate.value, 1.35)
  assert.equal(offer.term.value, 10)
  assert.equal(offer.paymentAmount?.value, 120)
  assert.equal(offer.frequency.value, "daily")
  const conditional = parseReplyDeterministically({ ...base, body: "Approved for $25,000. Please send the latest bank statement." })
  assert.equal(conditional.classification, "approval")
  assert.equal(conditional.stipulations.length, 1)
  const unclear = parseReplyDeterministically({ ...base, body: "Let's talk tomorrow about the file." })
  assert.equal(unclear.classification, "unparseable")
  assert.equal(unclear.amount.value, null)
})

test("declines and stip requests preserve the stated reason and requested items", () => {
  const decline = parseReplyDeterministically({ ...base, body: "Declined due to insufficient time in business." })
  assert.equal(decline.classification, "decline")
  assert.match(decline.declineReason?.value ?? "", /insufficient time in business/)
  const stip = parseReplyDeterministically({ ...base, body: "Please send the last three bank statements." })
  assert.equal(stip.classification, "pending")
  assert.match(stip.stipulations[0]?.text ?? "", /last three bank statements/)
})

test("AI extraction requests strict structured output and validates the mocked reply", async () => {
  const originalFetch = globalThis.fetch
  let calls = 0
  globalThis.fetch = (async (_url, init) => {
    calls += 1
    const request = JSON.parse(String(init?.body)) as { store: boolean; text: { format: { strict: boolean; schema: { required: string[] } } } }
    assert.equal(request.store, false)
    assert.equal(request.text.format.strict, true)
    assert.ok(request.text.format.schema.required.includes("paymentAmount"))
    assert.ok(request.text.format.schema.required.includes("declineReason"))
    const number = { value: null, unknown: true, evidence: null }
    const string = { value: null, unknown: true, evidence: null }
    const result = {
      classification: "decline", confidence: 0.9, amount: number, rate: number, term: number,
      paymentAmount: number, frequency: string, declineReason: { value: "Insufficient revenue", unknown: false, evidence: "Insufficient revenue" },
      commission: number, fees: [], offerLink: string, stipulations: [], summary: "Declined", warnings: [],
    }
    return new Response(JSON.stringify({ output_text: JSON.stringify(result) }), { status: 200 })
  }) as typeof fetch
  try {
    const result = await new OpenAiReplyOutcomeClassifier("fixture-key", "fixture-model", "https://example.test/mock").classify({ ...base, body: "Insufficient revenue" })
    assert.equal(result.classification, "decline")
    assert.equal(result.declineReason?.value, "Insufficient revenue")
    assert.equal(calls, 1)
  } finally { globalThis.fetch = originalFetch }
})
