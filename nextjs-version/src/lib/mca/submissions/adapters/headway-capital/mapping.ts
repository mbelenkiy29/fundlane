import "server-only"

import type { AdapterStatusResult, SubmissionJob } from "../../contracts"

export const HEADWAY_CAPITAL_SLUG = "headway-capital"

export const PROVIDER_STATUS_MAP = {
  "application incomplete": "pending",
  "in underwriting": "submitted",
  "action required": "pending",
  "offer ready": "approved",
  "contract unsigned": "approved",
  "funding pending": "approved",
  issued: "funded",
  declined: "declined",
} as const

export type HeadwayDocumentCategory = "application" | "bank_statements" | "other"

export interface HeadwayOwnerInput {
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
  ownershipPercent?: number
  index: number
}

export interface HeadwayApplication {
  legalName: string
  email: string
  street: string
  city: string
  state: string
  postalCode: string
  phone: string
  ein: string
  industry: string
  entityType: string
  startDate: string
  annualRevenue: number
  requestedAmount: number
  loanPurpose: string
  owners: HeadwayOwnerInput[]
  documents: HeadwayMappedDocument[]
}

export interface HeadwayMappedOwner {
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
  ownershipPercent?: number
}

export interface HeadwayMappedDocument {
  documentId: string
  category: HeadwayDocumentCategory
  checksum: string
}

export interface HeadwayMappedRequest {
  business: {
    legalName: string
    email: string
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
  financial: {
    annualRevenue: number
    requestedAmount: number
    loanPurpose: string
  }
  owners: HeadwayMappedOwner[]
  documents: HeadwayMappedDocument[]
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

function money(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value.replace(/[$,]/g, "").trim())
    if (Number.isFinite(parsed)) return parsed
  }
  return undefined
}

function firstMoney(record: Record<string, unknown> | undefined, keys: string[]): number | undefined {
  if (!record) return undefined
  for (const key of keys) {
    const value = money(record[key])
    if (value !== undefined) return value
  }
  return undefined
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

export function mapDocumentCategory(category: string): HeadwayDocumentCategory {
  const key = category.trim().toLowerCase()
  if (key === "application" || key === "api_application") return "application"
  if (key === "statement" || key === "bank_statement" || key === "bank_statements") return "bank_statements"
  return "other"
}

export function mapJobDocuments(job: SubmissionJob): HeadwayMappedDocument[] {
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

function parseDocuments(record: Record<string, unknown>): Array<Partial<Omit<HeadwayMappedDocument, "category">> & { category: string }> {
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

function parseOwners(record: Record<string, unknown>): Array<Partial<HeadwayOwnerInput> & { index: number }> {
  const source = Array.isArray(record.owners) ? record.owners : record.owner ? [record.owner] : []
  return source.map((item, index) => {
    const owner = asRecord(item) ?? {}
    const address = readAddress(owner)
    const percentValue = owner.ownershipPercent ?? owner.ownership ?? owner.percentage
    const percent = typeof percentValue === "number"
      ? percentValue
      : text(percentValue) === ""
        ? undefined
        : Number(text(percentValue))
    const fullName = firstText(owner, ["name", "fullName"])
    const nameParts = fullName.split(/\s+/).filter(Boolean)
    const firstName = firstText(owner, ["firstName", "first_name"]) || nameParts[0] || ""
    const lastName = firstText(owner, ["lastName", "last_name"]) || nameParts.slice(1).join(" ")
    return {
      index,
      firstName,
      lastName,
      street: address.street,
      city: address.city,
      state: address.state,
      postalCode: address.postalCode,
      phone: firstText(owner, ["phone", "mobile"]),
      email: firstText(owner, ["email"]),
      dateOfBirth: firstText(owner, ["dateOfBirth", "dob"]),
      ssn: digits(firstText(owner, ["ssn", "socialSecurityNumber"])),
      ownershipPercent: percent !== undefined && Number.isFinite(percent) ? percent : undefined,
    }
  })
}

function addField(fields: Record<string, string>, field: string, message: string): void {
  if (!fields[field]) fields[field] = message
}

export function validateApplication(
  input: unknown,
): { ok: true; value: HeadwayApplication } | { ok: false; fields: Record<string, string> } {
  const record = asRecord(input)
  if (!record) {
    return { ok: false, fields: { application: "An application payload is required." } }
  }
  const business = nested(record, "business") ?? record
  const financial = nested(record, "financial") ?? record
  const address = readAddress(business)
  const fields: Record<string, string> = {}
  const legalName = firstText(business, ["legalName", "businessName", "companyName", "name"])
  const email = firstText(business, ["email", "businessEmail", "contactEmail"])
  const phone = firstText(business, ["phone", "contactPhone", "businessPhone"])
  const ein = digits(firstText(business, ["ein", "taxId"]))
  const industry = firstText(business, ["industry", "industryName"])
  const entityType = firstText(business, ["entityType", "legalStructure"])
  const startDate = firstText(business, ["startDate", "businessStartDate"])
  const annualRevenue = firstMoney(financial, ["annualRevenue", "grossAnnualRevenue"])
  const requestedAmount = firstMoney(financial, ["requestedAmount", "requestedLoanAmount", "loanAmount"])
  const loanPurpose = firstText(financial, ["loanPurpose", "purpose", "useOfFunds"])

  if (!legalName) addField(fields, "legalName", "Business name is required.")
  if (!email) addField(fields, "email", "Business email is required.")
  else if (!isEmail(email)) addField(fields, "email", "Enter a valid business email address.")
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
  if (annualRevenue === undefined) addField(fields, "annualRevenue", "Annual revenue is required.")
  else if (annualRevenue <= 0) addField(fields, "annualRevenue", "Annual revenue must be greater than 0.")
  if (requestedAmount === undefined) addField(fields, "requestedAmount", "Requested loan amount is required.")
  else if (requestedAmount <= 0) addField(fields, "requestedAmount", "Requested loan amount must be greater than 0.")
  if (!loanPurpose) addField(fields, "loanPurpose", "Loan purpose is required.")

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
    if (owner.ownershipPercent !== undefined && (owner.ownershipPercent < 0 || owner.ownershipPercent > 100)) {
      addField(fields, `${prefix}.ownershipPercent`, "Ownership must be between 0 and 100%.")
    }
  }

  const parsedDocuments = parseDocuments(record)
  Object.assign(fields, requiredDocumentErrors(parsedDocuments))

  if (Object.keys(fields).length) return { ok: false, fields }
  return {
    ok: true,
    value: {
      legalName,
      email,
      street: address.street,
      city: address.city,
      state: address.state,
      postalCode: address.postalCode,
      phone,
      ein,
      industry,
      entityType,
      startDate,
      annualRevenue: annualRevenue!,
      requestedAmount: requestedAmount!,
      loanPurpose,
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
        ownershipPercent: owner.ownershipPercent,
        index: owner.index,
      })),
      documents: parsedDocuments.map((document) => ({
        documentId: document.documentId || "",
        category: mapDocumentCategory(document.category),
        checksum: document.checksum || "",
      })),
    },
  }
}

export function mapApplication(application: HeadwayApplication, documents: HeadwayMappedDocument[] = []): HeadwayMappedRequest {
  return {
    business: {
      legalName: application.legalName,
      email: application.email,
      street: application.street,
      city: application.city,
      state: application.state,
      postalCode: application.postalCode,
      phone: application.phone,
      ein: application.ein,
      industry: application.industry,
      entityType: application.entityType,
      startDate: application.startDate,
    },
    financial: {
      annualRevenue: application.annualRevenue,
      requestedAmount: application.requestedAmount,
      loanPurpose: application.loanPurpose,
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
    documents: documents.length ? documents : application.documents,
  }
}

export function mapProviderStatus(
  rawStatus: string,
  outstandingDocuments: string[] = [],
): Pick<AdapterStatusResult, "rawStatus" | "normalized" | "unknown"> {
  if (outstandingDocuments.length) {
    const base = rawStatus.trim() || "Application Incomplete"
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
