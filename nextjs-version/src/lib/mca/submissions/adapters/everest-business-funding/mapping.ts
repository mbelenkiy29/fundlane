import "server-only"

import type { AdapterSecretValues } from "../contracts"
import type { AdapterStatusResult, SubmissionJob } from "../../contracts"

export const EVEREST_BUSINESS_FUNDING_SLUG = "everest-business-funding"

export const CREDENTIAL_COMPONENT_FIELDS = {
  clientId: "clientId",
  clientSecret: "clientSecret",
} as const

export const PROVIDER_STATUS_MAP = {
  submitted: "submitted",
  received: "submitted",
  sent: "submitted",
  new: "submitted",
  newsubmission: "submitted",
  offer: "approved",
  offered: "approved",
  approved: "approved",
  declined: "declined",
  decline: "declined",
  rejected: "declined",
} as const

export type EverestDocumentCategory = "application" | "bank_statements" | "other"

export interface EverestCredentialComponents {
  clientId: string
  clientSecret: string
}

export interface EverestApplication {
  legalName: string
  ein: string
  dba?: string
  phone?: string
  street?: string
  city?: string
  state?: string
  postalCode?: string
  industry?: string
  entityType?: string
  documents: EverestMappedDocument[]
}

export interface EverestMappedDocument {
  documentId: string
  category: EverestDocumentCategory
  checksum: string
}

export interface EverestMappedRequest {
  business: {
    legalName: string
    ein: string
    dba: string
    phone: string
    street: string
    city: string
    state: string
    postalCode: string
    industry: string
    entityType: string
  }
  documents: EverestMappedDocument[]
  credentials: {
    hasClientId: boolean
    hasClientSecret: boolean
  }
}

export interface ValidateApplicationOptions {
  requireDocuments?: boolean
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function text(value: unknown): string {
  if (typeof value === "string") return value.trim()
  if (typeof value === "number" && Number.isFinite(value)) return String(value)
  return ""
}

function firstText(record: Record<string, unknown> | undefined, keys: string[]): string {
  if (!record) return ""
  for (const key of keys) {
    const value = text(record[key])
    if (value) return value
  }
  return ""
}

function nested(record: Record<string, unknown> | undefined, key: string): Record<string, unknown> | undefined {
  return asRecord(record?.[key])
}

function digits(value: string): string {
  return value.replace(/\D/g, "")
}

function addField(fields: Record<string, string>, field: string, message: string): void {
  if (!fields[field]) fields[field] = message
}

function readAddress(record: Record<string, unknown> | undefined, nestedKey = "address"): {
  street: string
  city: string
  state: string
  postalCode: string
} {
  const address = nested(record, nestedKey)
  return {
    street: firstText(record, ["street", "line1"]) || firstText(address, ["street", "line1"]),
    city: firstText(record, ["city"]) || firstText(address, ["city"]),
    state: (firstText(record, ["state"]) || firstText(address, ["state"])).toUpperCase(),
    postalCode: firstText(record, ["postalCode", "zip", "zipCode"]) || firstText(address, ["postalCode", "zip", "zipCode"]),
  }
}

export function statusToken(raw: string): string {
  return raw.trim().toLowerCase().replace(/[^a-z0-9]+/g, "")
}

export function mapDocumentCategory(category: string): EverestDocumentCategory {
  const key = category.trim().toLowerCase()
  if (key === "application" || key === "api_application" || key === "app") return "application"
  if (key === "statement" || key === "bank_statement" || key === "bank_statements" || key === "banks") {
    return "bank_statements"
  }
  return "other"
}

export function mapJobDocuments(job: SubmissionJob): EverestMappedDocument[] {
  if (job.documentVersions.length) {
    return job.documentVersions.map((document) => ({
      documentId: document.documentId,
      category: mapDocumentCategory(document.category),
      checksum: document.checksum,
    }))
  }
  return job.packageDocumentIds.map((documentId) => ({
    documentId,
    category: "other" as const,
    checksum: "",
  }))
}

export function parseDocuments(input: unknown): Array<{ documentId: string; category: string; checksum: string }> {
  const record = asRecord(input)
  const source = Array.isArray(record?.documents)
    ? record.documents
    : Array.isArray(record?.files)
      ? record.files
      : []
  return source.map((item, index) => {
    const document = asRecord(item) ?? {}
    return {
      documentId: firstText(document, ["documentId", "id"]) || `document-${index}`,
      category: firstText(document, ["category", "kind", "type"]) || "other",
      checksum: firstText(document, ["checksum"]),
    }
  })
}

export function requiredDocumentErrors(
  documents: Array<{ documentId?: string; category: string }>,
): Record<string, string> {
  const fields: Record<string, string> = {}
  const mapped = documents.map((document) => ({
    documentId: (document.documentId ?? "").trim(),
    category: mapDocumentCategory(document.category),
  }))
  const applications = mapped.filter((document) => document.category === "application")
  const statements = mapped.filter((document) => document.category === "bank_statements")
  if (!applications.length) addField(fields, "documents.application", "An API application file is required.")
  if (!statements.length) addField(fields, "documents.bankStatements", "Bank statement files are required.")
  const applicationIds = new Set(applications.map((document) => document.documentId).filter(Boolean))
  const statementIds = new Set(statements.map((document) => document.documentId).filter(Boolean))
  for (const documentId of applicationIds) {
    if (statementIds.has(documentId)) {
      addField(fields, "documents.distinct", "Application and bank-statement files must be distinct.")
      break
    }
  }
  return fields
}

export function validateJobDocuments(job: SubmissionJob): Record<string, string> {
  return requiredDocumentErrors(mapJobDocuments(job))
}

export function mapCredentialComponents(secrets: AdapterSecretValues = {}): EverestCredentialComponents {
  // Structured client ID/secret only; do not parse comma-joined API key blobs.
  return {
    clientId: secrets.clientId?.trim() ?? "",
    clientSecret: secrets.clientSecret?.trim() ?? "",
  }
}

export function mapProviderStatus(
  rawStatus: string,
): Pick<AdapterStatusResult, "rawStatus" | "normalized" | "unknown"> {
  const raw = rawStatus.trim()
  const normalized = PROVIDER_STATUS_MAP[statusToken(raw) as keyof typeof PROVIDER_STATUS_MAP]
  if (normalized) {
    return { rawStatus: raw, normalized, unknown: false }
  }
  return { rawStatus: raw, normalized: "unknown", unknown: true }
}

export function validateApplication(
  input: unknown,
  options: ValidateApplicationOptions = {},
): { ok: true; value: EverestApplication } | { ok: false; fields: Record<string, string> } {
  const record = asRecord(input)
  if (!record) {
    return { ok: false, fields: { application: "An application payload is required." } }
  }
  const business = nested(record, "business") ?? record
  const address = readAddress(business)
  const fields: Record<string, string> = {}
  const legalName = firstText(business, ["legalName", "businessName", "name"])
  const dba = firstText(business, ["dba", "dbaName"]) || firstText(record, ["dba", "dbaName"])
  const phone = firstText(business, ["phone", "contactPhone", "businessPhone"])
  const ein = digits(firstText(business, ["ein", "taxId"]))
  const industry = firstText(business, ["industry"])
  const entityType = firstText(business, ["entityType", "legalStructure"])

  if (!legalName) addField(fields, "legalName", "Business name is required.")
  if (!ein) addField(fields, "ein", "EIN / Tax ID is required.")
  else if (ein.length !== 9) addField(fields, "ein", "EIN must contain 9 digits.")

  const documents = parseDocuments(record)
  if (options.requireDocuments !== false) {
    Object.assign(fields, requiredDocumentErrors(documents))
  }

  if (Object.keys(fields).length) return { ok: false, fields }
  return {
    ok: true,
    value: {
      legalName,
      ein,
      dba: dba || undefined,
      phone: phone || undefined,
      street: address.street || undefined,
      city: address.city || undefined,
      state: address.state || undefined,
      postalCode: address.postalCode || undefined,
      industry: industry || undefined,
      entityType: entityType || undefined,
      documents: documents.map((document) => ({
        documentId: document.documentId,
        category: mapDocumentCategory(document.category),
        checksum: document.checksum,
      })),
    },
  }
}

export function mapApplication(
  application: EverestApplication,
  documents: EverestMappedDocument[] = [],
  secrets: AdapterSecretValues = {},
): EverestMappedRequest {
  const components = mapCredentialComponents(secrets)
  return {
    business: {
      legalName: application.legalName,
      ein: application.ein,
      dba: application.dba ?? "",
      phone: application.phone ?? "",
      street: application.street ?? "",
      city: application.city ?? "",
      state: application.state ?? "",
      postalCode: application.postalCode ?? "",
      industry: application.industry ?? "",
      entityType: application.entityType ?? "",
    },
    documents: documents.length ? documents : application.documents,
    credentials: {
      hasClientId: Boolean(components.clientId),
      hasClientSecret: Boolean(components.clientSecret),
    },
  }
}
