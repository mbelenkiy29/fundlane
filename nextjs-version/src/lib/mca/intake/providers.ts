import "server-only"

import { createHash, createHmac, createPublicKey, timingSafeEqual, verify } from "node:crypto"
import { AppError } from "../errors"
import { hashOpaqueToken } from "../crypto"
import type { DealWriteInput } from "../deals/schema"
import type { DocumentCategory } from "../documents/contracts"
import type { IntegrationRecord } from "./repository"
import { ZOHO_CONTRACT_KEY } from "./configuration"
import { verifyUsesendSignature } from "./usesend"

export interface ProviderAttachment {
  id: string
  url: string
  filename: string
  mimeType: string
  category: DocumentCategory
}

export interface ProviderApplication {
  eventId: string
  sourceReference: string
  application: DealWriteInput
  attachments: ProviderAttachment[]
  invitationToken?: string
  attributionToken?: string
  receiptRecipient?: string
  externalAssignee?: string
}

const GHL_ED25519_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAi2HR1srL4o18O8BRa7gVJY7G7bupbN3H9AwJrHCDiOg=
-----END PUBLIC KEY-----`

function equalText(left: string, right: string): boolean {
  const a = Buffer.from(left); const b = Buffer.from(right)
  return a.length === b.length && timingSafeEqual(a, b)
}

function bearerToken(request: Request): string | undefined {
  const authorization = request.headers.get("authorization")
  if (authorization?.toLowerCase().startsWith("bearer ")) return authorization.slice(7).trim()
  return request.headers.get("x-mca-webhook-token") ?? undefined
}

export function verifyProviderAdmission(request: Request, rawBody: string, integration: IntegrationRecord): void {
  if (!integration.enabled) throw new AppError(403, "integration_disabled", "This intake integration is disabled.")
  if (integration.provider === "email" && integration.emailGateway === "usesend") {
    if (!integration.signingSecret) throw new AppError(401, "webhook_signature_required", "useSend HMAC signing secret is not configured for this route.")
    verifyUsesendSignature(request, rawBody, integration.signingSecret)
    return
  }
  if (integration.provider === "email" && integration.emailGateway === "postmark") {
    const authorization = request.headers.get("authorization")
    const encoded = authorization?.match(/^Basic ([A-Za-z0-9+/]+={0,2})$/i)?.[1]
    let username = ""; let password = ""
    try {
      if (!encoded || encoded.length % 4 !== 0) throw new Error()
      const decoded = Buffer.from(encoded, "base64").toString("utf8")
      const separator = decoded.indexOf(":")
      if (separator < 0) throw new Error()
      username = decoded.slice(0, separator); password = decoded.slice(separator + 1)
    } catch { /* handled by the shared rejection below */ }
    if (username !== "mca" || !password || !integration.admissionSecretHash || !equalText(hashOpaqueToken(password), integration.admissionSecretHash)) {
      throw new AppError(401, "webhook_credential_invalid", "Postmark Basic credentials are missing or invalid.")
    }
    return
  }
  if (integration.provider === "highlevel") {
    const signature = request.headers.get("x-ghl-signature")
    if (!signature) throw new AppError(401, "webhook_signature_required", "HighLevel X-GHL-Signature is required.")
    let valid = false
    try {
      const publicKey = process.env.MCA_HIGHLEVEL_WEBHOOK_PUBLIC_KEY?.trim() || GHL_ED25519_PUBLIC_KEY
      valid = verify(null, Buffer.from(rawBody), createPublicKey(publicKey), Buffer.from(signature, "base64"))
    } catch { valid = false }
    if (!valid) throw new AppError(401, "webhook_signature_invalid", "HighLevel webhook signature is invalid.")
    return
  }
  if (integration.provider === "docuseal") {
    const signatureHeader = request.headers.get("x-docuseal-signature")
    if (!signatureHeader || !integration.signingSecret) throw new AppError(401, "webhook_signature_required", "DocuSeal HMAC signature is required.")
    const [timestamp, supplied] = signatureHeader.split(".", 2)
    const seconds = Number(timestamp)
    if (!supplied || !Number.isFinite(seconds) || Math.abs(Date.now() / 1000 - seconds) > 300) {
      throw new AppError(401, "webhook_signature_stale", "DocuSeal signature is malformed or older than five minutes.")
    }
    const expected = createHmac("sha256", integration.signingSecret).update(`${timestamp}.${rawBody}`).digest("hex")
    if (!equalText(expected, supplied)) throw new AppError(401, "webhook_signature_invalid", "DocuSeal webhook signature is invalid.")
    return
  }
  const token = bearerToken(request)
  if (!token || !integration.admissionSecretHash || !equalText(hashOpaqueToken(token), integration.admissionSecretHash)) {
    throw new AppError(401, "webhook_credential_invalid", "Webhook credential is missing or invalid.")
  }
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function text(value: unknown): string | undefined {
  if (typeof value === "string") return value.trim() || undefined
  if (typeof value === "number") return String(value)
  return undefined
}

function valueAt(source: unknown, path: string): unknown {
  let current = source
  for (const segment of path.split(".")) {
    if (Array.isArray(current) && /^\d+$/.test(segment)) current = current[Number(segment)]
    else if (current && typeof current === "object") current = (current as Record<string, unknown>)[segment]
    else return undefined
  }
  return current
}

function numeric(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value
  if (value === null || value === undefined) return undefined
  const normalized = String(value).replace(/[$,%\s,]/g, "")
  if (!normalized) return undefined
  const parsed = Number(normalized)
  return Number.isFinite(parsed) ? parsed : undefined
}

function put(target: Record<string, unknown>, path: string, value: unknown): void {
  if (value === undefined || value === "") return
  const segments = path.split(".")
  let current: Record<string, unknown> | unknown[] = target
  for (let index = 0; index < segments.length - 1; index += 1) {
    const segment = segments[index]
    const nextIsIndex = /^\d+$/.test(segments[index + 1])
    if (Array.isArray(current)) {
      const itemIndex = Number(segment)
      current[itemIndex] ??= nextIsIndex ? [] : {}
      current = current[itemIndex] as Record<string, unknown> | unknown[]
    } else {
      current[segment] ??= nextIsIndex ? [] : {}
      current = current[segment] as Record<string, unknown> | unknown[]
    }
  }
  const last = segments[segments.length - 1]
  if (Array.isArray(current)) current[Number(last)] = value
  else current[last] = value
}

const numberFields = new Set(["monthlyRevenue", "ficoScore", "requestedAmount"])
const permittedTargets = new Set([
  "legalName", "dbaName", "ein", "entityType", "contactName", "contactEmail", "contactPhone",
  "startDate", "industry", "naicsCode", "monthlyRevenue", "ficoScore", "fundingPurpose", "requestedAmount",
  "address.line1", "address.line2", "address.city", "address.state", "address.postalCode", "address.country",
])
const ownerFields = new Set(["firstName", "lastName", "ownershipPercent", "isPrimary", "dateOfBirth", "identityLast4", "email", "phone"])
const MAX_MAPPED_OWNERS = 10

function ownerTarget(target: string): { index: number; field: string } | undefined {
  const match = /^owners\.(\d+)\.([A-Za-z][A-Za-z0-9]*)$/.exec(target)
  if (!match) return undefined
  const index = Number(match[1])
  if (!Number.isInteger(index) || index < 0 || index >= MAX_MAPPED_OWNERS || !ownerFields.has(match[2])) return undefined
  return { index, field: match[2] }
}

function permittedTarget(target: string): boolean {
  return permittedTargets.has(target) || Boolean(ownerTarget(target))
}

function mappedApplication(source: Record<string, unknown>, mapping: Record<string, string>): DealWriteInput {
  const result: Record<string, unknown> = {}
  for (const [target, sourcePath] of Object.entries(mapping)) {
    if (!permittedTarget(target) || !sourcePath || sourcePath.startsWith("rep:")) continue
    let value = valueAt(source, sourcePath)
    const owner = ownerTarget(target)
    if (numberFields.has(target) || owner?.field === "ownershipPercent") value = numeric(value)
    if (owner?.field === "isPrimary" && value !== undefined && value !== null && value !== "") {
      const normalized = typeof value === "string" ? value.trim().toLowerCase() : value
      value = normalized === true || normalized === "true" || normalized === "yes" || normalized === "1"
    }
    put(result, target, value)
  }
  return result as DealWriteInput
}

function withDefaultMapping(source: Record<string, unknown>, integration: IntegrationRecord): DealWriteInput {
  const defaults: Record<string, string> = {
    legalName: "legalName", dbaName: "dbaName", ein: "ein", entityType: "entityType",
    contactName: "contactName", contactEmail: "contactEmail", contactPhone: "contactPhone",
    startDate: "startDate", industry: "industry", naicsCode: "naicsCode", monthlyRevenue: "monthlyRevenue",
    ficoScore: "ficoScore", fundingPurpose: "fundingPurpose", requestedAmount: "requestedAmount",
    "address.line1": "address.line1", "address.line2": "address.line2", "address.city": "address.city",
    "address.state": "address.state", "address.postalCode": "address.postalCode", "address.country": "address.country",
  }
  const sourceOwners = Array.isArray(source.owners) ? source.owners : source.owner ? [source.owner] : []
  for (let index = 0; index < Math.min(sourceOwners.length, MAX_MAPPED_OWNERS); index += 1) {
    for (const field of ownerFields) defaults[`owners.${index}.${field}`] = `${Array.isArray(source.owners) ? "owners" : "owner"}.${Array.isArray(source.owners) ? `${index}.` : ""}${field}`
  }
  return mappedApplication(source, Object.keys(integration.mapping).length ? integration.mapping : defaults)
}

function inferMime(filename: string, supplied?: string): string {
  if (supplied) return supplied
  const lower = filename.toLowerCase()
  if (lower.endsWith(".pdf")) return "application/pdf"
  if (lower.endsWith(".png")) return "image/png"
  return "image/jpeg"
}

function filenameFromUrl(url: string, fallback: string): string {
  try {
    const parts = new URL(url).pathname.split("/").filter(Boolean)
    return decodeURIComponent(parts[parts.length - 1] ?? fallback)
  } catch { return fallback }
}

function attachment(value: unknown, index: number, defaultCategory: DocumentCategory = "other_stip"): ProviderAttachment | undefined {
  if (typeof value === "string" && value.startsWith("https://")) {
    const filename = filenameFromUrl(value, `attachment-${index + 1}`)
    return { id: createHash("sha256").update(value).digest("hex").slice(0, 24), url: value, filename, mimeType: inferMime(filename), category: defaultCategory }
  }
  const item = object(value)
  const url = text(item.url) ?? text(item.downloadUrl) ?? text(item.download_url)
  if (!url) return undefined
  const filename = text(item.filename) ?? text(item.name) ?? filenameFromUrl(url, `attachment-${index + 1}`)
  const category = text(item.category) as DocumentCategory | undefined
  return { id: text(item.id) ?? text(item.uuid) ?? createHash("sha256").update(url).digest("hex").slice(0, 24), url, filename, mimeType: inferMime(filename, text(item.mimeType) ?? text(item.mime_type)), category: category ?? defaultCategory }
}

function attachments(values: unknown[], defaultCategory?: DocumentCategory): ProviderAttachment[] {
  return values.flatMap((value, index) => {
    if (Array.isArray(value)) return value.map((nested, nestedIndex) => attachment(nested, index + nestedIndex, defaultCategory)).filter(Boolean) as ProviderAttachment[]
    const item = attachment(value, index, defaultCategory)
    return item ? [item] : []
  })
}

function categorizedAttachments(source: Record<string, unknown>, integration: IntegrationRecord, existing: ProviderAttachment[]): ProviderAttachment[] {
  const mapped = (["application", "statement"] as const).flatMap(category => {
    const path = integration.mapping[`files:${category}`]
    const value = path ? valueAt(source, path) : undefined
    return attachments(value === undefined ? [] : [value], category)
  })
  const urls = new Set(mapped.map(file => file.url))
  return [...mapped, ...existing.filter(file => !urls.has(file.url))]
}

function jotform(payload: Record<string, unknown>, integration: IntegrationRecord): ProviderApplication {
  const formId = text(payload.formID) ?? text(payload.formId)
  if (!formId || formId !== integration.formId) throw new AppError(422, "provider_binding_mismatch", "Jotform form ID does not match this integration.")
  const eventId = text(payload.submissionID) ?? text(payload.submissionId)
  if (!eventId) throw new AppError(422, "provider_event_missing", "Jotform submissionID is required.")
  let raw = object(payload.rawRequest)
  if (typeof payload.rawRequest === "string") {
    try { raw = object(JSON.parse(payload.rawRequest)) } catch { throw new AppError(400, "provider_payload_invalid", "Jotform rawRequest must contain valid JSON.") }
  }
  const uploads = Object.values(raw).filter((value) => typeof value === "string" && value.startsWith("https://www.jotform.com/uploads/"))
  return {
    eventId, sourceReference: `jotform:submission:${eventId}`, application: withDefaultMapping(raw, integration),
    attachments: categorizedAttachments(raw, integration, attachments([...(Array.isArray(payload.attachments) ? payload.attachments : []), ...uploads])),
    invitationToken: raw.mca_invite !== undefined ? String(raw.mca_invite) : payload.mca_invite !== undefined ? String(payload.mca_invite) : undefined,
    attributionToken: text(raw.mca_rep) ?? text(payload.mca_rep), receiptRecipient: text(raw.contactEmail),
    externalAssignee: text(raw.assignedRep) ?? text(raw.assigned_rep),
  }
}

function fillout(payload: Record<string, unknown>, integration: IntegrationRecord): ProviderApplication {
  const formId = text(payload.formId) ?? text(payload.form_id)
  if (!formId || formId !== integration.formId) throw new AppError(422, "provider_binding_mismatch", "Fillout form ID does not match this integration.")
  const eventId = text(payload.submissionId) ?? text(payload.submission_id)
  if (!eventId) throw new AppError(422, "provider_event_missing", "Fillout submissionId is required.")
  const flat: Record<string, unknown> = {}
  const fileValues: unknown[] = []
  for (const question of Array.isArray(payload.questions) ? payload.questions : []) {
    const item = object(question); const name = text(item.name) ?? text(item.id)
    if (name) flat[name] = item.value
    if (["fileUpload", "file_upload", "file"].includes(text(item.type) ?? "")) fileValues.push(item.value)
  }
  for (const parameter of Array.isArray(payload.urlParameters) ? payload.urlParameters : []) {
    const item = object(parameter); const name = text(item.name)
    if (name) flat[name] = item.value
  }
  return {
    eventId, sourceReference: `fillout:submission:${eventId}`, application: withDefaultMapping(flat, integration),
    attachments: attachments(fileValues), attributionToken: text(flat.mca_rep), receiptRecipient: text(flat.contactEmail),
    externalAssignee: text(flat.assignedRep) ?? text(flat.assigned_rep),
  }
}

function highlevel(payload: Record<string, unknown>, integration: IntegrationRecord): ProviderApplication {
  const locationId = text(payload.locationId)
  if (!locationId || locationId !== integration.locationId) throw new AppError(422, "provider_binding_mismatch", "HighLevel location ID does not match this integration.")
  const eventId = text(payload.webhookId)
  if (!eventId) throw new AppError(422, "provider_event_missing", "HighLevel webhookId is required.")
  const source = { ...payload }
  const customFields: Record<string, unknown> = {}
  for (const field of Array.isArray(payload.customFields) ? payload.customFields : []) {
    const item = object(field); const name = text(item.id) ?? text(item.key)
    if (name) customFields[name] = item.value
  }
  source.customFields = customFields
  return {
    eventId, sourceReference: `highlevel:webhook:${eventId}`, application: withDefaultMapping(source, integration),
    attachments: categorizedAttachments(source, integration, attachments(Array.isArray(payload.attachments) ? payload.attachments : [])), receiptRecipient: text(payload.email),
    externalAssignee: text(payload.assignedTo) ?? text(payload.assignedUserId),
  }
}

function custom(payload: Record<string, unknown>, integration: IntegrationRecord): ProviderApplication {
  const formId = text(payload.formId)
  if (!formId || formId !== integration.formId) throw new AppError(422, "provider_binding_mismatch", "Custom form ID does not match this integration.")
  const eventId = text(payload.eventId)
  if (!eventId) throw new AppError(422, "provider_event_missing", "Custom webhook eventId is required.")
  const source = object(payload.application)
  return {
    eventId, sourceReference: text(payload.sourceReference) ?? `custom:event:${eventId}`,
    application: Object.keys(integration.mapping).length ? mappedApplication(source, integration.mapping) : source as DealWriteInput,
    attachments: categorizedAttachments(source, integration, attachments(Array.isArray(payload.attachments) ? payload.attachments : [])),
    attributionToken: text(payload.attributionToken), receiptRecipient: text(source.contactEmail),
    externalAssignee: text(payload.assignedRep),
  }
}

function zoho(payload: Record<string, unknown>, integration: IntegrationRecord): ProviderApplication {
  if (integration.approvalState !== "approved" || integration.contractKey !== ZOHO_CONTRACT_KEY) {
    throw new AppError(503, "zoho_contract_pending", "Select and approve a supported Zoho payload and attachment contract before receiving submissions.")
  }
  const formId = text(payload.formId)
  if (!formId || formId !== integration.formId) throw new AppError(422, "provider_binding_mismatch", "Zoho form ID does not match this integration.")
  const eventId = text(payload.entryId)
  if (!eventId) throw new AppError(422, "provider_event_missing", "The approved Zoho entry identifier is required.")
  const driveFiles = (value: unknown, field: "applicationFile" | "statementFile", category: DocumentCategory): ProviderAttachment[] => {
    if (value === undefined || value === null || value === "") return []
    const values = Array.isArray(value) ? value : [value]
    if (!values.length || values.length > 10) throw new AppError(422, "zoho_attachment_link_invalid", `${field} must contain one to ten Google Drive links.`)
    return values.map((item, index) => {
      if (typeof item !== "string") throw new AppError(422, "zoho_attachment_link_invalid", `${field} must contain Google Drive link strings.`)
      let url: URL
      try { url = new URL(item) } catch { throw new AppError(422, "zoho_attachment_link_invalid", `${field} contains an invalid URL.`) }
      if (url.protocol !== "https:" || url.hostname !== "drive.google.com" || url.username || url.password) {
        throw new AppError(422, "zoho_attachment_link_invalid", `${field} accepts only recognized HTTPS Google Drive file links.`)
      }
      const pathMatch = /^\/file\/d\/([A-Za-z0-9_-]{10,200})\/view\/?$/.exec(url.pathname)
      const openId = url.pathname === "/open" ? url.searchParams.get("id") : undefined
      const fileId = pathMatch?.[1] ?? (openId && /^[A-Za-z0-9_-]{10,200}$/.test(openId) ? openId : undefined)
      if (!fileId) throw new AppError(422, "zoho_attachment_link_invalid", `${field} contains an unsupported Google Drive file link.`)
      const sourceUrl = `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?alt=media`
      return {
        id: createHash("sha256").update(`zoho-drive\0${field}\0${fileId}\0${index}`).digest("hex"),
        url: sourceUrl,
        filename: `${category}-${fileId.slice(-12)}.pdf`,
        mimeType: "application/pdf",
        category,
      }
    })
  }
  return {
    eventId, sourceReference: `zoho:entry:${eventId}`, application: withDefaultMapping(payload, integration),
    attachments: [
      ...driveFiles(payload.applicationFile, "applicationFile", "application"),
      ...driveFiles(payload.statementFile, "statementFile", "statement"),
    ],
    receiptRecipient: text(payload.contactEmail),
  }
}

function docuseal(payload: Record<string, unknown>, integration: IntegrationRecord): ProviderApplication {
  const eventType = text(payload.event_type)
  if (eventType !== "submission.completed") {
    throw new AppError(202, "docuseal_event_ignored", "Only submission.completed confirms that every signing party has completed.")
  }
  const data = object(payload.data)
  const eventId = text(data.id)
  if (!eventId) throw new AppError(422, "provider_event_missing", "DocuSeal completed submission ID is required.")
  const template = object(data.template)
  const templateId = text(data.template_id) ?? text(template.id)
  if (!templateId || templateId !== integration.templateId) throw new AppError(422, "docuseal_template_unknown", "DocuSeal template is not assigned to this integration and was placed in review.")
  const flat: Record<string, unknown> = { ...data }
  for (const submitter of Array.isArray(data.submitters) ? data.submitters : []) {
    const item = object(submitter)
    for (const value of Array.isArray(item.values) ? item.values : []) {
      const field = object(value); const name = text(field.field) ?? text(field.name)
      if (name) flat[name] = field.value
    }
  }
  return {
    eventId, sourceReference: `docuseal:submission:${eventId}`, application: withDefaultMapping(flat, integration),
    attachments: attachments(Array.isArray(data.documents) ? data.documents : [], "application"),
    receiptRecipient: text(object((data.submitters as unknown[])?.[0]).email),
  }
}

export function normalizeProviderPayload(provider: string, payload: unknown, integration: IntegrationRecord): ProviderApplication {
  const body = object(payload)
  switch (provider) {
    case "jotform": return jotform(body, integration)
    case "fillout": return fillout(body, integration)
    case "highlevel": return highlevel(body, integration)
    case "custom": return custom(body, integration)
    case "zoho": return zoho(body, integration)
    case "docuseal": return docuseal(body, integration)
    default: throw new AppError(404, "provider_not_supported", "This provider does not use the form webhook route.")
  }
}
