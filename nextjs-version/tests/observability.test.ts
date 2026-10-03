import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import test from "node:test"
import { RequestError } from "../src/lib/mca/client"
import { identifyServerUser, registerReporter, reportException, type ReportContext, type ServerIdentity } from "../src/lib/observability/bridge"
import { markCaughtError } from "../src/lib/observability/caught-errors"
import { replayAllowedPath, scrubBreadcrumb, scrubEvent, scrubLog, scrubRecordingEvent, scrubSpan, scrubUrl, scrubUrlsInText } from "../src/lib/observability/scrub"
import { FEEDBACK_FORMS, FEEDBACK_KINDS, feedbackButtonOffset } from "../src/lib/observability/feedback-forms"
import { DATA_COLLECTION, SENTRY_TUNNEL_ROUTE, sampleRate } from "../src/lib/observability/sentry-options"

function fakeReporter() {
  const captured: Array<{ error: unknown; context: ReportContext }> = []
  const identities: ServerIdentity[] = []
  registerReporter({ captureException: (error, context) => { captured.push({ error, context }) }, identify: (identity) => { identities.push(identity) } })
  return { captured, identities }
}

test("scrubUrl removes token segments, query values, fragments and credentials", () => {
  assert.equal(scrubUrl("https://app.example/merchant-upload/abc123?x=1#access_token=secret"), "https://app.example/merchant-upload/[token]?x=[Filtered]")
  assert.equal(scrubUrl("/apply/r/tok_9?mca_rep=55&flag"), "/apply/r/[token]?mca_rep=[Filtered]&flag")
  assert.equal(scrubUrl("/review/opaque-token"), "/review/[token]")
  assert.equal(scrubUrl("/api/mca/underwriting/review/t1"), "/api/mca/underwriting/review/[token]")
  assert.equal(scrubUrl("/api/mca/documents/download/t2"), "/api/mca/documents/download/[token]")
  assert.equal(scrubUrl("/api/mca/exports/download/t3"), "/api/mca/exports/download/[token]")
  assert.equal(scrubUrl("/api/mca/closing/artifacts/t4"), "/api/mca/closing/artifacts/[token]")
  assert.equal(scrubUrl("/api/mca/closing/merchant-upload/t5"), "/api/mca/closing/merchant-upload/[token]")
  assert.equal(scrubUrl("/api/public/apply/t6/submit"), "/api/public/apply/[token]/submit")
  assert.equal(scrubUrl("/accept-invite?token=abc"), "/accept-invite?token=[Filtered]")
  assert.equal(scrubUrl("postgres://user:pw@db.example/x"), "postgres://db.example/x")
  assert.equal(scrubUrl("/pipeline/deals/123"), "/pipeline/deals/123")
  assert.equal(scrubUrl("/apply/form-1"), "/apply/form-1")
  assert.equal(scrubUrlsInText("GET /review/abc?x=1"), "GET /review/[token]?x=[Filtered]")
})

test("scrubEvent redacts messages, request data, headers, paths and breadcrumbs", () => {
  const event = scrubEvent({
    message: "failed for owner@example.com",
    exception: { values: [{ value: "account 1234567890 rejected" }, { value: "cause for a@b.co" }] },
    transaction: "GET /merchant-upload/abc",
    request: {
      url: "https://app.example/review/tok?q=Acme",
      headers: { Cookie: "sb=1", Authorization: "Bearer x", "User-Agent": "UA", "x-request-id": "r1" },
      cookies: { sb: "1" },
      data: { ein: "12-3456789" },
      query_string: "q=Acme",
    },
    contexts: { nextjs: { request_path: "/apply/r/tok?x=1" }, feedback: { url: "https://app.example/settings?tab=team" } },
    tags: { url: "/merchant-upload/abc", workspace_id: "w1" },
    user: { id: "u1", email: "rep@example.com", ip_address: "1.2.3.4" },
    breadcrumbs: [
      { category: "console", level: "log", message: "Form submitted: {ein: 12-3456789}" },
      { category: "console", level: "warning", message: "warn owner@example.com", data: { arguments: ["owner@example.com"] } },
      { category: "fetch", data: { url: "/api/mca/documents/download/tok?sig=1" } },
      { category: "navigation", data: { from: "/review/a", to: "/pipeline?deal=1" } },
    ],
  })
  assert.ok(event)
  assert.doesNotMatch(event.message!, /owner@example\.com/)
  assert.doesNotMatch(event.exception!.values![0].value!, /1234567890/)
  assert.doesNotMatch(event.exception!.values![1].value!, /a@b\.co/)
  assert.equal(event.transaction, "GET /merchant-upload/[token]")
  assert.equal(event.request!.url, "https://app.example/review/[token]?q=[Filtered]")
  assert.deepEqual(event.request!.headers, { "User-Agent": "UA", "x-request-id": "r1" })
  assert.equal(event.request!.cookies, undefined)
  assert.equal(event.request!.data, undefined)
  assert.equal(event.request!.query_string, undefined)
  assert.equal(event.contexts!.nextjs!.request_path, "/apply/r/[token]?x=[Filtered]")
  assert.equal(event.contexts!.feedback!.url, "https://app.example/settings?tab=[Filtered]")
  assert.equal(event.tags!.url, "/merchant-upload/[token]")
  assert.equal(event.tags!.workspace_id, "w1")
  assert.deepEqual(event.user, { id: "u1", email: "rep@example.com" })
  assert.equal(event.breadcrumbs!.length, 3)
  assert.doesNotMatch(JSON.stringify(event.breadcrumbs), /owner@example|12-3456789|tok\?|sig=1|\/review\/a|deal=1/)
})

test("scrubEvent drops expected 4xx RequestErrors but keeps server failures", () => {
  assert.equal(scrubEvent({}, { originalException: new RequestError(400, "Invalid") }), null)
  assert.equal(scrubEvent({}, { originalException: new RequestError(403, "Forbidden") }), null)
  assert.ok(scrubEvent({}, { originalException: new RequestError(500, "Boom") }))
  assert.ok(scrubEvent({}, { originalException: new Error("Boom") }))
})

test("scrubEvent drops fetch failures re-raised by a browser extension's fetch wrapper (FUNDLANE-1, FUNDLANE-2)", () => {
  const unhandled = { type: "auto.browser.global_handlers.onunhandledrejection", handled: false }
  const event = () => ({ exception: { values: [{ type: "TypeError", value: "Failed to fetch", mechanism: { ...unhandled } }] } })
  const networkError = (message: string, stack: string) => Object.assign(new TypeError(message), { stack: `TypeError: ${message}\n${stack}` })
  // Our poller caught the failure; the extension leaked the same error object.
  const caughtError = (message: string, stack: string) => { const error = networkError(message, stack); markCaughtError(error); return error }
  // Production stack: Similarweb's frame_ant.js wraps window.fetch and leaks the rejection our poller already caught.
  const similarweb = "    at o (chrome-extension://hoklmmgfnpapgjgcpechhaamimifchmp/frame_ant/frame_ant.js:2:14445)\n    at window.fetch (chrome-extension://hoklmmgfnpapgjgcpechhaamimifchmp/frame_ant/frame_ant.js:2:14510)\n    at requestJson (https://fundlane.io/_next/static/chunks/app.js:16:26)"
  const firstParty = "    at requestJson (https://fundlane.io/_next/static/chunks/app.js:16:26)"
  assert.equal(scrubEvent(event(), { originalException: caughtError("Failed to fetch", similarweb) }), null)
  assert.equal(scrubEvent(event(), { originalException: caughtError("Failed to fetch (fundlane.io)", similarweb) }), null)
  assert.equal(scrubEvent(event(), { originalException: caughtError("Load failed", "fetch@safari-web-extension://abc/content.js:1:2") }), null)
  assert.equal(scrubEvent(event(), { originalException: caughtError("Load failed", "fetch@safari-extension://com.example.ext/abc/content.js:1:2") }), null)
  assert.equal(scrubEvent(event(), { originalException: caughtError("NetworkError when attempting to fetch resource.", "fetch@moz-extension://abc/content.js:1:2") }), null)
  // Everything else is still reported.
  assert.ok(scrubEvent(event(), { originalException: caughtError("Failed to fetch", firstParty) }), "a caught fetch failure without an extension frame is kept")
  assert.ok(scrubEvent(event(), { originalException: caughtError("Cannot read properties of undefined", similarweb) }), "a real TypeError is kept")
  assert.ok(scrubEvent(event(), { originalException: Object.assign(new Error("Failed to fetch"), { stack: similarweb }) }), "a non-TypeError is kept")
  const handled = { exception: { values: [{ type: "TypeError", value: "Failed to fetch", mechanism: { type: "generic", handled: true } }] } }
  assert.ok(scrubEvent(handled, { originalException: caughtError("Failed to fetch", similarweb) }), "an explicitly captured failure is kept")
  assert.ok(scrubEvent(event(), { originalException: new RequestError(502, "Bad gateway") }), "server failures are kept")
})

test("an uncaught first-party fetch failure is kept even when an extension wraps fetch", () => {
  const event = () => ({ exception: { values: [{ type: "TypeError", value: "Failed to fetch (fundlane.io)", mechanism: { type: "auto.browser.global_handlers.onunhandledrejection", handled: false } }] } })
  const wrapped = "TypeError: Failed to fetch (fundlane.io)\n    at window.fetch (chrome-extension://hoklmmgfnpapgjgcpechhaamimifchmp/frame_ant/frame_ant.js:2:14510)\n    at loadDeals (https://fundlane.io/_next/static/chunks/app.js:20:4)"
  const uncaught = Object.assign(new TypeError("Failed to fetch (fundlane.io)"), { stack: wrapped })
  assert.ok(scrubEvent(event(), { originalException: uncaught }), "nothing of ours caught it, so it is reported")
  const safari = Object.assign(new TypeError("Load failed"), { stack: "fetch@safari-extension://com.example.ext/abc/content.js:1:2\nloadDeals@https://fundlane.io/_next/static/chunks/app.js:20:4" })
  assert.ok(scrubEvent(event(), { originalException: safari }), "an uncaught failure through a safari-extension:// wrapper is reported")
  // Once our helper catches the same error object, the extension's leaked copy is dropped.
  markCaughtError(uncaught)
  markCaughtError(safari)
  assert.equal(scrubEvent(event(), { originalException: uncaught }), null)
  assert.equal(scrubEvent(event(), { originalException: safari }), null)
})

test("the FUNDLANE-1/2 pollers mark the fetch failures they handle", () => {
  const bell = readFileSync(resolve("src/components/mca/assistant/notification-bell.tsx"), "utf8")
  assert.equal(bell.match(/markCaughtError\(caught\)/g)?.length, 4)
  assert.doesNotMatch(bell, /catch\s*\{|\.catch\(\(\)\s*=>/, "every notification-bell catch marks its error")
  const voice = readFileSync(resolve("src/components/mca/voice/voice-provider.tsx"), "utf8")
  assert.match(voice, /async function load\(\)\{try\{[^\n]*\/api\/mca\/voice\/readiness[^\n]*\}catch\(caught\)\{markCaughtError\(caught\);/)
})

test("scrubEvent scrubs replay event URLs", () => {
  const event = scrubEvent({ type: "replay_event", urls: ["https://app.example/pipeline?deal=1", "/merchant-upload/abc"] })
  assert.deepEqual(event!.urls, ["https://app.example/pipeline?deal=[Filtered]", "/merchant-upload/[token]"])
})

test("scrubBreadcrumb keeps console warnings and errors only", () => {
  assert.equal(scrubBreadcrumb({ category: "console", level: "info", message: "x" }), null)
  assert.equal(scrubBreadcrumb({ category: "console", message: "x" }), null)
  assert.ok(scrubBreadcrumb({ category: "console", level: "error", message: "x" }))
  assert.equal(scrubBreadcrumb({ category: "ui.click", message: "button.save" })!.message, "button.save")
})

test("scrubLog keeps UUIDs readable, drops Node deprecation notices", () => {
  const id = "fc77836e-1234-5678-9012-3a40b1adf7ff"
  const log = scrubLog({ message: JSON.stringify({ event: "operational_error", id, account: "123456789012" }) })
  assert.match(String(log!.message), new RegExp(id))
  assert.doesNotMatch(String(log!.message), /123456789012/)
  assert.equal(scrubLog({ message: "(node:18346) [DEP0060] DeprecationWarning: The `util._extend` API is deprecated." }), null)
})

test("scrubLog redacts messages and attributes but keeps SDK metadata", () => {
  const log = scrubLog({
    message: JSON.stringify({ event: "operational_error", email: "owner@example.com" }),
    attributes: { "sentry.release": "abc", "url.full": "https://app.example/review/tok?x=1", note: { value: "card 4111 1111 1111 1111", type: "string" } },
  })
  assert.doesNotMatch(String(log!.message), /owner@example\.com/)
  assert.equal(log!.attributes!["sentry.release"], "abc")
  assert.equal(log!.attributes!["url.full"], "https://app.example/review/[token]?x=[Filtered]")
  assert.doesNotMatch(JSON.stringify(log!.attributes!.note), /4111/)
})

test("scrubSpan removes headers and AI payloads and scrubs URLs", () => {
  const span = scrubSpan({
    name: "GET /merchant-upload/abc",
    attributes: {
      "http.request.header.authorization": "Bearer x",
      "http.response.header.set_cookie": "a=b",
      "gen_ai.input.messages": "[merchant data]",
      "url.full": { value: "https://api.example/v1?key=secret", type: "string" },
      "http.route": "/review/[token]",
      "db.system": "postgresql",
    },
  })
  assert.equal(span.name, "GET /merchant-upload/[token]")
  assert.deepEqual(Object.keys(span.attributes!).sort(), ["db.system", "http.route", "url.full"])
  assert.deepEqual(span.attributes!["url.full"], { value: "https://api.example/v1?key=[Filtered]", type: "string" })
})

test("scrubRecordingEvent scrubs replay frames and drops console frames", () => {
  assert.deepEqual(scrubRecordingEvent({ type: 4, data: { href: "https://app.example/pipeline?deal=9", width: 1 } }), { type: 4, data: { href: "https://app.example/pipeline?deal=[Filtered]", width: 1 } })
  assert.equal(scrubRecordingEvent({ type: 5, data: { tag: "breadcrumb", payload: { category: "console", message: "x" } } }), null)
  const navigation = scrubRecordingEvent({ type: 5, data: { tag: "performanceSpan", payload: { op: "navigation.push", description: "/review/tok?x=1", data: {} } } })
  assert.equal((navigation!.data as { payload: { description: string } }).payload.description, "/review/[token]?x=[Filtered]")
  const fetchFrame = scrubRecordingEvent({ type: 5, data: { tag: "breadcrumb", payload: { category: "fetch", data: { url: "/api/mca/exports/download/tok" } } } })
  assert.equal((fetchFrame!.data as { payload: { data: { url: string } } }).payload.data.url, "/api/mca/exports/download/[token]")
})

test("replay records signed-in workspace and platform pages only", () => {
  for (const path of ["/dashboard", "/pipeline", "/pipeline/deals/1", "/settings/team", "/platform", "/platform/monitoring", "/assistant"]) assert.equal(replayAllowedPath(path), true, path)
  for (const path of ["/", "/review/tok", "/account-security", "/apply/form", "/apply/r/tok", "/merchant-upload/tok", "/sign-in", "/pricing", "/dashboardx", "/platformer"]) assert.equal(replayAllowedPath(path), false, path)
})

test("sampleRate clamps and falls back", () => {
  assert.equal(sampleRate(undefined, 0.1), 0.1)
  assert.equal(sampleRate("", 0.1), 0.1)
  assert.equal(sampleRate("nope", 0.1), 0.1)
  assert.equal(sampleRate("0.25", 0.1), 0.25)
  assert.equal(sampleRate("2", 0.1), 1)
  assert.equal(sampleRate("-1", 0.1), 0)
})

test("data collection disables bodies, cookies, query values, AI payloads and IP inference", () => {
  assert.equal(DATA_COLLECTION.userInfo, false)
  assert.equal(DATA_COLLECTION.cookies, false)
  assert.deepEqual(DATA_COLLECTION.httpBodies, [])
  assert.equal(DATA_COLLECTION.urlQueryParams, false)
  assert.deepEqual(DATA_COLLECTION.genAI, { inputs: false, outputs: false })
  assert.equal(DATA_COLLECTION.databaseQueryData, false)
  assert.equal(DATA_COLLECTION.stackFrameVariables, false)
  assert.equal(DATA_COLLECTION.httpHeaders.response, false)
  assert.ok(!DATA_COLLECTION.httpHeaders.request.allow.some((name) => /cookie|authorization/i.test(name)))
})

test("bridge is a no-op without a reporter and never throws", () => {
  registerReporter(undefined)
  assert.doesNotThrow(() => reportException(new Error("x")))
  assert.doesNotThrow(() => identifyServerUser({ authType: "session", userId: "u", workspaceId: "w", role: "rep" }))
  registerReporter({ captureException: () => { throw new Error("sdk down") }, identify: () => { throw new Error("sdk down") } })
  try {
    assert.doesNotThrow(() => reportException(new Error("x")))
    assert.doesNotThrow(() => identifyServerUser({ authType: "api_key", userId: null, workspaceId: "w", role: null, apiKeyId: "k" }))
  } finally { registerReporter(undefined) }
})

test("apiError reports 5xx failures through the bridge and skips 4xx", async () => {
  const { apiError, AppError } = await import("../src/lib/mca/errors")
  const { captured } = fakeReporter()
  const original = console.error
  console.error = () => {}
  try {
    const unexpected = new TypeError("boom")
    apiError(unexpected, "corr-1")
    apiError(new AppError(503, "billing_disabled", "off"))
    apiError(new AppError(404, "not_found", "missing"))
    apiError(new AppError(400, "invalid", "bad"))
    assert.equal(captured.length, 2)
    assert.equal(captured[0].error, unexpected)
    assert.deepEqual(captured[0].context, { tags: { correlation_id: "corr-1" } })
    assert.equal(captured[1].context.level, "warning")
    assert.deepEqual(captured[1].context.fingerprint, ["app-error", "billing_disabled"])
    assert.equal(captured[1].context.tags?.error_code, "billing_disabled")
  } finally {
    console.error = original
    registerReporter(undefined)
  }
})

test("the Sentry tunnel bypasses the proxy without hiding similarly named routes", async () => {
  const { config } = await import("../src/proxy")
  const matcher = new RegExp(`^${config.matcher[0]}$`)
  assert.equal(SENTRY_TUNNEL_ROUTE, "/monitoring")
  assert.equal(matcher.test(SENTRY_TUNNEL_ROUTE), false)
  assert.equal(matcher.test(`${SENTRY_TUNNEL_ROUTE}/`), false)
  for (const path of ["/platform/monitoring", "/monitoringx", "/dashboard", "/api/mca/deals"]) assert.equal(matcher.test(path), true, path)
  const nextConfig = readFileSync(resolve("next.config.ts"), "utf8")
  assert.match(nextConfig, /withSentryConfig\(nextConfig/)
  assert.match(nextConfig, /tunnelRoute: SENTRY_TUNNEL_ROUTE/)
  assert.match(nextConfig, /disable: !process\.env\.SENTRY_AUTH_TOKEN/)
})

test("shared server modules reach Sentry only through the dependency-free bridge", () => {
  for (const file of ["src/lib/observability/bridge.ts", "src/lib/mca/errors.ts", "src/lib/mca/auth.ts", "src/lib/mca/supabase-auth.ts", "src/lib/mca/jobs/worker.ts"]) {
    assert.doesNotMatch(readFileSync(resolve(file), "utf8"), /from ["']@sentry\/|import\(["']@sentry\//, file)
  }
  assert.doesNotMatch(readFileSync(resolve("src/lib/observability/bridge.ts"), "utf8"), /^import /m)
})

test("the floating Feedback button offers issue, feature and improvement forms with distinct tags", () => {
  assert.deepEqual(FEEDBACK_KINDS, ["bug", "feature_request", "improvement"])
  assert.deepEqual(FEEDBACK_KINDS.map((kind) => FEEDBACK_FORMS[kind].label), ["Report an issue", "Request a feature", "Suggest an improvement"])
  assert.deepEqual(FEEDBACK_KINDS.map((kind) => FEEDBACK_FORMS[kind].tags.feedback_type), ["bug", "feature_request", "improvement"])
  for (const kind of FEEDBACK_KINDS) {
    const form = FEEDBACK_FORMS[kind]
    assert.ok(form.formTitle && form.submitButtonLabel && form.successMessageText, kind)
    assert.match(form.messagePlaceholder, /use Hide to cover merchant or banking details/, kind)
  }
})

test("the Feedback button sits beside the sidebar and replaces the header menu", () => {
  assert.equal(feedbackButtonOffset({ isMobile: true, state: "expanded" }), "1rem")
  assert.equal(feedbackButtonOffset({ isMobile: false, state: "expanded" }), "calc(var(--sidebar-width) + 1rem)")
  assert.equal(feedbackButtonOffset({ isMobile: false, state: "collapsed" }), "calc(var(--sidebar-width-icon) + 1rem)")
  for (const file of ["src/components/site-header.tsx", "src/components/mca/platform/platform-chrome.tsx", "src/components/mca/dashboard-chrome.tsx"]) {
    assert.doesNotMatch(readFileSync(resolve(file), "utf8"), /feedback-menu|FeedbackMenu/, file)
  }
  assert.match(readFileSync(resolve("src/components/mca/dashboard-chrome.tsx"), "utf8"), /<FeedbackButton raised=\{fullBleed\} \/>/)
  assert.match(readFileSync(resolve("src/components/mca/platform/platform-chrome.tsx"), "utf8"), /<FeedbackButton \/>/)
})
