import "server-only"

import type { SubmissionJob } from "../../contracts"

export const FUNDOMATE_SLUG = "fundomate"

export const FUNDOMATE_OWNERSHIP_TYPES = [
  "LLC",
  "Corporation",
  "S-Corporation",
  "Partnership",
  "Sole Proprietor",
  "Other",
] as const
export type FundomateOwnershipType = (typeof FUNDOMATE_OWNERSHIP_TYPES)[number]

export const FUNDOMATE_INDUSTRIES = [
  "Food Services",
  "Retail",
  "Construction",
  "Healthcare",
  "Transportation",
  "Professional Services",
  "Manufacturing",
  "Other",
] as const
export type FundomateIndustry = (typeof FUNDOMATE_INDUSTRIES)[number]

export const FUNDOMATE_RECEIVED_STATUS = "Received"

export type FundomateDocumentCategory = "signed_application" | "bank_statements"

const INDUSTRY_ALIASES: Record<string, FundomateIndustry> = {
  "food services": "Food Services",
  "food service": "Food Services",
  restaurant: "Food Services",
  restaurants: "Food Services",
  "coffee shop": "Food Services",
  qsr: "Food Services",
  retail: "Retail",
  ecommerce: "Retail",
  "e commerce": "Retail",
  construction: "Construction",
  healthcare: "Healthcare",
  medical: "Healthcare",
  dental: "Healthcare",
  transportation: "Transportation",
  trucking: "Transportation",
  "professional services": "Professional Services",
  consulting: "Professional Services",
  manufacturing: "Manufacturing",
  other: "Other",
}

export interface FundomateOwnerInput {
  firstName: string
  lastName: string
  street: string
  city: string
  state: string
  postalCode: string
  ssn: string
  email?: string
  phone?: string
  dateOfBirth?: string
  ownershipPercent?: number
  index: number
}

export interface FundomateApplication {
  legalName: string
  street: string
  city: string
  state: string
  postalCode: string
  businessEmail: string
  ein: string
  industry: string
  ownershipType: string
  startMonthYear: string
  requestedAmount?: number
  owners: FundomateOwnerInput[]
  documents: FundomateMappedDocument[]
}

export interface FundomateMappedOwner {
  firstName: string
  lastName: string
  street: string
  city: string
  state: string
  postalCode: string
  ssnLast4: string
  email?: string
  phone?: string
  dateOfBirth?: string
  ownershipPercent?: number
}

export interface FundomateMappedDocument {
  documentId: string
  category: FundomateDocumentCategory
  checksum: string
}

export interface FundomateMappedRequest {
  business: {
    legalName: string
    street: string
    city: string
    state: string
    postalCode: string
    businessEmail: string
    ein: string
    industry: FundomateIndustry
    ownershipType: FundomateOwnershipType
    startMonthYear: string
    requestedAmount?: number
  }
  owners: FundomateMappedOwner[]
  documents: FundomateMappedDocument[]
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

function isDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00.000Z`))
}

function isEmail(value: string): boolean {
  return /^\S+@\S+\.\S+$/.test(value)
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

function money(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value.replace(/[$,\s]/g, ""))
    if (Number.isFinite(parsed)) return parsed
  }
  return undefined
}

export function normalizeEin(value: string): string {
  return digits(value)
}

export function isTexasState(state: string): boolean {
  const key = state.trim().toLowerCase()
  return key === "tx" || key === "texas"
}

export function parseStartMonthYear(value: string): string | undefined {
  const match = value.trim().match(/^(\d{4})-(\d{2})(?:-(\d{2}))?$/)
  if (!match) return undefined
  const month = Number(match[2])
  if (month < 1 || month > 12) return undefined
  if (match[3] && !isDate(`${match[1]}-${match[2]}-${match[3]}`)) return undefined
  return `${match[1]}-${match[2]}`
}

export function mapOwnershipType(value: string): FundomateOwnershipType {
  const key = value.trim().toLowerCase().replace(/[\s-]+/g, "_")
  if (key === "llc") return "LLC"
  if (key === "corporation" || key === "corp" || key === "c_corporation" || key === "c_corp") return "Corporation"
  if (key === "s_corporation" || key === "s_corp") return "S-Corporation"
  if (key === "partnership") return "Partnership"
  if (key === "sole_proprietor" || key === "sole_proprietorship") return "Sole Proprietor"
  if (key === "other") return "Other"
  const exact = FUNDOMATE_OWNERSHIP_TYPES.find((item) => item.toLowerCase().replace(/[\s-]+/g, "_") === key)
  return exact ?? "Other"
}

export function mapIndustry(value: string): FundomateIndustry {
  const key = value.trim().toLowerCase().replace(/[_-]+/g, " ").replace(/\s+/g, " ")
  if (!key) return "Other"
  if (INDUSTRY_ALIASES[key]) return INDUSTRY_ALIASES[key]
  const exact = FUNDOMATE_INDUSTRIES.find((item) => item.toLowerCase() === key)
  return exact ?? "Other"
}

export function mapDocumentCategory(category: string, extras: { kind?: string } = {}): FundomateDocumentCategory | undefined {
  const key = category.trim().toLowerCase()
  const kind = extras.kind?.trim().toLowerCase()
  if (key === "application" || key === "api_application" || key === "signed_application" || kind === "signed_application") {
    return "signed_application"
  }
  if (key === "statement" || key === "bank_statement" || key === "bank_statements") return "bank_statements"
  return undefined
}

export function mapJobDocuments(job: SubmissionJob): FundomateMappedDocument[] {
  const source = job.documentVersions.length
    ? job.documentVersions.map((document) => ({
      documentId: document.documentId,
      category: mapDocumentCategory(document.category),
      checksum: document.checksum,
    }))
    : job.packageDocumentIds.map((documentId) => ({
      documentId,
      category: undefined,
      checksum: "",
    }))
  return source.flatMap((document) => (
    document.category
      ? [{ documentId: document.documentId, category: document.category, checksum: document.checksum }]
      : []
  ))
}

function parseDocuments(record: Record<string, unknown>): FundomateMappedDocument[] {
  const source = Array.isArray(record.documents) ? record.documents : []
  return source.flatMap((item, index) => {
    const document = asRecord(item) ?? {}
    const category = mapDocumentCategory(firstText(document, ["category"]), {
      kind: firstText(document, ["kind"]),
    })
    if (!category) return []
    return [{
      documentId: firstText(document, ["documentId", "id"]) || `document-${index}`,
      category,
      checksum: firstText(document, ["checksum"]),
    }]
  })
}

function parseOwners(record: Record<string, unknown>): Array<Partial<FundomateOwnerInput> & { index: number }> {
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
    const email = firstText(owner, ["email"])
    const phone = firstText(owner, ["phone", "mobile"])
    const dateOfBirth = firstText(owner, ["dateOfBirth", "dob"])
    return {
      index,
      firstName: firstText(owner, ["firstName", "first_name"]),
      lastName: firstText(owner, ["lastName", "last_name"]),
      street: address.street,
      city: address.city,
      state: address.state,
      postalCode: address.postalCode,
      ssn: digits(firstText(owner, ["ssn", "socialSecurityNumber"])),
      email: email || undefined,
      phone: phone || undefined,
      dateOfBirth: dateOfBirth || undefined,
      ownershipPercent: percent !== undefined && Number.isFinite(percent) ? percent : undefined,
    }
  })
}

export function documentFieldErrors(documents: Array<{ category: string }>): Record<string, string> {
  const fields: Record<string, string> = {}
  if (!documents.some((document) => document.category === "signed_application")) {
    addField(fields, "signedApplication", "A signed merchant application is required.")
  }
  if (!documents.some((document) => document.category === "bank_statements")) {
    addField(fields, "bankStatements", "Bank statements are required.")
  }
  return fields
}

export function validateJobDocuments(job: SubmissionJob): Record<string, string> {
  return documentFieldErrors(mapJobDocuments(job))
}

export function validateApplication(
  input: unknown,
  options: ValidateApplicationOptions = {},
): { ok: true; value: FundomateApplication } | { ok: false; fields: Record<string, string> } {
  const record = asRecord(input)
  if (!record) {
    return { ok: false, fields: { application: "An application payload is required." } }
  }
  const business = nested(record, "business") ?? record
  const address = readAddress(business)
  const fields: Record<string, string> = {}
  const legalName = firstText(business, ["legalName", "businessName", "name", "companyName"])
  const businessEmail = firstText(business, ["businessEmail", "email", "contactEmail"])
  const ein = normalizeEin(firstText(business, ["ein", "taxId"]))
  const industry = firstText(business, ["industry"])
  const ownershipType = firstText(business, ["ownershipType", "entityType", "legalStructure"])
  const startMonthYear = parseStartMonthYear(firstText(business, ["startDate", "startMonthYear", "businessStartDate"]))
  const requestedAmount = money(
    business.requestedAmount ?? business.fundingAmount ?? business.amountRequested
      ?? record.requestedAmount ?? record.fundingAmount ?? record.amountRequested,
  )

  if (!legalName) addField(fields, "legalName", "Business name is required.")
  if (!address.street) addField(fields, "address.line1", "Business street is required.")
  if (!address.city) addField(fields, "address.city", "Business city is required.")
  if (!address.state) addField(fields, "address.state", "Business state is required.")
  else if (!/^[A-Z]{2}$/.test(address.state) && !isTexasState(address.state)) {
    addField(fields, "address.state", "Business state must be a 2-letter code.")
  }
  if (!address.postalCode) addField(fields, "address.postalCode", "Business ZIP is required.")
  else if (!/^\d{5}(?:-?\d{4})?$/.test(address.postalCode)) addField(fields, "address.postalCode", "Business ZIP must be 5 digits.")
  if (!businessEmail) addField(fields, "businessEmail", "Business email is required.")
  else if (!isEmail(businessEmail)) addField(fields, "businessEmail", "Enter a valid business email address.")
  if (!ein) addField(fields, "ein", "EIN / Tax ID is required.")
  else if (ein.length !== 9) addField(fields, "ein", "EIN must contain 9 digits.")
  if (!industry) addField(fields, "industry", "Industry is required.")
  if (!ownershipType) addField(fields, "ownershipType", "Ownership type is required.")
  if (!startMonthYear) {
    addField(fields, "startDate", "Enter the business start month and year as YYYY-MM or YYYY-MM-DD.")
  }
  // Fundomate requires requested amount only for Texas merchants.
  const texas = isTexasState(address.state)
  if (texas && requestedAmount === undefined) {
    addField(fields, "requestedAmount", "Requested funding amount is required for Texas businesses.")
  } else if (requestedAmount !== undefined && requestedAmount <= 0) {
    addField(fields, "requestedAmount", "Requested funding amount must be greater than zero.")
  }

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
    if (!owner.ssn) addField(fields, `${prefix}.ssn`, "Owner SSN is required.")
    else if (owner.ssn.length !== 9) addField(fields, `${prefix}.ssn`, "Owner SSN must contain 9 digits.")
    if (owner.email && !isEmail(owner.email)) addField(fields, `${prefix}.email`, "Enter a valid owner email address.")
    if (owner.phone && digits(owner.phone).length < 10) addField(fields, `${prefix}.phone`, "Owner phone must include at least 10 digits.")
    if (owner.dateOfBirth && !isDate(owner.dateOfBirth)) addField(fields, `${prefix}.dateOfBirth`, "Use a valid date in YYYY-MM-DD format.")
    if (owner.ownershipPercent !== undefined && (owner.ownershipPercent < 0 || owner.ownershipPercent > 100)) {
      addField(fields, `${prefix}.ownershipPercent`, "Ownership must be between 0 and 100%.")
    }
  }

  const documents = parseDocuments(record)
  if (options.requireDocuments !== false) {
    Object.assign(fields, documentFieldErrors(documents))
  }

  if (Object.keys(fields).length) return { ok: false, fields }
  const state = isTexasState(address.state) ? "TX" : address.state
  return {
    ok: true,
    value: {
      legalName,
      street: address.street,
      city: address.city,
      state,
      postalCode: address.postalCode,
      businessEmail,
      ein,
      industry,
      ownershipType,
      startMonthYear: startMonthYear!,
      requestedAmount,
      owners: parsedOwners.map((owner) => ({
        firstName: owner.firstName!,
        lastName: owner.lastName!,
        street: owner.street!,
        city: owner.city!,
        state: owner.state!,
        postalCode: owner.postalCode!,
        ssn: owner.ssn!,
        email: owner.email,
        phone: owner.phone,
        dateOfBirth: owner.dateOfBirth,
        ownershipPercent: owner.ownershipPercent,
        index: owner.index,
      })),
      documents,
    },
  }
}

export function mapApplication(application: FundomateApplication, documents: FundomateMappedDocument[] = []): FundomateMappedRequest {
  return {
    business: {
      legalName: application.legalName,
      street: application.street,
      city: application.city,
      state: application.state,
      postalCode: application.postalCode,
      businessEmail: application.businessEmail,
      ein: application.ein,
      industry: mapIndustry(application.industry),
      ownershipType: mapOwnershipType(application.ownershipType),
      startMonthYear: application.startMonthYear,
      requestedAmount: application.requestedAmount,
    },
    owners: application.owners.map((owner) => ({
      firstName: owner.firstName,
      lastName: owner.lastName,
      street: owner.street,
      city: owner.city,
      state: owner.state,
      postalCode: owner.postalCode,
      ssnLast4: owner.ssn.slice(-4),
      email: owner.email,
      phone: owner.phone,
      dateOfBirth: owner.dateOfBirth,
      ownershipPercent: owner.ownershipPercent,
    })),
    documents: documents.length ? documents : application.documents,
  }
}
