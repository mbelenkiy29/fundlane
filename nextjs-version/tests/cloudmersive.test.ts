import assert from "node:assert/strict"
import { test } from "node:test"
import { CLOUDMERSIVE_MAX_SCAN_BYTES, CloudmersiveScanner, resetCloudmersiveThrottleForTests } from "../src/lib/mca/documents/cloudmersive"
import { documentScanner, scannerFailure, setDocumentScannerForTests } from "../src/lib/mca/documents/scanner"

test("documentScanner selects Cloudmersive and keeps unconfigured fail-closed", async () => {
  const originalMode = process.env.MCA_DOCUMENT_SCANNER
  const originalKey = process.env.MCA_CLOUDMERSIVE_API_KEY
  setDocumentScannerForTests()
  try {
    delete process.env.MCA_DOCUMENT_SCANNER
    delete process.env.MCA_CLOUDMERSIVE_API_KEY
    const unconfigured = documentScanner()
    assert.equal(unconfigured.name, "unconfigured")
    assert.equal((await unconfigured.scan(Buffer.from("a"), "a.txt")).status, "unavailable")

    process.env.MCA_DOCUMENT_SCANNER = "cloudmersive"
    delete process.env.MCA_CLOUDMERSIVE_API_KEY
    const withoutKey = documentScanner()
    assert.equal(withoutKey.name, "cloudmersive")
    assert.equal((await withoutKey.scan(Buffer.from("a"), "a.txt")).status, "unavailable")

    process.env.MCA_CLOUDMERSIVE_API_KEY = "synthetic-key"
    assert.equal(documentScanner().name, "cloudmersive")
  } finally {
    setDocumentScannerForTests()
    if (originalMode === undefined) delete process.env.MCA_DOCUMENT_SCANNER
    else process.env.MCA_DOCUMENT_SCANNER = originalMode
    if (originalKey === undefined) delete process.env.MCA_CLOUDMERSIVE_API_KEY
    else process.env.MCA_CLOUDMERSIVE_API_KEY = originalKey
  }
})

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
      resetCloudmersiveThrottleForTests()
      const result = await scanner.scan(Buffer.from("synthetic-content"), "test.txt")
      assert.equal(result.status, expected)
      if (result.status === "clean") {
        assert.equal(result.evidence.bytes, 17)
        assert.match(String(result.evidence.sha256), /^[a-f0-9]{64}$/)
      }
    }
    resetCloudmersiveThrottleForTests()
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

test("Cloudmersive refuses files over 3.5 MB before calling the provider", async () => {
  const originalFetch = globalThis.fetch
  const originalKey = process.env.MCA_CLOUDMERSIVE_API_KEY
  process.env.MCA_CLOUDMERSIVE_API_KEY = "synthetic-key"
  let calls = 0
  globalThis.fetch = async () => { calls++; return Response.json({ CleanResult: true, FoundViruses: [] }) }
  try {
    resetCloudmersiveThrottleForTests()
    const tooLarge = await new CloudmersiveScanner().scan(new Uint8Array(CLOUDMERSIVE_MAX_SCAN_BYTES + 1), "big.pdf")
    assert.equal(tooLarge.status, "error")
    assert.equal(tooLarge.evidence.reason, "file_too_large")
    assert.equal(tooLarge.evidence.message, "File too large for virus scan (max 3.5 MB)")
    assert.equal(calls, 0)
    const failure = scannerFailure(tooLarge.evidence, "retry later")
    assert.equal(failure.status, 413)
    assert.equal(failure.code, "scan_file_too_large")
    assert.equal(scannerFailure({ reason: "scanner_http_error" }, "retry later").status, 503)
    assert.equal((await new CloudmersiveScanner().scan(new Uint8Array(CLOUDMERSIVE_MAX_SCAN_BYTES), "limit.pdf")).status, "clean")
    assert.equal(calls, 1)
  } finally {
    globalThis.fetch = originalFetch
    if (originalKey === undefined) delete process.env.MCA_CLOUDMERSIVE_API_KEY
    else process.env.MCA_CLOUDMERSIVE_API_KEY = originalKey
  }
})

test("Cloudmersive spaces provider calls at least one second apart", async () => {
  const originalFetch = globalThis.fetch
  const originalKey = process.env.MCA_CLOUDMERSIVE_API_KEY
  process.env.MCA_CLOUDMERSIVE_API_KEY = "synthetic-key"
  const calledAt: number[] = []
  globalThis.fetch = async () => { calledAt.push(Date.now()); return Response.json({ CleanResult: true, FoundViruses: [] }) }
  try {
    resetCloudmersiveThrottleForTests()
    const scanner = new CloudmersiveScanner()
    await Promise.all([scanner.scan(Buffer.from("a"), "a"), scanner.scan(Buffer.from("b"), "b"), scanner.scan(Buffer.from("c"), "c")])
    assert.equal(calledAt.length, 3)
    calledAt.sort((a, b) => a - b)
    for (let i = 1; i < calledAt.length; i++) assert.ok(calledAt[i] - calledAt[i - 1] >= 990, `gap ${calledAt[i] - calledAt[i - 1]}ms`)
  } finally {
    globalThis.fetch = originalFetch
    if (originalKey === undefined) delete process.env.MCA_CLOUDMERSIVE_API_KEY
    else process.env.MCA_CLOUDMERSIVE_API_KEY = originalKey
  }
})
