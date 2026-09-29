import { pathToFileURL } from "node:url"

import { SENDER_OAUTH_CALLBACK_PATH } from "../../src/lib/mca/senders/oauth"

type ReadinessEnvironment = Readonly<Record<string, string | undefined>>
type ProviderStatus = "ready" | "not configured" | "partial (missing ID or secret)"

export interface EmailSenderReadinessReport {
  ready: boolean
  checks: {
    runtime: { ready: boolean }
    appOrigin: { ready: boolean; value?: string }
    callback: { ready: boolean; value?: string }
    cronSecret: { ready: boolean }
    providers: {
      google: { status: ProviderStatus }
      microsoft: { status: ProviderStatus }
    }
  }
}

function present(value: string | undefined): boolean {
  return Boolean(value?.trim())
}

function canonicalHttpsOrigin(value: string | undefined): string | undefined {
  const candidate = value?.trim()
  if (!candidate) return undefined

  try {
    const url = new URL(candidate)
    if (
      url.protocol !== "https:"
      || url.username
      || url.password
      || url.pathname !== "/"
      || url.search
      || url.hash
    ) return undefined
    return url.origin
  } catch {
    return undefined
  }
}

function providerStatus(clientId: string | undefined, clientSecret: string | undefined): ProviderStatus {
  const hasId = present(clientId)
  const hasSecret = present(clientSecret)
  if (hasId && hasSecret) return "ready"
  if (!hasId && !hasSecret) return "not configured"
  return "partial (missing ID or secret)"
}

export function inspectEmailSenderReadiness(env: ReadinessEnvironment): EmailSenderReadinessReport {
  const origin = canonicalHttpsOrigin(env.MCA_APP_ORIGIN)
  const callback = origin ? `${origin}${SENDER_OAUTH_CALLBACK_PATH}` : undefined
  const checks: EmailSenderReadinessReport["checks"] = {
    runtime: { ready: env.MCA_EMAIL_CONVERSATIONS_RUNTIME === "vercel_cron" },
    appOrigin: { ready: Boolean(origin), ...(origin ? { value: origin } : {}) },
    callback: { ready: Boolean(callback), ...(callback ? { value: callback } : {}) },
    cronSecret: { ready: present(env.CRON_SECRET) },
    providers: {
      google: {
        status: providerStatus(env.MCA_GOOGLE_SENDER_CLIENT_ID, env.MCA_GOOGLE_SENDER_CLIENT_SECRET),
      },
      microsoft: {
        status: providerStatus(env.MCA_MICROSOFT_SENDER_CLIENT_ID, env.MCA_MICROSOFT_SENDER_CLIENT_SECRET),
      },
    },
  }
  const ready = checks.runtime.ready
    && checks.appOrigin.ready
    && checks.callback.ready
    && checks.cronSecret.ready
    && (checks.providers.google.status === "ready" || checks.providers.microsoft.status === "ready")
    && checks.providers.google.status !== "partial (missing ID or secret)"
    && checks.providers.microsoft.status !== "partial (missing ID or secret)"
  return { ready, checks }
}

export function assertEmailSenderReadinessEnabled(env: ReadinessEnvironment): void {
  if (env.MCA_EMAIL_SENDER_READINESS_ENABLED !== "true") {
    throw new Error("Email sender readiness is disabled. Set MCA_EMAIL_SENDER_READINESS_ENABLED=true to run this offline check.")
  }
}

export function main(env: ReadinessEnvironment = process.env): void {
  assertEmailSenderReadinessEnabled(env)
  const report = inspectEmailSenderReadiness(env)
  const commonReady = report.checks.runtime.ready
    && report.checks.appOrigin.ready
    && report.checks.callback.ready
    && report.checks.cronSecret.ready

  process.stdout.write("Email sender OAuth readiness\n")
  process.stdout.write(`Runtime: ${commonReady ? "ready" : "missing"}\n`)
  process.stdout.write(`Google: ${report.checks.providers.google.status}\n`)
  process.stdout.write(`Microsoft: ${report.checks.providers.microsoft.status}\n`)
  if (report.checks.callback.value) process.stdout.write(`OAuth callback: ${report.checks.callback.value}\n`)
  process.stdout.write(report.ready
    ? "Readiness passed. No provider or database calls were made.\n"
    : "Readiness failed. Fix the missing or invalid configuration before hosted OAuth acceptance.\n")
  if (!report.ready) process.exitCode = 1
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    main()
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : "Email sender readiness is disabled. Set MCA_EMAIL_SENDER_READINESS_ENABLED=true to run this offline check."}\n`)
    process.exitCode = 1
  }
}
