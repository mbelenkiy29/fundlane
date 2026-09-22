#!/usr/bin/env node
/**
 * Checks a local `.env.local` for the variables needed to run the app and to
 * live-test SMS/email messaging from the assistant chat.
 *
 * Usage (from nextjs-version/):
 *   node scripts/messaging/check-env.mjs [--env-file path/to/.env.local]
 *
 * Exit code 0 always; reports are informational.
 */
import { readFileSync, existsSync } from "node:fs"
import { join, resolve } from "node:path"

const flagIndex = process.argv.indexOf("--env-file")
const envPath = resolve(
  process.cwd(),
  flagIndex >= 0 ? process.argv[flagIndex + 1] : ".env.local"
)

function loadDotenv(path) {
  const vars = {}
  if (!existsSync(path)) return vars
  const text = readFileSync(path, "utf8")
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith("#")) continue
    const match = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/)
    if (!match) continue
    let value = match[2].trim()
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    )
      value = value.slice(1, -1)
    vars[match[1]] = value
  }
  return vars
}

const env = loadDotenv(envPath)
const has = (key) => Boolean(env[key] && env[key].trim())

function printable(value, max = 40) {
  if (!value) return "—"
  const text = String(value)
  return text.length > max ? `${text.slice(0, max)}…` : text
}

function group(title, rows) {
  console.log(`\n${title}`)
  for (const row of rows) {
    const mark = row.ok ? "✓" : "✗"
    console.log(`  ${mark} ${row.key.padEnd(38, " ")} ${row.note}`)
  }
}

function urlOk(value) {
  try {
    new URL(value)
    return true
  } catch {
    return false
  }
}

function twilioOk(value) {
  try {
    const parsed = JSON.parse(value)
    const workspaces = Object.entries(parsed)
    if (!workspaces.length) return false
    return workspaces.some(([, accounts]) => {
      const list = Object.values(accounts ?? {})
      return list.some(
        (a) =>
          a &&
          (a.accountSid || "").startsWith("AC") &&
          Boolean(a.apiKeySid) &&
          Boolean(a.apiKeySecret) &&
          Boolean(a.authToken)
      )
    })
  } catch {
    return false
  }
}

console.log(`Loaded ${envPath}`)
console.log(`  ${Object.keys(env).length} variable(s) defined\n`)

group("App boot (required to run the app at all)", [
  {
    key: "NEXT_PUBLIC_SUPABASE_URL",
    ok: has("NEXT_PUBLIC_SUPABASE_URL") && urlOk(env.NEXT_PUBLIC_SUPABASE_URL),
    note: printable(env.NEXT_PUBLIC_SUPABASE_URL),
  },
  {
    key: "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY",
    ok: has("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY"),
    note: printable(env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY),
  },
  {
    key: "SUPABASE_URL",
    ok: has("SUPABASE_URL") && urlOk(env.SUPABASE_URL),
    note: printable(env.SUPABASE_URL),
  },
  {
    key: "SUPABASE_SECRET_KEY",
    ok: has("SUPABASE_SECRET_KEY"),
    note: printable(env.SUPABASE_SECRET_KEY),
  },
  {
    key: "DATABASE_URL",
    ok: has("DATABASE_URL") && urlOk(env.DATABASE_URL),
    note: printable(env.DATABASE_URL, 60),
  },
  {
    key: "MCA_DATA_ENCRYPTION_KEY",
    ok: has("MCA_DATA_ENCRYPTION_KEY"),
    note: "encrypts SMS recipients in the database",
  },
  {
    key: "MCA_APP_ORIGIN",
    ok: has("MCA_APP_ORIGIN") && urlOk(env.MCA_APP_ORIGIN),
    note: printable(env.MCA_APP_ORIGIN),
  },
])

group("SMS — sending texts from the panel and inbox", [
  {
    key: "MCA_SMS_PROVIDER",
    ok: has("MCA_SMS_PROVIDER") && env.MCA_SMS_PROVIDER === "twilio",
    note: printable(env.MCA_SMS_PROVIDER) + (has("MCA_SMS_PROVIDER") && env.MCA_SMS_PROVIDER !== "twilio" ? "  (only twilio is supported for direct sends)" : ""),
  },
  {
    key: "MCA_SMS_TWILIO_ACCOUNTS_JSON",
    ok: has("MCA_SMS_TWILIO_ACCOUNTS_JSON") && twilioOk(env.MCA_SMS_TWILIO_ACCOUNTS_JSON),
    note: twilioOk(env.MCA_SMS_TWILIO_ACCOUNTS_JSON)
      ? "JSON with ≥1 account { accountSid, apiKeySid, apiKeySecret, authToken }"
      : "expects { \"<workspaceId-or-*\">: { \"<account>\": { accountSid, apiKeySid, apiKeySecret, authToken, allowedSenders } } }",
  },
  {
    key: "MCA_SMS_PUBLIC_BASE_URL",
    ok: has("MCA_SMS_PUBLIC_BASE_URL") && urlOk(env.MCA_SMS_PUBLIC_BASE_URL) && env.MCA_SMS_PUBLIC_BASE_URL.startsWith("https"),
    note: printable(env.MCA_SMS_PUBLIC_BASE_URL, 50) + "  (https webhook/status URL for Twilio)",
  },
])

group("Email — sending email from the panel and inbox", [
  {
    key: "(in-app sender)",
    ok: true,
    note: "No email env var is required — connect a Google/Microsoft sender in the email inbox, then the panel uses it.",
  },
])

group("Assistant — draft tooling", [
  {
    key: "MCA_ASSISTANT_SERVICE_URL",
    ok: true,
    note: has("MCA_ASSISTANT_SERVICE_URL")
      ? `optional: ${printable(env.MCA_ASSISTANT_SERVICE_URL, 50)} (legacy ChatKit host; suspended — drafts run on the native runtime)`
      : "not set — native (Supabase) runtime is used, which is where drafts work",
  },
])

const critical = [
  "NEXT_PUBLIC_SUPABASE_URL",
  "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY",
  "SUPABASE_URL",
  "SUPABASE_SECRET_KEY",
  "DATABASE_URL",
  "MCA_DATA_ENCRYPTION_KEY",
]
const missing = critical.filter((key) => !has(key))
if (missing.length) {
  console.log(
    `\nMissing app-boot variables: ${missing.join(", ")}. Copy .env.example to .env.local and fill them.`
  )
} else {
  console.log(
    `\nApp boot variables are present. Run:  node scripts/messaging/seed-live-user.ts --help`
  )
}