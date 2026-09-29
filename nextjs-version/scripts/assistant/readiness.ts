import { pathToFileURL } from "node:url"

const DISABLED_MESSAGE = "Assistant readiness check is disabled. Set MCA_ASSISTANT_READINESS_CHECK_ENABLED=true to run the offline check."
const VALID_MESSAGE = "Assistant readiness configuration is valid for offline checks."
const INVALID_MESSAGE = "Assistant readiness configuration is invalid."
const MODEL_INVALID_MESSAGE = "The configured model identifier failed local syntax validation."
const MODEL_VALID_MESSAGE = "Model identifier syntax passed; provider access and model capabilities were not verified."

export type ReadinessCheck = {
  field: string
  status: "pass" | "fail" | "warning" | "disabled"
  message?: string
}

export type AssistantReadinessResult = {
  ok: boolean
  enabled: boolean
  checks: ReadinessCheck[]
  errors: string[]
}

function validModelIdentifier(value: string | undefined) {
  if (!value || value !== value.trim() || value.length > 128 || /[\s\p{Cc}]/u.test(value)) return false
  const normalized = value.toLowerCase().replace(/[^a-z0-9]/g, "")
  return !["placeholder", "changeme", "replaceme", "yourmodel", "modelid", "example"].includes(normalized)
}

export function validateAssistantReadiness(env: NodeJS.ProcessEnv): AssistantReadinessResult {
  if (env.MCA_ASSISTANT_READINESS_CHECK_ENABLED !== "true") {
    return { ok: true, enabled: false, checks: [], errors: [] }
  }

  const checks: ReadinessCheck[] = []
  const errors: string[] = []
  const check = (field: string, valid: boolean, message: string) => {
    checks.push({ field, status: valid ? "pass" : "fail", message: valid ? undefined : message })
    if (!valid) errors.push(message)
  }

  check("MCA_ASSISTANT_RUNTIME", env.MCA_ASSISTANT_RUNTIME === "vercel_node", "MCA_ASSISTANT_RUNTIME must be vercel_node.")
  checks.push({ field: "MCA_ASSISTANT_ENABLED", status: env.MCA_ASSISTANT_ENABLED === "true" ? "pass" : "disabled" })
  checks.push({ field: "MCA_ASSISTANT_MAINTENANCE_ENABLED", status: env.MCA_ASSISTANT_MAINTENANCE_ENABLED === "true" ? "pass" : "disabled" })
  check("OPENAI_API_KEY", Boolean(env.OPENAI_API_KEY), "OPENAI_API_KEY is required for the native assistant.")
  check("MCA_ASSISTANT_MODEL", Boolean(env.MCA_ASSISTANT_MODEL), "MCA_ASSISTANT_MODEL is required for the native assistant.")
  if (env.MCA_ASSISTANT_MODEL) check("MCA_ASSISTANT_MODEL (syntax only)", validModelIdentifier(env.MCA_ASSISTANT_MODEL), MODEL_INVALID_MESSAGE)
  check("MCA_ASSISTANT_SIGNING_SECRET", Buffer.byteLength(env.MCA_ASSISTANT_SIGNING_SECRET ?? "", "utf8") >= 32, "MCA_ASSISTANT_SIGNING_SECRET must contain at least 32 bytes.")

  if (env.MCA_DOCUMENT_AI_PROVIDER) {
    check("MCA_DOCUMENT_AI_PROVIDER", env.MCA_DOCUMENT_AI_PROVIDER === "openai", "MCA_DOCUMENT_AI_PROVIDER must be openai when document AI is configured.")
    check("OPENAI_API_KEY (document AI)", Boolean(env.OPENAI_API_KEY), "OPENAI_API_KEY is required for the native assistant.")
    check("MCA_DOCUMENT_AI_MODEL", Boolean(env.MCA_DOCUMENT_AI_MODEL), "MCA_DOCUMENT_AI_MODEL is required when document AI is configured.")
    if (env.MCA_DOCUMENT_AI_MODEL) check("MCA_DOCUMENT_AI_MODEL (syntax only)", validModelIdentifier(env.MCA_DOCUMENT_AI_MODEL), MODEL_INVALID_MESSAGE)
  } else {
    checks.push({ field: "MCA_DOCUMENT_AI_PROVIDER", status: "disabled", message: "Document AI is not configured and remains disabled." })
  }

  if (env.MCA_ASSISTANT_SERVICE_URL || env.MCA_ASSISTANT_DOMAIN_KEY) {
    checks.push({ field: "legacy ChatKit configuration", status: "warning", message: "Legacy ChatKit configuration is present but is not required by the Vercel Node runtime." })
  }

  return { ok: errors.length === 0, enabled: true, checks, errors }
}

export function formatAssistantReadiness(result: AssistantReadinessResult) {
  if (!result.enabled) return DISABLED_MESSAGE
  const lines = [result.ok ? VALID_MESSAGE : INVALID_MESSAGE]
  for (const check of result.checks) {
    lines.push(`[${check.status}] ${check.field}${check.message ? `: ${check.message}` : ""}`)
    if (check.status === "pass" && check.field.endsWith("(syntax only)")) lines.push(`[syntax only] ${check.field}: ${MODEL_VALID_MESSAGE}`)
  }
  return lines.join("\n")
}

export function runAssistantReadinessCli(env: NodeJS.ProcessEnv = process.env) {
  const result = validateAssistantReadiness(env)
  console.log(formatAssistantReadiness(result))
  return result.ok ? 0 : 1
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  process.exitCode = runAssistantReadinessCli()
}
