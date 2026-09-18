import assert from "node:assert/strict"
import { test } from "node:test"
import { CloudmersiveScanner } from "../src/lib/mca/documents/cloudmersive"

test("Cloudmersive binds clean receipts to exact bytes and fails closed", async () => {
  const originalFetch = globalThis.fetch
  const originalKey = process.env.MCA_CLOUDMERSIVE_API_KEY
  process.env.MCA_CLOUDMERSIVE_API_KEY = "synthetic-key"
  const scanner = new CloudmersiveScanner()
  try {
    for (const [status, payload, expected] of [
      [200, { CleanResult: true, FoundViruses: [] }, "clean"],
      [200, { CleanResult: false, FoundViruses: [{ FileName: "test", VirusName: "EICAR" }] }, "infected"],
      [200, { CleanResult: true, FoundViruses: [{ FileName: "test", VirusName: "EICAR" }] }, "error"],
      [200, { CleanResult: "true" }, "error"],
      [401, {}, "unavailable"], [403, {}, "unavailable"], [429, {}, "unavailable"], [503, {}, "unavailable"],
    ] as const) {
      globalThis.fetch = async (url, init) => {
        assert.equal(url, "https://api.cloudmersive.com/virus/scan/file")
        assert.equal(init?.redirect, "error")
        assert.ok(init?.body instanceof FormData)
        const file = init.body.get("inputFile") as File
        assert.equal(await file.text(), "synthetic-content")
        return Response.json(payload, { status })
      }
      const result = await scanner.scan(Buffer.from("synthetic-content"), "test.txt")
      assert.equal(result.status, expected)
      if (result.status === "clean") {
        assert.equal(result.evidence.bytes, 17)
        assert.match(String(result.evidence.sha256), /^[a-f0-9]{64}$/)
      }
    }
    globalThis.fetch = async () => { throw new Error("sensitive provider detail") }
    assert.equal((await scanner.scan(Buffer.from("a"), "a")).status, "error")
    delete process.env.MCA_CLOUDMERSIVE_API_KEY
    assert.equal((await scanner.scan(Buffer.from("a"), "a")).status, "unavailable")
  } finally {
    globalThis.fetch = originalFetch
    if (originalKey === undefined) delete process.env.MCA_CLOUDMERSIVE_API_KEY
    else process.env.MCA_CLOUDMERSIVE_API_KEY = originalKey
  }
})
