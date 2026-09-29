import assert from "node:assert/strict"
import test from "node:test"

import {
  assertEmailSenderReadinessEnabled,
  inspectEmailSenderReadiness,
} from "../scripts/ops/email-sender-readiness"

const completeEnvironment = {
  MCA_EMAIL_SENDER_READINESS_ENABLED: "true",
  MCA_EMAIL_CONVERSATIONS_RUNTIME: "vercel_cron",
  MCA_APP_ORIGIN: "https://fundlane.example",
  CRON_SECRET: "sentinel-cron-secret",
  MCA_GOOGLE_SENDER_CLIENT_ID: "sentinel-google-client-id",
  MCA_GOOGLE_SENDER_CLIENT_SECRET: "sentinel-google-client-secret",
  MCA_MICROSOFT_SENDER_CLIENT_ID: "sentinel-microsoft-client-id",
  MCA_MICROSOFT_SENDER_CLIENT_SECRET: "sentinel-microsoft-client-secret",
} as const

test("the command guard accepts only the exact true value", () => {
  for (const value of [undefined, "false", "TRUE"]) {
    assert.throws(
      () => assertEmailSenderReadinessEnabled({ MCA_EMAIL_SENDER_READINESS_ENABLED: value }),
      /Email sender readiness is disabled/,
    )
  }
  assert.doesNotThrow(() => assertEmailSenderReadinessEnabled({ MCA_EMAIL_SENDER_READINESS_ENABLED: "true" }))
})

test("complete synthetic Google and Microsoft configuration passes without exposing credentials", () => {
  const report = inspectEmailSenderReadiness(completeEnvironment)
  assert.equal(report.ready, true)
  assert.equal(report.checks.callback.value, "https://fundlane.example/api/mca/senders/oauth/callback")
  assert.equal(report.checks.providers.google.status, "ready")
  assert.equal(report.checks.providers.microsoft.status, "ready")

  const serialized = JSON.stringify(report)
  for (const sentinel of Object.values(completeEnvironment).filter(value => value.startsWith("sentinel-"))) {
    assert.equal(serialized.includes(sentinel), false)
  }
})

test("a trailing origin slash is normalized when deriving the production callback path", () => {
  const report = inspectEmailSenderReadiness({ ...completeEnvironment, MCA_APP_ORIGIN: "https://fundlane.example/" })
  assert.equal(report.ready, true)
  assert.equal(report.checks.appOrigin.value, "https://fundlane.example")
  assert.equal(report.checks.callback.value, "https://fundlane.example/api/mca/senders/oauth/callback")
})

test("Google-only and Microsoft-only configuration each pass", () => {
  const googleOnly = inspectEmailSenderReadiness({
    ...completeEnvironment,
    MCA_MICROSOFT_SENDER_CLIENT_ID: undefined,
    MCA_MICROSOFT_SENDER_CLIENT_SECRET: undefined,
  })
  assert.equal(googleOnly.ready, true)
  assert.equal(googleOnly.checks.providers.google.status, "ready")
  assert.equal(googleOnly.checks.providers.microsoft.status, "not configured")

  const microsoftOnly = inspectEmailSenderReadiness({
    ...completeEnvironment,
    MCA_GOOGLE_SENDER_CLIENT_ID: undefined,
    MCA_GOOGLE_SENDER_CLIENT_SECRET: undefined,
  })
  assert.equal(microsoftOnly.ready, true)
  assert.equal(microsoftOnly.checks.providers.google.status, "not configured")
  assert.equal(microsoftOnly.checks.providers.microsoft.status, "ready")
})

test("a partial provider fails even when the other provider is ready", () => {
  for (const [provider, replacement] of [
    ["google", { MCA_GOOGLE_SENDER_CLIENT_ID: "" }],
    ["google", { MCA_GOOGLE_SENDER_CLIENT_SECRET: "   " }],
    ["microsoft", { MCA_MICROSOFT_SENDER_CLIENT_ID: undefined }],
    ["microsoft", { MCA_MICROSOFT_SENDER_CLIENT_SECRET: "\t" }],
  ] as const) {
    const report = inspectEmailSenderReadiness({ ...completeEnvironment, ...replacement })
    assert.equal(report.ready, false)
    assert.equal(report.checks.providers[provider].status, "partial (missing ID or secret)")
  }
})

test("neither provider configured fails", () => {
  const report = inspectEmailSenderReadiness({
    ...completeEnvironment,
    MCA_GOOGLE_SENDER_CLIENT_ID: "",
    MCA_GOOGLE_SENDER_CLIENT_SECRET: " ",
    MCA_MICROSOFT_SENDER_CLIENT_ID: undefined,
    MCA_MICROSOFT_SENDER_CLIENT_SECRET: undefined,
  })
  assert.equal(report.ready, false)
  assert.equal(report.checks.providers.google.status, "not configured")
  assert.equal(report.checks.providers.microsoft.status, "not configured")
})

test("runtime mode and cron secret requirements fail closed", () => {
  for (const replacement of [
    { MCA_EMAIL_CONVERSATIONS_RUNTIME: undefined },
    { MCA_EMAIL_CONVERSATIONS_RUNTIME: "VERCEL_CRON" },
    { MCA_EMAIL_CONVERSATIONS_RUNTIME: " vercel_cron " },
    { CRON_SECRET: undefined },
    { CRON_SECRET: "   " },
  ]) {
    assert.equal(inspectEmailSenderReadiness({ ...completeEnvironment, ...replacement }).ready, false)
  }
})

test("origins must be HTTPS and contain no credentials, path, query, or hash", () => {
  const invalidOrigins = [
    undefined,
    "   ",
    "http://fundlane.example",
    "https://user:password@fundlane.example",
    "https://fundlane.example/app",
    "https://fundlane.example?preview=true",
    "https://fundlane.example#callback",
  ]
  for (const MCA_APP_ORIGIN of invalidOrigins) {
    const report = inspectEmailSenderReadiness({ ...completeEnvironment, MCA_APP_ORIGIN })
    assert.equal(report.ready, false)
    assert.equal(report.checks.appOrigin.value, undefined)
    assert.equal(report.checks.callback.value, undefined)
  }
})
