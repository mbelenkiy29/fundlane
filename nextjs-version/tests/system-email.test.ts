import "./helpers/business-auth"
import test from "node:test"
import assert from "node:assert/strict"
import { sendSystemEmail, systemEmailCredentials } from "../src/lib/mca/system-email"
import { emailIntakeReadiness } from "../src/lib/mca/intake/email-readiness"
import { deliverBillingEmail } from "../src/lib/mca/email"
import { notifyDemoSubmission } from "../src/lib/marketing/demo-storage"

const names = ["MCA_SYSTEM_EMAIL_PROVIDER", "MCA_RESEND_API_KEY", "MCA_RESEND_FROM", "MCA_USESEND_API_KEY", "MCA_USESEND_FROM", "MCA_DEMO_NOTIFY_EMAIL", "MCA_PRIVATE_EMAIL_INTAKE_ENABLED", "MCA_PRIVATE_EMAIL_DELIVERY_ENABLED"] as const
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
    await assert.rejects(sendSystemEmail(message), { code })
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
  await deliverBillingEmail({ recipient: "owner@example.test", actionUrl: "https://fundlane.example/settings/billing", expiresAt: "2030-01-01T00:00:00Z", data: { kind: "billing_paused" }, transport: "usesend" }, "billing-key")
  assert.equal(await notifyDemoSubmission("demo-key", { name: "Alex", email: "alex@example.test", brokerage: "Synthetic", teamSize: "1", message: "" }), true)
  assert.deepEqual(calls.map(call => [call.url, call.body.to[0], call.key]), [
    ["https://api.resend.com/emails", "owner@example.test", "billing-key"],
    ["https://api.resend.com/emails", "sales@example.test", "demo-key"],
  ])
}))
