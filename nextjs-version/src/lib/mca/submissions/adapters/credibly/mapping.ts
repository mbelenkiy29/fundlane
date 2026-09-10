import "server-only"

import type { AdapterStatusResult, SubmissionJob } from "../../contracts"

export const CREDIBLY_SLUG = "credibly"
export const CREDIBLY_API_VERSION = "v2"

export const CREDIBLY_ENTITY_TYPES = ["LLC", "Corporation", "Partnership", "Sole Proprietor", "Other"] as const
export type CrediblyEntityType = (typeof CREDIBLY_ENTITY_TYPES)[number]

export const PROVIDER_STATUS_MAP = {
  submitted: "submitted",
  "new submission": "submitted",
  received: "submitted",
  sent: "submitted",
  "in review": "submitted",
  underwriting: "submitted",
  prequalified: "pending",
  "pre qualified": "pending",
  pq: "pending",
  "offers ready": "approved",
  "offer ready": "approved",
  declined: "declined",
  decline: "declined",
  rejected: "declined",
  funded: "funded",
} as const

export type CrediblyDocumentCategory = "application" | "bank_statements" | "other"

export interface CrediblyOwnerInput {
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
  index: number
}

export interface CrediblyPositionInput {
  label: string
  estimatedPayment: number
  index: number
}

export interface CrediblyApplication {
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
  startDate: string
  owners: CrediblyOwnerInput[]
  positions: CrediblyPositionInput[]
  documents: CrediblyMappedDocument[]
}

export interface CrediblyMappedOwner {
  firstName: string
  lastName: string
  street: string
  city: string
  state: string
  postalCode: string
  phone: string
  email: string
  dateOfBirth: string
  ssnLast4: string
  ownershipPercent: number
}

export interface CrediblyMappedPosition {
  label: string
  estimatedPayment: number
}

export interface CrediblyMappedDocument {
  documentId: string
  category: CrediblyDocumentCategory
  checksum: string
}

export interface CrediblyMappedRequest {
  apiVersion: typeof CREDIBLY_API_VERSION
  business: {
    legalName: string
    dba?: string
    street: string
    city: string
    state: string
    postalCode: string
    phone: string
    ein: string
    industry: string
    entityType: CrediblyEntityType
    startDate: string
  }
  owners: CrediblyMappedOwner[]
  positions: CrediblyMappedPosition[]
  documents: CrediblyMappedDocument[]
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

function addField(fields: Record<string, string>, field: string, message: string): void {
  if (!fields[field]) fields[field] = message
}

export function mapEntityType(value: string): CrediblyEntityType {
  const key = value.trim().toLowerCase().replace(/[\s-]+/g, "_")
  if (key === "llc") return "LLC"
  if (key === "corporation" || key === "corp" || key === "s_corporation" || key === "s_corp") return "Corporation"
  if (key === "partnership") return "Partnership"
  if (key === "sole_proprietor" || key === "sole_proprietorship") return "Sole Proprietor"
  if (key === "other") return "Other"
  const exact = CREDIBLY_ENTITY_TYPES.find((item) => item.toLowerCase().replace(/[\s-]+/g, "_") === key)
  return exact ?? "Other"
}

export function mapDocumentCategory(category: string): CrediblyDocumentCategory {
  const key = category.trim().toLowerCase()
  if (key === "application" || key === "api_application" || key === "application for api") return "application"
  if (key === "statement" || key === "bank_statement" || key === "bank_statements") return "bank_statements"
  return "other"
}

export function mapJobDocuments(job: SubmissionJob): CrediblyMappedDocument[] {
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

export function requiredDocumentErrors(documents: Array<{ category: string }>): Record<string, string> {
  const fields: Record<string, string> = {}
  const categories = documents.map((document) => mapDocumentCategory(document.category))
  if (!categories.includes("application")) fields["documents.application"] = "An application file is required."
  if (!categories.includes("bank_statements")) fields["documents.bankStatements"] = "Bank statements are required."
  return fields
}

export function validateJobDocuments(
  documents: Array<{ documentId: string; checksum: string; category: string }>,
): Record<string, string> {
  return requiredDocumentErrors(documents)
}

function parseDocuments(record: Record<string, unknown>): Array<Partial<Omit<CrediblyMappedDocument, "category">> & { category: string }> {
  const source = Array.isArray(record.documents) ? record.documents : Array.isArray(record.files) ? record.files : []
  return source.map((item) => {
    const document = asRecord(item) ?? {}
    return {
      documentId: firstText(document, ["documentId", "id"]),
      category: firstText(document, ["category", "kind", "type"]) || "other",
      checksum: firstText(document, ["checksum"]),
    }
  })
}

function parseOwners(record: Record<string, unknown>): Array<Partial<CrediblyOwnerInput> & { index: number }> {
  const source = Array.isArray(record.owners) ? record.owners : record.owner ? [record.owner] : []
  return source.map((item, index) => {
    const owner = asRecord(item) ?? {}
    const address = readAddress(owner)
    const percentValue = owner.ownershipPercent ?? owner.ownership ?? owner.percentage
    const percent = typeof percentValue === "number"
      ? percentValue
      : text(percentValue) === ""
        ? Number.NaN
        : Number(text(percentValue))
    return {
      index,
      firstName: firstText(owner, ["firstName", "first_name"]),
      lastName: firstText(owner, ["lastName", "last_name"]),
      street: address.street,
      city: address.city,
      state: address.state,
      postalCode: address.postalCode,
      phone: firstText(owner, ["phone", "mobile"]),
      email: firstText(owner, ["email"]),
      dateOfBirth: firstText(owner, ["dateOfBirth", "dob"]),
      ssn: digits(firstText(owner, ["ssn", "socialSecurityNumber"])),
      ownershipPercent: Number.isFinite(percent) ? percent : undefined,
    }
  })
}

function positionSource(record: Record<string, unknown>): unknown[] | undefined {
  if (Array.isArray(record.positions)) return record.positions
  const underwrite = nested(record, "underwrite")
  if (Array.isArray(underwrite?.positions)) return underwrite.positions
  const underwriting = nested(record, "underwriting")
  if (Array.isArray(underwriting?.positions)) return underwriting.positions
  return undefined
}

function parsePositions(record: Record<string, unknown>): Array<Partial<CrediblyPositionInput> & { index: number }> | undefined {
  const source = positionSource(record)
  if (!source) return undefined
  return source.map((item, index) => {
    const position = asRecord(item) ?? {}
    const paymentValue = position.estimatedPayment ?? position.payment ?? position.monthlyPayment
    const payment = typeof paymentValue === "number"
      ? paymentValue
      : text(paymentValue) === ""
        ? Number.NaN
        : Number(text(paymentValue))
    return {
      index,
      label: firstText(position, ["label", "funderName", "name"]),
      estimatedPayment: Number.isFinite(payment) ? payment : undefined,
    }
  })
}

export function validateApplication(
  input: unknown,
): { ok: true; value: CrediblyApplication } | { ok: false; fields: Record<string, string> } {
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
  if (!startDate) addField(fields, "startDate", "Business start date is required.")
  else if (!isDate(startDate)) addField(fields, "startDate", "Use a valid date in YYYY-MM-DD format.")

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

  const parsedPositions = parsePositions(record)
  if (!parsedPositions) addField(fields, "positions", "Available positions are required.")
  else {
    for (const position of parsedPositions) {
      const prefix = `positions.${position.index}`
      if (!position.label) addField(fields, `${prefix}.label`, "Position label is required.")
      if (position.estimatedPayment === undefined) addField(fields, `${prefix}.estimatedPayment`, "Position payment is required.")
      else if (position.estimatedPayment < 0) addField(fields, `${prefix}.estimatedPayment`, "Position payment must be 0 or greater.")
    }
  }

  const parsedDocuments = parseDocuments(record)
  Object.assign(fields, requiredDocumentErrors(parsedDocuments))

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
      startDate,
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
        index: owner.index,
      })),
      positions: parsedPositions!.map((position) => ({
        label: position.label!,
        estimatedPayment: position.estimatedPayment!,
        index: position.index,
      })),
      documents: parsedDocuments.map((document) => ({
        documentId: document.documentId || "",
        category: mapDocumentCategory(document.category),
        checksum: document.checksum || "",
      })),
    },
  }
}

export function mapApplication(application: CrediblyApplication, documents: CrediblyMappedDocument[] = []): CrediblyMappedRequest {
  return {
    apiVersion: CREDIBLY_API_VERSION,
    business: {
      legalName: application.legalName,
      dba: application.dba,
      street: application.street,
      city: application.city,
      state: application.state,
      postalCode: application.postalCode,
      phone: application.phone,
      ein: application.ein,
      industry: application.industry,
      entityType: mapEntityType(application.entityType),
      startDate: application.startDate,
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
      ssnLast4: owner.ssn.slice(-4),
      ownershipPercent: owner.ownershipPercent,
    })),
    positions: application.positions.map((position) => ({
      label: position.label,
      estimatedPayment: position.estimatedPayment,
    })),
    documents: documents.length ? documents : application.documents,
  }
}

export function mapProviderStatus(
  rawStatus: string,
  outstandingDocuments: string[] = [],
): Pick<AdapterStatusResult, "rawStatus" | "normalized" | "unknown"> {
  if (outstandingDocuments.length) {
    const base = rawStatus.trim() || "In Review"
    return {
      rawStatus: `${base}: outstanding document requests: ${outstandingDocuments.join(", ")}`,
      normalized: "pending",
      unknown: false,
    }
  }
  const key = rawStatus.trim().toLowerCase().replace(/[_-]+/g, " ").replace(/\s+/g, " ")
  const normalized = PROVIDER_STATUS_MAP[key as keyof typeof PROVIDER_STATUS_MAP]
  if (normalized) {
    return { rawStatus, normalized, unknown: false }
  }
  return { rawStatus, normalized: "unknown", unknown: true }
}
