import "server-only"

import { AppError } from "../errors"
import { assertExecutionActive, executionSignal } from "../jobs/execution"
import type { SenderProvider } from "./contracts"
import type { OAuthCredential } from "./repository"

const GOOGLE_AUTH = "https://accounts.google.com/o/oauth2/v2/auth"
const GOOGLE_TOKEN = "https://oauth2.googleapis.com/token"
const GOOGLE_USERINFO = "https://www.googleapis.com/oauth2/v2/userinfo"
const MICROSOFT_AUTH = "https://login.microsoftonline.com/common/oauth2/v2.0/authorize"
const MICROSOFT_TOKEN = "https://login.microsoftonline.com/common/oauth2/v2.0/token"
const MICROSOFT_ME = "https://graph.microsoft.com/v1.0/me"

export const GOOGLE_SENDER_SCOPES = [
  "https://www.googleapis.com/auth/gmail.send",
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/userinfo.email",
] as const

export const MICROSOFT_SENDER_SCOPES = [
  "offline_access",
  "https://graph.microsoft.com/Mail.Send",
  "https://graph.microsoft.com/Mail.Read",
  "https://graph.microsoft.com/User.Read",
] as const

export const SENDER_OAUTH_CALLBACK_PATH = "/api/mca/senders/oauth/callback"

type SenderFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
let fetchOverride: SenderFetch | undefined

export function setSenderOAuthFetchForTests(fetchImpl?: SenderFetch): void {
  fetchOverride = fetchImpl
}

function http(): SenderFetch {
  return fetchOverride ?? globalThis.fetch
}

export interface SenderOAuthConfig {
  provider: "google" | "microsoft"
  clientId: string
  clientSecret: string
  redirectUri: string
}

export function senderOAuthConfigured(provider: SenderProvider): boolean {
  try {
    senderOAuthConfig(provider)
    return true
  } catch {
    return false
  }
}

export function senderOAuthConfig(provider: SenderProvider): SenderOAuthConfig {
  if (provider !== "google" && provider !== "microsoft") {
    throw new AppError(422, "validation_failed", "OAuth is only available for Google and Microsoft senders.", {
      provider: ["Choose Google or Microsoft to start OAuth."],
    })
  }
  const origin = process.env.MCA_APP_ORIGIN?.trim()
  const clientId = provider === "google"
    ? process.env.MCA_GOOGLE_SENDER_CLIENT_ID?.trim()
    : process.env.MCA_MICROSOFT_SENDER_CLIENT_ID?.trim()
  const clientSecret = provider === "google"
    ? process.env.MCA_GOOGLE_SENDER_CLIENT_SECRET?.trim()
    : process.env.MCA_MICROSOFT_SENDER_CLIENT_SECRET?.trim()
  if (!clientId || !clientSecret || !origin) {
    const names = provider === "google"
      ? "MCA_GOOGLE_SENDER_CLIENT_ID, MCA_GOOGLE_SENDER_CLIENT_SECRET, and MCA_APP_ORIGIN"
      : "MCA_MICROSOFT_SENDER_CLIENT_ID, MCA_MICROSOFT_SENDER_CLIENT_SECRET, and MCA_APP_ORIGIN"
    throw new AppError(503, "sender_oauth_not_configured", `${provider === "google" ? "Google" : "Microsoft"} sender OAuth needs ${names}.`)
  }
  return {
    provider,
    clientId,
    clientSecret,
    redirectUri: `${origin.replace(/\/$/, "")}${SENDER_OAUTH_CALLBACK_PATH}`,
  }
}

export function senderAuthorizationUrl(provider: "google" | "microsoft", state: string): string {
  const config = senderOAuthConfig(provider)
  if (provider === "google") {
    const url = new URL(GOOGLE_AUTH)
    url.search = new URLSearchParams({
      client_id: config.clientId,
      redirect_uri: config.redirectUri,
      response_type: "code",
      scope: GOOGLE_SENDER_SCOPES.join(" "),
      access_type: "offline",
      prompt: "consent",
      include_granted_scopes: "true",
      state,
    }).toString()
    return url.toString()
  }
  const url = new URL(MICROSOFT_AUTH)
  url.search = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    response_type: "code",
    response_mode: "query",
    scope: MICROSOFT_SENDER_SCOPES.join(" "),
    state,
  }).toString()
  return url.toString()
}

async function oauthPost(url: string, body: URLSearchParams): Promise<Record<string, unknown>> {
  assertExecutionActive()
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 15_000)
  try {
    const response = await http()(url, {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.any([controller.signal, ...(executionSignal() ? [executionSignal()!] : [])]),
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
    })
    const payload = await response.json() as Record<string, unknown>
    if (!response.ok) {
      if (response.status === 429) throw new AppError(429, "sender_oauth_rate_limited", "The email provider is rate limited. Try again shortly.")
      if (response.status >= 500) throw new AppError(503, "sender_oauth_unavailable", "The email provider is temporarily unavailable.")
      throw new AppError(502, "sender_oauth_exchange_failed", "The email provider did not accept the authorization grant. Start the connection again.")
    }
    return payload
  } catch (error) {
    assertExecutionActive()
    if (error instanceof AppError) throw error
    throw new AppError(503, "sender_oauth_timeout", "Email sender authorization timed out. Start the connection again.")
  } finally {
    clearTimeout(timeout)
  }
}

function asCredential(payload: Record<string, unknown>, existing?: OAuthCredential): OAuthCredential {
  const accessToken = String(payload.access_token ?? "")
  const refreshToken = String(payload.refresh_token ?? "") || existing?.refreshToken
  if (!accessToken) {
    throw new AppError(502, "sender_oauth_exchange_failed", "The email provider did not return an access token. Start the connection again.")
  }
  const seconds = Number(payload.expires_in ?? 3600)
  return {
    kind: "oauth",
    accessToken,
    refreshToken,
    scope: String(payload.scope ?? existing?.scope ?? "") || undefined,
    expiresAt: new Date(Date.now() + Math.max(60, Number.isFinite(seconds) ? seconds : 3600) * 1000).toISOString(),
    email: existing?.email,
  }
}

export async function exchangeSenderAuthorizationCode(provider: "google" | "microsoft", code: string, existing?: OAuthCredential): Promise<OAuthCredential> {
  const config = senderOAuthConfig(provider)
  if (!code.trim()) throw new AppError(422, "sender_oauth_code_missing", "The email provider did not return an authorization code.")
  const tokenUrl = provider === "google" ? GOOGLE_TOKEN : MICROSOFT_TOKEN
  const payload = await oauthPost(tokenUrl, new URLSearchParams({
    code,
    client_id: config.clientId,
    client_secret: config.clientSecret,
    redirect_uri: config.redirectUri,
    grant_type: "authorization_code",
  }))
  const credential = asCredential(payload, existing)
  if (provider === "google" && !credential.refreshToken) {
    throw new AppError(422, "sender_oauth_offline_access", "Google did not return offline access. Revoke the prior grant and authorize again.")
  }
  if (provider === "microsoft" && !credential.refreshToken) {
    throw new AppError(422, "sender_oauth_offline_access", "Microsoft did not return offline access. Authorize the sender again.")
  }
  const email = await fetchSenderProfileEmail(provider, credential.accessToken)
  return { ...credential, email: email || credential.email }
}

export async function refreshSenderCredential(provider: "google" | "microsoft", credential: OAuthCredential): Promise<OAuthCredential> {
  if (!credential.refreshToken) {
    throw new AppError(401, "sender_reconnect_required", "Offline access is missing. Reconnect the sender.")
  }
  const config = senderOAuthConfig(provider)
  const tokenUrl = provider === "google" ? GOOGLE_TOKEN : MICROSOFT_TOKEN
  const payload = await oauthPost(tokenUrl, new URLSearchParams({
    refresh_token: credential.refreshToken,
    client_id: config.clientId,
    client_secret: config.clientSecret,
    grant_type: "refresh_token",
  }))
  return asCredential(payload, credential)
}

export async function fetchSenderProfileEmail(provider: "google" | "microsoft", accessToken: string): Promise<string | undefined> {
  const url = provider === "google" ? GOOGLE_USERINFO : MICROSOFT_ME
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 10_000)
  try {
    const response = await http()(url, {
      method: "GET",
      redirect: "error",
      signal: controller.signal,
      headers: { authorization: `Bearer ${accessToken}`, accept: "application/json" },
    })
    if (!response.ok) return undefined
    const payload = await response.json() as Record<string, unknown>
    const email = String(payload.email ?? payload.mail ?? payload.userPrincipalName ?? "").trim()
    return email || undefined
  } catch {
    return undefined
  } finally {
    clearTimeout(timeout)
  }
}
