import test from "node:test"
import assert from "node:assert/strict"
import { uploadMultipart } from "../src/components/mca/documents/upload"
import { parseHistoricalPreview } from "../src/lib/mca/historical/preview-client"
import { parseHistoricalSpreadsheet } from "../src/lib/mca/historical/parser"

class FakeRequest extends EventTarget {
  static latest: FakeRequest
  upload = new EventTarget()
  timeout = 0
  status = 0
  responseText = ""
  aborted = false
  sent = false
  constructor() { super(); FakeRequest.latest = this }
  open() {}
  send() { this.sent = true }
  abort() { this.aborted = true; this.dispatchEvent(new Event("abort")) }
  respond(status: number, text: string) { this.status = status; this.responseText = text; this.dispatchEvent(new Event("load")) }
}

const csv = (rows: number) => Buffer.from("external_id,legal_name,funder_name,funded_at,amount_cents\n" + Array.from({ length: rows }, (_, index) => `id-${index},Merchant ${index},Funder,2025-01-01,10000`).join("\n"))

for (const rows of [1, 99]) test(`historical parser accepts ${rows} rows with all optional columns omitted`, () => {
  const parsed = parseHistoricalSpreadsheet({ filename: "test.csv", bytes: csv(rows) })
  assert.equal(parsed.length, rows)
  assert.equal(parsed[0].commissionCents, undefined)
  assert.equal(parsed[0].factorRate, undefined)
  assert.equal(parsed.at(-1)?.externalId, `id-${rows - 1}`)
})

test("historical parser reports missing columns and malformed cents", () => {
  assert.throws(() => parseHistoricalSpreadsheet({ filename: "test.csv", bytes: Buffer.from("legal_name,funder_name\nExample,Funder") }), /Missing required column: external_id/)
  assert.throws(() => parseHistoricalSpreadsheet({ filename: "test.csv", bytes: Buffer.from(csv(1).toString().replace("10000", "1.5")) }), /Row 2: amount_cents must contain whole cents/)
})

test("upload handles progress, timeout, cancellation, late responses and invalid responses", async (t) => {
  const original = Object.getOwnPropertyDescriptor(globalThis, "XMLHttpRequest")
  Object.defineProperty(globalThis, "XMLHttpRequest", { configurable: true, writable: true, value: FakeRequest })
  t.after(() => {
    if (original) Object.defineProperty(globalThis, "XMLHttpRequest", original)
    else Reflect.deleteProperty(globalThis, "XMLHttpRequest")
  })
  const progress: number[] = []
  const pending = uploadMultipart("/preview", new FormData(), (percent) => progress.push(percent), { timeoutMs: 60_000 })
  const xhr = FakeRequest.latest
  assert.equal(xhr.timeout, 60_000)
  const event = new Event("progress")
  Object.assign(event, { loaded: 5, total: 10, lengthComputable: true })
  xhr.upload.dispatchEvent(event)
  xhr.upload.dispatchEvent(new Event("load"))
  assert.deepEqual(progress, [50, 100])
  const timedOut = assert.rejects(pending, /timed out.*same file, source and batch/)
  xhr.dispatchEvent(new Event("timeout"))
  await timedOut
  xhr.respond(201, '{"late":true}')
  xhr.upload.dispatchEvent(new Event("load"))
  assert.deepEqual(progress, [50, 100])

  const controller = new AbortController()
  const cancelled = uploadMultipart("/preview", new FormData(), () => {}, { signal: controller.signal })
  const cancellation = assert.rejects(cancelled, /interrupted/)
  const closedRequest = FakeRequest.latest
  controller.abort()
  await cancellation
  assert.equal(closedRequest.aborted, true)
  closedRequest.respond(201, '{"late":true}')

  const neverSent = uploadMultipart("/preview", new FormData(), () => {}, { signal: controller.signal })
  await assert.rejects(neverSent, /interrupted/)
  assert.equal(FakeRequest.latest.sent, false)

  for (const [status, body, message] of [[201, "<html>sign in</html>", /invalid response/], [422, '{"error":{"message":"Bad CSV"}}', /Bad CSV/]] as const) {
    const request = uploadMultipart("/preview", new FormData(), () => {})
    assert.equal(FakeRequest.latest.timeout, 0)
    FakeRequest.latest.respond(status, body)
    await assert.rejects(request, message)
  }
  const network = uploadMultipart("/preview", new FormData(), () => {})
  FakeRequest.latest.dispatchEvent(new Event("error"))
  await assert.rejects(network, /interrupted/)
  const retry = uploadMultipart("/preview", new FormData(), () => {})
  FakeRequest.latest.respond(201, '{"runId":"recovered"}')
  assert.deepEqual(await retry, { runId: "recovered" })
})

test("preview response validation rejects malformed success payloads", () => {
  for (const payload of [null, {}, { rows: [] }, { runId: "x", rows: "bad" }]) assert.throws(() => parseHistoricalPreview(payload), /invalid preview/)
  const preview = { runId: "run", state: "preview", previewRevision: 1, rows: [], totals: { rows: 0, valid: 0, invalid: 0, duplicates: 0, principalCents: 0, expectedCommissionCents: 0, paidCommissionCents: 0, feeCents: 0 } }
  assert.deepEqual(parseHistoricalPreview(preview), preview)
})
