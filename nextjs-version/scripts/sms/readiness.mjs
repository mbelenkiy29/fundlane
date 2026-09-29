#!/usr/bin/env node

import { existsSync, readFileSync } from "node:fs"
import { resolve } from "node:path"
import { pathToFileURL } from "node:url"

const ACCOUNT_SID = /^AC[0-9a-fA-F]{32}$/
const API_KEY_SID = /^SK[0-9a-fA-F]{32}$/
const MESSAGING_SERVICE_SID = /^MG[0-9a-fA-F]{32}$/
const PRIMARY_PROFILE_SID = /^BU[0-9a-fA-F]{32}$/
const AUTH_TOKEN = /^[0-9a-fA-F]{32}$/
const E164 = /^\+[1-9][0-9]{7,14}$/
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

const DISABLED_MESSAGE = "SMS readiness tool is disabled. Set MCA_SMS_READINESS_TOOL_ENABLED=true to run offline validation."
const READY_MESSAGE = "SMS configuration is structurally ready for hosted acceptance."
const INVALID_MESSAGE = "SMS configuration is not ready; resolve the reported check codes without pasting secret values into logs or tickets."
const DELIVERY_MESSAGE = "Delivery status callbacks are generated per message by Fundlane; do not configure a static status URL in the Twilio console."

function text(value) {
  return typeof value === "string" ? value.trim() : ""
}

function plainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype
}

function validIdentifier(value) {
  const normalized = text(value)
  return normalized.length > 0 && normalized.length <= 200 && !/[\u0000-\u001f\u007f]/.test(normalized)
}

export function cleanPublicOrigin(value) {
  try {
    const url = new URL(text(value))
    const hostname = url.hostname.toLowerCase()
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.pathname !== "/") return undefined
    if (!hostname.includes(".") || hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".local")) return undefined
    if (/^(?:10|127|169\.254|192\.168)\./.test(hostname)) return undefined
    const private172 = hostname.match(/^172\.(\d+)\./)
    if (private172 && Number(private172[1]) >= 16 && Number(private172[1]) <= 31) return undefined
    if (hostname === "::1" || hostname.startsWith("fc") || hostname.startsWith("fd") || hostname.startsWith("fe80:")) return undefined
    return url.origin
  } catch {
    return undefined
  }
}

export function buildSmsWebhookUrls(origin, ids = {}) {
  const cleanOrigin = cleanPublicOrigin(origin)
  const accountId = validIdentifier(ids.accountId) ? text(ids.accountId) : undefined
  const workspaceId = validIdentifier(ids.workspaceId) ? text(ids.workspaceId) : undefined
  return {
    inboundAdvancedOptOut: cleanOrigin && accountId
      ? `${cleanOrigin}/api/mca/sms/webhooks/twilio/${encodeURIComponent(accountId)}/inbound`
      : null,
    eventStreamsRegistration: cleanOrigin && workspaceId
      ? `${cleanOrigin}/api/mca/sms/webhooks/registration/${encodeURIComponent(workspaceId)}`
      : null,
    deliveryStatus: DELIVERY_MESSAGE,
  }
}

function issue(code, message, location) {
  return location ? { code, message, location } : { code, message }
}

function validateDirect(env, checks) {
  const raw = text(env.MCA_SMS_TWILIO_ACCOUNTS_JSON)
  const configured = Boolean(text(env.MCA_SMS_PROVIDER)) || (raw !== "" && raw !== "{}")
  if (!configured) return

  if (env.MCA_SMS_PROVIDER !== "twilio") {
    checks.push(issue("DIRECT_PROVIDER_INVALID", "MCA_SMS_PROVIDER must be exactly twilio."))
  }

  let workspaces
  try {
    workspaces = JSON.parse(raw)
  } catch {
    checks.push(issue("DIRECT_ACCOUNTS_JSON_INVALID", "Invalid MCA_SMS_TWILIO_ACCOUNTS_JSON."))
    return
  }
  if (!plainObject(workspaces) || Object.keys(workspaces).length === 0) {
    checks.push(issue("DIRECT_ACCOUNTS_OBJECT_INVALID", "MCA_SMS_TWILIO_ACCOUNTS_JSON must be a nonempty plain object."))
    return
  }

  for (const [workspaceIndex, [workspaceId, references]] of Object.entries(workspaces).entries()) {
    const workspacePath = `MCA_SMS_TWILIO_ACCOUNTS_JSON.<workspace #${workspaceIndex + 1}>`
    if (!text(workspaceId)) checks.push(issue("DIRECT_WORKSPACE_ID_INVALID", "Workspace identifiers must be nonempty.", workspacePath))
    if (!plainObject(references) || Object.keys(references).length === 0) {
      checks.push(issue("DIRECT_REFERENCES_OBJECT_INVALID", "Each workspace must contain a nonempty plain reference object.", workspacePath))
      continue
    }
    for (const [referenceIndex, [reference, account]] of Object.entries(references).entries()) {
      const accountPath = `${workspacePath}.<reference #${referenceIndex + 1}>`
      if (!text(reference)) checks.push(issue("DIRECT_REFERENCE_INVALID", "Credential references must be nonempty.", accountPath))
      if (!plainObject(account)) {
        checks.push(issue("DIRECT_ACCOUNT_OBJECT_INVALID", "Each Twilio account must be a plain object.", accountPath))
        continue
      }
      if (!ACCOUNT_SID.test(text(account.accountSid))) checks.push(issue("DIRECT_ACCOUNT_SID_INVALID", "Invalid Twilio Account SID.", `${accountPath}.accountSid`))
      if (!API_KEY_SID.test(text(account.apiKeySid))) checks.push(issue("DIRECT_API_KEY_SID_INVALID", "Invalid Twilio API key SID.", `${accountPath}.apiKeySid`))
      if (!text(account.apiKeySecret)) checks.push(issue("DIRECT_API_KEY_SECRET_MISSING", "Twilio API key secret is required.", `${accountPath}.apiKeySecret`))
      if (!text(account.authToken)) checks.push(issue("DIRECT_AUTH_TOKEN_MISSING", "Twilio auth token is required.", `${accountPath}.authToken`))
      if (!Array.isArray(account.allowedSenders) || account.allowedSenders.length === 0) {
        checks.push(issue("DIRECT_ALLOWED_SENDERS_INVALID", "A nonempty allowedSenders array is required.", `${accountPath}.allowedSenders`))
        continue
      }
      const seen = new Set()
      for (const [senderIndex, senderValue] of account.allowedSenders.entries()) {
        const sender = text(senderValue)
        const senderPath = `${accountPath}.allowedSenders[${senderIndex}]`
        if (!(E164.test(sender) || MESSAGING_SERVICE_SID.test(sender))) {
          checks.push(issue("DIRECT_ALLOWED_SENDER_INVALID", "Allowed senders must be E.164 numbers or Twilio Messaging Service SIDs.", senderPath))
        } else if (seen.has(sender)) {
          checks.push(issue("DIRECT_ALLOWED_SENDER_DUPLICATE", "Allowed senders must be unique within an account.", senderPath))
        }
        seen.add(sender)
      }
    }
  }
}

function positiveInteger(value) {
  return /^[1-9][0-9]*$/.test(text(value))
}

function validateManaged(env, checks) {
  const managedKeys = [
    "MCA_SMS_ELIGIBILITY_REFERENCE", "MCA_TWILIO_PRIMARY_PROFILE_SID", "MCA_TWILIO_PARENT_ACCOUNT_SID",
    "MCA_TWILIO_PARENT_AUTH_TOKEN", "MCA_SMS_COMPLIANCE_EMAIL", "MCA_SMS_REGISTRATION_ESTIMATE_CENTS",
    "MCA_SMS_SEGMENT_ESTIMATE_CENTS",
  ]
  const configured = env.MCA_SMS_ISV_APPROVED === "true" || env.MCA_SMS_CRON_ENABLED === "true" || managedKeys.some((key) => Boolean(text(env[key])))
  if (!configured) return

  if (env.MCA_SMS_ISV_APPROVED !== "true") checks.push(issue("MANAGED_ISV_APPROVAL_INVALID", "MCA_SMS_ISV_APPROVED must be exactly true."))
  if (!text(env.MCA_SMS_ELIGIBILITY_REFERENCE)) checks.push(issue("MANAGED_ELIGIBILITY_REFERENCE_MISSING", "MCA_SMS_ELIGIBILITY_REFERENCE is required."))
  if (!PRIMARY_PROFILE_SID.test(text(env.MCA_TWILIO_PRIMARY_PROFILE_SID))) checks.push(issue("MANAGED_PRIMARY_PROFILE_SID_INVALID", "Invalid MCA_TWILIO_PRIMARY_PROFILE_SID."))
  if (!ACCOUNT_SID.test(text(env.MCA_TWILIO_PARENT_ACCOUNT_SID))) checks.push(issue("MANAGED_PARENT_ACCOUNT_SID_INVALID", "Invalid MCA_TWILIO_PARENT_ACCOUNT_SID."))
  if (!AUTH_TOKEN.test(text(env.MCA_TWILIO_PARENT_AUTH_TOKEN))) checks.push(issue("MANAGED_PARENT_AUTH_TOKEN_INVALID", "Invalid MCA_TWILIO_PARENT_AUTH_TOKEN."))
  if (!EMAIL.test(text(env.MCA_SMS_COMPLIANCE_EMAIL))) checks.push(issue("MANAGED_COMPLIANCE_EMAIL_INVALID", "Invalid MCA_SMS_COMPLIANCE_EMAIL."))
  if (!positiveInteger(env.MCA_SMS_REGISTRATION_ESTIMATE_CENTS)) checks.push(issue("MANAGED_REGISTRATION_ESTIMATE_INVALID", "MCA_SMS_REGISTRATION_ESTIMATE_CENTS must be a positive base-10 integer."))
  if (!positiveInteger(env.MCA_SMS_SEGMENT_ESTIMATE_CENTS)) checks.push(issue("MANAGED_SEGMENT_ESTIMATE_INVALID", "MCA_SMS_SEGMENT_ESTIMATE_CENTS must be a positive base-10 integer."))
  if (env.MCA_SMS_CRON_ENABLED === "true" && !text(env.CRON_SECRET)) checks.push(issue("MANAGED_CRON_SECRET_MISSING", "CRON_SECRET is required when MCA_SMS_CRON_ENABLED=true."))
}

export function validateSmsReadiness(env, ids = {}) {
  const checks = []
  const origin = text(env.MCA_SMS_PUBLIC_BASE_URL) || text(env.MCA_APP_ORIGIN)
  if (!cleanPublicOrigin(origin)) checks.push(issue("PUBLIC_BASE_URL_INVALID", "Invalid MCA_SMS_PUBLIC_BASE_URL."))
  validateDirect(env, checks)
  validateManaged(env, checks)
  const ready = checks.length === 0
  return {
    enabled: true,
    ready,
    message: ready ? READY_MESSAGE : INVALID_MESSAGE,
    checks,
    webhookUrls: buildSmsWebhookUrls(origin, ids),
  }
}

export function parseEnvFile(path) {
  if (!path || !existsSync(path)) return {}
  const values = {}
  for (const rawLine of readFileSync(path, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith("#")) continue
    const match = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/)
    if (!match) continue
    let value = match[2].trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1)
    values[match[1]] = value
  }
  return values
}

function cliArguments(argv) {
  const result = { envFile: ".env.local" }
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index]
    if (!["--env-file", "--workspace-id", "--account-id"].includes(name) || index + 1 >= argv.length) return undefined
    const value = argv[index += 1]
    if (name === "--env-file") result.envFile = value
    if (name === "--workspace-id") result.workspaceId = value
    if (name === "--account-id") result.accountId = value
  }
  return result
}

export function runCli(argv = process.argv.slice(2), processEnv = process.env) {
  const args = cliArguments(argv)
  const fileEnv = args ? parseEnvFile(resolve(process.cwd(), args.envFile)) : {}
  const env = { ...fileEnv, ...processEnv }
  if (env.MCA_SMS_READINESS_TOOL_ENABLED !== "true") {
    console.log(JSON.stringify({ enabled: false, ready: false, message: DISABLED_MESSAGE, checks: [], webhookUrls: null }))
    return 0
  }
  const report = args
    ? validateSmsReadiness(env, { workspaceId: args.workspaceId, accountId: args.accountId })
    : { enabled: true, ready: false, message: INVALID_MESSAGE, checks: [issue("CLI_ARGUMENT_INVALID", "Invalid command arguments.")], webhookUrls: buildSmsWebhookUrls("") }
  console.log(JSON.stringify(report, null, 2))
  return report.ready ? 0 : 1
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  process.exitCode = runCli()
}
