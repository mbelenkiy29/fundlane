import "server-only"

import type { AdapterStatusResult, SubmissionJob } from "../../contracts"

export const LENDR_SLUG = "lendr"

export const PROVIDER_STATUS_MAP = {
  submitted: "submitted",
  received: "submitted",
  sent: "submitted",
  new: "submitted",
  newsubmission: "submitted",
  inreview: "pending",
  pending: "pending",
  inprogress: "pending",
  approved: "approved",
  declined: "declined",
  decline: "declined",
  rejected: "declined",
  funded: "funded",
} as const

export type LendrDocumentCategory = "application" | "bank_statements" | "other"

export interface LendrOwnerInput {
  firstName: string
  lastName: string
  street: string
  city: string
  state: string
  postalCode: string
  phone: string
  email: string
  dateOfBirth: string
  ssn: string
  ownershipPercent: number
  isPrimary?: boolean
  index: number
}

export interface LendrDocumentInput {
  documentId: string
  category: string
  checksum: string
  index: number
}

export interface LendrApplication {
  legalName: string
  dba?: string
  street: string
  city: string
  state: string
  postalCode: string
  phone: string
  ein: string
  industry: string
  entityType: string
  startDate?: string
  owners: LendrOwnerInput[]
  documents: LendrDocumentInput[]
}

export interface LendrMappedOwner {
  firstName: string
  lastName: string
  street: string
  city: string
  state: string
  postalCode: string
  phone: string
  email: string
  dateOfBirth: string
  ssn: string
  ownershipPercent: number
}

export interface LendrMappedDocument {
  documentId: string
  category: LendrDocumentCategory
  checksum: string
}

export interface LendrMappedRequest {
  business: {
    legalName: string
    dba: string
    street: string
    city: string
    state: string
    postalCode: string
    phone: string
    ein: string
    industry: string
    entityType: string
    startDate: string
  }
  owners: LendrMappedOwner[]
  documents: LendrMappedDocument[]
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

function isDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00.000Z`))
}

function isEmail(value: string): boolean {
  return /^\S+@\S+\.\S+$/.test(value)
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

export function mapDocumentCategory(category: string): LendrDocumentCategory {
  const key = category.trim().toLowerCase()
  if (key === "application" || key === "api_application" || key === "app") return "application"
  if (key === "statement" || key === "bank_statement" || key === "bank_statements" || key === "banks") return "bank_statements"
  return "other"
}

export function isApplicationDocument(category: string): boolean {
  return mapDocumentCategory(category) === "application"
}

export function isBankStatementDocument(category: string): boolean {
  return mapDocumentCategory(category) === "bank_statements"
}

export function mapJobDocuments(job: SubmissionJob): LendrMappedDocument[] {
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

export function validateJobDocuments(
  documents: Array<{ documentId: string; checksum: string; category: string }>,
): Record<string, string> {
  const fields: Record<string, string> = {}
  if (!documents.some((document) => isApplicationDocument(document.category))) {
    fields["documents.application"] = "Upload the application file."
  }
  if (!documents.some((document) => isBankStatementDocument(document.category))) {
    fields["documents.bankStatements"] = "Upload bank statements."
  }
  return fields
}

function ownerSource(record: Record<string, unknown>): unknown[] {
  if (Array.isArray(record.owners)) return record.owners
  if (record.owner) return [record.owner]
  const business = nested(record, "business")
  if (Array.isArray(business?.owners)) return business.owners
  if (business?.owner) return [business.owner]
  return []
}

function parseOwners(record: Record<string, unknown>): Array<Partial<LendrOwnerInput> & { index: number }> {
  return ownerSource(record).map((item, index) => {
    const owner = asRecord(item) ?? {}
    const address = readAddress(owner)
    const percentValue = owner.ownershipPercent ?? owner.ownership ?? owner.percentage
    const percent = typeof percentValue === "number"
      ? percentValue
      : text(percentValue) === ""
        ? Number.NaN
        : Number(text(percentValue))
    const fullName = firstText(owner, ["name", "fullName"])
    const nameParts = fullName.split(/\s+/).filter(Boolean)
    return {
      index,
      firstName: firstText(owner, ["firstName", "first_name"]) || nameParts[0] || "",
      lastName: firstText(owner, ["lastName", "last_name"]) || nameParts.slice(1).join(" "),
      street: address.street,
      city: address.city,
      state: address.state,
      postalCode: address.postalCode,
      phone: firstText(owner, ["phone", "mobile"]),
      email: firstText(owner, ["email"]),
      dateOfBirth: firstText(owner, ["dateOfBirth", "dob"]),
      ssn: digits(firstText(owner, ["ssn", "socialSecurityNumber"])),
      ownershipPercent: Number.isFinite(percent) ? percent : undefined,
      isPrimary: owner.isPrimary === true,
    }
  })
}

function parseDocuments(record: Record<string, unknown>): LendrDocumentInput[] {
  const source = Array.isArray(record.documents)
    ? record.documents
    : Array.isArray(record.files)
      ? record.files
      : []
  return source.flatMap((item, index) => {
    const document = asRecord(item) ?? {}
    const documentId = firstText(document, ["documentId", "id"])
    const category = firstText(document, ["category", "kind", "type"])
    const checksum = firstText(document, ["checksum"])
    if (!documentId && !category && !checksum) return []
    return [{ documentId, category, checksum, index }]
  })
}

function addField(fields: Record<string, string>, field: string, message: string): void {
  if (!fields[field]) fields[field] = message
}

export function mapProviderStatus(
  rawStatus: string,
): Pick<AdapterStatusResult, "rawStatus" | "normalized" | "unknown"> {
  const raw = rawStatus.trim()
  const token = statusToken(raw)
  const normalized = PROVIDER_STATUS_MAP[token as keyof typeof PROVIDER_STATUS_MAP]
  if (normalized) {
    return { rawStatus: raw, normalized, unknown: false }
  }
  return { rawStatus: raw, normalized: "unknown", unknown: true }
}

export function validateApplication(
  input: unknown,
): { ok: true; value: LendrApplication } | { ok: false; fields: Record<string, string> } {
  const record = asRecord(input)
  if (!record) {
    return { ok: false, fields: { application: "An application payload is required." } }
  }
  const business = nested(record, "business") ?? record
  const address = readAddress(business)
  const fields: Record<string, string> = {}
  const legalName = firstText(business, ["legalName", "businessName", "name"])
  const dba = firstText(business, ["dba", "dbaName"])
  const phone = firstText(business, ["phone", "contactPhone"])
  const ein = digits(firstText(business, ["ein", "taxId"]))
  const industry = firstText(business, ["industry"])
  const entityType = firstText(business, ["entityType", "legalStructure"])
  const startDate = firstText(business, ["startDate", "businessStartDate"])

  if (!legalName) addField(fields, "legalName", "Business name is required.")
  if (!address.street) addField(fields, "address.line1", "Business street is required.")
  if (!address.city) addField(fields, "address.city", "Business city is required.")
  if (!address.state) addField(fields, "address.state", "Business state is required.")
  else if (!/^[A-Z]{2}$/.test(address.state)) addField(fields, "address.state", "Business state must be a 2-letter code.")
  if (!address.postalCode) addField(fields, "address.postalCode", "Business ZIP is required.")
  else if (!/^\d{5}(?:-?\d{4})?$/.test(address.postalCode)) addField(fields, "address.postalCode", "Business ZIP must be 5 digits.")
  if (!phone) addField(fields, "phone", "Business phone is required.")
  else if (digits(phone).length < 10) addField(fields, "phone", "Business phone must include at least 10 digits.")
  if (!ein) addField(fields, "ein", "EIN / Tax ID is required.")
  else if (ein.length !== 9) addField(fields, "ein", "EIN must contain 9 digits.")
  if (!industry) addField(fields, "industry", "Industry is required.")
  if (!entityType) addField(fields, "entityType", "Entity type is required.")
  if (startDate && !isDate(startDate)) addField(fields, "startDate", "Use a valid date in YYYY-MM-DD format.")

  const parsedOwners = parseOwners(record)
  if (!parsedOwners.length) addField(fields, "owners", "At least one business owner is required.")
  for (const owner of parsedOwners) {
    const prefix = `owners.${owner.index}`
    if (!owner.firstName) addField(fields, `${prefix}.firstName`, "Owner first name is required.")
    if (!owner.lastName) addField(fields, `${prefix}.lastName`, "Owner last name is required.")
    if (!owner.street) addField(fields, `${prefix}.street`, "Owner street is required.")
    if (!owner.city) addField(fields, `${prefix}.city`, "Owner city is required.")
    if (!owner.state) addField(fields, `${prefix}.state`, "Owner state is required.")
    else if (!/^[A-Z]{2}$/.test(owner.state)) addField(fields, `${prefix}.state`, "Owner state must be a 2-letter code.")
    if (!owner.postalCode) addField(fields, `${prefix}.postalCode`, "Owner ZIP is required.")
    else if (!/^\d{5}(?:-?\d{4})?$/.test(owner.postalCode)) addField(fields, `${prefix}.postalCode`, "Owner ZIP must be 5 digits.")
    if (!owner.phone) addField(fields, `${prefix}.phone`, "Owner phone is required.")
    else if (digits(owner.phone).length < 10) addField(fields, `${prefix}.phone`, "Owner phone must include at least 10 digits.")
    if (!owner.email) addField(fields, `${prefix}.email`, "Owner email is required.")
    else if (!isEmail(owner.email)) addField(fields, `${prefix}.email`, "Enter a valid owner email address.")
    if (!owner.dateOfBirth) addField(fields, `${prefix}.dateOfBirth`, "Owner date of birth is required.")
    else if (!isDate(owner.dateOfBirth)) addField(fields, `${prefix}.dateOfBirth`, "Use a valid date in YYYY-MM-DD format.")
    if (!owner.ssn) addField(fields, `${prefix}.ssn`, "Owner SSN is required.")
    else if (owner.ssn.length !== 9) addField(fields, `${prefix}.ssn`, "Owner SSN must contain 9 digits.")
    if (owner.ownershipPercent === undefined) addField(fields, `${prefix}.ownershipPercent`, "Owner ownership percentage is required.")
    else if (owner.ownershipPercent < 0 || owner.ownershipPercent > 100) addField(fields, `${prefix}.ownershipPercent`, "Ownership must be between 0 and 100%.")
  }

  const parsedDocuments = parseDocuments(record)
  if (!parsedDocuments.some((document) => isApplicationDocument(document.category))) {
    addField(fields, "documents.application", "Upload the application file.")
  }
  if (!parsedDocuments.some((document) => isBankStatementDocument(document.category))) {
    addField(fields, "documents.bankStatements", "Upload bank statements.")
  }

  if (Object.keys(fields).length) return { ok: false, fields }
  return {
    ok: true,
    value: {
      legalName,
      dba: dba || undefined,
      street: address.street,
      city: address.city,
      state: address.state,
      postalCode: address.postalCode,
      phone,
      ein,
      industry,
      entityType,
      startDate: startDate || undefined,
      owners: parsedOwners.map((owner) => ({
        firstName: owner.firstName!,
        lastName: owner.lastName!,
        street: owner.street!,
        city: owner.city!,
        state: owner.state!,
        postalCode: owner.postalCode!,
        phone: owner.phone!,
        email: owner.email!,
        dateOfBirth: owner.dateOfBirth!,
        ssn: owner.ssn!,
        ownershipPercent: owner.ownershipPercent!,
        isPrimary: owner.isPrimary,
        index: owner.index,
      })),
      documents: parsedDocuments,
    },
  }
}

export function mapApplication(
  application: LendrApplication,
  documents: LendrMappedDocument[] = [],
): LendrMappedRequest {
  const payloadDocuments = documents.length
    ? documents
    : application.documents.map((document) => ({
      documentId: document.documentId,
      category: mapDocumentCategory(document.category),
      checksum: document.checksum,
    }))
  return {
    business: {
      legalName: application.legalName,
      dba: application.dba ?? "",
      street: application.street,
      city: application.city,
      state: application.state,
      postalCode: application.postalCode,
      phone: application.phone,
      ein: application.ein,
      industry: application.industry,
      entityType: application.entityType,
      startDate: application.startDate ?? "",
    },
    owners: application.owners.map((owner) => ({
      firstName: owner.firstName,
      lastName: owner.lastName,
      street: owner.street,
      city: owner.city,
      state: owner.state,
      postalCode: owner.postalCode,
      phone: owner.phone,
      email: owner.email,
      dateOfBirth: owner.dateOfBirth,
      ssn: owner.ssn,
      ownershipPercent: owner.ownershipPercent,
    })),
    documents: payloadDocuments,
  }
}
