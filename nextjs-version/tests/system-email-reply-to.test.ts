import "./helpers/business-auth"
import test from "node:test"
import assert from "node:assert/strict"
import { sendSystemEmail, systemEmailReplyTo } from "../src/lib/mca/system-email"
import { deliverEmail } from "../src/lib/mca/email"
import { requestSystemEmail } from "../src/lib/mca/operations/email-transport"
import { runMonitor, type MonitorDb } from "../src/lib/mca/operations/monitor"

const names = ["MCA_SYSTEM_EMAIL_REPLY_TO", "MCA_SYSTEM_EMAIL_PROVIDER", "MCA_USESEND_API_KEY", "MCA_USESEND_FROM", "MCA_RESEND_API_KEY", "MCA_RESEND_FROM", "MCA_TRANSACTIONAL_EMAIL_SYSTEM_PROVIDER_ENABLED", "MCA_EMAIL_WEBHOOK_URL"] as const
const message = { apiKey: "key", from: "Fundlane <system@example.test>", to: "client@example.test", subject: "Subject", text: "Plain", html: "<p>Plain</p>", idempotencyKey: "stable" }
const invitation = { recipient: "client@example.test", template: "workspace_invitation" as const, actionUrl: "https://app.example.test/invite", expiresAt: "2030-01-01T00:00:00Z" }

async function withEnv(run: () => Promise<void>) {
  const saved = names.map(name => process.env[name])
  const originalFetch = globalThis.fetch
  try {
    names.forEach(name => delete process.env[name])
    await run()
  } finally {
    globalThis.fetch = originalFetch
    names.forEach((name, index) => {
      if (saved[index] === undefined) delete process.env[name]
      else process.env[name] = saved[index]
    })
  }
}

function captureBody(provider: "usesend" | "resend" = "usesend") {
  let body = ""
  const fetchImpl: typeof fetch = async (_input, init) => {
    body = String(init?.body)
    return Response.json(provider === "resend" ? { id: "sent" } : { emailId: "sent" }, { status: provider === "resend" ? 201 : 200 })
  }
  return { fetchImpl, body: () => body }
}

test("unset and blank configuration preserve exact provider bodies", async () => withEnv(async () => {
  process.env.MCA_USESEND_API_KEY = "key"
  process.env.MCA_USESEND_FROM = message.from
  for (const value of [undefined, "  "]) {
    if (value === undefined) delete process.env.MCA_SYSTEM_EMAIL_REPLY_TO
    else process.env.MCA_SYSTEM_EMAIL_REPLY_TO = value
    assert.equal(systemEmailReplyTo(), undefined)
    const usesend = captureBody()
    await sendSystemEmail({ ...message, fetchImpl: usesend.fetchImpl })
    assert.equal(usesend.body(), JSON.stringify({ to: message.to, from: message.from, subject: message.subject, text: message.text, html: message.html }))
    process.env.MCA_SYSTEM_EMAIL_PROVIDER = "resend"
    process.env.MCA_RESEND_API_KEY = "resend-key"
    const resend = captureBody("resend")
    await sendSystemEmail({ ...message, fetchImpl: resend.fetchImpl })
    assert.equal(resend.body(), JSON.stringify({ from: message.from, to: [message.to], subject: message.subject, text: message.text, html: message.html }))
    delete process.env.MCA_SYSTEM_EMAIL_PROVIDER
  }
}))

test("plain and named Reply-To values reach both providers and the transactional fallback", async () => withEnv(async () => {
  process.env.MCA_USESEND_API_KEY = "key"
  process.env.MCA_USESEND_FROM = message.from
  process.env.MCA_RESEND_API_KEY = "resend-key"
  process.env.MCA_TRANSACTIONAL_EMAIL_SYSTEM_PROVIDER_ENABLED = "true"
  for (const value of ["reply@example.test", "Replies <reply@example.test>"]) {
    process.env.MCA_SYSTEM_EMAIL_REPLY_TO = `  ${value}  `
    assert.equal(systemEmailReplyTo(), value)
    const usesend = captureBody()
    await sendSystemEmail({ ...message, fetchImpl: usesend.fetchImpl })
    assert.equal(JSON.parse(usesend.body()).replyTo, value)
    const fallback = captureBody()
    await deliverEmail(invitation, { correlationId: "invite", fetchImpl: fallback.fetchImpl })
    assert.equal(JSON.parse(fallback.body()).replyTo, value)
    process.env.MCA_SYSTEM_EMAIL_PROVIDER = "resend"
    const resend = captureBody("resend")
    await sendSystemEmail({ ...message, fetchImpl: resend.fetchImpl })
    assert.equal(JSON.parse(resend.body()).reply_to, value)
    delete process.env.MCA_SYSTEM_EMAIL_PROVIDER
  }
  const explicit = captureBody()
  await sendSystemEmail({ ...message, replyTo: "other@example.test", fetchImpl: explicit.fetchImpl })
  assert.equal(JSON.parse(explicit.body()).replyTo, "other@example.test")
  process.env.MCA_SYSTEM_EMAIL_PROVIDER = "resend"
  const explicitResend = captureBody("resend")
  await sendSystemEmail({ ...message, replyTo: "other@example.test", fetchImpl: explicitResend.fetchImpl })
  assert.equal(JSON.parse(explicitResend.body()).reply_to, "other@example.test")
}))

test("tenant From does not inherit the system Reply-To", async () => withEnv(async () => {
  process.env.MCA_USESEND_API_KEY = "key"
  process.env.MCA_USESEND_FROM = message.from
  process.env.MCA_SYSTEM_EMAIL_REPLY_TO = "reply@example.test"
  const tenant = captureBody()
  await sendSystemEmail({ ...message, from: "Tenant <tenant@example.test>", fetchImpl: tenant.fetchImpl })
  assert.equal(Object.hasOwn(JSON.parse(tenant.body()), "replyTo"), false)
  process.env.MCA_SYSTEM_EMAIL_REPLY_TO = "invalid"
  const tenantInvalid = captureBody()
  await sendSystemEmail({ ...message, from: "Tenant <tenant@example.test>", fetchImpl: tenantInvalid.fetchImpl })
  assert.equal(Object.hasOwn(JSON.parse(tenantInvalid.body()), "replyTo"), false)
}))

test("invalid Reply-To fails before fetch and maps transactional delivery to unconfigured", async () => withEnv(async () => {
  process.env.MCA_USESEND_API_KEY = "key"
  process.env.MCA_USESEND_FROM = message.from
  process.env.MCA_TRANSACTIONAL_EMAIL_SYSTEM_PROVIDER_ENABLED = "true"
  process.env.MCA_SYSTEM_EMAIL_REPLY_TO = "invalid"
  let calls = 0
  const fetchImpl: typeof fetch = async () => { calls++; return Response.json({ emailId: "unexpected" }) }
  await assert.rejects(sendSystemEmail({ ...message, fetchImpl }), { status: 503, code: "system_email_reply_to_invalid", message: "MCA_SYSTEM_EMAIL_REPLY_TO must be an email address." })
  await assert.rejects(deliverEmail(invitation, { correlationId: "invite", fetchImpl }), { status: 503, code: "email_delivery_unconfigured" })
  assert.equal(calls, 0)
}))

test("shared transport maps Reply-To to each provider key", async () => withEnv(async () => {
  for (const provider of ["usesend", "resend"] as const) {
    const captured = captureBody(provider)
    await requestSystemEmail({ ...message, provider, replyTo: "reply@example.test", fetchImpl: captured.fetchImpl })
    const body = JSON.parse(captured.body())
    assert.equal(body[provider === "resend" ? "reply_to" : "replyTo"], "reply@example.test")
  }
}))

test("monitor forwards configured Reply-To and omits a value without @", async () => withEnv(async () => {
  for (const value of ["reply@example.test", "invalid"]) {
    const bodies: Record<string, unknown>[] = []
    const db: MonitorDb = { query: async (sql) => {
      if (sql.startsWith("UPDATE mca_private.ops_control SET lease_token=")) return [{ id: true }]
      if (sql.startsWith("SELECT count(*)::int FROM mca_background_jobs")) throw new Error("metrics unavailable")
      if (sql.includes("RETURNING component,kind AS pending_kind")) return [{ component: "website", pending_kind: "opening", pending_id: "00000000-0000-4000-8000-000000000001" }]
      if (sql.startsWith("SELECT id FROM mca_private.ops_control")) return [{ id: true }]
      if (sql.startsWith("SELECT opened_at::text")) return [{ opened_at: null, bad_checks: 0, good_checks: 0, last_sent_at: null, pending_kind: null }]
      return []
    } }
    const fetchImpl: typeof fetch = async (input, init) => {
      if (String(input).endsWith("/api/internal/health")) return Response.json({ databaseOk: true, databaseMs: 1 })
      bodies.push(JSON.parse(String(init?.body)))
      return Response.json({ emailId: "sent" })
    }
    await runMonitor(db, { origin: "https://app.example.test", token: "token", alerts: true, recipient: "ops@example.test", systemProviderEnabled: true, systemProvider: "usesend", systemApiKey: "key", systemFrom: message.from, systemReplyTo: value }, fetchImpl)
    assert.equal(bodies.length, 1)
    assert.equal(bodies[0].replyTo, value.includes("@") ? value : undefined)
    assert.equal(Object.hasOwn(bodies[0], "replyTo"), value.includes("@"))
  }
}))
