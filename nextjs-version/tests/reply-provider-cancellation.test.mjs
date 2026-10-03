import test from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { stripTypeScriptTypes } from "node:module"
import vm from "node:vm"

class AppError extends Error { constructor(status, code, message) { super(message); Object.assign(this, { status, code }) } }
function executionFixture() {
  const controller = new AbortController()
  const context = vm.createContext({
    AppError, AbortController, AbortSignal, URLSearchParams, setTimeout, clearTimeout,
    executionSignal: () => controller.signal, executionRemainingMs: () => 20_000,
    assertExecutionActive: () => { if (controller.signal.aborted) throw new AppError(503, "execution_expired", "Synthetic expired slice") },
    outcomeJsonSchema: {},
  })
  return { controller, context }
}
function pendingResponse(signal) {
  return new Promise((_resolve, reject) => {
    if (signal.aborted) reject(new DOMException("Aborted", "AbortError"))
    else signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true })
  })
}

test("configured AI receives slice cancellation while reading the response body", { timeout: 1000 }, async () => {
  const f = executionFixture()
  const source = readFileSync(new URL("../src/lib/mca/submissions/extract-outcomes.ts", import.meta.url), "utf8")
  const classifier = source.slice(source.indexOf("export class OpenAiReplyOutcomeClassifier"), source.indexOf("let classifierOverride"))
  let observedSignal
  f.context.fetch = async (_url, init) => {
    observedSignal = init.signal
    return { ok: true, headers: new Headers(), json: () => pendingResponse(init.signal) }
  }
  vm.runInContext(stripTypeScriptTypes(classifier, { mode: "transform" }).replace(/^export /gm, ""), f.context)
  const Classifier = vm.runInContext("OpenAiReplyOutcomeClassifier", f.context)
  const pending = new Classifier("synthetic-key", "configured-model").call([])
  const rejected = assert.rejects(pending, error => error.code === "execution_expired")
  f.controller.abort()
  await rejected
  assert.equal(observedSignal.aborted, true)
})

test("OAuth token refresh shares the slice cancellation", { timeout: 1000 }, async () => {
  const f = executionFixture()
  const source = readFileSync(new URL("../src/lib/mca/senders/oauth.ts", import.meta.url), "utf8")
  const helper = source.slice(source.indexOf("async function oauthPost"), source.indexOf("function asCredential"))
  let observedSignal
  f.context.http = () => async (_url, init) => { observedSignal = init.signal; return pendingResponse(init.signal) }
  vm.runInContext(stripTypeScriptTypes(helper, { mode: "transform" }), f.context)
  const pending = f.context.oauthPost("https://oauth.example.test", new URLSearchParams())
  const rejected = assert.rejects(pending, error => error.code === "execution_expired")
  f.controller.abort()
  await rejected
  assert.equal(observedSignal.aborted, true)
})
