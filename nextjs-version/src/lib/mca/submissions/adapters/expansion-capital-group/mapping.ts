import "server-only"

import type { AdapterStatusResult, SubmissionJob } from "../../contracts"

export const EXPANSION_CAPITAL_GROUP_SLUG = "expansion-capital-group"
export const MAX_OWNERS = 2

export const EXPANSION_ENTITY_TYPES = ["LLC", "Corporation", "Partnership", "Sole Proprietor", "Other"] as const
export type ExpansionEntityType = (typeof EXPANSION_ENTITY_TYPES)[number]

export const PROVIDER_STATUS_MAP = {
  "new submission": "submitted",
  "uw prep": "submitted",
  "ready to uw": "submitted",
  "on hold": "submitted",
  "soft approval": "approved",
  "contracts requested": "approved",
  "contracts out": "approved",
  "contracts in": "approved",
  funded: "funded",
  declined: "declined",
  "outside funded": "declined",
  dead: "declined",
  unwind: "declined",
} as const

export type ExpansionDocumentCategory = "application" | "bank_statements" | "other"

export interface ExpansionOwnerInput {
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

export interface ExpansionApplication {
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
  partnerEmail: string
  partnerRepName: string
  owners: ExpansionOwnerInput[]
}

export interface ExpansionMappedOwner {
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

export interface ExpansionMappedDocument {
  documentId: string
  category: ExpansionDocumentCategory
  checksum: string
}

export interface ExpansionMappedRequest {
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
    entityType: ExpansionEntityType
    startDate: string
    landlordName: ""
    landlordPhone: ""
  }
  owners: ExpansionMappedOwner[]
  partner: {
    email: string
    repName: string
  }
  documents: ExpansionMappedDocument[]
}

export interface ValidateApplicationOptions {
  isRegisteredPartner?: (email: string) => boolean
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

export function mapEntityType(value: string): ExpansionEntityType {
  const key = value.trim().toLowerCase().replace(/[\s-]+/g, "_")
  if (key === "llc") return "LLC"
  if (key === "corporation" || key === "corp" || key === "s_corporation" || key === "s_corp") return "Corporation"
  if (key === "partnership") return "Partnership"
  if (key === "sole_proprietor" || key === "sole_proprietorship") return "Sole Proprietor"
  if (key === "other") return "Other"
  const exact = EXPANSION_ENTITY_TYPES.find((item) => item.toLowerCase().replace(/[\s-]+/g, "_") === key)
  return exact ?? "Other"
}

export function mapDocumentCategory(category: string): ExpansionDocumentCategory {
  const key = category.trim().toLowerCase()
  if (key === "application" || key === "api_application") return "application"
  if (key === "statement" || key === "bank_statement" || key === "bank_statements") return "bank_statements"
  return "other"
}

export function mapJobDocuments(job: SubmissionJob): ExpansionMappedDocument[] {
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

export function selectOwners<T extends { ownershipPercent?: number; isPrimary?: boolean }>(owners: T[]): T[] {
  return owners
    .map((owner, index) => ({ owner, index }))
    .sort((left, right) => {
      const percent = (right.owner.ownershipPercent ?? Number.NEGATIVE_INFINITY) - (left.owner.ownershipPercent ?? Number.NEGATIVE_INFINITY)
      if (percent !== 0) return percent
      if (left.owner.isPrimary === true && right.owner.isPrimary !== true) return -1
      if (right.owner.isPrimary === true && left.owner.isPrimary !== true) return 1
      return left.index - right.index
    })
    .slice(0, MAX_OWNERS)
    .map((entry) => entry.owner)
}

function parseOwners(record: Record<string, unknown>): Array<Partial<ExpansionOwnerInput> & { index: number }> {
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
      isPrimary: owner.isPrimary === true,
    }
  })
}

function addField(fields: Record<string, string>, field: string, message: string): void {
  if (!fields[field]) fields[field] = message
}

export function validateApplication(
  input: unknown,
  options: ValidateApplicationOptions = {},
): { ok: true; value: ExpansionApplication } | { ok: false; fields: Record<string, string> } {
  const record = asRecord(input)
  if (!record) {
    return { ok: false, fields: { application: "An application payload is required." } }
  }
  const business = nested(record, "business") ?? record
  const partner = nested(record, "partner")
  const address = readAddress(business)
  const fields: Record<string, string> = {}
  const legalName = firstText(business, ["legalName", "businessName", "name"])
  const dba = firstText(business, ["dba", "dbaName"])
  const phone = firstText(business, ["phone", "contactPhone"])
  const ein = digits(firstText(business, ["ein", "taxId"]))
  const industry = firstText(business, ["industry"])
  const entityType = firstText(business, ["entityType", "legalStructure"])
  const startDate = firstText(business, ["startDate", "businessStartDate"])
  const partnerEmail = firstText(record, ["partnerEmail"]) || firstText(partner, ["email"])
  const partnerRepName = firstText(record, ["partnerRepName", "partnerName"]) || firstText(partner, ["repName", "name"])

  if (!legalName) addField(fields, "legalName", "Business name is required.")
  if (!dba) addField(fields, "dba", "DBA is required.")
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
  if (!partnerEmail) addField(fields, "partnerEmail", "Registered partner email is required.")
  else if (!isEmail(partnerEmail)) addField(fields, "partnerEmail", "Enter a valid partner email address.")
  else if (options.isRegisteredPartner && !options.isRegisteredPartner(partnerEmail)) {
    addField(fields, "partnerEmail", "Partner email must be registered with Expansion Capital Group.")
  }
  if (!partnerRepName) addField(fields, "partnerRepName", "Registered partner representative name is required.")

  const parsedOwners = parseOwners(record)
  if (!parsedOwners.length) addField(fields, "owners", "At least one business owner is required.")
  const selected = selectOwners(parsedOwners)
  for (const owner of selected) {
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

  if (Object.keys(fields).length) return { ok: false, fields }
  return {
    ok: true,
    value: {
      legalName,
      dba,
      street: address.street,
      city: address.city,
      state: address.state,
      postalCode: address.postalCode,
      phone,
      ein,
      industry,
      entityType,
      startDate,
      partnerEmail,
      partnerRepName,
      owners: selected.map((owner) => ({
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
    },
  }
}

export function mapApplication(application: ExpansionApplication, documents: ExpansionMappedDocument[] = []): ExpansionMappedRequest {
  return {
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
      landlordName: "",
      landlordPhone: "",
    },
    owners: application.owners.slice(0, MAX_OWNERS).map((owner) => ({
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
    partner: {
      email: application.partnerEmail,
      repName: application.partnerRepName,
    },
    documents,
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
