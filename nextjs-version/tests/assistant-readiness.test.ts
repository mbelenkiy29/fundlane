import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { test } from "node:test"
import { fileURLToPath } from "node:url"
import { formatAssistantReadiness, validateAssistantReadiness } from "../scripts/assistant/readiness"

const validEnv = (): NodeJS.ProcessEnv => ({
  NODE_ENV: "test",
  MCA_ASSISTANT_READINESS_CHECK_ENABLED: "true",
  MCA_ASSISTANT_RUNTIME: "vercel_node",
  OPENAI_API_KEY: "synthetic-openai-secret-never-print",
  MCA_ASSISTANT_MODEL: "opaque-assistant-model-2026-09",
  MCA_ASSISTANT_SIGNING_SECRET: "synthetic-signing-secret-at-least-32-bytes",
})

test("unset and non-exact readiness flags are inert", () => {
  for (const value of [undefined, "", "false", "TRUE", "1"]) {
    const env: NodeJS.ProcessEnv = {
      NODE_ENV: "test",
      MCA_ASSISTANT_READINESS_CHECK_ENABLED: value,
      MCA_ASSISTANT_RUNTIME: "wrong",
    }
    let inspected = false
    const guarded = new Proxy(env, {
      get(target, key, receiver) {
        if (key !== "MCA_ASSISTANT_READINESS_CHECK_ENABLED") inspected = true
        return Reflect.get(target, key, receiver)
      },
    })
    const result = validateAssistantReadiness(guarded)
    assert.deepEqual(result, { ok: true, enabled: false, checks: [], errors: [] })
    assert.equal(inspected, false)
  }
})

test("complete Vercel Node assistant configuration passes without a legacy URL", () => {
  const result = validateAssistantReadiness(validEnv())
  assert.equal(result.ok, true)
  assert.equal(result.enabled, true)
  assert.equal(result.checks.some(check => check.field === "MCA_ASSISTANT_SERVICE_URL"), false)
  assert.match(formatAssistantReadiness(result), /provider access and model capabilities were not verified/)
})

test("every required assistant field fails independently", () => {
  for (const [field, value, expected] of [
    ["MCA_ASSISTANT_RUNTIME", undefined, "MCA_ASSISTANT_RUNTIME must be vercel_node."],
    ["OPENAI_API_KEY", undefined, "OPENAI_API_KEY is required for the native assistant."],
    ["MCA_ASSISTANT_MODEL", undefined, "MCA_ASSISTANT_MODEL is required for the native assistant."],
    ["MCA_ASSISTANT_SIGNING_SECRET", undefined, "MCA_ASSISTANT_SIGNING_SECRET must contain at least 32 bytes."],
    ["MCA_ASSISTANT_SIGNING_SECRET", "1234567890123456789012345678901", "MCA_ASSISTANT_SIGNING_SECRET must contain at least 32 bytes."],
  ] as const) {
    const env = validEnv()
    if (value === undefined) delete env[field]
    else env[field] = value
    const result = validateAssistantReadiness(env)
    assert.equal(result.ok, false, field)
    assert.ok(result.errors.includes(expected), field)
  }
  assert.equal(validateAssistantReadiness({ ...validEnv(), MCA_ASSISTANT_SIGNING_SECRET: "😀".repeat(8) }).ok, true)
})

test("assistant activation flags are status-only with exact-true semantics", () => {
  const inactive = validateAssistantReadiness({ ...validEnv(), MCA_ASSISTANT_ENABLED: "TRUE", MCA_ASSISTANT_MAINTENANCE_ENABLED: "false" })
  assert.equal(inactive.ok, true)
  assert.equal(inactive.checks.find(check => check.field === "MCA_ASSISTANT_ENABLED")?.status, "disabled")
  const active = validateAssistantReadiness({ ...validEnv(), MCA_ASSISTANT_ENABLED: "true", MCA_ASSISTANT_MAINTENANCE_ENABLED: "true" })
  assert.equal(active.ok, true)
  assert.equal(active.checks.find(check => check.field === "MCA_ASSISTANT_MAINTENANCE_ENABLED")?.status, "pass")
})

test("document AI may be absent but partial and unsupported configurations fail", () => {
  const absent = validateAssistantReadiness(validEnv())
  assert.equal(absent.ok, true)
  assert.match(formatAssistantReadiness(absent), /Document AI is not configured and remains disabled\./)

  for (const env of [
    { ...validEnv(), MCA_DOCUMENT_AI_PROVIDER: "other", MCA_DOCUMENT_AI_MODEL: "opaque-document-model" },
    { ...validEnv(), MCA_DOCUMENT_AI_PROVIDER: "openai" },
    { ...validEnv(), MCA_DOCUMENT_AI_PROVIDER: "openai", MCA_DOCUMENT_AI_MODEL: "opaque-document-model", OPENAI_API_KEY: "" },
  ]) assert.equal(validateAssistantReadiness(env).ok, false)

  assert.equal(validateAssistantReadiness({ ...validEnv(), MCA_DOCUMENT_AI_PROVIDER: "openai", MCA_DOCUMENT_AI_MODEL: "opaque-document-model" }).ok, true)
})

test("model identifiers receive syntax-only validation", () => {
  for (const model of [" placeholder ", "change-me", "two words", "line\nbreak", "x".repeat(129)]) {
    const result = validateAssistantReadiness({ ...validEnv(), MCA_ASSISTANT_MODEL: model })
    assert.equal(result.ok, false, model)
    assert.ok(result.errors.includes("The configured model identifier failed local syntax validation."))
  }
  const result = validateAssistantReadiness({ ...validEnv(), MCA_ASSISTANT_MODEL: "vendor/model.v9:2026-opaque" })
  assert.equal(result.ok, true)
  assert.match(formatAssistantReadiness(result), /syntax only[\s\S]*provider access and model capabilities were not verified/)
})

test("formatted results expose statuses but no configured values", () => {
  const env: NodeJS.ProcessEnv = {
    ...validEnv(),
    MCA_ASSISTANT_SERVICE_URL: "https://secret-service.example.test",
    MCA_ASSISTANT_DOMAIN_KEY: "synthetic-domain-secret",
  }
  const output = formatAssistantReadiness(validateAssistantReadiness(env))
  assert.match(output, /\[warning\] legacy ChatKit configuration/)
  assert.match(output, /Legacy ChatKit configuration is present but is not required by the Vercel Node runtime\./)
  for (const secret of [env.OPENAI_API_KEY, env.MCA_ASSISTANT_SIGNING_SECRET, env.MCA_ASSISTANT_SERVICE_URL, env.MCA_ASSISTANT_DOMAIN_KEY]) {
    assert.equal(output.includes(secret!), false)
  }
})

test("CLI is inert with the flag off and exits nonzero for invalid enabled configuration", () => {
  const script = fileURLToPath(new URL("../scripts/assistant/readiness.ts", import.meta.url))
  const run = (env: NodeJS.ProcessEnv) => spawnSync(process.execPath, ["--import", "tsx", script], {
    cwd: fileURLToPath(new URL("../", import.meta.url)),
    env: { PATH: process.env.PATH, ...env },
    encoding: "utf8",
  })
  const inert = run({ NODE_ENV: "test" })
  assert.equal(inert.status, 0)
  assert.equal(inert.stdout.trim(), "Assistant readiness check is disabled. Set MCA_ASSISTANT_READINESS_CHECK_ENABLED=true to run the offline check.")
  const invalid = run({ NODE_ENV: "test", MCA_ASSISTANT_READINESS_CHECK_ENABLED: "true" })
  assert.equal(invalid.status, 1)
  assert.match(invalid.stdout, /^Assistant readiness configuration is invalid\./)
  const valid = run(validEnv())
  assert.equal(valid.status, 0)
  assert.match(valid.stdout, /^Assistant readiness configuration is valid for offline checks\./)
})

test("validation performs no fetch or database work", () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = () => { throw new Error("fetch must not be called") }
  try {
    assert.equal(validateAssistantReadiness(validEnv()).ok, true)
  } finally {
    globalThis.fetch = originalFetch
  }
})
