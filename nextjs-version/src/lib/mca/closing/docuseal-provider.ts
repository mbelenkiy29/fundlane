import "server-only"

import { createHash, createHmac, timingSafeEqual } from "node:crypto"
import { isIP } from "node:net"
import { lookup } from "node:dns/promises"
import { AppError } from "../errors"
import { assertUsAbaRoutingNumber } from "./aba"

export const DOCUSEAL_SIGNATURE_HEADER = "x-docuseal-signature"

export const DOCUSEAL_PSF_FIELD_KEYS = [
  "amount",
  "bankName",
  "routingNumber",
  "accountNumber",
  "businessName",
  "contactName",
  "contactEmail",
] as const

export type DocuSealPsfFieldKey = (typeof DOCUSEAL_PSF_FIELD_KEYS)[number]
export type DocuSealPsfFieldType = "text" | "number"

export const DOCUSEAL_CONTRACT_FIELD_KEYS = [
  "merchantLegalName", "signerEmail", "signerName", "funderName", "fundedAmount",
  "paybackAmount", "factorRate", "paymentFrequency",
] as const
export type DocuSealContractFieldKey = (typeof DOCUSEAL_CONTRACT_FIELD_KEYS)[number]

export interface DocuSealContractProviderConfig {
  apiBaseUrl: string
  apiKey: string
  templateId: number
  signerRole: string
  fieldMap: Record<DocuSealContractFieldKey, string>
}

export interface DocuSealContractSubmissionInput {
  externalId: string
  workspaceId: string
  workflowId: string
  offerRevisionId: string
  merchantLegalName: string
  signerEmail: string
  signerName: string
  funderName: string
  fundedAmountCents: number
  paybackAmountCents: number
  factorRate: number
  paymentFrequency: string
}

export interface DocuSealPsfFieldBinding {
  /** Exact, case-sensitive field name configured on the approved DocuSeal template. */
  name: string
  /** Expected template field type. The binding check fails closed if the template differs. */
  type: DocuSealPsfFieldType
  /** Optional DocuSeal field masking preference. No masking choice is inferred here. */
  mask?: boolean
}

export interface DocuSealProviderConfig {
  /** Exact API root: https://api.docuseal.com for Cloud or https://host.example/api for self-hosted. */
  apiBaseUrl: string
  apiToken: string
  webhookSecret: string
  templateId: number
  /** Exact, case-sensitive role name configured on the approved template. */
  signerRole: string
  fieldBindings: Record<DocuSealPsfFieldKey, DocuSealPsfFieldBinding>
  sendEmail: boolean
  requireEmail2fa: boolean
  /** Exact hosts from which temporary completed-document URLs may be downloaded. */
  artifactAllowedHosts: readonly string[]
}

export interface DocuSealPsfSubmissionInput {
  requestId: string
  workspaceId: string
  dealId: string
  offerRevisionId: string
  payloadHash: string
  signerName: string
  signerEmail: string
  amountCents: number
  bankName: string
  routingNumber: string
  accountNumber: string
  businessName: string
  contactName: string
  contactEmail: string
}

export interface DocuSealCreateSubmissionBody {
  template_id: number
  send_email: boolean
  send_sms: false
  order: "preserved"
  submitters: [{
    name: string
    email: string
    role: string
    external_id: string
    metadata: {
      mca_workspace_id: string
      mca_request_id: string
      mca_deal_id: string
      mca_offer_revision_id: string
      mca_payload_hash: string
    }
    require_email_2fa: boolean
    fields: Array<{
      name: string
      default_value: string
      readonly: true
      required: true
      mask?: boolean
    }>
  }]
}

export type DocuSealSubmitterStatus = "awaiting" | "sent" | "opened" | "completed" | "declined"

export interface DocuSealSubmissionIdentity {
  source: "reconciled" | "created"
  submissionId: string
  submitterId: string
  status: DocuSealSubmitterStatus
  slug?: string
  embedSrc?: string
}

export type DocuSealCreationMode =
  /** Caller durably reserved and locked this request and knows no provider POST was attempted. */
  | "never_attempted"
  /** A provider POST may already have occurred; lookup only and never create from an empty result. */
  | "reconcile_only"

export interface DocuSealExpectedSubmission {
  submissionId: string
  requestId: string
  signerEmail: string
  signerRole: string
}

export interface DocuSealArtifactReference {
  kind: "signed_document" | "audit_log" | "combined_document"
  name: string
  url: string
}

export interface DocuSealVerifiedCompletion {
  /** Closing must retain this state until every required artifact is durable and scan-clean. */
  state: "completed_pending_artifact"
  submissionId: string
  submitterId: string
  completedAt: string
  documents: DocuSealArtifactReference[]
  auditLog: DocuSealArtifactReference
  combinedDocument?: DocuSealArtifactReference
}

export interface DocuSealVerifiedWebhook {
  eventType: "submission.completed"
  submissionId: string
  eventTimestamp?: string
  payload: Record<string, unknown>
}

export interface DocuSealArtifact {
  bytes: Uint8Array
  mimeType: "application/pdf"
  checksum: string
}

export type DocuSealLookup = (
  hostname: string,
  options: { all: true; verbatim: true },
) => Promise<Array<{ address: string; family: number }>>

export interface DocuSealProviderDependencies {
  beforeRequest?: () => Promise<void>
  fetchImpl?: typeof fetch
  lookupImpl?: DocuSealLookup
  nowMs?: () => number
  timeoutMs?: number
  maxArtifactBytes?: number
}

interface NormalizedConfig extends DocuSealProviderConfig {
  apiBaseUrl: string
  apiToken: string
  webhookSecret: string
  signerRole: string
  artifactAllowedHosts: readonly string[]
}

const MAX_JSON_BYTES = 1_000_000
const DEFAULT_ARTIFACT_BYTES = 25 * 1024 * 1024
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function cleanRequired(value: string, field: string, max = 300): string {
  if (typeof value !== "string" || !value.trim() || value.trim().length > max) {
    throw new AppError(422, "docuseal_configuration_invalid", `${field} is required and must be at most ${max} characters.`)
  }
  return value.trim()
}

function providerId(value: unknown, field: string): string {
  const id = typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? String(value)
    : typeof value === "string" && /^\d+$/.test(value) && Number(value) > 0 ? value : ""
  if (!id) throw new AppError(502, "docuseal_response_invalid", `DocuSeal returned an invalid ${field}.`)
  return id
}

function normalizeConfig(config: DocuSealProviderConfig): NormalizedConfig {
  let api: URL
  try { api = new URL(config.apiBaseUrl) } catch { throw new AppError(422, "docuseal_configuration_invalid", "DocuSeal API root is invalid.") }
  if (api.protocol !== "https:" || api.username || api.password || api.search || api.hash) {
    throw new AppError(422, "docuseal_configuration_invalid", "DocuSeal API root must be an HTTPS URL without credentials, query, or fragment.")
  }
  if (!Number.isSafeInteger(config.templateId) || config.templateId <= 0) {
    throw new AppError(422, "docuseal_configuration_invalid", "DocuSeal template ID must be a positive integer.")
  }
  if (typeof config.sendEmail !== "boolean" || typeof config.requireEmail2fa !== "boolean") {
    throw new AppError(422, "docuseal_configuration_invalid", "DocuSeal email delivery and email 2FA choices must be explicit booleans.")
  }
  const names = new Set<string>()
  const fieldBindings = {} as Record<DocuSealPsfFieldKey, DocuSealPsfFieldBinding>
  for (const key of DOCUSEAL_PSF_FIELD_KEYS) {
    const source = config.fieldBindings?.[key]
    if (!source || !["text", "number"].includes(source.type) || (source.mask !== undefined && typeof source.mask !== "boolean")) {
      throw new AppError(422, "docuseal_configuration_invalid", `DocuSeal ${key} field type must be text or number.`)
    }
    const name = cleanRequired(source.name, `DocuSeal ${key} field name`, 180)
    if (names.has(name)) throw new AppError(422, "docuseal_configuration_invalid", "DocuSeal PSF field names must be unique.")
    names.add(name)
    fieldBindings[key] = { name, type: source.type, ...(source.mask === undefined ? {} : { mask: source.mask }) }
  }
  if (!Array.isArray(config.artifactAllowedHosts) || config.artifactAllowedHosts.some((host) => typeof host !== "string")) {
    throw new AppError(422, "docuseal_configuration_invalid", "DocuSeal artifact hosts must be an array of exact host names.")
  }
  const artifactAllowedHosts = [...new Set(config.artifactAllowedHosts.map((host) => host.trim().toLowerCase()))]
  if (!artifactAllowedHosts.length || artifactAllowedHosts.some((host) => !/^[a-z0-9.-]+$/.test(host) || host.startsWith(".") || host.endsWith("."))) {
    throw new AppError(422, "docuseal_configuration_invalid", "Configure one or more exact DocuSeal artifact hosts.")
  }
  const apiBaseUrl = api.toString().replace(/\/$/, "")
  const webhookSecret = cleanRequired(config.webhookSecret, "DocuSeal webhook secret", 500)
  if (webhookSecret.length < 32) throw new AppError(422, "docuseal_configuration_invalid", "DocuSeal webhook secret must contain at least 32 characters.")
  return {
    ...config,
    apiBaseUrl,
    apiToken: cleanRequired(config.apiToken, "DocuSeal API token", 500),
    webhookSecret,
    signerRole: cleanRequired(config.signerRole, "DocuSeal signer role", 180),
    fieldBindings,
    artifactAllowedHosts,
  }
}

function validateSubmissionInput(input: DocuSealPsfSubmissionInput): DocuSealPsfSubmissionInput {
  const requestId = cleanRequired(input.requestId, "PSF request ID", 200)
  const workspaceId = cleanRequired(input.workspaceId, "workspace ID", 200)
  const dealId = cleanRequired(input.dealId, "deal ID", 200)
  const offerRevisionId = cleanRequired(input.offerRevisionId, "offer revision ID", 200)
  if (!/^[a-f0-9]{64}$/i.test(input.payloadHash)) throw new AppError(422, "docuseal_submission_invalid", "PSF payload hash must be a SHA-256 hex digest.")
  if (!Number.isSafeInteger(input.amountCents) || input.amountCents <= 0) throw new AppError(422, "docuseal_submission_invalid", "PSF amount must be positive integer cents.")
  const signerEmail = cleanRequired(input.signerEmail, "signer email", 320).toLowerCase()
  const contactEmail = cleanRequired(input.contactEmail, "contact email", 320).toLowerCase()
  if (!EMAIL_PATTERN.test(signerEmail) || !EMAIL_PATTERN.test(contactEmail)) throw new AppError(422, "docuseal_submission_invalid", "PSF signer and contact emails must be valid.")
  const routingNumber = assertUsAbaRoutingNumber(String(input.routingNumber))
  const accountNumber = String(input.accountNumber).replace(/\s/g, "")
  if (!/^\d{4,17}$/.test(accountNumber)) {
    throw new AppError(422, "docuseal_submission_invalid", "PSF bank account details are invalid.")
  }
  return {
    ...input,
    requestId,
    workspaceId,
    dealId,
    offerRevisionId,
    payloadHash: input.payloadHash.toLowerCase(),
    signerName: cleanRequired(input.signerName, "signer name", 180),
    signerEmail,
    bankName: cleanRequired(input.bankName, "bank name", 180),
    routingNumber,
    accountNumber,
    businessName: cleanRequired(input.businessName, "business name", 220),
    contactName: cleanRequired(input.contactName, "contact name", 180),
    contactEmail,
  }
}

function centsText(cents: number): string {
  return `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, "0")}`
}

export function buildDocuSealPsfSubmissionRequest(configInput: DocuSealProviderConfig, inputValue: DocuSealPsfSubmissionInput): DocuSealCreateSubmissionBody {
  const config = normalizeConfig(configInput)
  const input = validateSubmissionInput(inputValue)
  const values: Record<DocuSealPsfFieldKey, string> = {
    amount: centsText(input.amountCents),
    bankName: input.bankName,
    routingNumber: input.routingNumber,
    accountNumber: input.accountNumber,
    businessName: input.businessName,
    contactName: input.contactName,
    contactEmail: input.contactEmail,
  }
  return {
    template_id: config.templateId,
    send_email: config.sendEmail,
    send_sms: false,
    order: "preserved",
    submitters: [{
      name: input.signerName,
      email: input.signerEmail,
      role: config.signerRole,
      external_id: input.requestId,
      metadata: {
        mca_workspace_id: input.workspaceId,
        mca_request_id: input.requestId,
        mca_deal_id: input.dealId,
        mca_offer_revision_id: input.offerRevisionId,
        mca_payload_hash: input.payloadHash,
      },
      require_email_2fa: config.requireEmail2fa,
      fields: DOCUSEAL_PSF_FIELD_KEYS.map((key) => ({
        name: config.fieldBindings[key].name,
        default_value: values[key],
        readonly: true,
        required: true,
        ...(config.fieldBindings[key].mask === undefined ? {} : { mask: config.fieldBindings[key].mask }),
      })),
    }],
  }
}

function apiUrl(config: NormalizedConfig, path: string): URL {
  return new URL(path.replace(/^\//, ""), `${config.apiBaseUrl}/`)
}

function isPrivateAddress(address: string): boolean {
  const normalized = address.toLowerCase().split("%")[0]
  if (normalized === "::" || normalized === "::1" || normalized.startsWith("fe8") || normalized.startsWith("fe9") || normalized.startsWith("fea") || normalized.startsWith("feb") || normalized.startsWith("fc") || normalized.startsWith("fd")) return true
  const mapped = normalized.startsWith("::ffff:") ? normalized.slice(7) : normalized
  if (isIP(mapped) !== 4) return false
  const parts = mapped.split(".").map(Number)
  const [a, b] = parts
  return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
}

async function assertSafeUrl(url: URL, allowedHosts: readonly string[], lookupImpl: DocuSealLookup, code: string): Promise<void> {
  if (url.protocol !== "https:" || url.username || url.password || !allowedHosts.includes(url.hostname.toLowerCase())) {
    throw new AppError(422, code, "DocuSeal URL is outside the configured HTTPS host allowlist.")
  }
  if (isIP(url.hostname) && isPrivateAddress(url.hostname)) throw new AppError(422, code, "DocuSeal URL resolves to a private address.")
  let addresses: Array<{ address: string; family: number }>
  try { addresses = await lookupImpl(url.hostname, { all: true, verbatim: true }) } catch { throw new AppError(503, "docuseal_dns_unavailable", "DocuSeal host resolution failed.") }
  if (!addresses.length || addresses.some((entry) => isPrivateAddress(entry.address))) {
    throw new AppError(422, code, "DocuSeal URL resolves to a private or unavailable address.")
  }
}

function timeout(dependencies: DocuSealProviderDependencies): number {
  const value = dependencies.timeoutMs ?? 10_000
  if (!Number.isSafeInteger(value) || value < 100 || value > 30_000) throw new AppError(422, "docuseal_configuration_invalid", "DocuSeal timeout must be between 100 and 30000 milliseconds.")
  return value
}

async function readBounded(response: Response, maxBytes: number, code: string): Promise<Uint8Array> {
  const length = Number(response.headers.get("content-length"))
  if (Number.isFinite(length) && length > maxBytes) throw new AppError(413, code, "DocuSeal response exceeds the configured size limit.")
  if (!response.body) return new Uint8Array()
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined)
      throw new AppError(413, code, "DocuSeal response exceeds the configured size limit.")
    }
    chunks.push(value)
  }
  const result = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength }
  return result
}

async function requestJson(config: NormalizedConfig, path: string, init: RequestInit, dependencies: DocuSealProviderDependencies): Promise<unknown> {
  const url = apiUrl(config, path)
  await assertSafeUrl(url, [new URL(config.apiBaseUrl).hostname.toLowerCase()], dependencies.lookupImpl ?? lookup, "docuseal_api_url_denied")
  await dependencies.beforeRequest?.()
  let response: Response
  try {
    response = await (dependencies.fetchImpl ?? fetch)(url, {
      ...init,
      headers: { accept: "application/json", "X-Auth-Token": config.apiToken, ...init.headers },
      redirect: "error",
      signal: AbortSignal.timeout(timeout(dependencies)),
    })
  } catch {
    throw new AppError(503, "docuseal_outcome_unknown", "DocuSeal did not return a verifiable response.")
  }
  if (!response.ok) {
    const status = response.status === 401 || response.status === 403 ? 503 : response.status >= 500 || response.status === 429 ? 503 : 422
    const code = response.status === 401 || response.status === 403 ? "docuseal_auth_rejected" : response.status >= 500 || response.status === 429 ? "docuseal_outcome_unknown" : "docuseal_request_rejected"
    throw new AppError(status, code, `DocuSeal rejected the request with HTTP ${response.status}.`)
  }
  const bytes = await readBounded(response, MAX_JSON_BYTES, "docuseal_response_too_large")
  try { return JSON.parse(new TextDecoder().decode(bytes)) as unknown } catch { throw new AppError(502, "docuseal_response_invalid", "DocuSeal returned invalid JSON.") }
}

function contractConfig(input: DocuSealContractProviderConfig): NormalizedConfig {
  const names = new Set<string>()
  for (const key of DOCUSEAL_CONTRACT_FIELD_KEYS) {
    const name = cleanRequired(input.fieldMap?.[key], `DocuSeal ${key} field name`, 180)
    if (names.has(name)) throw new AppError(422, "docuseal_configuration_invalid", "DocuSeal contract field names must be unique.")
    names.add(name)
  }
  let api: URL
  try { api = new URL(input.apiBaseUrl) } catch { throw new AppError(422, "docuseal_configuration_invalid", "DocuSeal API root is invalid.") }
  if (api.protocol !== "https:" || api.username || api.password || api.search || api.hash || !Number.isSafeInteger(input.templateId) || input.templateId <= 0) throw new AppError(422, "docuseal_configuration_invalid", "DocuSeal contract provider configuration is invalid.")
  return { apiBaseUrl: api.toString().replace(/\/$/, ""), apiToken: cleanRequired(input.apiKey, "DocuSeal API key", 500), webhookSecret: "contract-send-only-placeholder-secret", templateId: input.templateId,
    signerRole: cleanRequired(input.signerRole, "DocuSeal signer role", 180), fieldBindings: {} as DocuSealProviderConfig["fieldBindings"], sendEmail: true, requireEmail2fa: true, artifactAllowedHosts: [api.hostname] }
}

/** Creates the contract submission once. Callers must durably fence retries before invoking this. */
export async function createDocuSealContractSubmission(configInput: DocuSealContractProviderConfig, input: DocuSealContractSubmissionInput, dependencies: DocuSealProviderDependencies = {}): Promise<DocuSealSubmissionIdentity> {
  const config = contractConfig(configInput)
  const signerEmail = cleanRequired(input.signerEmail, "signer email", 320).toLowerCase()
  if (!EMAIL_PATTERN.test(signerEmail)) throw new AppError(422, "docuseal_submission_invalid", "Contract signer email must be valid.")
  if (!Number.isSafeInteger(input.fundedAmountCents) || input.fundedAmountCents <= 0 || !Number.isSafeInteger(input.paybackAmountCents) || input.paybackAmountCents < input.fundedAmountCents || !Number.isFinite(input.factorRate) || input.factorRate <= 0) {
    throw new AppError(422, "docuseal_submission_invalid", "Contract financial terms are invalid.")
  }
  const roleTemplate = object(await requestJson(config, `templates/${config.templateId}`, { method: "GET" }, dependencies))
  if (providerId(roleTemplate.id, "template ID") !== String(config.templateId) || roleTemplate.archived_at) throw new AppError(409, "docuseal_template_binding_invalid", "The configured contract template is missing, archived, or changed.")
  const roles = (Array.isArray(roleTemplate.submitters) ? roleTemplate.submitters : []).map(object)
  const role = roles.filter((item) => item.name === config.signerRole)
  if (role.length !== 1 || typeof role[0].uuid !== "string") throw new AppError(409, "docuseal_template_binding_invalid", "The configured contract signer role does not exactly match one template role.")
  const fields = (Array.isArray(roleTemplate.fields) ? roleTemplate.fields : []).map(object)
  for (const key of DOCUSEAL_CONTRACT_FIELD_KEYS) {
    const matches = fields.filter((field) => field.name === configInput.fieldMap[key])
    if (matches.length !== 1 || matches[0].submitter_uuid !== role[0].uuid) throw new AppError(409, "docuseal_template_binding_invalid", `The approved contract template no longer has the exact ${key} field binding.`)
  }
  const values: Record<DocuSealContractFieldKey, string> = {
    merchantLegalName: cleanRequired(input.merchantLegalName, "merchant legal name", 220), signerEmail,
    signerName: cleanRequired(input.signerName, "signer name", 180), funderName: cleanRequired(input.funderName, "funder name", 220),
    fundedAmount: centsText(input.fundedAmountCents), paybackAmount: centsText(input.paybackAmountCents),
    factorRate: String(input.factorRate), paymentFrequency: cleanRequired(input.paymentFrequency, "payment frequency", 40),
  }
  const payload = await requestJson(config, "submissions", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({
    template_id: config.templateId, send_email: true, send_sms: false, order: "preserved",
    submitters: [{ name: values.signerName, email: signerEmail, role: config.signerRole, external_id: cleanRequired(input.externalId, "contract external ID", 200),
      metadata: { mca_workspace_id: cleanRequired(input.workspaceId, "workspace ID", 200), mca_workflow_id: cleanRequired(input.workflowId, "workflow ID", 200), mca_offer_revision_id: cleanRequired(input.offerRevisionId, "offer revision ID", 200) },
      require_email_2fa: true, fields: DOCUSEAL_CONTRACT_FIELD_KEYS.map((key) => ({ name: configInput.fieldMap[key], default_value: values[key], readonly: true, required: true })) }],
  }) }, dependencies)
  const rows = Array.isArray(payload) ? payload : Array.isArray(object(payload).submitters) ? object(payload).submitters as unknown[] : []
  if (rows.length !== 1) throw new AppError(502, "docuseal_response_invalid", "DocuSeal returned an invalid contract submission response.")
  return identity(rows[0], "created")
}

function status(value: unknown): DocuSealSubmitterStatus {
  if (["awaiting", "sent", "opened", "completed", "declined"].includes(String(value))) return String(value) as DocuSealSubmitterStatus
  throw new AppError(502, "docuseal_response_invalid", "DocuSeal returned an invalid submitter status.")
}

function identity(value: unknown, source: DocuSealSubmissionIdentity["source"]): DocuSealSubmissionIdentity {
  const row = object(value)
  const slug = typeof row.slug === "string" && row.slug.trim() ? row.slug.trim() : undefined
  const embedSrc = typeof row.embed_src === "string" && row.embed_src.trim() ? row.embed_src.trim() : undefined
  return {
    source,
    submissionId: providerId(row.submission_id, "submission ID"),
    submitterId: providerId(row.id, "submitter ID"),
    status: status(row.status),
    ...(slug ? { slug } : {}),
    ...(embedSrc ? { embedSrc } : {}),
  }
}

function exactReconciledSubmitter(value: unknown, config: NormalizedConfig, input: DocuSealPsfSubmissionInput): DocuSealSubmissionIdentity {
  const row = object(value)
  const template = object(row.template)
  if (String(row.external_id ?? "") !== input.requestId
    || String(row.email ?? "").toLowerCase() !== input.signerEmail
    || row.role !== config.signerRole
    || providerId(template.id, "template ID") !== String(config.templateId)) {
    throw new AppError(409, "docuseal_reconciliation_conflict", "The DocuSeal external identity is already bound to different signer or template data.")
  }
  return identity(row, "reconciled")
}

async function findReconciledSubmission(config: NormalizedConfig, input: DocuSealPsfSubmissionInput, dependencies: DocuSealProviderDependencies): Promise<DocuSealSubmissionIdentity | undefined> {
  const rawPayload = await requestJson(config, `submitters?external_id=${encodeURIComponent(input.requestId)}&limit=100`, { method: "GET" }, dependencies)
  const payload = object(rawPayload)
  if (!Array.isArray(payload.data)) throw new AppError(502, "docuseal_response_invalid", "DocuSeal returned an invalid submitter lookup response.")
  const matches = payload.data.filter((item) => object(item).external_id === input.requestId)
  if (matches.length > 1) throw new AppError(409, "docuseal_reconciliation_ambiguous", "More than one DocuSeal submitter uses this PSF request identity.")
  return matches[0] ? exactReconciledSubmitter(matches[0], config, input) : undefined
}

export async function verifyDocuSealTemplateBinding(configInput: DocuSealProviderConfig, dependencies: DocuSealProviderDependencies = {}): Promise<void> {
  const config = normalizeConfig(configInput)
  const template = object(await requestJson(config, `templates/${config.templateId}`, { method: "GET" }, dependencies))
  if (providerId(template.id, "template ID") !== String(config.templateId) || template.archived_at) {
    throw new AppError(409, "docuseal_template_binding_invalid", "The configured DocuSeal template is missing, archived, or changed.")
  }
  const roles = (Array.isArray(template.submitters) ? template.submitters : []).map(object)
  const matchingRoles = roles.filter((item) => item.name === config.signerRole)
  if (matchingRoles.length !== 1 || typeof matchingRoles[0].uuid !== "string" || !matchingRoles[0].uuid) {
    throw new AppError(409, "docuseal_template_binding_invalid", "The configured DocuSeal signer role does not exactly match one template role.")
  }
  const signerUuid = matchingRoles[0].uuid
  const templateFields = (Array.isArray(template.fields) ? template.fields : []).map(object)
  for (const key of DOCUSEAL_PSF_FIELD_KEYS) {
    const binding = config.fieldBindings[key]
    const matches = templateFields.filter((field) => field.name === binding.name)
    if (matches.length !== 1 || matches[0].submitter_uuid !== signerUuid || matches[0].type !== binding.type) {
      throw new AppError(409, "docuseal_template_binding_invalid", `The approved template no longer has the exact ${key} field binding.`)
    }
  }
}

export async function reconcileDocuSealPsfSubmission(configInput: DocuSealProviderConfig, inputValue: DocuSealPsfSubmissionInput, dependencies: DocuSealProviderDependencies = {}): Promise<DocuSealSubmissionIdentity | undefined> {
  const config = normalizeConfig(configInput)
  const input = validateSubmissionInput(inputValue)
  return findReconciledSubmission(config, input, dependencies)
}

/**
 * The caller must durably reserve and lock the local PSF request before using
 * `never_attempted`, and must persist an unknown outcome after the first POST.
 * Every later retry uses `reconcile_only`; an empty lookup then remains unknown
 * because DocuSeal's external_id index may be delayed.
 */
export async function reconcileOrCreateDocuSealPsfSubmission(configInput: DocuSealProviderConfig, inputValue: DocuSealPsfSubmissionInput, mode: DocuSealCreationMode, dependencies: DocuSealProviderDependencies = {}): Promise<DocuSealSubmissionIdentity | undefined> {
  const config = normalizeConfig(configInput)
  const input = validateSubmissionInput(inputValue)
  const replay = await findReconciledSubmission(config, input, dependencies)
  if (replay) return replay
  if (mode === "reconcile_only") return undefined
  if (mode !== "never_attempted") throw new AppError(422, "docuseal_creation_mode_invalid", "Choose an explicit DocuSeal creation mode.")
  await verifyDocuSealTemplateBinding(config, dependencies)
  const request = buildDocuSealPsfSubmissionRequest(config, input)
  let originalError: unknown
  try {
    const payload = await requestJson(config, "submissions", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(request) }, dependencies)
    if (!Array.isArray(payload) || payload.length !== 1) throw new AppError(502, "docuseal_response_invalid", "DocuSeal returned an invalid submission response.")
    const row = object(payload[0])
    if (row.external_id !== input.requestId || String(row.email ?? "").toLowerCase() !== input.signerEmail || row.role !== config.signerRole) {
      throw new AppError(502, "docuseal_response_invalid", "DocuSeal returned a submission with different binding data.")
    }
    return identity(row, "created")
  } catch (error) {
    originalError = error
  }
  try {
    const recovered = await findReconciledSubmission(config, input, dependencies)
    if (recovered) return recovered
  } catch {
    // The creation outcome remains unknown if reconciliation is unavailable or conflicting.
  }
  if (originalError instanceof AppError && originalError.code === "docuseal_request_rejected") throw originalError
  throw new AppError(503, "docuseal_outcome_unknown", "DocuSeal submission creation could not be reconciled. Review provider activity before retrying.")
}

function rawBytes(rawBody: string | Uint8Array): Uint8Array {
  return typeof rawBody === "string" ? new TextEncoder().encode(rawBody) : rawBody
}

export function verifyDocuSealWebhook(rawBody: string | Uint8Array, signatureHeader: string | null, webhookSecret: string, options: { nowMs?: number; toleranceSeconds?: number } = {}): Record<string, unknown> {
  const secret = cleanRequired(webhookSecret, "DocuSeal webhook secret", 500)
  const [timestamp, supplied, extra] = (signatureHeader ?? "").split(".")
  const epoch = Number(timestamp)
  const tolerance = options.toleranceSeconds ?? 300
  if (extra !== undefined || !timestamp || !supplied || !/^\d+$/.test(timestamp) || !Number.isFinite(epoch) || !Number.isSafeInteger(tolerance) || tolerance < 1 || tolerance > 900
    || Math.abs((options.nowMs ?? Date.now()) / 1000 - epoch) > tolerance || !/^[a-f0-9]{64}$/i.test(supplied)) {
    throw new AppError(401, "docuseal_signature_invalid", "DocuSeal webhook signature is missing, malformed, or stale.")
  }
  const expected = createHmac("sha256", secret).update(`${timestamp}.`).update(rawBytes(rawBody)).digest("hex")
  const left = Buffer.from(expected, "hex"), right = Buffer.from(supplied, "hex")
  if (left.length !== right.length || !timingSafeEqual(left, right)) throw new AppError(401, "docuseal_signature_invalid", "DocuSeal webhook signature is invalid.")
  let payload: unknown
  try { payload = JSON.parse(new TextDecoder().decode(rawBytes(rawBody))) as unknown } catch { throw new AppError(400, "docuseal_webhook_invalid", "DocuSeal webhook body must be valid JSON.") }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new AppError(422, "docuseal_webhook_invalid", "DocuSeal webhook body must be an object.")
  return payload as Record<string, unknown>
}

export function requireDocuSealCompletedWebhook(payload: Record<string, unknown>, expectedSubmissionId?: string): DocuSealVerifiedWebhook {
  if (payload.event_type !== "submission.completed") throw new AppError(202, "docuseal_event_ignored", "Only submission.completed confirms that every signing party completed.")
  const data = object(payload.data)
  const submissionId = providerId(data.id, "webhook submission ID")
  if (expectedSubmissionId && submissionId !== expectedSubmissionId) throw new AppError(409, "docuseal_submission_binding_invalid", "DocuSeal webhook does not match the expected submission.")
  if (data.status !== "completed" || !Array.isArray(data.submitters) || !data.submitters.length || data.submitters.some((item) => object(item).status !== "completed")) {
    throw new AppError(409, "docuseal_submission_incomplete", "DocuSeal has not confirmed completion by every signing party.")
  }
  const eventTimestamp = typeof payload.timestamp === "string" && !Number.isNaN(Date.parse(payload.timestamp)) ? payload.timestamp : undefined
  return { eventType: "submission.completed", submissionId, ...(eventTimestamp ? { eventTimestamp } : {}), payload }
}

export function verifyDocuSealCompletedWebhook(rawBody: string | Uint8Array, signatureHeader: string | null, webhookSecret: string, options: { nowMs?: number; toleranceSeconds?: number; expectedSubmissionId?: string } = {}): DocuSealVerifiedWebhook {
  return requireDocuSealCompletedWebhook(
    verifyDocuSealWebhook(rawBody, signatureHeader, webhookSecret, options),
    options.expectedSubmissionId,
  )
}

function artifactReference(value: unknown, kind: DocuSealArtifactReference["kind"], fallbackName: string): DocuSealArtifactReference {
  const row = object(value)
  const url = typeof row.url === "string" ? row.url.trim() : ""
  if (!url) throw new AppError(502, "docuseal_artifact_missing", "DocuSeal completed without a required artifact URL.")
  const name = typeof row.name === "string" && row.name.trim() ? row.name.trim().slice(0, 180) : fallbackName
  return { kind, name, url }
}

export function requireDocuSealCompletedSubmission(configInput: DocuSealProviderConfig, payload: unknown, expected: DocuSealExpectedSubmission): DocuSealVerifiedCompletion {
  const config = normalizeConfig(configInput)
  const submission = object(payload)
  const submissionId = providerId(submission.id, "submission ID")
  const expectedSubmissionId = providerId(expected.submissionId, "expected submission ID")
  const expectedRequestId = cleanRequired(expected.requestId, "expected PSF request ID", 200)
  const expectedSignerEmail = cleanRequired(expected.signerEmail, "expected signer email", 320).toLowerCase()
  const expectedSignerRole = cleanRequired(expected.signerRole, "expected signer role", 180)
  if (!EMAIL_PATTERN.test(expectedSignerEmail) || expectedSignerRole !== config.signerRole) throw new AppError(409, "docuseal_submission_binding_invalid", "Expected DocuSeal signer binding does not match provider configuration.")
  if (submissionId !== expectedSubmissionId || submission.status !== "completed") throw new AppError(409, "docuseal_submission_incomplete", "DocuSeal submission is not the expected completed submission.")
  const completedAt = typeof submission.completed_at === "string" && !Number.isNaN(Date.parse(submission.completed_at)) ? submission.completed_at : ""
  if (!completedAt) throw new AppError(502, "docuseal_response_invalid", "DocuSeal completed submission has no valid completion time.")
  const template = object(submission.template)
  if (providerId(template.id, "template ID") !== String(config.templateId)) throw new AppError(409, "docuseal_submission_binding_invalid", "DocuSeal completed a different template.")
  const submitters = (Array.isArray(submission.submitters) ? submission.submitters : []).map(object)
  if (!submitters.length || submitters.some((item) => item.status !== "completed")) throw new AppError(409, "docuseal_submission_incomplete", "Not every DocuSeal submitter completed the submission.")
  const expectedSubmitters = submitters.filter((item) => item.external_id === expectedRequestId)
  if (expectedSubmitters.length !== 1) throw new AppError(409, "docuseal_submission_binding_invalid", "DocuSeal completion does not contain the expected PSF request identity.")
  const signer = expectedSubmitters[0]
  if (String(signer.email ?? "").toLowerCase() !== expectedSignerEmail || signer.role !== expectedSignerRole) {
    throw new AppError(409, "docuseal_submission_binding_invalid", "DocuSeal completion contains different signer binding data.")
  }
  const documents = (Array.isArray(submission.documents) ? submission.documents : []).map((item, index) => artifactReference(item, "signed_document", `signed-document-${index + 1}.pdf`))
  if (!documents.length) throw new AppError(502, "docuseal_artifact_missing", "DocuSeal completed without a signed document.")
  const auditLogUrl = typeof submission.audit_log_url === "string" ? submission.audit_log_url.trim() : ""
  if (!auditLogUrl) throw new AppError(502, "docuseal_artifact_missing", "DocuSeal completed without an audit log.")
  const combinedUrl = typeof submission.combined_document_url === "string" ? submission.combined_document_url.trim() : ""
  return {
    state: "completed_pending_artifact",
    submissionId,
    submitterId: providerId(signer.id, "submitter ID"),
    completedAt,
    documents,
    auditLog: { kind: "audit_log", name: "docuseal-audit-log.pdf", url: auditLogUrl },
    ...(combinedUrl ? { combinedDocument: { kind: "combined_document", name: "docuseal-combined.pdf", url: combinedUrl } } : {}),
  }
}

export async function getVerifiedDocuSealCompletedSubmission(configInput: DocuSealProviderConfig, expected: DocuSealExpectedSubmission, dependencies: DocuSealProviderDependencies = {}): Promise<DocuSealVerifiedCompletion> {
  const config = normalizeConfig(configInput)
  const submissionId = providerId(expected.submissionId, "expected submission ID")
  const payload = await requestJson(config, `submissions/${encodeURIComponent(submissionId)}`, { method: "GET" }, dependencies)
  return requireDocuSealCompletedSubmission(config, payload, { ...expected, submissionId })
}

export async function fetchDocuSealArtifact(configInput: DocuSealProviderConfig, rawUrl: string, dependencies: DocuSealProviderDependencies = {}): Promise<DocuSealArtifact> {
  const config = normalizeConfig(configInput)
  let url: URL
  try { url = new URL(rawUrl) } catch { throw new AppError(422, "docuseal_artifact_url_denied", "DocuSeal artifact URL is invalid.") }
  await assertSafeUrl(url, config.artifactAllowedHosts, dependencies.lookupImpl ?? lookup, "docuseal_artifact_url_denied")
  const maxBytes = dependencies.maxArtifactBytes ?? DEFAULT_ARTIFACT_BYTES
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 100 * 1024 * 1024) throw new AppError(422, "docuseal_configuration_invalid", "DocuSeal artifact limit must be between 1 byte and 100 MiB.")
  let response: Response
  try {
    response = await (dependencies.fetchImpl ?? fetch)(url, { method: "GET", headers: { accept: "application/pdf" }, redirect: "error", signal: AbortSignal.timeout(timeout(dependencies)) })
  } catch { throw new AppError(503, "docuseal_artifact_unavailable", "DocuSeal signed artifact could not be downloaded.") }
  if (!response.ok) throw new AppError(503, "docuseal_artifact_unavailable", `DocuSeal signed artifact returned HTTP ${response.status}.`)
  const mimeType = response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase()
  if (mimeType !== "application/pdf") throw new AppError(422, "docuseal_artifact_type_invalid", "DocuSeal signed artifact is not a PDF.")
  const bytes = await readBounded(response, maxBytes, "docuseal_artifact_too_large")
  if (bytes.byteLength < 5 || new TextDecoder().decode(bytes.slice(0, 5)) !== "%PDF-") throw new AppError(422, "docuseal_artifact_type_invalid", "DocuSeal signed artifact does not contain a PDF header.")
  return { bytes, mimeType: "application/pdf", checksum: createHash("sha256").update(bytes).digest("hex") }
}
