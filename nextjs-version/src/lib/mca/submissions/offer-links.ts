import "server-only"

import { lookup as dnsLookup } from "node:dns/promises"
import { isIP } from "node:net"
import { getDatabase, newId, nowIso, parseJson, recordAuditEvent, withImmediateTransaction } from "../db"
import type { DealActor } from "../deals/schema"
import { getDealForDocument } from "../deals/service"
import { AppError } from "../errors"
import {
  CHECKPOINT_PROVIDER_MESSAGE_ID,
  EXTRACTION_KIND,
  type ReplyExtractionSnapshot,
} from "./extract-outcomes"
import { getReply, type FunderReply } from "./replies"
import { findJobById, insertDealSubmissionCache } from "./repository"

export const OFFER_LINK_KIND = "mca:offer-link-extraction:v1"
export const OFFER_LINK_SCHEMA_VERSION = 1
export const OFFER_LINK_MAX_REDIRECTS = 3
export const OFFER_LINK_MAX_BYTES = 512 * 1024
export const OFFER_LINK_TIMEOUT_MS = 10_000

export type OfferLinkState = "empty" | "skipped" | "success" | "incomplete" | "blocked" | "unmatched"
export type OfferLinkSource = "email" | "link"

export type OfferLinkLookup = (
  hostname: string,
  options: { all: true; verbatim: true },
) => Promise<Array<{ address: string; family: number }>>

export interface OfferLinkTerms {
  amount: number | null
  rate: number | null
  term: number | null
  frequency: string | null
  commission: number | null
}

export interface OfferLinkNetworkOptions {
  fetchImpl?: typeof fetch
  lookupImpl?: OfferLinkLookup
  timeoutMs?: number
  maxBytes?: number
}

export interface OfferLinkRunInput {
  replyId?: unknown
}

export interface OfferLinkResolution {
  skipped: boolean
  fetched: boolean
  blocked: boolean
  inaccessible: boolean
  reason?: string
  message: string
  offerLink: string | null
  finalHost?: string
  sourceHost?: string
  redirectCount: number
  terms: OfferLinkTerms
  termsUnknown: boolean
  evidence: string[]
}

export interface OfferLinkOfferView {
  id: string
  status: string
  amount: number | null
  rate: number | null
  term: number | null
  frequency: string | null
  commission: number | null
  offerLink: string | null
  source: OfferLinkSource
  termsUnknown: boolean
  requiresReview: boolean
  created: boolean
}

export interface OfferLinkExtractView {
  state: OfferLinkState
  replyId: string
  replayed: boolean
  fetched: boolean
  skipped: boolean
  blocked: boolean
  inaccessible: boolean
  reason?: string
  offer?: OfferLinkOfferView
  matchedDealId?: string
  matchedJobId?: string
  message?: string
}

export interface OfferLinkListResult {
  state: "empty" | "ready"
  dealId: string
  extractions: OfferLinkExtractView[]
  canWrite: boolean
  message?: string
}

interface OfferRow {
  id: string
  workspace_id: string
  deal_id: string
  submission_id: string
  status: string
  amount: number | null
  rate: number | null
  term: number | null
  frequency: string | null
  commission: number | null
  fees_json: string | null
  offer_link: string | null
  source: string | null
  raw_status: string | null
  evidence_json: string | null
  terms_unknown: number | string
}

interface ReplyRow {
  id: string
  workspace_id: string
  sender_id: string
  provider_message_id: string
  thread_id: string | null
  from_address: string
  subject: string | null
  body_cipher: string | null
  matched_deal_id: string | null
  matched_job_id: string | null
  match_evidence: string | null
  state: string
  created_at: string
  updated_at: string
}

interface OfferLinkSnapshot {
  kind: typeof OFFER_LINK_KIND
  schemaVersion: typeof OFFER_LINK_SCHEMA_VERSION
  replyId: string
  state: OfferLinkState
  fetched: boolean
  skipped: boolean
  blocked: boolean
  inaccessible: boolean
  reason?: string
  offerId?: string
  sourceHost?: string
  finalHost?: string
  redirectCount: number
  termsUnknown: boolean
  warnings: string[]
  extractedAt: string
  committedAt: string
  message: string
}

let fetchOverride: typeof fetch | undefined
let lookupOverride: OfferLinkLookup | undefined

export function setOfferLinkNetworkForTests(input?: OfferLinkNetworkOptions): void {
  fetchOverride = input?.fetchImpl
  lookupOverride = input?.lookupImpl
}

function db() {
  return getDatabase()
}

function invalid(field: string, message: string): never {
  throw new AppError(422, "validation_failed", "Review the highlighted fields.", { [field]: [message] })
}

function asReplyId(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) invalid("replyId", "Choose a funder reply to follow the offer link.")
  const next = value.trim()
  if (next.length > 80) invalid("replyId", "Enter a valid reply id.")
  return next
}

function asDealQuery(value: string | null): string {
  if (value == null || !value.trim()) invalid("dealId", "Choose a deal to list offer-link extractions.")
  const next = value.trim()
  if (next.length > 80) invalid("dealId", "Enter a valid deal id.")
  return next
}

function compact(value: string | undefined | null): string {
  return (value ?? "").replace(/\s+/g, " ").trim()
}

function emptyTerms(): OfferLinkTerms {
  return { amount: null, rate: null, term: null, frequency: null, commission: null }
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null
}

export function offerLinkTermsComplete(terms: OfferLinkTerms): boolean {
  return [terms.amount, terms.rate, terms.term].every((value) => typeof value === "number" && Number.isFinite(value))
}

function mergeTerms(preferred: OfferLinkTerms, fallback: OfferLinkTerms): OfferLinkTerms {
  return {
    amount: preferred.amount ?? fallback.amount,
    rate: preferred.rate ?? fallback.rate,
    term: preferred.term ?? fallback.term,
    frequency: preferred.frequency ?? fallback.frequency,
    commission: preferred.commission ?? fallback.commission,
  }
}

function termsFromSnapshot(snapshot: ReplyExtractionSnapshot): OfferLinkTerms {
  return {
    amount: snapshot.terms.amount.unknown ? null : finiteNumber(snapshot.terms.amount.value),
    rate: snapshot.terms.rate.unknown ? null : finiteNumber(snapshot.terms.rate.value),
    term: snapshot.terms.term.unknown ? null : finiteNumber(snapshot.terms.term.value),
    frequency: snapshot.terms.frequency.unknown ? null : compact(snapshot.terms.frequency.value) || null,
    commission: snapshot.terms.commission.unknown ? null : finiteNumber(snapshot.terms.commission.value),
  }
}

function termsFromOffer(row: OfferRow | undefined): OfferLinkTerms {
  if (!row) return emptyTerms()
  return {
    amount: finiteNumber(row.amount),
    rate: finiteNumber(row.rate),
    term: finiteNumber(row.term),
    frequency: row.frequency ? compact(row.frequency) : null,
    commission: finiteNumber(row.commission),
  }
}

function asOfferSource(value: string | null | undefined): OfferLinkSource {
  return value === "link" ? "link" : "email"
}

function isBlockedIp(address: string): boolean {
  const value = address.toLowerCase().replace(/^\[|\]$/g, "")
  if (value.startsWith("::ffff:")) return isBlockedIp(value.slice(7))
  const family = isIP(value)
  if (family === 6) {
    if (value === "::" || value === "::1" || value === "0:0:0:0:0:0:0:0" || value === "0:0:0:0:0:0:0:1") return true
    const head = Number.parseInt((value.split(":")[0] ?? "").padEnd(4, "0").slice(0, 4), 16)
    if (!Number.isFinite(head)) return true
    if ((head & 0xffc0) === 0xfe80) return true
    if ((head & 0xff00) === 0xff00) return true
    if ((head & 0xfe00) === 0xfc00) return true
    return false
  }
  if (family !== 4) return false
  const [a, b] = value.split(".").map(Number)
  return a === 0 || a === 10 || a === 127
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168)
    || (a === 198 && (b === 18 || b === 19))
}

function isBlockedHostname(host: string): boolean {
  const hostname = host.toLowerCase().replace(/\.$/, "").replace(/^\[|\]$/g, "")
  if (!hostname) return true
  if (hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".local")) return true
  if (hostname === "metadata.google.internal" || hostname.endsWith(".internal") || hostname.endsWith(".arpa")) return true
  if (isIP(hostname)) return isBlockedIp(hostname)
  return false
}

function blockedResolution(input: {
  reason: string
  message: string
  offerLink: string | null
  sourceHost?: string
  emailTerms: OfferLinkTerms
}): OfferLinkResolution {
  return {
    skipped: false,
    fetched: false,
    blocked: true,
    inaccessible: false,
    reason: input.reason,
    message: input.message,
    offerLink: input.offerLink,
    sourceHost: input.sourceHost,
    redirectCount: 0,
    terms: input.emailTerms,
    termsUnknown: !offerLinkTermsComplete(input.emailTerms),
    evidence: [],
  }
}

function skippedResolution(input: { offerLink: string | null; sourceHost?: string; terms: OfferLinkTerms }): OfferLinkResolution {
  return {
    skipped: true,
    fetched: false,
    blocked: false,
    inaccessible: false,
    reason: "email_terms",
    message: "Email financial terms were complete, so the portal link was not fetched.",
    offerLink: input.offerLink,
    sourceHost: input.sourceHost,
    redirectCount: 0,
    terms: input.terms,
    termsUnknown: false,
    evidence: ["email terms"],
  }
}

function incompleteResolution(input: {
  fetched: boolean
  reason: string
  message: string
  offerLink: string | null
  sourceHost?: string
  finalHost?: string
  redirectCount: number
  terms: OfferLinkTerms
  evidence?: string[]
}): OfferLinkResolution {
  return {
    skipped: false,
    fetched: input.fetched,
    blocked: false,
    inaccessible: true,
    reason: input.reason,
    message: input.message,
    offerLink: input.offerLink,
    sourceHost: input.sourceHost,
    finalHost: input.finalHost,
    redirectCount: input.redirectCount,
    terms: input.terms,
    termsUnknown: !offerLinkTermsComplete(input.terms),
    evidence: input.evidence ?? [],
  }
}

// SSRF: reject non-https and private/link-local/metadata targets before any fetch.
async function assertSafeOfferUrl(
  raw: string,
  lookupImpl: OfferLinkLookup,
): Promise<{ ok: true; url: URL } | { ok: false; reason: string; message: string; host?: string }> {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return { ok: false, reason: "invalid_url", message: "The offer link is not a valid URL." }
  }
  if (url.protocol !== "https:") {
    return { ok: false, reason: "insecure_scheme", message: "Offer links must use HTTPS. Non-HTTPS URLs are rejected before fetch." }
  }
  if (url.username || url.password) {
    return { ok: false, reason: "embedded_credentials", message: "Offer links may not include embedded credentials." }
  }
  const host = url.hostname.toLowerCase().replace(/\.$/, "").replace(/^\[|\]$/g, "")
  if (isBlockedHostname(host)) {
    return { ok: false, reason: "private_network", message: "Private-network, link-local, and metadata offer links are rejected before fetch.", host }
  }
  if (isIP(host)) return { ok: true, url }
  let addresses: Array<{ address: string; family: number }>
  try {
    addresses = await lookupImpl(host, { all: true, verbatim: true })
  } catch {
    return { ok: false, reason: "unresolvable", message: "The offer-link host could not be resolved and was not fetched.", host }
  }
  if (!addresses.length || addresses.some((entry) => isBlockedIp(entry.address))) {
    return { ok: false, reason: "private_network", message: "The offer-link host resolves to a private, link-local, or metadata address and was not fetched.", host }
  }
  return { ok: true, url }
}

function mediaType(value: string | null): string {
  return (value ?? "").split(";")[0].trim().toLowerCase()
}

function looksLikeLoginWall(html: string): boolean {
  const lower = html.toLowerCase()
  if (/type\s*=\s*["']password["']/.test(lower)) return true
  if (/captcha|cf-browser-verification|just a moment…|attention required/.test(lower)) return true
  if (/<form[^>]*(login|signin|sign-in|sign_in)/.test(lower)) return true
  return false
}

function parseMoney(raw: string): number | null {
  const value = Number(raw.replace(/[$,\s]/g, ""))
  if (!Number.isFinite(value) || value <= 0 || value > 50_000_000) return null
  return value
}

function parseRate(raw: string): number | null {
  const value = Number(raw)
  if (!Number.isFinite(value) || value <= 0 || value > 10) return null
  return value
}

function parseTerm(raw: string): number | null {
  const value = Math.trunc(Number(raw))
  if (!Number.isFinite(value) || value <= 0 || value > 120) return null
  return value
}

function firstMatch(text: string, pattern: RegExp): string | undefined {
  return text.match(pattern)?.[1]
}

function parseLabeledTerms(html: string): { terms: OfferLinkTerms; evidence: string[] } {
  const terms = emptyTerms()
  const evidence: string[] = []
  const amountAttr = firstMatch(html, /data-amount\s*=\s*["']([0-9][0-9,]*(?:\.[0-9]+)?)/i)
  const rateAttr = firstMatch(html, /data-(?:rate|factor)\s*=\s*["']([0-9]+(?:\.[0-9]+)?)/i)
  const termAttr = firstMatch(html, /data-term\s*=\s*["']([0-9]{1,3})/i)
  const text = html
    .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/\s+/g, " ")
    .trim()
  const amountRaw = amountAttr ?? firstMatch(text, /\b(?:offer\s+)?amount\b[^0-9$]{0,24}\$?\s*([0-9][0-9,]*(?:\.[0-9]{1,2})?)/i)
  const rateRaw = rateAttr ?? firstMatch(text, /\b(?:factor(?:\s+rate)?|rate)\b[^0-9]{0,24}([0-9]+(?:\.[0-9]+)?)/i)
  const termRaw = termAttr ?? firstMatch(text, /\bterm\b[^0-9]{0,24}([0-9]{1,3})\s*(?:months?|mos?\.?)?/i)
  const frequencyRaw = firstMatch(text, /\b(?:frequency|pay(?:ment)?s?)\b[^a-z]{0,24}(daily|weekly|monthly|bi-?weekly)/i)
  const commissionRaw = firstMatch(text, /\bcommission\b[^0-9$]{0,24}\$?\s*([0-9][0-9,]*(?:\.[0-9]{1,2})?)/i)
  const amount = amountRaw ? parseMoney(amountRaw) : null
  const rate = rateRaw ? parseRate(rateRaw) : null
  const term = termRaw ? parseTerm(termRaw) : null
  const commission = commissionRaw ? parseMoney(commissionRaw) : null
  if (amount != null) {
    terms.amount = amount
    evidence.push(`amount ${amount}`)
  }
  if (rate != null) {
    terms.rate = rate
    evidence.push(`rate ${rate}`)
  }
  if (term != null) {
    terms.term = term
    evidence.push(`term ${term}`)
  }
  if (frequencyRaw) {
    terms.frequency = frequencyRaw.toLowerCase().replace("biweekly", "bi-weekly")
    evidence.push(`frequency ${terms.frequency}`)
  }
  if (commission != null) {
    terms.commission = commission
    evidence.push(`commission ${commission}`)
  }
  return { terms, evidence }
}

function jsonRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {}
  const record = value as Record<string, unknown>
  const nested = record.offer && typeof record.offer === "object" && !Array.isArray(record.offer)
    ? record.offer as Record<string, unknown>
    : {}
  return { ...nested, ...record }
}

function parseJsonTerms(text: string): { terms: OfferLinkTerms; evidence: string[] } {
  try {
    const record = jsonRecord(JSON.parse(text))
    const amount = parseMoney(String(record.amount ?? record.offerAmount ?? record.purchaseAmount ?? record.fundedAmount ?? record.advance ?? ""))
    const rate = parseRate(String(record.rate ?? record.factor ?? record.factorRate ?? ""))
    const term = parseTerm(String(record.term ?? record.termMonths ?? record.months ?? ""))
    const frequency = typeof record.frequency === "string" || typeof record.payFrequency === "string"
      ? compact(String(record.frequency ?? record.payFrequency)).toLowerCase()
      : ""
    const commission = parseMoney(String(record.commission ?? ""))
    const terms = emptyTerms()
    const evidence: string[] = []
    if (amount != null) {
      terms.amount = amount
      evidence.push(`json amount ${amount}`)
    }
    if (rate != null) {
      terms.rate = rate
      evidence.push(`json rate ${rate}`)
    }
    if (term != null) {
      terms.term = term
      evidence.push(`json term ${term}`)
    }
    if (frequency === "daily" || frequency === "weekly" || frequency === "monthly" || frequency === "bi-weekly" || frequency === "biweekly") {
      terms.frequency = frequency.replace("biweekly", "bi-weekly")
      evidence.push(`json frequency ${terms.frequency}`)
    }
    if (commission != null) {
      terms.commission = commission
      evidence.push(`json commission ${commission}`)
    }
    return { terms, evidence }
  } catch {
    return { terms: emptyTerms(), evidence: [] }
  }
}

function parsePortalBody(body: string, contentType: string): { terms: OfferLinkTerms; evidence: string[]; inaccessible?: string } {
  const type = mediaType(contentType) || "text/html"
  if (type === "application/json" || type === "text/json") return parseJsonTerms(body)
  if (type !== "text/html" && type !== "application/xhtml+xml" && type !== "text/plain" && type !== "") {
    return { terms: emptyTerms(), evidence: [], inaccessible: "unsupported_content_type" }
  }
  if (looksLikeLoginWall(body)) return { terms: emptyTerms(), evidence: [], inaccessible: "login_wall" }
  if (/^\s*[{\[]/.test(body)) {
    const json = parseJsonTerms(body)
    if (offerLinkTermsComplete(json.terms) || json.evidence.length) return json
  }
  return parseLabeledTerms(body)
}

export async function resolveOfferLink(input: {
  url?: string | null
  emailTerms?: OfferLinkTerms
  fetchImpl?: typeof fetch
  lookupImpl?: OfferLinkLookup
  timeoutMs?: number
  maxBytes?: number
}): Promise<OfferLinkResolution> {
  const emailTerms = input.emailTerms ?? emptyTerms()
  const rawUrl = compact(input.url).slice(0, 2000)
  let sourceHost: string | undefined
  try {
    if (rawUrl) sourceHost = new URL(rawUrl).hostname.toLowerCase().replace(/\.$/, "")
  } catch {
    sourceHost = undefined
  }
  if (offerLinkTermsComplete(emailTerms)) {
    return skippedResolution({ offerLink: rawUrl || null, sourceHost, terms: emailTerms })
  }
  if (!rawUrl) {
    return incompleteResolution({
      fetched: false,
      reason: "missing_link",
      message: "No offer link was present. The offer was left incomplete for manual review.",
      offerLink: null,
      redirectCount: 0,
      terms: emailTerms,
    })
  }
  const lookupImpl = input.lookupImpl ?? lookupOverride ?? dnsLookup
  const fetchImpl = input.fetchImpl ?? fetchOverride ?? fetch
  const timeoutMs = input.timeoutMs ?? OFFER_LINK_TIMEOUT_MS
  const maxBytes = input.maxBytes ?? OFFER_LINK_MAX_BYTES
  const initial = await assertSafeOfferUrl(rawUrl, lookupImpl)
  if (!initial.ok) {
    return blockedResolution({
      reason: initial.reason,
      message: initial.message,
      offerLink: rawUrl,
      sourceHost: initial.host ?? sourceHost,
      emailTerms,
    })
  }
  let current = initial.url
  let redirectCount = 0
  let response: Response
  try {
    while (true) {
      response = await fetchImpl(current, {
        method: "GET",
        redirect: "manual",
        cache: "no-store",
        credentials: "omit",
        headers: { accept: "text/html, application/json;q=0.9, text/plain;q=0.8" },
        signal: AbortSignal.timeout(timeoutMs),
      })
      if (response.status < 300 || response.status >= 400) break
      if (redirectCount >= OFFER_LINK_MAX_REDIRECTS) {
        return incompleteResolution({
          fetched: true,
          reason: "too_many_redirects",
          message: "The offer portal redirected too many times. The offer was left incomplete for manual review.",
          offerLink: rawUrl,
          sourceHost,
          finalHost: current.hostname.toLowerCase(),
          redirectCount,
          terms: emailTerms,
        })
      }
      const location = response.headers.get("location")
      if (!location) {
        return incompleteResolution({
          fetched: true,
          reason: "redirect_missing_location",
          message: "The offer portal returned a redirect without a location. The offer was left incomplete for manual review.",
          offerLink: rawUrl,
          sourceHost,
          finalHost: current.hostname.toLowerCase(),
          redirectCount,
          terms: emailTerms,
        })
      }
      let next: URL
      try {
        next = new URL(location, current)
      } catch {
        return incompleteResolution({
          fetched: true,
          reason: "redirect_invalid",
          message: "The offer portal returned an invalid redirect. The offer was left incomplete for manual review.",
          offerLink: rawUrl,
          sourceHost,
          finalHost: current.hostname.toLowerCase(),
          redirectCount,
          terms: emailTerms,
        })
      }
      const nextSafe = await assertSafeOfferUrl(next.toString(), lookupImpl)
      if (!nextSafe.ok) {
        return blockedResolution({
          reason: nextSafe.reason,
          message: nextSafe.message,
          offerLink: rawUrl,
          sourceHost: nextSafe.host ?? sourceHost,
          emailTerms,
        })
      }
      current = nextSafe.url
      redirectCount += 1
    }
  } catch (error) {
    const timeout = error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError")
    return incompleteResolution({
      fetched: true,
      reason: timeout ? "timeout" : "network_error",
      message: timeout
        ? "The offer portal timed out. The offer was left incomplete for manual review."
        : "The offer portal could not be reached. The offer was left incomplete for manual review.",
      offerLink: rawUrl,
      sourceHost,
      finalHost: current.hostname.toLowerCase(),
      redirectCount,
      terms: emailTerms,
    })
  }
  const finalHost = current.hostname.toLowerCase()
  if (response.status === 401 || response.status === 403) {
    return incompleteResolution({
      fetched: true,
      reason: "unauthorized",
      message: "The offer portal required authentication. The offer was left incomplete for manual review.",
      offerLink: rawUrl,
      sourceHost,
      finalHost,
      redirectCount,
      terms: emailTerms,
    })
  }
  if (!response.ok) {
    return incompleteResolution({
      fetched: true,
      reason: "http_error",
      message: "The offer portal was not readable. The offer was left incomplete for manual review.",
      offerLink: rawUrl,
      sourceHost,
      finalHost,
      redirectCount,
      terms: emailTerms,
    })
  }
  const type = mediaType(response.headers.get("content-type"))
  if (type.startsWith("application/octet-stream") || type.startsWith("application/zip") || type.startsWith("application/pdf")
    || type.startsWith("application/x-msdownload") || type.startsWith("image/") || type.startsWith("video/") || type.startsWith("audio/")) {
    return incompleteResolution({
      fetched: true,
      reason: "suspicious_download",
      message: "The offer link returned a download rather than an offer page. The offer was left incomplete for manual review.",
      offerLink: rawUrl,
      sourceHost,
      finalHost,
      redirectCount,
      terms: emailTerms,
    })
  }
  const declared = Number(response.headers.get("content-length") ?? 0)
  if (declared > maxBytes) {
    return incompleteResolution({
      fetched: true,
      reason: "download_too_large",
      message: "The offer page exceeded the size limit. The offer was left incomplete for manual review.",
      offerLink: rawUrl,
      sourceHost,
      finalHost,
      redirectCount,
      terms: emailTerms,
    })
  }
  const bytes = new Uint8Array(await response.arrayBuffer())
  if (bytes.byteLength > maxBytes) {
    return incompleteResolution({
      fetched: true,
      reason: "download_too_large",
      message: "The offer page exceeded the size limit. The offer was left incomplete for manual review.",
      offerLink: rawUrl,
      sourceHost,
      finalHost,
      redirectCount,
      terms: emailTerms,
    })
  }
  const body = new TextDecoder("utf-8", { fatal: false }).decode(bytes)
  const parsed = parsePortalBody(body, type || "text/html")
  if (parsed.inaccessible) {
    return incompleteResolution({
      fetched: true,
      reason: parsed.inaccessible,
      message: parsed.inaccessible === "login_wall"
        ? "The offer portal required sign-in. The offer was left incomplete for manual review."
        : "The offer portal could not be read as an offer page. The offer was left incomplete for manual review.",
      offerLink: rawUrl,
      sourceHost,
      finalHost,
      redirectCount,
      terms: emailTerms,
    })
  }
  const terms = mergeTerms(emailTerms, parsed.terms)
  if (!offerLinkTermsComplete(terms)) {
    return {
      skipped: false,
      fetched: true,
      blocked: false,
      inaccessible: false,
      reason: "terms_not_found",
      message: "The offer page did not include complete financial terms. The offer was left incomplete for manual review.",
      offerLink: rawUrl,
      sourceHost,
      finalHost,
      redirectCount,
      terms,
      termsUnknown: true,
      evidence: parsed.evidence,
    }
  }
  return {
    skipped: false,
    fetched: true,
    blocked: false,
    inaccessible: false,
    reason: "parsed",
    message: "Offer terms were read from the portal page.",
    offerLink: rawUrl,
    sourceHost,
    finalHost,
    redirectCount,
    terms,
    termsUnknown: false,
    evidence: parsed.evidence,
  }
}

function extractionFromEvidence(raw: string | null): ReplyExtractionSnapshot | undefined {
  const parsed = parseJson<Record<string, unknown>>(raw, {})
  const record = parsed.extraction
  if (!record || typeof record !== "object" || Array.isArray(record)) return undefined
  const snapshot = record as Partial<ReplyExtractionSnapshot>
  if (snapshot.kind !== EXTRACTION_KIND) return undefined
  return snapshot as ReplyExtractionSnapshot
}

function linkFromEvidence(raw: string | null): OfferLinkSnapshot | undefined {
  const parsed = parseJson<Record<string, unknown>>(raw, {})
  const record = parsed.offerLinkExtraction
  if (!record || typeof record !== "object" || Array.isArray(record)) return undefined
  const snapshot = record as Partial<OfferLinkSnapshot>
  if (snapshot.kind !== OFFER_LINK_KIND) return undefined
  return snapshot as OfferLinkSnapshot
}

async function loadReplyRow(workspaceId: string, id: string): Promise<ReplyRow | undefined> {
  return db().prepare<ReplyRow>(
    "SELECT * FROM mca_funder_replies WHERE workspace_id = ? AND id = ? AND provider_message_id <> ?",
  ).get(workspaceId, id, CHECKPOINT_PROVIDER_MESSAGE_ID)
}

async function loadOffer(workspaceId: string, id: string | undefined): Promise<OfferRow | undefined> {
  if (!id) return undefined
  return db().prepare<OfferRow>("SELECT * FROM deal_offers WHERE workspace_id = ? AND id = ?").get(workspaceId, id)
}

function emptyView(reply: FunderReply, message: string, offer?: OfferLinkOfferView): OfferLinkExtractView {
  return {
    state: "empty",
    replyId: reply.id,
    replayed: false,
    fetched: false,
    skipped: false,
    blocked: false,
    inaccessible: false,
    offer,
    matchedDealId: reply.matchedDealId,
    matchedJobId: reply.matchedJobId,
    message,
  }
}

function offerStatusFor(termsUnknown: boolean): "received" | "presented" {
  return termsUnknown ? "received" : "presented"
}

function viewMessage(state: OfferLinkState, resolvedMessage?: string): string {
  if (state === "empty") return "Offer link has not been fetched yet."
  if (state === "unmatched") return "Unmatched replies are not fetched."
  if (state === "blocked") return resolvedMessage ?? "The offer link was rejected before fetch."
  if (state === "skipped") return resolvedMessage ?? "Email financial terms were complete, so the portal link was not fetched."
  if (state === "incomplete") return resolvedMessage ?? "The offer portal was not readable. Amounts were left unknown."
  if (state === "success") return resolvedMessage ?? "Offer terms were read from the portal page."
  return resolvedMessage ?? "Offer link extraction recorded."
}

function viewFrom(input: {
  reply: FunderReply
  state: OfferLinkState
  replayed: boolean
  fetched: boolean
  skipped: boolean
  blocked: boolean
  inaccessible: boolean
  reason?: string
  offer?: OfferLinkOfferView
  message?: string
}): OfferLinkExtractView {
  return {
    state: input.state,
    replyId: input.reply.id,
    replayed: input.replayed,
    fetched: input.fetched,
    skipped: input.skipped,
    blocked: input.blocked,
    inaccessible: input.inaccessible,
    ...(input.reason ? { reason: input.reason } : {}),
    offer: input.offer,
    matchedDealId: input.reply.matchedDealId,
    matchedJobId: input.reply.matchedJobId,
    message: viewMessage(input.state, input.message),
  }
}

function offerViewFromRow(row: OfferRow, created: boolean): OfferLinkOfferView {
  const termsUnknown = Number(row.terms_unknown) !== 0
  return {
    id: row.id,
    status: row.status,
    amount: row.amount,
    rate: row.rate,
    term: row.term,
    frequency: row.frequency,
    commission: row.commission,
    offerLink: row.offer_link,
    source: asOfferSource(row.source),
    termsUnknown,
    requiresReview: termsUnknown,
    created,
  }
}

async function upsertLinkOffer(input: {
  actor: DealActor
  reply: FunderReply
  extraction: ReplyExtractionSnapshot
  resolved: OfferLinkResolution
  source: OfferLinkSource
}): Promise<OfferLinkOfferView | undefined> {
  if (!input.reply.matchedDealId || !input.reply.matchedJobId) return undefined
  const job = await findJobById(input.actor.workspaceId, input.reply.matchedJobId)
  if (!job || job.dealId !== input.reply.matchedDealId) return undefined
  await insertDealSubmissionCache({
    workspaceId: job.workspaceId,
    dealId: job.dealId,
    funderName: job.displayFunderName,
    status: "approved",
    funderId: job.funderId,
    jobId: job.id,
    routeKind: job.routeKind,
  })
  const submission = await db().prepare<{ id: string }>(
    "SELECT id FROM deal_submissions WHERE workspace_id = ? AND job_id = ?",
  ).get(job.workspaceId, job.id)
  if (!submission) throw new Error("Deal submission cache was not found after offer-link extract.")
  const terms = input.resolved.terms
  const termsUnknown = !offerLinkTermsComplete(terms)
  const amount = terms.amount
  const rate = terms.rate
  const term = terms.term
  const frequency = terms.frequency
  const commission = terms.commission
  const offerLink = input.resolved.offerLink
  const status = input.extraction.offerId
    ? (await loadOffer(input.actor.workspaceId, input.extraction.offerId))?.status === "accepted" ? "accepted" : offerStatusFor(termsUnknown)
    : offerStatusFor(termsUnknown)
  const existingId = input.extraction.offerId
  const existing = await loadOffer(input.actor.workspaceId, existingId)
  const evidence = {
    kind: OFFER_LINK_KIND,
    schemaVersion: OFFER_LINK_SCHEMA_VERSION,
    extractionKind: EXTRACTION_KIND,
    replyId: input.reply.id,
    providerMessageId: input.reply.providerMessageId,
    fetched: input.resolved.fetched,
    skipped: input.resolved.skipped,
    blocked: input.resolved.blocked,
    inaccessible: input.resolved.inaccessible,
    reason: input.resolved.reason,
    sourceHost: input.resolved.sourceHost,
    finalHost: input.resolved.finalHost,
    redirectCount: input.resolved.redirectCount,
    emailPreferred: true,
  }
  if (existing) {
    const nextSource = input.source === "email" && existing.source === "link" ? "link" : input.source
    const nextStatus = existing.status === "accepted" ? "accepted" : status
    await db().prepare(`UPDATE deal_offers SET
      status = ?, amount = ?, rate = ?, term = ?, frequency = ?, commission = ?, offer_link = ?,
      source = ?, raw_status = ?, evidence_json = ?, terms_unknown = ?
      WHERE workspace_id = ? AND id = ?`).run(
      nextStatus,
      amount,
      rate,
      term,
      frequency,
      commission,
      offerLink,
      nextSource,
      "approval",
      JSON.stringify(evidence),
      termsUnknown ? 1 : 0,
      input.actor.workspaceId,
      existing.id,
    )
    const updated = await loadOffer(input.actor.workspaceId, existing.id)
    return updated ? offerViewFromRow(updated, false) : offerViewFromRow({ ...existing, status: nextStatus, amount, rate, term, frequency, commission, offer_link: offerLink, source: nextSource, terms_unknown: termsUnknown ? 1 : 0 }, false)
  }
  const id = newId()
  await db().prepare(`INSERT INTO deal_offers
    (id, workspace_id, deal_id, submission_id, status, amount, rate, term, frequency, commission, fees_json, offer_link, source, raw_status, evidence_json, terms_unknown)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    id,
    job.workspaceId,
    job.dealId,
    submission.id,
    status,
    amount,
    rate,
    term,
    frequency,
    commission,
    JSON.stringify(input.extraction.terms.fees),
    offerLink,
    input.source,
    "approval",
    JSON.stringify(evidence),
    termsUnknown ? 1 : 0,
  )
  const created = await loadOffer(input.actor.workspaceId, id)
  if (!created) throw new Error("Deal offer was not found after offer-link insert.")
  return offerViewFromRow(created, true)
}

async function writeLinkSnapshot(row: ReplyRow, extraction: ReplyExtractionSnapshot, snapshot: OfferLinkSnapshot): Promise<void> {
  const evidence = parseJson<Record<string, unknown>>(row.match_evidence, {})
  const nextExtraction = snapshot.offerId && !extraction.offerId ? { ...extraction, offerId: snapshot.offerId } : extraction
  await db().prepare(
    "UPDATE mca_funder_replies SET match_evidence = ?, updated_at = ? WHERE workspace_id = ? AND id = ?",
  ).run(
    JSON.stringify({ ...evidence, extraction: nextExtraction, offerLinkExtraction: snapshot }),
    nowIso(),
    row.workspace_id,
    row.id,
  )
}

function snapshotOf(input: {
  reply: FunderReply
  state: OfferLinkState
  resolved: OfferLinkResolution
  offerId?: string
}): OfferLinkSnapshot {
  return {
    kind: OFFER_LINK_KIND,
    schemaVersion: OFFER_LINK_SCHEMA_VERSION,
    replyId: input.reply.id,
    state: input.state,
    fetched: input.resolved.fetched,
    skipped: input.resolved.skipped,
    blocked: input.resolved.blocked,
    inaccessible: input.resolved.inaccessible,
    ...(input.resolved.reason ? { reason: input.resolved.reason } : {}),
    ...(input.offerId ? { offerId: input.offerId } : {}),
    ...(input.resolved.sourceHost ? { sourceHost: input.resolved.sourceHost } : {}),
    ...(input.resolved.finalHost ? { finalHost: input.resolved.finalHost } : {}),
    redirectCount: input.resolved.redirectCount,
    termsUnknown: input.resolved.termsUnknown,
    warnings: input.resolved.blocked
      ? ["Offer link rejected before fetch."]
      : input.resolved.inaccessible || input.resolved.termsUnknown
        ? ["Portal terms were left unknown; amounts were not invented."]
        : [],
    extractedAt: nowIso(),
    committedAt: nowIso(),
    message: input.resolved.message,
  }
}

function stateFromResolved(resolved: OfferLinkResolution): OfferLinkState {
  if (resolved.skipped) return "skipped"
  if (resolved.blocked) return "blocked"
  if (resolved.inaccessible || resolved.termsUnknown) return "incomplete"
  return "success"
}

function asReply(row: ReplyRow): FunderReply {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    senderId: row.sender_id,
    providerMessageId: row.provider_message_id,
    threadId: row.thread_id ?? undefined,
    fromAddress: row.from_address,
    subject: row.subject ?? undefined,
    matchedDealId: row.matched_deal_id ?? undefined,
    matchedJobId: row.matched_job_id ?? undefined,
    evidence: { method: "unrecognized", flagsUnchanged: true, notes: [] },
    state: row.state === "pending_review" || row.state === "matched" || row.state === "ignored" || row.state === "processed"
      ? row.state
      : "pending_review",
    created: false,
    replayed: false,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

async function viewFromRow(actor: DealActor, reply: FunderReply, row: ReplyRow): Promise<OfferLinkExtractView> {
  const extraction = extractionFromEvidence(row.match_evidence)
  const link = linkFromEvidence(row.match_evidence)
  const offerId = link?.offerId ?? extraction?.offerId
  const offerRow = await loadOffer(actor.workspaceId, offerId)
  const offer = offerRow ? offerViewFromRow(offerRow, false) : undefined
  if (!extraction || extraction.preview) {
    return emptyView(reply, "Extract the funder reply before following an offer link.", offer)
  }
  if (!link) {
    return emptyView(reply, "Offer link has not been fetched yet.", offer)
  }
  return viewFrom({
    reply,
    state: link.state,
    replayed: false,
    fetched: link.fetched,
    skipped: link.skipped,
    blocked: link.blocked,
    inaccessible: link.inaccessible,
    reason: link.reason,
    offer,
    message: link.message,
  })
}

export async function getOfferLinkExtraction(actor: DealActor, replyId: string): Promise<OfferLinkExtractView> {
  const reply = await getReply(actor, asReplyId(replyId))
  if (reply.matchedDealId) await getDealForDocument(actor, reply.matchedDealId)
  const row = await loadReplyRow(actor.workspaceId, reply.id)
  if (!row) throw new AppError(404, "resource_not_found", "The requested resource was not found.")
  return viewFromRow(actor, reply, row)
}

export async function listOfferLinkExtractions(actor: DealActor, dealId: string | null): Promise<OfferLinkListResult> {
  const scoped = await getDealForDocument(actor, asDealQuery(dealId))
  const rows = await db().prepare<ReplyRow>(
    `SELECT * FROM mca_funder_replies
     WHERE workspace_id = ? AND provider_message_id <> ? AND matched_deal_id = ?
     ORDER BY updated_at DESC, id DESC`,
  ).all(actor.workspaceId, CHECKPOINT_PROVIDER_MESSAGE_ID, scoped.id)
  const extractions: OfferLinkExtractView[] = []
  for (const row of rows) {
    const snapshot = extractionFromEvidence(row.match_evidence)
    if (!snapshot) continue
    extractions.push(await viewFromRow(actor, asReply(row), row))
  }
  const ready = extractions.some((item) => item.state !== "empty")
  return {
    state: ready ? "ready" : "empty",
    dealId: scoped.id,
    extractions,
    canWrite: actor.source === "user",
    ...(ready ? {} : { message: "No offer-link extractions yet." }),
  }
}

export async function extractOfferLink(
  actor: DealActor,
  input: OfferLinkRunInput,
  options: OfferLinkNetworkOptions = {},
): Promise<OfferLinkExtractView> {
  const replyId = asReplyId(input.replyId)
  const reply = await getReply(actor, replyId)
  if (reply.matchedDealId) await getDealForDocument(actor, reply.matchedDealId)
  const row = await loadReplyRow(actor.workspaceId, reply.id)
  if (!row) throw new AppError(404, "resource_not_found", "The requested resource was not found.")
  const extraction = extractionFromEvidence(row.match_evidence)
  if (!extraction || extraction.preview) {
    return emptyView(reply, "Extract the funder reply before following an offer link.")
  }
  if (extraction.classification === "unrelated" || !reply.matchedDealId || !reply.matchedJobId) {
    return viewFrom({
      reply,
      state: "unmatched",
      replayed: false,
      fetched: false,
      skipped: false,
      blocked: false,
      inaccessible: false,
      reason: "unmatched",
      message: "Unmatched replies are not fetched.",
    })
  }
  if (extraction.classification !== "approval") {
    return viewFrom({
      reply,
      state: "skipped",
      replayed: Boolean(linkFromEvidence(row.match_evidence)?.committedAt),
      fetched: false,
      skipped: true,
      blocked: false,
      inaccessible: false,
      reason: "not_approval",
      message: "Offer links are followed only for approvals.",
    })
  }
  return withImmediateTransaction(async () => {
    const current = await loadReplyRow(actor.workspaceId, reply.id)
    if (!current) throw new AppError(404, "resource_not_found", "The requested resource was not found.")
    const latest = extractionFromEvidence(current.match_evidence) ?? extraction
    const previousLink = linkFromEvidence(current.match_evidence)
    const existing = await loadOffer(actor.workspaceId, latest.offerId ?? previousLink?.offerId)
    const preferred = mergeTerms(termsFromSnapshot(latest), termsFromOffer(existing))
    const url = latest.terms.offerLink.unknown ? null : compact(latest.terms.offerLink.value)
    const resolved = await resolveOfferLink({
      url,
      emailTerms: preferred,
      fetchImpl: options.fetchImpl,
      lookupImpl: options.lookupImpl,
      timeoutMs: options.timeoutMs,
      maxBytes: options.maxBytes,
    })
    const state = stateFromResolved(resolved)
    const source: OfferLinkSource = resolved.fetched ? "link" : asOfferSource(existing?.source)
    let offer: OfferLinkOfferView | undefined
    if (state === "blocked") {
      offer = existing ? offerViewFromRow(existing, false) : undefined
    } else if (resolved.skipped && existing && offerLinkTermsComplete(preferred)) {
      offer = offerViewFromRow(existing, false)
    } else {
      offer = await upsertLinkOffer({
        actor,
        reply,
        extraction: latest,
        resolved,
        source,
      })
    }
    const snapshot = snapshotOf({ reply, state, resolved, offerId: offer?.id ?? existing?.id })
    await writeLinkSnapshot(current, latest, snapshot)
    await recordAuditEvent({
      context: actor,
      action: "funder_reply.offer_link_extracted",
      resourceType: "funder_reply_extraction",
      resourceId: reply.id,
      metadata: {
        state,
        fetched: resolved.fetched,
        skipped: resolved.skipped,
        blocked: resolved.blocked,
        inaccessible: resolved.inaccessible,
        termsUnknown: resolved.termsUnknown,
        offerId: snapshot.offerId,
        sourceHost: resolved.sourceHost,
        redirectCount: resolved.redirectCount,
        replayed: Boolean(previousLink?.committedAt),
      },
      correlationId: actor.correlationId,
    })
    return viewFrom({
      reply,
      state,
      replayed: Boolean(previousLink?.committedAt),
      fetched: resolved.fetched,
      skipped: resolved.skipped,
      blocked: resolved.blocked,
      inaccessible: resolved.inaccessible,
      reason: resolved.reason,
      offer,
      message: resolved.message,
    })
  })
}
