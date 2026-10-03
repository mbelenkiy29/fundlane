import "./helpers/business-auth"
import test from "node:test"
import assert from "node:assert/strict"
import { requestFrozenSystemEmail, sendSystemEmail, systemEmailConfiguration, systemEmailCredentials } from "../src/lib/mca/system-email"
import { emailIntakeReadiness } from "../src/lib/mca/intake/email-readiness"
import { billingEmailConfiguration, deliverBillingEmail } from "../src/lib/mca/email"
import { notifyDemoSubmission } from "../src/lib/marketing/demo-storage"

const names = ["MCA_SYSTEM_EMAIL_PROVIDER", "MCA_SYSTEM_EMAIL_REPLY_TO", "MCA_USESEND_BASE_URL", "MCA_EMAIL_WEBHOOK_URL", "MCA_EMAIL_WEBHOOK_TOKEN", "MCA_RESEND_API_KEY", "MCA_RESEND_FROM", "MCA_USESEND_API_KEY", "MCA_USESEND_FROM", "MCA_DEMO_NOTIFY_EMAIL", "MCA_PRIVATE_EMAIL_INTAKE_ENABLED", "MCA_PRIVATE_EMAIL_DELIVERY_ENABLED"] as const
const message = { apiKey: "usesend-key", from: "UseSend <old@example.test>", to: "customer@example.test", subject: "Subject", text: "Plain", html: "<p>Plain</p>", idempotencyKey: "stable-key" }

async function withEnv(run: () => Promise<void>) {
  const saved = names.map(name => process.env[name])
  const original = globalThis.fetch
  try { for (const name of names) delete process.env[name]; await run() }
  finally {
    globalThis.fetch = original
    names.forEach((name, i) => { if (saved[i] === undefined) delete process.env[name]; else process.env[name] = saved[i] })
  }
}

test("unset provider keeps the exact useSend request", async () => withEnv(async () => {
  let url = "", init: RequestInit | undefined
  globalThis.fetch = async (input, options) => { url = String(input); init = options; return Response.json({ emailId: "usesend-id" }) }
  assert.deepEqual(await sendSystemEmail(message), { emailId: "usesend-id" })
  assert.equal(url, "https://app.usesend.com/api/v1/emails")
  assert.equal(new Headers(init?.headers).get("authorization"), "Bearer usesend-key")
  assert.equal(new Headers(init?.headers).get("idempotency-key"), "stable-key")
  assert.deepEqual(JSON.parse(String(init?.body)), { to: message.to, from: message.from, subject: message.subject, text: message.text, html: message.html })
  process.env.MCA_SYSTEM_EMAIL_PROVIDER = "Resend"
  assert.deepEqual(await sendSystemEmail(message), { emailId: "usesend-id" })
  assert.equal(url, "https://app.usesend.com/api/v1/emails")
}))

test("Resend maps payload, fallback sender, stable key, and provider ID", async () => withEnv(async () => {
  process.env.MCA_SYSTEM_EMAIL_PROVIDER = "resend"
  process.env.MCA_RESEND_API_KEY = "resend-key"
  process.env.MCA_USESEND_FROM = "Fallback <fallback@example.test>"
  let url = "", init: RequestInit | undefined
  globalThis.fetch = async (input, options) => { url = String(input); init = options; return Response.json({ id: "resend-id" }, { status: 201 }) }
  assert.deepEqual(await sendSystemEmail(message), { emailId: "resend-id" })
  assert.equal(url, "https://api.resend.com/emails")
  assert.equal(new Headers(init?.headers).get("authorization"), "Bearer resend-key")
  assert.equal(new Headers(init?.headers).get("content-type"), "application/json")
  assert.equal(new Headers(init?.headers).get("idempotency-key"), "stable-key")
  assert.deepEqual(JSON.parse(String(init?.body)), { from: "Fallback <fallback@example.test>", to: [message.to], subject: message.subject, text: message.text, html: message.html })
  process.env.MCA_RESEND_FROM = "Resend <new@example.test>"
  assert.equal(systemEmailCredentials()?.from, "Resend <new@example.test>")
  await sendSystemEmail({ ...message, idempotencyKey: "k".repeat(300) })
  assert.equal(new Headers(init?.headers).get("idempotency-key"), "k".repeat(256))
}))

test("Resend errors and timeout never report sent", async () => withEnv(async () => {
  process.env.MCA_SYSTEM_EMAIL_PROVIDER = "resend"
  process.env.MCA_RESEND_API_KEY = "resend-key"
  process.env.MCA_RESEND_FROM = "sender@example.test"
  for (const [status, code] of [[400, "resend_send_failed"], [401, "resend_auth_rejected"], [429, "resend_rate_limited"], [500, "resend_send_failed"]] as const) {
    globalThis.fetch = async () => Response.json({ message: "rejected" }, { status })
    await assert.rejects(sendSystemEmail(message), (error: unknown) => error instanceof Error && "code" in error && error.code === code && "extra" in error && (error.extra as {providerStatus:number}).providerStatus === status)
  }
  globalThis.fetch = async () => { throw new DOMException("timed out", "TimeoutError") }
  await assert.rejects(sendSystemEmail(message), { name: "TimeoutError" })
  globalThis.fetch = async () => Response.json({}, { status: 200 })
  await assert.rejects(sendSystemEmail(message), { code: "resend_send_failed" })
}))

test("receipt readiness accepts configured Resend without outbound useSend credentials", async () => withEnv(async () => {
  process.env.MCA_PRIVATE_EMAIL_INTAKE_ENABLED = "true"
  process.env.MCA_PRIVATE_EMAIL_DELIVERY_ENABLED = "true"
  process.env.MCA_SYSTEM_EMAIL_PROVIDER = "resend"
  process.env.MCA_RESEND_API_KEY = "resend-key"
  process.env.MCA_RESEND_FROM = "sender@example.test"
  const input = { enabled: true, inboundAddress: "inbound@example.test", admissionSecretHash: "secret", senderRules: ["broker@example.test"], emailGateway: "usesend", providerEvidenceHash: "inbound-proof" }
  assert.deepEqual(emailIntakeReadiness(input), [])
  delete process.env.MCA_RESEND_API_KEY
  assert.ok(emailIntakeReadiness(input).includes("Verified receipt sender is missing"))
}))

test("billing and demo call sites route through Resend", async () => withEnv(async () => {
  process.env.MCA_SYSTEM_EMAIL_PROVIDER = "resend"
  process.env.MCA_RESEND_API_KEY = "resend-key"
  process.env.MCA_RESEND_FROM = "sender@example.test"
  process.env.MCA_DEMO_NOTIFY_EMAIL = "sales@example.test"
  const calls: Array<{ url: string; body: { to: string[] }; key: string | null }> = []
  globalThis.fetch = async (input, init) => {
    calls.push({ url: String(input), body: JSON.parse(String(init?.body)), key: new Headers(init?.headers).get("idempotency-key") })
    return Response.json({ id: `resend-${calls.length}` })
  }
  await deliverBillingEmail({ recipient: "owner@example.test", actionUrl: "https://fundlane.example/settings/billing", expiresAt: "2030-01-01T00:00:00Z", data: { kind: "billing_paused" }, transport: "system", configuration: systemEmailConfiguration(), from: systemEmailConfiguration().from, retryUntil: new Date(Date.now() + 3600000).toISOString() }, "billing-key")
  assert.equal(await notifyDemoSubmission("demo-key", { name: "Alex", email: "alex@example.test", brokerage: "Synthetic", teamSize: "1", message: "" }), true)
  assert.deepEqual(calls.map(call => [call.url, call.body.to[0], call.key]), [
    ["https://api.resend.com/emails", "owner@example.test", "billing-key"],
    ["https://api.resend.com/emails", "sales@example.test", "demo-key"],
  ])
}))

test("Resend is primary when its key is set; usesend keeps the fallback", async () => withEnv(async () => {
  process.env.MCA_RESEND_API_KEY = "resend-key"
  process.env.MCA_RESEND_FROM = "Fundlane <noreply@example.test>"
  process.env.MCA_USESEND_API_KEY = "usesend-key"
  process.env.MCA_USESEND_FROM = "UseSend <old@example.test>"
  const urls: string[] = []
  globalThis.fetch = async (input) => { urls.push(String(input)); return Response.json({ id: "resend-id", emailId: "usesend-id" }) }
  assert.deepEqual(await sendSystemEmail(message), { emailId: "resend-id" })
  assert.equal(systemEmailCredentials()?.from, "Fundlane <noreply@example.test>")
  process.env.MCA_SYSTEM_EMAIL_PROVIDER = "usesend"
  assert.deepEqual(await sendSystemEmail(message), { emailId: "usesend-id" })
  assert.equal(systemEmailCredentials()?.from, "UseSend <old@example.test>")
  assert.deepEqual(urls, ["https://api.resend.com/emails", "https://app.usesend.com/api/v1/emails"])
}))

test("frozen billing retry keeps its provider and exact request after the default switches", async () => withEnv(async () => {
  Object.assign(process.env, { MCA_SYSTEM_EMAIL_PROVIDER: "usesend", MCA_USESEND_API_KEY: "old-key", MCA_USESEND_FROM: "Old <old@example.test>", MCA_RESEND_API_KEY: "new-key", MCA_RESEND_FROM: "New <new@example.test>" })
  const configuration = systemEmailConfiguration()
  const frozen = { recipient: "owner@example.test", actionUrl: "https://fundlane.example/settings/billing", expiresAt: "2030-01-01T00:00:00Z", data: { kind: "billing_paused" }, transport: "usesend" as const, configuration, from: configuration.from, retryUntil: new Date(Date.now() + 3600000).toISOString(), content: { subject: "Frozen", text: "Frozen", html: "<p>Frozen</p>" } }
  const calls: Array<{ url: string; body: string; key: string | null; authorization: string | null }> = []
  globalThis.fetch = async (input, init) => {
    const headers = new Headers(init?.headers)
    calls.push({ url: String(input), body: String(init?.body), key: headers.get("idempotency-key"), authorization: headers.get("authorization") })
    if (calls.length === 1) throw new DOMException("Accepted response was lost", "TimeoutError")
    return Response.json({ emailId: "original-provider-id" })
  }
  await assert.rejects(deliverBillingEmail(frozen, "frozen-billing-key"))
  delete process.env.MCA_SYSTEM_EMAIL_PROVIDER
  // Onboarding retains its existing review requirement when selection changes.
  await assert.rejects(requestFrozenSystemEmail({ to: message.to, subject: message.subject, text: message.text, html: message.html, idempotencyKey: "onboarding-key" }, configuration), { code: "onboarding_email_provider_changed" })
  await deliverBillingEmail(frozen, "frozen-billing-key")
  assert.deepEqual(calls[1], calls[0])
  assert.equal(calls[1]!.url, "https://app.usesend.com/api/v1/emails")
}))

test("billing provider key, endpoint, sender or reply configuration drift requires review without sending", async () => withEnv(async () => {
  Object.assign(process.env, { MCA_SYSTEM_EMAIL_PROVIDER: "usesend", MCA_USESEND_API_KEY: "old-key", MCA_USESEND_FROM: "Old <old@example.test>" })
  const configuration = systemEmailConfiguration()
  const frozen = { recipient: "owner@example.test", actionUrl: "https://fundlane.example/settings/billing", expiresAt: "2030-01-01T00:00:00Z", data: { kind: "billing_paused" }, transport: "usesend" as const, configuration, from: configuration.from, retryUntil: new Date(Date.now() + 3600000).toISOString() }
  let calls = 0
  globalThis.fetch = async () => { calls++; return Response.json({ emailId: "wrong-provider-id" }) }
  for (const [key, value] of [["MCA_USESEND_API_KEY", "different-account-key"], ["MCA_USESEND_FROM", "Changed <changed@example.test>"], ["MCA_USESEND_BASE_URL", "https://different-endpoint.example.test"], ["MCA_SYSTEM_EMAIL_REPLY_TO", "changed-reply@example.test"]] as const) {
    const before = process.env[key]
    process.env[key] = value
    await assert.rejects(deliverBillingEmail(frozen, "frozen-billing-key"), { code: "billing_delivery_review_required" })
    if (before === undefined) delete process.env[key]; else process.env[key] = before
  }
  assert.equal(calls, 0)
}))

test("legacy frozen billing payloads never infer a provider account from current deployment settings", async () => withEnv(async () => {
  Object.assign(process.env, { MCA_RESEND_API_KEY: "new-key", MCA_RESEND_FROM: "new@example.test", MCA_USESEND_API_KEY: "old-key", MCA_USESEND_FROM: "old@example.test", MCA_EMAIL_WEBHOOK_URL: "https://changed-webhook.example.test/send" })
  let calls = 0
  globalThis.fetch = async () => { calls++; return Response.json({ id: "would-duplicate" }) }
  for (const transport of ["usesend", "webhook"] as const) {
    await assert.rejects(deliverBillingEmail({ recipient: "owner@example.test", actionUrl: "https://fundlane.example/settings/billing", expiresAt: "2030-01-01T00:00:00Z", data: { kind: "billing_paused" }, transport, from: "old@example.test", retryUntil: new Date(Date.now() + 3600000).toISOString() }, "legacy-key"), { code: "billing_delivery_review_required" })
  }
  assert.equal(calls, 0)
}))

test("frozen billing webhooks reject endpoint and token changes without switching transport", async () => withEnv(async () => {
  Object.assign(process.env, { MCA_EMAIL_WEBHOOK_URL: "https://original.example.test/send", MCA_EMAIL_WEBHOOK_TOKEN: "original-token" })
  const frozen = { recipient: "owner@example.test", actionUrl: "https://fundlane.example/settings/billing", expiresAt: "2030-01-01T00:00:00Z", data: { kind: "billing_paused" }, transport: "webhook" as const, configuration: billingEmailConfiguration() }
  const calls: Array<{ url: string; body: Record<string, unknown> }> = []
  globalThis.fetch = async (input, init) => { calls.push({ url: String(input), body: JSON.parse(String(init?.body)) }); return Response.json({ id: "original-id" }) }
  await deliverBillingEmail(frozen, "webhook-key")
  assert.equal(calls[0]?.url, "https://original.example.test/send")
  assert.equal(calls[0]?.body.configuration, undefined)
  for (const [key, value] of [["MCA_EMAIL_WEBHOOK_URL", "https://different.example.test/send"], ["MCA_EMAIL_WEBHOOK_TOKEN", "different-token"]] as const) {
    const before = process.env[key]
    process.env[key] = value
    await assert.rejects(deliverBillingEmail(frozen, "webhook-key"), { code: "billing_delivery_review_required" })
    process.env[key] = before!
  }
  assert.equal(calls.length, 1)
}))
