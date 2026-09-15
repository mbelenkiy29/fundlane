import test from "node:test"
import assert from "node:assert/strict"
import { commitHistoricalPreview } from "../src/lib/mca/historical/commit-client"
import type { HistoricalImportPreview } from "../src/lib/mca/historical/contracts"

const preview = { runId: "saved-run", previewRevision: 1 } as HistoricalImportPreview

test("commit retries address the same saved run and include a bounded signal", async (t) => {
  const requests: string[] = []
  t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    requests.push(url)
    assert.equal(init.method, "POST")
    assert.deepEqual(JSON.parse(String(init.body)), { expectedPreviewRevision: 1 })
    assert.ok(init.signal instanceof AbortSignal)
    return Response.json({ state: "committed", created: 10 })
  })
  assert.equal((await commitHistoricalPreview(preview)).created, 10)
  await commitHistoricalPreview(preview)
  assert.deepEqual(requests, ["/api/mca/historical/saved-run/commit", "/api/mca/historical/saved-run/commit"])
})

test("timeout leaves the outcome unconfirmed and explains safe retry", async (t) => {
  t.mock.method(globalThis, "fetch", async () => { throw new DOMException("Expired", "TimeoutError") })
  await assert.rejects(commitHistoricalPreview(preview), /outcome is not yet confirmed.*Retry this preview/)
})
