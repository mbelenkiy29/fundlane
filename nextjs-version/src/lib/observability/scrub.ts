/**
 * Privacy filters applied to everything Fundlane sends to Sentry, in the browser
 * and on the server. Sentry is an exception to the native-log rule in
 * docs/platform-status.md (stacks are sent), so every message, URL, header,
 * breadcrumb, log, span and replay frame passes through here first.
 *
 * Browser-safe: no server-only imports. Types are structural so the functions can
 * be unit-tested without the SDK.
 */
import { RequestError } from "../mca/client"
import { redactDiagnosticText } from "../mca/error-diagnostics"
import { wasCaughtError } from "./caught-errors"

type Dict = Record<string, unknown>

// Path segments that carry bearer-style access tokens (merchant upload links,
// public application links, review links, signed downloads).
const TOKEN_SEGMENT = /(\/(?:merchant-upload|apply\/r|review|download|artifacts|public\/apply)\/)[^/?#\s]+/g
const URL_CREDENTIALS = /^([a-z][a-z0-9+.-]*:\/\/)[^/@\s]*@/i
const ALLOWED_HEADERS = new Set(["user-agent", "content-type", "accept", "accept-language", "x-request-id", "x-vercel-id"])
const URL_DATA_KEYS = ["url", "to", "from", "href"]
const KEPT_CONSOLE_LEVELS = new Set(["warning", "error", "fatal"])
const MESSAGE_LIMIT = 1000
const LOG_LIMIT = 4000
const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi
const NODE_DEPRECATION = /^\(node:\d+\) \[DEP\d+\] DeprecationWarning/
// Chrome, Safari and Firefox wording for a fetch that got no HTTP response; Sentry may append " (host)".
const FETCH_NETWORK_FAILURE = /^(?:Failed to fetch|Load failed|NetworkError when attempting to fetch resource\.)(?: \([^)]*\))?$/
const EXTENSION_SCRIPT = /\b(?:chrome|moz|safari(?:-web)?)-extension:\/\//

/** `redactDiagnosticText` that keeps record and correlation UUIDs readable for tracing. */
function redact(value: string, max: number): string {
  const ids: string[] = []
  const masked = value.replace(UUID, (id) => `\u27e6${ids.push(id) - 1}\u27e7`)
  return redactDiagnosticText(masked, max).replace(/\u27e6(\d+)\u27e7/g, (_, index: string) => ids[Number(index)] ?? "")
}

/** Drops the fragment, filters every query value and replaces token path segments. */
export function scrubUrl(value: string): string {
  let url = value.split("#")[0].replace(URL_CREDENTIALS, "$1")
  let query = ""
  const queryStart = url.indexOf("?")
  if (queryStart >= 0) {
    query = url.slice(queryStart + 1)
    url = url.slice(0, queryStart)
  }
  url = url.replace(TOKEN_SEGMENT, "$1[token]")
  if (!query) return url
  const params = query.split("&").filter(Boolean).map((pair) => pair.includes("=") ? `${pair.split("=")[0]}=[Filtered]` : pair)
  return params.length ? `${url}?${params.join("&")}` : url
}

/** Scrubs URL-looking words inside free text such as span names ("GET /review/abc?x=1"). */
export function scrubUrlsInText(value: string): string {
  return value.split(/(\s+)/).map((part) => /[/?#]/.test(part) ? scrubUrl(part) : part).join("")
}

function scrubDataUrls(data: Dict | undefined) {
  if (!data) return
  for (const key of URL_DATA_KEYS) if (typeof data[key] === "string") data[key] = scrubUrl(data[key] as string)
}

function attributeString(value: unknown): string | undefined {
  if (typeof value === "string") return value
  if (value && typeof value === "object" && typeof (value as Dict).value === "string") return (value as Dict).value as string
  return undefined
}

function setAttributeString(attributes: Dict, key: string, next: string) {
  const current = attributes[key]
  if (current && typeof current === "object") (current as Dict).value = next
  else attributes[key] = next
}

interface BreadcrumbLike {
  category?: string
  level?: string
  message?: string
  data?: Dict
}

export function scrubBreadcrumb<T extends BreadcrumbLike>(crumb: T): T | null {
  if (crumb.category === "console") {
    if (!KEPT_CONSOLE_LEVELS.has(crumb.level ?? "log")) return null
    if (crumb.data) delete crumb.data.arguments
  }
  if (typeof crumb.message === "string") crumb.message = redact(crumb.message, MESSAGE_LIMIT)
  scrubDataUrls(crumb.data)
  return crumb
}

interface EventLike {
  type?: string
  message?: string
  logentry?: { message?: string }
  transaction?: string
  exception?: { values?: Array<{ value?: string; mechanism?: { type?: string } }> }
  request?: { url?: string; headers?: Record<string, string>; cookies?: unknown; data?: unknown; query_string?: unknown }
  contexts?: Record<string, Dict | undefined>
  breadcrumbs?: BreadcrumbLike[]
  tags?: Record<string, unknown>
  user?: Dict
  urls?: string[]
}

/**
 * A browser extension that wraps `window.fetch` (e.g. Similarweb's frame_ant.js) can leak a
 * network failure our code already caught as an unhandled rejection. Such an extension sits in
 * the stack of every fetch, so an extension frame alone does not prove the error was caught.
 * An event is dropped only when all of these hold: the error is a no-response fetch TypeError,
 * it came from the global unhandled-rejection handler, our own code marked it as caught
 * (`markCaughtError`), and its stack runs through an extension script. An uncaught first-party
 * fetch failure is always reported, with or without an extension in its stack.
 */
export function isExtensionFetchNoise(event: EventLike, hint?: { originalException?: unknown }): boolean {
  const error = hint?.originalException
  if (!(error instanceof Error) || error.name !== "TypeError" || !FETCH_NETWORK_FAILURE.test(error.message)) return false
  if (!wasCaughtError(error)) return false
  if (!event.exception?.values?.some((value) => value.mechanism?.type?.endsWith("onunhandledrejection"))) return false
  return EXTENSION_SCRIPT.test(error.stack ?? "")
}

export function scrubEvent<T extends EventLike>(event: T, hint?: { originalException?: unknown }): T | null {
  // Expected 4xx API responses are shown to the user and are not defects.
  if (hint?.originalException instanceof RequestError && hint.originalException.status < 500) return null
  if (isExtensionFetchNoise(event, hint)) return null

  if (typeof event.message === "string") event.message = redact(event.message, MESSAGE_LIMIT)
  if (typeof event.logentry?.message === "string") event.logentry.message = redact(event.logentry.message, MESSAGE_LIMIT)
  for (const value of event.exception?.values ?? []) {
    if (typeof value.value === "string") value.value = redact(value.value, MESSAGE_LIMIT)
  }
  if (typeof event.transaction === "string") event.transaction = scrubUrlsInText(event.transaction)

  const request = event.request
  if (request) {
    if (typeof request.url === "string") request.url = scrubUrl(request.url)
    delete request.cookies
    delete request.data
    delete request.query_string
    if (request.headers) {
      request.headers = Object.fromEntries(Object.entries(request.headers).filter(([name]) => ALLOWED_HEADERS.has(name.toLowerCase())))
    }
  }

  const nextjs = event.contexts?.nextjs
  if (nextjs && typeof nextjs.request_path === "string") nextjs.request_path = scrubUrl(nextjs.request_path)
  const feedback = event.contexts?.feedback
  if (feedback && typeof feedback.url === "string") feedback.url = scrubUrl(feedback.url)
  if (Array.isArray(event.urls)) event.urls = event.urls.map((url) => typeof url === "string" ? scrubUrl(url) : url)

  if (event.tags) {
    for (const [key, value] of Object.entries(event.tags)) {
      if (typeof value === "string" && /^(?:https?:\/\/|\/)/.test(value)) event.tags[key] = scrubUrl(value)
    }
  }
  if (event.user) delete event.user.ip_address
  if (event.breadcrumbs) {
    event.breadcrumbs = event.breadcrumbs.map((crumb) => scrubBreadcrumb(crumb)).filter((crumb): crumb is BreadcrumbLike => crumb !== null)
  }
  return event
}

interface LogLike {
  message: unknown
  attributes?: Dict
}

export function scrubLog<T extends LogLike>(log: T): T | null {
  // Node runtime deprecation notices are printed through console.error; they are not app errors.
  if (NODE_DEPRECATION.test(String(log.message))) return null
  log.message = redact(String(log.message), LOG_LIMIT)
  for (const [key, value] of Object.entries(log.attributes ?? {})) {
    if (key.startsWith("sentry.")) continue
    const text = attributeString(value)
    if (text !== undefined) setAttributeString(log.attributes!, key, /url|path|query|target|route/i.test(key) ? scrubUrl(text) : redact(text, LOG_LIMIT))
  }
  return log
}

interface SpanLike {
  name: string
  attributes?: Dict
}

export function scrubSpan<T extends SpanLike>(span: T): T {
  span.name = scrubUrlsInText(span.name)
  const attributes = span.attributes
  if (!attributes) return span
  for (const [key, value] of Object.entries(attributes)) {
    if (/^http\.(?:request|response)\.header\./.test(key) || key.startsWith("gen_ai.")) {
      delete attributes[key]
      continue
    }
    const text = attributeString(value)
    if (text !== undefined && /url|path|query|target|route|description/i.test(key)) setAttributeString(attributes, key, scrubUrlsInText(text))
  }
  return span
}

interface RecordingEventLike {
  type: number
  data: unknown
}

/** Replay `beforeAddRecordingEvent`: scrubs page and request URLs, drops console frames. */
export function scrubRecordingEvent<T extends RecordingEventLike>(event: T): T | null {
  const data = event.data as Dict | undefined
  if (!data) return event
  // rrweb Meta events carry the page URL.
  if (event.type === 4 && typeof data.href === "string") data.href = scrubUrl(data.href)
  const payload = data.payload as (Dict & { data?: Dict }) | undefined
  if (data.tag === "breadcrumb" && payload) {
    if (payload.category === "console") return null
    if (typeof payload.message === "string") payload.message = redact(payload.message, MESSAGE_LIMIT)
    scrubDataUrls(payload.data)
  }
  if (data.tag === "performanceSpan" && payload) {
    if (typeof payload.description === "string") payload.description = scrubUrl(payload.description)
    scrubDataUrls(payload.data)
  }
  return event
}

// Signed-in workspace and platform areas. Everything else (public merchant pages,
// auth and MFA pages, token review links, marketing) is never recorded.
const REPLAY_PREFIXES = [
  "/dashboard", "/dashboard-2", "/pipeline", "/deals", "/applications", "/intake", "/submissions", "/offers",
  "/advances", "/renewals", "/funders", "/calendar", "/mail", "/sms", "/assistant", "/reports", "/payments",
  "/settings", "/getting-started", "/platform",
]

export function replayAllowedPath(pathname: string): boolean {
  return REPLAY_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`))
}
