import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { tmpdir } from "node:os"
import test from "node:test"

import { buildSmsWebhookUrls, validateSmsReadiness } from "../scripts/sms/readiness.mjs"

const appRoot = resolve(import.meta.dirname, "..")
const script = join(appRoot, "scripts/sms/readiness.mjs")
const temp = mkdtempSync(join(tmpdir(), "mca-sms-readiness-"))
test.after(() => rmSync(temp, { recursive: true, force: true }))

const accountSid = `AC${"1".repeat(32)}`
const apiKeySid = `SK${"2".repeat(32)}`
const profileSid = `BU${"3".repeat(32)}`
const messagingSid = `MG${"4".repeat(32)}`
const secretSentinels = ["SENTINEL_API_KEY_SECRET", "SENTINEL_AUTH_TOKEN"]

function completeEnv(overrides = {}) {
  return {
    MCA_SMS_READINESS_TOOL_ENABLED: "true",
    MCA_SMS_PUBLIC_BASE_URL: "https://sms.example.test",
    MCA_SMS_PROVIDER: "twilio",
    MCA_SMS_TWILIO_ACCOUNTS_JSON: JSON.stringify({
      workspace: {
        DEFAULT: {
          accountSid,
          apiKeySid,
          apiKeySecret: secretSentinels[0],
          authToken: secretSentinels[1],
          allowedSenders: ["+12125551212", messagingSid],
        },
      },
    }),
    MCA_SMS_ISV_APPROVED: "true",
    MCA_SMS_ELIGIBILITY_REFERENCE: "synthetic-eligibility",
    MCA_TWILIO_PRIMARY_PROFILE_SID: profileSid,
    MCA_TWILIO_PARENT_ACCOUNT_SID: accountSid,
    MCA_TWILIO_PARENT_AUTH_TOKEN: "a".repeat(32),
    MCA_SMS_COMPLIANCE_EMAIL: "compliance@example.test",
    MCA_SMS_REGISTRATION_ESTIMATE_CENTS: "100",
    MCA_SMS_SEGMENT_ESTIMATE_CENTS: "1",
    MCA_SMS_CRON_ENABLED: "true",
    CRON_SECRET: "SENTINEL_CRON_SECRET",
    ...overrides,
  }
}

function runCli(env, args = []) {
  return spawnSync(process.execPath, [script, ...args], {
    cwd: appRoot,
    encoding: "utf8",
    env: { PATH: process.env.PATH, ...env },
  })
}

function codes(report) {
  return report.checks.map((check) => check.code)
}

function assertRedacted(result) {
  const output = `${result.stdout}${result.stderr}`
  for (const sentinel of [...secretSentinels, "SENTINEL_CRON_SECRET"]) assert.equal(output.includes(sentinel), false)
}

test("CLI remains inert for unset and near-miss enable flags", () => {
  for (const flag of [undefined, "false", "TRUE", "1", " true"]) {
    const result = runCli(flag === undefined ? {} : { MCA_SMS_READINESS_TOOL_ENABLED: flag })
    assert.equal(result.status, 0)
    assert.equal(result.stderr, "")
    assert.deepEqual(JSON.parse(result.stdout), {
      enabled: false,
      ready: false,
      message: "SMS readiness tool is disabled. Set MCA_SMS_READINESS_TOOL_ENABLED=true to run offline validation.",
      checks: [],
      webhookUrls: null,
    })
  }
})

test("CLI overlays process environment, reports complete synthetic configuration, and redacts secrets", () => {
  const envFile = join(temp, "complete.env")
  writeFileSync(envFile, Object.entries(completeEnv({ MCA_SMS_PUBLIC_BASE_URL: "https://file.example.test" })).map(([key, value]) => `${key}=${value}`).join("\n"))
  const result = runCli({ MCA_SMS_PUBLIC_BASE_URL: "https://override.example.test" }, ["--env-file", envFile, "--workspace-id", "workspace/id", "--account-id", "account id"])
  assert.equal(result.status, 0)
  assert.equal(result.stderr, "")
  assertRedacted(result)
  const report = JSON.parse(result.stdout)
  assert.equal(report.enabled, true)
  assert.equal(report.ready, true)
  assert.deepEqual(report.checks, [])
  assert.equal(report.webhookUrls.inboundAdvancedOptOut, "https://override.example.test/api/mca/sms/webhooks/twilio/account%20id/inbound")
  assert.equal(report.webhookUrls.eventStreamsRegistration, "https://override.example.test/api/mca/sms/webhooks/registration/workspace%2Fid")
  assert.equal(report.webhookUrls.eventStreamsRegistration.includes("bodySHA256"), false)
})

test("direct-account validation rejects malformed structures, SIDs, and sender allowlists", () => {
  for (const [json, expected] of [
    ["not json", "DIRECT_ACCOUNTS_JSON_INVALID"],
    ["[]", "DIRECT_ACCOUNTS_OBJECT_INVALID"],
    [JSON.stringify({ workspace: [] }), "DIRECT_REFERENCES_OBJECT_INVALID"],
    [JSON.stringify({ workspace: { DEFAULT: [] } }), "DIRECT_ACCOUNT_OBJECT_INVALID"],
  ]) {
    const report = validateSmsReadiness(completeEnv({ MCA_SMS_TWILIO_ACCOUNTS_JSON: json }))
    assert.equal(report.ready, false)
    assert.ok(codes(report).includes(expected))
  }

  const invalid = JSON.parse(completeEnv().MCA_SMS_TWILIO_ACCOUNTS_JSON)
  invalid.workspace.DEFAULT.accountSid = `XX${"1".repeat(32)}`
  invalid.workspace.DEFAULT.apiKeySid = `AC${"2".repeat(32)}`
  invalid.workspace.DEFAULT.allowedSenders = ["not-a-sender", "+12125551212", "+12125551212"]
  const report = validateSmsReadiness(completeEnv({ MCA_SMS_TWILIO_ACCOUNTS_JSON: JSON.stringify(invalid) }))
  assert.ok(codes(report).includes("DIRECT_ACCOUNT_SID_INVALID"))
  assert.ok(codes(report).includes("DIRECT_API_KEY_SID_INVALID"))
  assert.ok(codes(report).includes("DIRECT_ALLOWED_SENDER_INVALID"))
  assert.ok(codes(report).includes("DIRECT_ALLOWED_SENDER_DUPLICATE"))

  invalid.workspace.DEFAULT.allowedSenders = []
  assert.ok(codes(validateSmsReadiness(completeEnv({ MCA_SMS_TWILIO_ACCOUNTS_JSON: JSON.stringify(invalid) }))).includes("DIRECT_ALLOWED_SENDERS_INVALID"))
})

test("direct-account validation checks every workspace and reference without exposing values", () => {
  const nested = JSON.parse(completeEnv().MCA_SMS_TWILIO_ACCOUNTS_JSON)
  nested.second = { BROKEN: { accountSid, apiKeySid, apiKeySecret: "", authToken: "", allowedSenders: [messagingSid] } }
  const result = runCli({ ...completeEnv(), MCA_SMS_TWILIO_ACCOUNTS_JSON: JSON.stringify(nested) })
  assert.equal(result.status, 1)
  assertRedacted(result)
  const report = JSON.parse(result.stdout)
  assert.ok(codes(report).includes("DIRECT_API_KEY_SECRET_MISSING"))
  assert.ok(codes(report).includes("DIRECT_AUTH_TOKEN_MISSING"))
  assert.equal(result.stdout.includes("second"), false)
  assert.equal(result.stdout.includes("BROKEN"), false)
})

test("managed activation is coherent and estimates are positive base-10 integers", () => {
  const partial = validateSmsReadiness({ MCA_SMS_PUBLIC_BASE_URL: "https://sms.example.test", MCA_SMS_ELIGIBILITY_REFERENCE: "partial" })
  assert.equal(partial.ready, false)
  assert.ok(codes(partial).includes("MANAGED_ISV_APPROVAL_INVALID"))
  assert.ok(codes(partial).includes("MANAGED_PARENT_ACCOUNT_SID_INVALID"))

  for (const value of ["0", "-1", "1.5", "1e2", "abc"]) {
    const report = validateSmsReadiness(completeEnv({ MCA_SMS_REGISTRATION_ESTIMATE_CENTS: value, MCA_SMS_SEGMENT_ESTIMATE_CENTS: value }))
    assert.ok(codes(report).includes("MANAGED_REGISTRATION_ESTIMATE_INVALID"))
    assert.ok(codes(report).includes("MANAGED_SEGMENT_ESTIMATE_INVALID"))
  }

  const cron = validateSmsReadiness(completeEnv({ CRON_SECRET: "" }))
  assert.ok(codes(cron).includes("MANAGED_CRON_SECRET_MISSING"))

  const invalidIdentity = validateSmsReadiness(completeEnv({
    MCA_TWILIO_PRIMARY_PROFILE_SID: `AC${"3".repeat(32)}`,
    MCA_TWILIO_PARENT_ACCOUNT_SID: `SK${"1".repeat(32)}`,
    MCA_TWILIO_PARENT_AUTH_TOKEN: "not-an-auth-token",
    MCA_SMS_COMPLIANCE_EMAIL: "not-an-email",
  }))
  assert.ok(codes(invalidIdentity).includes("MANAGED_PRIMARY_PROFILE_SID_INVALID"))
  assert.ok(codes(invalidIdentity).includes("MANAGED_PARENT_ACCOUNT_SID_INVALID"))
  assert.ok(codes(invalidIdentity).includes("MANAGED_PARENT_AUTH_TOKEN_INVALID"))
  assert.ok(codes(invalidIdentity).includes("MANAGED_COMPLIANCE_EMAIL_INVALID"))
})

test("origin validation rejects HTTP, credentials, paths, and non-public hosts", () => {
  for (const origin of [
    "http://sms.example.test",
    "https://user:pass@sms.example.test",
    "https://sms.example.test/path",
    "https://sms.example.test/?query=yes",
    "https://localhost",
    "https://192.168.1.10",
  ]) {
    const report = validateSmsReadiness(completeEnv({ MCA_SMS_PUBLIC_BASE_URL: origin }))
    assert.ok(codes(report).includes("PUBLIC_BASE_URL_INVALID"), origin)
    assert.equal(report.webhookUrls.inboundAdvancedOptOut, null)
  }
})

test("origin falls back to MCA_APP_ORIGIN and missing callback identifiers omit only URLs", () => {
  const env = completeEnv({ MCA_SMS_PUBLIC_BASE_URL: "", MCA_APP_ORIGIN: "https://app.example.test" })
  const report = validateSmsReadiness(env)
  assert.equal(report.ready, true)
  assert.equal(report.webhookUrls.inboundAdvancedOptOut, null)
  assert.equal(report.webhookUrls.eventStreamsRegistration, null)
  assert.match(report.webhookUrls.deliveryStatus, /generated per message/)
  assert.deepEqual(buildSmsWebhookUrls("https://app.example.test", { workspaceId: "\n", accountId: "" }), report.webhookUrls)
})

test("pure readiness path performs no network request", () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = () => { throw new Error("network access attempted") }
  try {
    assert.equal(validateSmsReadiness(completeEnv()).ready, true)
  } finally {
    globalThis.fetch = originalFetch
  }
})
