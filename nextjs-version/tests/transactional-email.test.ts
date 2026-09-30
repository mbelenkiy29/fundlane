import "./helpers/business-auth"
import test from "node:test"
import assert from "node:assert/strict"
import { AppError } from "../src/lib/mca/errors"
import {
  assertEmailDeliveryConfigured,
  deliverEmail,
  renderEmailContent,
} from "../src/lib/mca/email"
import { requestSystemEmail, type TransactionalTemplate } from "../src/lib/mca/operations/email-transport"
import { invitationEmailEnabled } from "../src/lib/mca/applications/service"

const names = [
  "NODE_ENV",
  "MCA_EMAIL_WEBHOOK_URL",
  "MCA_EMAIL_WEBHOOK_TOKEN",
  "MCA_TRANSACTIONAL_EMAIL_SYSTEM_PROVIDER_ENABLED",
  "MCA_SYSTEM_EMAIL_PROVIDER",
  "MCA_USESEND_API_KEY",
  "MCA_USESEND_FROM",
  "MCA_USESEND_BASE_URL",
  "MCA_RESEND_API_KEY",
  "MCA_RESEND_FROM",
  "MCA_APPLICATION_INVITATION_EMAIL_ENABLED",
  "MCA_EMAIL_SENDER_VERIFIED",
] as const
async function withEnv(run: () => Promise<void>) {
  const saved = names.map((name) => process.env[name])
  const savedFetch = globalThis.fetch
  try {
    names.forEach((name) => delete process.env[name])
    await run()
  } finally {
    globalThis.fetch = savedFetch
    names.forEach((name, index) =>
      saved[index] === undefined
        ? delete process.env[name]
        : ((process.env as Record<string, string | undefined>)[name] = saved[index])
    )
  }
}
const message = {
  recipient: "client@example.test",
  template: "workspace_invitation" as const,
  actionUrl: "https://app.example.test/invite?token=secret",
  expiresAt: "2030-01-01T00:00:00Z",
}

test("flag off preserves unconfigured, preview, and webhook transport", async () =>
  withEnv(async () => {
    for (const flag of [undefined, "false", "TRUE"]) {
      if (flag)
        process.env.MCA_TRANSACTIONAL_EMAIL_SYSTEM_PROVIDER_ENABLED = flag
      else delete process.env.MCA_TRANSACTIONAL_EMAIL_SYSTEM_PROVIDER_ENABLED
      ;(process.env as Record<string, string | undefined>).NODE_ENV = "production"
      assert.throws(() => assertEmailDeliveryConfigured(), {
        code: "email_delivery_unconfigured",
      })
      await assert.rejects(deliverEmail(message), {
        code: "email_delivery_unconfigured",
      })
      ;(process.env as Record<string, string | undefined>).NODE_ENV = "development"
      assert.deepEqual(
        await deliverEmail(message, { correlationId: "preview-id" }),
        {
          delivery: "preview",
          correlationId: "preview-id",
          previewUrl: message.actionUrl,
        }
      )
    }
    ;(process.env as Record<string, string | undefined>).NODE_ENV = "production"
    process.env.MCA_EMAIL_WEBHOOK_URL = "https://hook.example.test"
    process.env.MCA_EMAIL_WEBHOOK_TOKEN = "token"
    process.env.MCA_TRANSACTIONAL_EMAIL_SYSTEM_PROVIDER_ENABLED = "true"
    process.env.MCA_USESEND_API_KEY = "key"
    process.env.MCA_USESEND_FROM = "sender@example.test"
    let request: { url: string; init?: RequestInit } | undefined
    const fetchImpl: typeof fetch = async (input, init) => {
      request = { url: String(input), init }
      return new Response(null, { status: 204 })
    }
    globalThis.fetch = fetchImpl
    await deliverEmail(message, { correlationId: "stable" })
    assert.equal(request?.url, "https://hook.example.test")
    assert.equal(
      new Headers(request?.init?.headers).get("idempotency-key"),
      "stable"
    )
    assert.deepEqual(JSON.parse(String(request?.init?.body)), message)
  }))

test("fallback renders and sends every template with a stable useSend key", async () =>
  withEnv(async () => {
    ;(process.env as Record<string, string | undefined>).NODE_ENV = "production"
    process.env.MCA_TRANSACTIONAL_EMAIL_SYSTEM_PROVIDER_ENABLED = "true"
    process.env.MCA_USESEND_API_KEY = "key"
    process.env.MCA_USESEND_FROM = "Fundlane <sender@example.test>"
    const templates: TransactionalTemplate[] = [
      "workspace_invitation",
      "account_recovery",
      "funder_analysis_review",
      "company_email_verification",
      "ai_credit_alert",
      "application_invitation",
      "application_invitation_reminder",
      "operations_alert",
    ]
    for (const template of templates) {
      let init: RequestInit | undefined
      const fetchImpl: typeof fetch = async (_input, options) => {
        init = options
        return Response.json({ emailId: `${template}-id` })
      }
      assert.deepEqual(
        await deliverEmail(
          { ...message, template },
          { correlationId: `key-${template}`, fetchImpl }
        ),
        { delivery: "sent", correlationId: `key-${template}` }
      )
      assert.equal(
        new Headers(init?.headers).get("idempotency-key"),
        `key-${template}`
      )
      assert.equal(
        JSON.parse(String(init?.body)).subject,
        renderEmailContent({ ...message, template }).subject
      )
    }
  }))

test("Resend fallback, classifications including 409, and malformed success", async () =>
  withEnv(async () => {
    ;(process.env as Record<string, string | undefined>).NODE_ENV = "production"
    process.env.MCA_TRANSACTIONAL_EMAIL_SYSTEM_PROVIDER_ENABLED = "true"
    process.env.MCA_SYSTEM_EMAIL_PROVIDER = "resend"
    process.env.MCA_RESEND_API_KEY = "key"
    process.env.MCA_USESEND_FROM = "fallback@example.test"
    for (const [status, code] of [
      [400, "email_delivery_failed"],
      [409, "email_delivery_uncertain"],
      [500, "email_delivery_uncertain"],
    ] as const) {
      await assert.rejects(
        deliverEmail(message, {
          fetchImpl: async () =>
            Response.json({ message: "private" }, { status }),
        }),
        (error: unknown) =>
          error instanceof AppError &&
          error.code === code &&
          !error.message.includes("private")
      )
    }
    await assert.rejects(
      deliverEmail(message, {
        fetchImpl: async () => Response.json({}, { status: 200 }),
      }),
      { code: "email_delivery_uncertain" }
    )
    await assert.rejects(
      deliverEmail(message, {
        fetchImpl: async () => {
          throw new TypeError("network")
        },
      }),
      { code: "email_delivery_uncertain" }
    )
    assert.equal(
      (
        await deliverEmail(message, {
          fetchImpl: async () =>
            Response.json({ id: "accepted" }, { status: 201 }),
        })
      ).delivery,
      "sent"
    )
  }))

test("useSend NOT_UNIQUE is uncertain and incomplete opt-in fails closed", async () =>
  withEnv(async () => {
    process.env.MCA_TRANSACTIONAL_EMAIL_SYSTEM_PROVIDER_ENABLED = "true"
    process.env.MCA_USESEND_API_KEY = "key"
    process.env.MCA_USESEND_FROM = "sender@example.test"
    await assert.rejects(
      deliverEmail(message, {
        fetchImpl: async () =>
          Response.json({ error: { code: "NOT_UNIQUE" } }, { status: 409 }),
      }),
      { code: "email_delivery_uncertain" }
    )
    delete process.env.MCA_USESEND_FROM
    await assert.rejects(deliverEmail(message), {
      code: "email_delivery_unconfigured",
    })
  }))

test("renderer escapes values and fallback validates action URLs", async () =>
  withEnv(async () => {
    const rendered = renderEmailContent({
      ...message,
      template: "operations_alert",
      actionUrl: "https://app.example.test/?token=a&x=%3C",
      expiresAt: `<>&"'`,
      data: {
        component: `<>&"'`,
        summary: `<script>bad</script>`,
        time: `<time>`,
      },
    })
    assert.ok(rendered.html.includes("&lt;script&gt;bad&lt;/script&gt;"))
    assert.ok(!rendered.html.includes("<script>"))
    assert.ok(rendered.text.includes("https://app.example.test/?token=a&x=%3C"))
    assert.ok(
      !rendered.html.includes('href="https://app.example.test/?token=a&x=%3C"')
    )
    process.env.MCA_TRANSACTIONAL_EMAIL_SYSTEM_PROVIDER_ENABLED = "true"
    process.env.MCA_USESEND_API_KEY = "key"
    process.env.MCA_USESEND_FROM = "sender@example.test"
    ;(process.env as Record<string, string | undefined>).NODE_ENV = "production"
    for (const actionUrl of [
      "http://example.test/x",
      "https://user:pass@example.test/x",
      "not a url",
    ])
      await assert.rejects(
        deliverEmail(
          { ...message, actionUrl },
          {
            fetchImpl: async () => {
              throw new Error("should not send")
            },
          }
        ),
        { code: "email_action_url_invalid" }
      )
  }))

test("AI credit alert copy uses the stored payload kind and totals", () => {
  const base = { ...message, template: "ai_credit_alert" as const }
  const low = renderEmailContent({ ...base, data: { kind: "low", total: 12, allowance: 100, companyName: "Acme", userName: "Dana", resetAt: "2030-02-01T00:00:00Z", workspaceId: "ws-secret", userId: "user-secret" } })
  assert.equal(low.subject, "Fundlane AI credits are running low")
  assert.match(low.text, /Remaining: 12\./)
  assert.match(low.text, /Allowance: 100\./)
  assert.equal(low.text.includes("ws-secret") || low.text.includes("user-secret"), false)
  const exhausted = renderEmailContent({ ...base, data: { kind: "exhausted", total: 0, allowance: 100 } })
  assert.equal(exhausted.subject, "Fundlane AI credits are exhausted")
  assert.match(exhausted.text, /Remaining: 0\./)
})

test("direct useSend request honors the configured origin and sends the useSend client agent", async () => {
  let url = "", headers = new Headers()
  const fetchImpl: typeof fetch = async (input, init) => {
    url = String(input)
    headers = new Headers(init?.headers)
    return Response.json({ emailId: "e1" })
  }
  const content = { subject: "s", text: "t", html: "<p>t</p>" }
  assert.deepEqual(await requestSystemEmail({ ...content, provider: "usesend", apiKey: "k", from: "f@example.test", to: "o@example.test", idempotencyKey: "id-1", fetchImpl, baseUrl: "https://mail.example.test/ignored" }), { status: 200, emailId: "e1" })
  assert.equal(url, "https://mail.example.test/api/v1/emails")
  assert.match(headers.get("user-agent") ?? "", /MCA-Intake/)
  await requestSystemEmail({ ...content, provider: "usesend", apiKey: "k", from: "f", to: "o", idempotencyKey: "id-2", fetchImpl })
  assert.equal(url, "https://app.usesend.com/api/v1/emails")
  await assert.rejects(requestSystemEmail({ ...content, provider: "usesend", apiKey: "k", from: "f", to: "o", idempotencyKey: "id-3", fetchImpl, baseUrl: "http://mail.example.test" }))
  await requestSystemEmail({ ...content, provider: "resend", apiKey: "k", from: "f", to: "o", idempotencyKey: "id-4", fetchImpl: async (input, init) => { url = String(input); headers = new Headers(init?.headers); return Response.json({ id: "r1" }) } })
  assert.equal(url, "https://api.resend.com/emails")
  assert.equal(headers.get("user-agent"), null)
})

test("local useSend configuration failure is unconfigured; Resend ignores useSend origin", () =>
  withEnv(async () => {
    process.env.MCA_TRANSACTIONAL_EMAIL_SYSTEM_PROVIDER_ENABLED = "true"
    process.env.MCA_USESEND_API_KEY = "fake-key"
    process.env.MCA_USESEND_FROM = "sender@example.test"
    let sends = 0
    globalThis.fetch = async () => { sends++; return Response.json({ emailId: "synthetic-receipt", id: "synthetic-receipt" }) }
    for (const origin of ["http://mail.example.test", "not-a-url", "https://user:pass@mail.example.test"]) {
      process.env.MCA_USESEND_BASE_URL = origin
      await assert.rejects(deliverEmail(message), { code: "email_delivery_unconfigured" })
      assert.equal(sends, 0)
    }
    process.env.MCA_SYSTEM_EMAIL_PROVIDER = "resend"
    process.env.MCA_RESEND_API_KEY = "fake-resend-key"
    process.env.MCA_RESEND_FROM = "sender@example.test"
    assert.equal((await deliverEmail(message)).delivery, "sent")
    assert.equal(sends, 1)
  }))

test("production invitation readiness accepts the credentialed fallback but keeps sender gates", () =>
  withEnv(async () => {
    ;(process.env as Record<string, string | undefined>).NODE_ENV = "production"
    process.env.MCA_APPLICATION_INVITATION_EMAIL_ENABLED = "true"
    process.env.MCA_EMAIL_SENDER_VERIFIED = "true"
    process.env.MCA_USESEND_API_KEY = "key"
    process.env.MCA_USESEND_FROM = "Fundlane <sender@example.test>"
    assert.equal(invitationEmailEnabled(), false)
    process.env.MCA_TRANSACTIONAL_EMAIL_SYSTEM_PROVIDER_ENABLED = "true"
    assert.equal(invitationEmailEnabled(), true)
    process.env.MCA_EMAIL_SENDER_VERIFIED = "false"
    assert.equal(invitationEmailEnabled(), false)
    process.env.MCA_EMAIL_SENDER_VERIFIED = "true"
    delete process.env.MCA_USESEND_FROM
    assert.equal(invitationEmailEnabled(), false)
  }))


test("production invitation readiness requires authentication for the selected webhook", () =>
  withEnv(async () => {
    ;(process.env as Record<string, string | undefined>).NODE_ENV = "production"
    process.env.MCA_APPLICATION_INVITATION_EMAIL_ENABLED = "true"
    process.env.MCA_EMAIL_SENDER_VERIFIED = "true"
    process.env.MCA_EMAIL_WEBHOOK_URL = "https://hook.example.test"
    for (const flag of [undefined, "false", "true"]) {
      if (flag) process.env.MCA_TRANSACTIONAL_EMAIL_SYSTEM_PROVIDER_ENABLED = flag
      else delete process.env.MCA_TRANSACTIONAL_EMAIL_SYSTEM_PROVIDER_ENABLED
      for (const credentialed of [false, true]) {
        if (credentialed) {
          process.env.MCA_USESEND_API_KEY = "key"
          process.env.MCA_USESEND_FROM = "sender@example.test"
        } else {
          delete process.env.MCA_USESEND_API_KEY
          delete process.env.MCA_USESEND_FROM
        }
        delete process.env.MCA_EMAIL_WEBHOOK_TOKEN
        assert.equal(invitationEmailEnabled(), false, `webhook without token: flag=${flag}, provider=${credentialed}`)
        process.env.MCA_EMAIL_WEBHOOK_TOKEN = "token"
        assert.equal(invitationEmailEnabled(), true)
      }
    }
  }))
