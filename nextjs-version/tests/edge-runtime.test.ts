import assert from "node:assert/strict"
import { test } from "node:test"
import { randomBytes } from "node:crypto"
import * as nodeGcm from "../src/lib/mca/gcm-runtime"
import * as portableGcm from "../src/lib/mca/gcm-portable"
import { requireWorkerCredential } from "../src/lib/mca/jobs/edge-auth"
import { executionShouldStop, executionSignal, withExecutionDeadline } from "../src/lib/mca/jobs/execution"
import { decodeSse, messageText, nativeChatRequest } from "../src/lib/mca/assistant/native-contract"

test("Edge AES-GCM preserves the existing ciphertext format and authenticates workspace, tag and bytes", () => {
  const key = randomBytes(32), nonce = randomBytes(12), aad = Buffer.from("company-a")
  for (const text of ["", "synthetic merchant 🙂", "x".repeat(65536)]) {
    const plain = Buffer.from(text), native = nodeGcm.encryptGcm(key, nonce, aad, plain)
    const portable = portableGcm.encryptGcm(key, nonce, aad, plain)
    assert.deepEqual(Buffer.from(portable.ciphertext), native.ciphertext)
    assert.deepEqual(Buffer.from(portable.tag), native.tag)
    assert.deepEqual(Buffer.from(portableGcm.decryptGcm(key, nonce, aad, native.ciphertext, native.tag)), plain)
    assert.deepEqual(nodeGcm.decryptGcm(key, nonce, aad, portable.ciphertext, portable.tag), plain)
    assert.throws(() => portableGcm.decryptGcm(key, nonce, Buffer.from("company-b"), native.ciphertext, native.tag))
    const wrongTag = Buffer.from(native.tag); wrongTag[0] ^= 1
    assert.throws(() => portableGcm.decryptGcm(key, nonce, aad, native.ciphertext, wrongTag))
    if (plain.length) {
      const corrupt = Buffer.from(native.ciphertext); corrupt[0] ^= 1
      assert.throws(() => portableGcm.decryptGcm(key, nonce, aad, corrupt, native.tag))
    }
  }
})
test("worker endpoints reject public keys, missing configuration and incorrect methods", () => {
  const secret = randomBytes(32).toString("hex")
  const request = (token: string, method = "POST") => new Request("https://example.test/worker", { method, headers: { authorization: `Bearer ${token}` } })
  assert.doesNotThrow(() => requireWorkerCredential(request(secret), secret))
  for (const value of ["", "sb_publishable_example", secret.slice(1), "x".repeat(secret.length)]) assert.throws(() => requireWorkerCredential(request(value), secret))
  assert.throws(() => requireWorkerCredential(request(secret, "GET"), secret))
  assert.throws(() => requireWorkerCredential(request(secret), ""))
})
test("expired executions signal cancellation and cannot report success", async () => {
  assert.equal(executionShouldStop(), false)
  await assert.rejects(withExecutionDeadline(async () => {
    const signal = executionSignal()!
    await new Promise(resolve => signal.addEventListener("abort", resolve, { once: true }))
    assert.equal(executionShouldStop(), true)
    return "must not be reported as successful"
  }, undefined, 5), /expired/)
  assert.equal(executionSignal(), undefined)
})
test("native chat accepts only versioned read-only operations", () => {
  assert.throws(() => nativeChatRequest.parse({ version: 1, type: "send_email", params: {} }))
  assert.throws(() => nativeChatRequest.parse({ type: "threads.list", params: {} }))
  assert.throws(() => nativeChatRequest.parse({ version: 1, type: "threads.list", params: { workspaceId: "other" } }))
  assert.equal(messageText({ content: [{ type: "output_text", text: "Legacy" }, { type: "text", text: "history" }] }), "Legacy\nhistory")
  assert.equal(messageText({ version: 1, text: "New history" }), "New history")
})
test("SSE decoder handles fragmented UTF-8 and rejects truncated or oversized events", async () => {
  const bytes = new TextEncoder().encode('data: {"text":"🙂"}\r\n\r\ndata: {"type":"complete"}\n\n')
  const body = new ReadableStream<Uint8Array>({ start(c) { for (const byte of bytes) c.enqueue(new Uint8Array([byte])); c.close() } })
  const events = []; for await (const event of decodeSse(body)) events.push(event)
  assert.deepEqual(events, [{ text: "🙂" }, { type: "complete" }])
  const consume = async (text: string, max = 256000) => { for await (const event of decodeSse(new Response(text).body!, max)) void event }
  await assert.rejects(consume('data: {"text":"unfinished"}'), /incomplete/)
  await assert.rejects(consume('data: {"text":"too long"}\n\n', 5), /limit/)
})
