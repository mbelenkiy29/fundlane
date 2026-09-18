import assert from "node:assert/strict"
import { test } from "node:test"
import { createHmac, randomUUID } from "node:crypto"
import { verifyVerisysSignature, verifiedObjectScan } from "../src/lib/mca/documents/verisys"

test("scanner authenticates exact raw callback bytes", () => {
  const secret = "synthetic-verisys-secret-for-test", raw = Buffer.from('{"status":"clean"}')
  const digest = createHmac("sha256", secret).update(raw).digest()
  for (const signature of [digest.toString("hex"), digest.toString("base64")]) assert.doesNotThrow(() => verifyVerisysSignature(raw, signature, secret))
  assert.throws(() => verifyVerisysSignature(Buffer.from('{ "status":"clean"}'), digest.toString("hex"), secret))
  assert.throws(() => verifyVerisysSignature(raw, null, secret))
  assert.throws(() => verifyVerisysSignature(raw, digest.toString("hex"), ""))
})
test("only a clean verdict for the exact scan, content hash and length permits promotion", () => {
  const expected = { scanId: randomUUID(), sha256: "a".repeat(64), bytes: 123 }
  const result = { id: expected.scanId, scan_type: "malware", status: "clean", content_length: 123, content_type: "application/pdf", metadata: { hash_sha256: expected.sha256 }, created_at: new Date().toISOString() }
  assert.equal(verifiedObjectScan(result, expected).status, "clean")
  assert.equal(verifiedObjectScan({ ...result, status: "threat" }, expected).status, "infected")
  assert.equal(verifiedObjectScan({ ...result, status: "pending" }, expected).status, "pending")
  assert.equal(verifiedObjectScan({ ...result, content_length: 124 }, expected).status, "error")
  assert.equal(verifiedObjectScan({ ...result, metadata: null }, expected).status, "error")
  assert.equal(verifiedObjectScan({ ...result, status: "error" }, expected).status, "error")
  assert.throws(() => verifiedObjectScan({ ...result, id: randomUUID() }, expected))
  assert.throws(() => verifiedObjectScan({ ...result, status: "probably_clean" }, expected))
})
