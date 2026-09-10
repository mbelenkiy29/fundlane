import type { AdapterStatusResult, SubmissionJob } from "../../contracts"

export const FINTEGRA_SLUG = "fintegra"
export const FINTEGRA_MAX_OWNERS = 3

export interface FintegraAddress {
  street: string
  city: string
  state: string
  zip: string
}

export interface FintegraOwnerInput {
  firstName?: string
  lastName?: string
  ssn?: string
  dateOfBirth?: string
  ownershipPercent?: number
  isPrimary?: boolean
  address?: Partial<FintegraAddress> & { line1?: string; postalCode?: string }
}

export interface FintegraDocumentInput {
  documentId?: string
  category?: string
  checksum?: string
}

export interface FintegraApplication {
  legalName?: string
  ein?: string
  address?: Partial<FintegraAddress> & { line1?: string; postalCode?: string }
  owners?: FintegraOwnerInput[]
  documents?: FintegraDocumentInput[]
  originatorEmail?: string
  isoName?: string
  brokerName?: string
}

export interface FintegraMappedOwner {
  firstName: string
  lastName: string
  ssnLast4: string
  dateOfBirth: string
  ownershipPercent: number
  isPrimary: boolean
  address: FintegraAddress
}

export interface FintegraMappedDocument {
  documentId: string
  category: "application" | "statement"
  checksum: string
}

export interface FintegraMappedRequest {
  attemptKey?: string
  workspaceId?: string
  originatorEmail: string
  isoName?: string
  brokerName?: string
  business: {
    legalName: string
    ein: string
    address: FintegraAddress
  }
  owners: FintegraMappedOwner[]
  documents: FintegraMappedDocument[]
}

export type FintegraValidationResult =
  | { ok: true; application: FintegraMappedRequest }
  | { ok: false; fields: Record<string, string> }

const SENT_STATUSES = new Set([
  "new_submission",
  "received",
  "work_in_process",
  "underwriting",
  "clarification_received",
  "processed",
])

function text(value: unknown, max = 200): string {
  if (typeof value !== "string") return ""
  const next = value.trim()
  return next.length > max ? "" : next
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
  return value as Record<string, unknown>
}

function digits(value: unknown): string {
  return typeof value === "string" || typeof value === "number" ? String(value).replace(/\D/g, "") : ""
}

function percent(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return undefined
}

function isDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00.000Z`))
}

function isEmail(value: string): boolean {
  return /^\S+@\S+\.\S+$/.test(value)
}

function isZip(value: string): boolean {
  return /^\d{5}(?:-\d{4})?$/.test(value)
}

function streetOf(address: Record<string, unknown> | undefined): string {
  if (!address) return ""
  return text(address.street) || text(address.line1)
}

function zipOf(address: Record<string, unknown> | undefined): string {
  if (!address) return ""
  return text(address.zip) || text(address.postalCode)
}

function readAddress(prefix: string, value: unknown, fields: Record<string, string>): FintegraAddress | undefined {
  const address = asRecord(value)
  const street = streetOf(address)
  const city = text(address?.city)
  const state = text(address?.state).toUpperCase()
  const zip = zipOf(address)
  if (!street) fields[`${prefix}.street`] = "Enter the street address."
  if (!city) fields[`${prefix}.city`] = "Enter the city."
  if (!/^[A-Z]{2}$/.test(state)) fields[`${prefix}.state`] = "Enter a two-letter state code."
  if (!isZip(zip)) fields[`${prefix}.zip`] = "Enter a ZIP code."
  if (fields[`${prefix}.street`] || fields[`${prefix}.city`] || fields[`${prefix}.state`] || fields[`${prefix}.zip`]) return undefined
  return { street, city, state, zip }
}

export function ssnLast4(ssn: string): string {
  return digits(ssn).slice(-4)
}

export function isApplicationCategory(category: string): boolean {
  const value = category.trim().toLowerCase()
  return value === "application" || value === "api_application"
}

export function isStatementCategory(category: string): boolean {
  return category.trim().toLowerCase() === "statement"
}

export function documentsFromJob(job: Pick<SubmissionJob, "documentVersions">): FintegraDocumentInput[] {
  return job.documentVersions.map((document) => ({
    documentId: document.documentId,
    category: document.category,
    checksum: document.checksum,
  }))
}

export function validateFintegraDocuments(documents: FintegraDocumentInput[] | undefined): Record<string, string> {
  const fields: Record<string, string> = {}
  const list = Array.isArray(documents) ? documents : []
  const usable = (document: FintegraDocumentInput, categoryOk: (category: string) => boolean) =>
    categoryOk(document.category ?? "") && Boolean(text(document.documentId, 128) && text(document.checksum, 128))
  if (!list.some((document) => usable(document, isApplicationCategory))) fields.applicationDocument = "Attach a signed application."
  if (!list.some((document) => usable(document, isStatementCategory))) fields.bankStatements = "Attach bank statements."
  return fields
}

function mapDocumentCategory(category: string): "application" | "statement" | undefined {
  if (isApplicationCategory(category)) return "application"
  if (isStatementCategory(category)) return "statement"
  return undefined
}

export function validateFintegraApplication(input: unknown): FintegraValidationResult {
  const fields: Record<string, string> = {}
  const root = asRecord(input)
  if (!root) return { ok: false, fields: { application: "Provide the merchant application as an object." } }

  const legalName = text(root.legalName)
  const einDigits = digits(root.ein)
  const originatorEmail = text(root.originatorEmail, 254).toLowerCase()
  const isoName = text(root.isoName) || undefined
  const brokerName = text(root.brokerName) || undefined
  if (!legalName) fields.legalName = "Enter the legal business name."
  if (einDigits.length !== 9) fields.ein = "Enter a 9-digit EIN / tax ID."
  const address = readAddress("address", root.address, fields)
  if (!originatorEmail) fields.originatorEmail = "Enter the registered originator email."
  else if (!isEmail(originatorEmail)) fields.originatorEmail = "Enter a valid originator email."

  const ownersRaw = root.owners
  if (!Array.isArray(ownersRaw) || ownersRaw.length === 0) {
    fields.owners = "A primary owner is required."
  } else if (ownersRaw.length > FINTEGRA_MAX_OWNERS) {
    fields.owners = "Fintegra accepts at most three owners."
  }

  const owners: FintegraMappedOwner[] = []
  const listed = Array.isArray(ownersRaw) ? ownersRaw.slice(0, FINTEGRA_MAX_OWNERS) : []
  listed.forEach((entry, index) => {
    const owner = asRecord(entry) ?? {}
    const prefix = `owners.${index}`
    const firstName = text(owner.firstName, 100)
    const lastName = text(owner.lastName, 100)
    const ssn = digits(owner.ssn)
    const dateOfBirth = text(owner.dateOfBirth) || text(owner.dob)
    const ownershipPercent = percent(owner.ownershipPercent)
    if (!firstName) fields[`${prefix}.firstName`] = "Enter the owner first name."
    if (!lastName) fields[`${prefix}.lastName`] = "Enter the owner last name."
    if (ssn.length !== 9) fields[`${prefix}.ssn`] = "Enter a 9-digit Social Security Number."
    if (!dateOfBirth || !isDate(dateOfBirth)) fields[`${prefix}.dateOfBirth`] = "Enter the owner date of birth as YYYY-MM-DD."
    if (ownershipPercent === undefined) fields[`${prefix}.ownershipPercent`] = "Enter the ownership percentage."
    else if (ownershipPercent < 0 || ownershipPercent > 100) fields[`${prefix}.ownershipPercent`] = "Ownership must be between 0 and 100%."
    const ownerAddress = readAddress(`${prefix}.address`, owner.address, fields)
    if (firstName && lastName && ssn.length === 9 && dateOfBirth && isDate(dateOfBirth) && ownershipPercent !== undefined && ownershipPercent >= 0 && ownershipPercent <= 100 && ownerAddress) {
      owners.push({
        firstName,
        lastName,
        ssnLast4: ssn.slice(-4),
        dateOfBirth,
        ownershipPercent,
        isPrimary: owner.isPrimary === true,
        address: ownerAddress,
      })
    }
  })

  const primaries = owners.filter((owner) => owner.isPrimary)
  if (!fields.owners && Array.isArray(ownersRaw) && ownersRaw.length > 0 && ownersRaw.length <= FINTEGRA_MAX_OWNERS) {
    if (primaries.length === 0) fields.owners = "Mark one owner as the primary owner."
    else if (primaries.length > 1) fields.owners = "Only one primary owner is allowed."
  }

  const documentFields = validateFintegraDocuments(Array.isArray(root.documents) ? root.documents as FintegraDocumentInput[] : undefined)
  Object.assign(fields, documentFields)
  const documents: FintegraMappedDocument[] = []
  if (Array.isArray(root.documents)) {
    for (const entry of root.documents) {
      const document = asRecord(entry) ?? {}
      const category = mapDocumentCategory(text(document.category, 64))
      const documentId = text(document.documentId, 128)
      const checksum = text(document.checksum, 128)
      if (!category || !documentId || !checksum) continue
      documents.push({ documentId, category, checksum })
    }
  }

  if (Object.keys(fields).length) return { ok: false, fields }
  if (!address) return { ok: false, fields: { address: "Enter the business address." } }
  return {
    ok: true,
    application: {
      originatorEmail,
      isoName,
      brokerName,
      business: {
        legalName,
        ein: `${einDigits.slice(0, 2)}-${einDigits.slice(2)}`,
        address,
      },
      owners,
      documents,
    },
  }
}

export function mapFintegraRequest(
  application: FintegraMappedRequest,
  job?: Pick<SubmissionJob, "attemptKey" | "workspaceId">,
): FintegraMappedRequest {
  return {
    ...application,
    attemptKey: job?.attemptKey,
    workspaceId: job?.workspaceId,
  }
}

export function mapFintegraStatus(rawStatus: string): Pick<AdapterStatusResult, "rawStatus" | "normalized" | "unknown"> {
  const raw = rawStatus.trim()
  const key = raw.toLowerCase().replace(/[\s-]+/g, "_").replace(/[^a-z0-9_]/g, "")
  if (SENT_STATUSES.has(key)) return { rawStatus: raw, normalized: "submitted", unknown: false }
  if (key === "awaiting_clarification") return { rawStatus: raw, normalized: "pending", unknown: false }
  if (key === "disregarded_email" || key === "cancelled" || key === "canceled" || key.startsWith("rejected")) {
    return { rawStatus: raw, normalized: "declined", unknown: false }
  }
  return { rawStatus: raw || "unknown", normalized: "unknown", unknown: true }
}
