import "server-only"

import type { AdapterStatusResult, SubmissionJob } from "../../contracts"

export const BITTY_ADVANCE_SLUG = "bitty-advance"

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

export type BittyDocumentCategory = "application" | "bank_statements" | "other"

export interface BittyOwnerInput {
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

export interface BittyStatementInput {
  period: string
  revenue: number
  negativeDays: number
  index: number
}

export interface BittyApplication {
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
  owners: BittyOwnerInput[]
  statements: BittyStatementInput[]
}

export interface BittyMappedOwner {
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

export interface BittyMappedStatement {
  period: string
  revenue: number
  negativeDays: number
}

export interface BittyMappedDocument {
  documentId: string
  category: BittyDocumentCategory
  checksum: string
}

export interface BittyMappedRequest {
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
  owners: BittyMappedOwner[]
  statements: BittyMappedStatement[]
  documents: BittyMappedDocument[]
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

function isPeriod(value: string): boolean {
  if (/^\d{4}-\d{2}$/.test(value)) return true
  return isDate(value)
}

function isEmail(value: string): boolean {
  return /^\S+@\S+\.\S+$/.test(value)
}

function metricNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value.replace(/[$,]/g, "").trim())
    return Number.isFinite(parsed) ? parsed : undefined
  }
  const record = asRecord(value)
  if (!record || record.unknown === true) return undefined
  if (!Object.hasOwn(record, "value")) return undefined
  return metricNumber(record.value)
}

function firstMetric(record: Record<string, unknown> | undefined, keys: string[]): number | undefined {
  if (!record) return undefined
  for (const key of keys) {
    const value = metricNumber(record[key])
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

export function statusToken(raw: string): string {
  return raw.trim().toLowerCase().replace(/[^a-z0-9]+/g, "")
}

export function mapDocumentCategory(category: string): BittyDocumentCategory {
  const key = category.trim().toLowerCase()
  if (key === "application" || key === "api_application" || key === "app") return "application"
  if (key === "statement" || key === "bank_statement" || key === "bank_statements" || key === "banks") return "bank_statements"
  return "other"
}

export function mapJobDocuments(job: SubmissionJob): BittyMappedDocument[] {
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

function ownerSource(record: Record<string, unknown>): unknown[] {
  if (Array.isArray(record.owners)) return record.owners
  if (record.owner) return [record.owner]
  const business = nested(record, "business")
  if (Array.isArray(business?.owners)) return business.owners
  if (business?.owner) return [business.owner]
  return []
}

function parseOwners(record: Record<string, unknown>): Array<Partial<BittyOwnerInput> & { index: number }> {
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

function statementList(record: Record<string, unknown>): unknown[] {
  if (Array.isArray(record.statements)) return record.statements
  if (Array.isArray(record.statementMonths)) return record.statementMonths
  const underwriting = nested(record, "underwriting") ?? nested(record, "financial") ?? nested(record, "aggregate")
  if (Array.isArray(underwriting?.statements)) return underwriting.statements
  if (Array.isArray(underwriting?.statementMonths)) return underwriting.statementMonths
  if (record.statement) return [record.statement]
  if (underwriting?.statement) return [underwriting.statement]
  return []
}

function parseStatementItem(item: unknown, index: number): Partial<BittyStatementInput> & { index: number } {
  const statement = asRecord(item) ?? {}
  return {
    index,
    period: firstText(statement, ["period", "month", "statementMonth"]),
    revenue: firstMetric(statement, ["revenue", "deposits", "monthlyRevenue", "monthly_revenue"]),
    negativeDays: firstMetric(statement, ["negativeDays", "negative_days", "negativeDayCount"]),
  }
}

export function parseStatements(record: Record<string, unknown>): Array<Partial<BittyStatementInput> & { index: number }> {
  const listed = statementList(record).map(parseStatementItem)
  if (listed.length) return listed
  const underwriting = nested(record, "underwriting") ?? nested(record, "financial") ?? nested(record, "aggregate")
  const revenue = firstMetric(record, ["monthlyRevenue", "revenue", "deposits"])
    ?? firstMetric(underwriting, ["monthlyRevenue", "revenue", "deposits"])
  const negativeDays = firstMetric(record, ["negativeDays", "negative_days"])
    ?? firstMetric(underwriting, ["negativeDays", "negative_days"])
  const period = firstText(record, ["period", "month"]) || firstText(underwriting, ["period", "month"])
  if (revenue === undefined && negativeDays === undefined && !period) return []
  return [{ index: 0, period, revenue, negativeDays }]
}

function addField(fields: Record<string, string>, field: string, message: string): void {
  if (!fields[field]) fields[field] = message
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
): { ok: true; value: BittyApplication } | { ok: false; fields: Record<string, string> } {
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

  const parsedStatements = parseStatements(record)
  if (!parsedStatements.length) {
    addField(fields, "statements", "At least one statement with revenue and negative days is required.")
  }
  for (const statement of parsedStatements) {
    const prefix = `statements.${statement.index}`
    if (statement.period && !isPeriod(statement.period)) {
      addField(fields, `${prefix}.period`, "Use a statement period in YYYY-MM or YYYY-MM-DD format.")
    }
    if (statement.revenue === undefined) addField(fields, `${prefix}.revenue`, "Statement revenue is required.")
    else if (statement.revenue < 0) addField(fields, `${prefix}.revenue`, "Statement revenue must be 0 or greater.")
    if (statement.negativeDays === undefined) addField(fields, `${prefix}.negativeDays`, "Statement negative days are required.")
    else if (!Number.isInteger(statement.negativeDays) || statement.negativeDays < 0) {
      addField(fields, `${prefix}.negativeDays`, "Negative days must be a whole number of 0 or greater.")
    }
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
      statements: parsedStatements.map((statement) => ({
        period: statement.period || "",
        revenue: statement.revenue!,
        negativeDays: statement.negativeDays!,
        index: statement.index,
      })),
    },
  }
}

export function mapApplication(application: BittyApplication, documents: BittyMappedDocument[] = []): BittyMappedRequest {
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
    statements: application.statements.map((statement) => ({
      period: statement.period,
      revenue: statement.revenue,
      negativeDays: statement.negativeDays,
    })),
    documents,
  }
}
