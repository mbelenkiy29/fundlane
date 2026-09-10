import "server-only"

import type { AdapterStatusResult, SubmissionJob } from "../../contracts"

export const LENDINI_SLUG = "lendini"
export const MAX_OWNERS = 1
export const ACKNOWLEDGEMENT_STATUS = "Received"

export const LENDINI_ENTITY_TYPES = [
  "LLC",
  "Corp",
  "Partnership",
  "Sole Proprietor",
  "Other",
] as const
export type LendiniEntityType = (typeof LENDINI_ENTITY_TYPES)[number]

export const LENDINI_INDUSTRIES = [
  "Food Services",
  "Retail",
  "Construction",
  "Healthcare",
  "Transportation",
  "Professional Services",
  "Manufacturing",
  "Automotive",
  "Other",
] as const
export type LendiniIndustry = (typeof LENDINI_INDUSTRIES)[number]

export const PROVIDER_STATUS_MAP = {
  received: "submitted",
  submitted: "submitted",
  acknowledged: "submitted",
  processing: "submitted",
  new: "submitted",
  newsubmission: "submitted",
  offer: "approved",
  offered: "approved",
  approved: "approved",
  declined: "declined",
  decline: "declined",
  rejected: "declined",
} as const

export type LendiniDocumentCategory = "application" | "bank_statements" | "other"

export interface LendiniOwnerInput {
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

export interface LendiniApplication {
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
  owner: LendiniOwnerInput
}

export interface LendiniMappedOwner {
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

export interface LendiniMappedDocument {
  documentId: string
  category: LendiniDocumentCategory
  checksum: string
}

export interface LendiniMappedRequest {
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
    entityType: LendiniEntityType
    startDate: string
  }
  owner: LendiniMappedOwner
  documents: LendiniMappedDocument[]
}

const INDUSTRY_ALIASES: Record<string, LendiniIndustry> = {
  food_services: "Food Services",
  food_service: "Food Services",
  restaurant: "Food Services",
  restaurants: "Food Services",
  cafe: "Food Services",
  coffee: "Food Services",
  coffee_shop: "Food Services",
  qsr: "Food Services",
  retail: "Retail",
  ecommerce: "Retail",
  e_commerce: "Retail",
  construction: "Construction",
  contractor: "Construction",
  healthcare: "Healthcare",
  medical: "Healthcare",
  dental: "Healthcare",
  transportation: "Transportation",
  trucking: "Transportation",
  logistics: "Transportation",
  professional_services: "Professional Services",
  consulting: "Professional Services",
  manufacturing: "Manufacturing",
  automotive: "Automotive",
  auto_repair: "Automotive",
  other: "Other",
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

function normalizeKey(value: string): string {
  return value.trim().toLowerCase().replace(/[\s-]+/g, "_")
}

function titleCaseIndustry(value: string): string {
  return value
    .trim()
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .split(" ")
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(" ")
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

export function mapEntityType(value: string): LendiniEntityType {
  const key = normalizeKey(value)
  if (key === "llc") return "LLC"
  if (
    key === "corporation"
    || key === "corp"
    || key === "inc"
    || key === "incorporated"
    || key === "c_corporation"
    || key === "c_corp"
    || key === "s_corporation"
    || key === "s_corp"
  ) {
    return "Corp"
  }
  if (key === "partnership" || key === "general_partnership" || key === "gp") return "Partnership"
  if (key === "sole_proprietor" || key === "sole_proprietorship" || key === "sole_prop") return "Sole Proprietor"
  if (key === "other" || key === "nonprofit" || key === "non_profit") return "Other"
  const exact = LENDINI_ENTITY_TYPES.find((item) => normalizeKey(item) === key)
  return exact ?? "Other"
}

export function formatIndustry(value: string): string {
  const trimmed = value.trim()
  if (!trimmed) return ""
  const exact = LENDINI_INDUSTRIES.find((item) => item.toLowerCase() === trimmed.toLowerCase())
  if (exact) return exact
  return INDUSTRY_ALIASES[normalizeKey(trimmed)] ?? titleCaseIndustry(trimmed)
}

export function mapIndustry(value: string): string {
  return formatIndustry(value)
}

export function mapDocumentCategory(category: string): LendiniDocumentCategory {
  const key = category.trim().toLowerCase().replace(/[\s-]+/g, "_")
  if (key === "application" || key === "api_application" || key === "app" || key === "signed_application") {
    return "application"
  }
  if (key === "statement" || key === "bank_statement" || key === "bank_statements" || key === "banks") {
    return "bank_statements"
  }
  return "other"
}

export function mapJobDocuments(job: SubmissionJob): LendiniMappedDocument[] {
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

export function selectPrimaryOwner<T extends { ownershipPercent?: number; isPrimary?: boolean }>(owners: T[]): T | undefined {
  if (!owners.length) return undefined
  return owners
    .map((owner, index) => ({ owner, index }))
    .sort((left, right) => {
      const percent = (right.owner.ownershipPercent ?? Number.NEGATIVE_INFINITY) - (left.owner.ownershipPercent ?? Number.NEGATIVE_INFINITY)
      if (percent !== 0) return percent
      if (left.owner.isPrimary === true && right.owner.isPrimary !== true) return -1
      if (right.owner.isPrimary === true && left.owner.isPrimary !== true) return 1
      return left.index - right.index
    })[0]!.owner
}

function ownerSource(record: Record<string, unknown>): unknown[] {
  if (Array.isArray(record.owners)) return record.owners
  if (record.owner) return [record.owner]
  const business = nested(record, "business")
  if (Array.isArray(business?.owners)) return business.owners
  if (business?.owner) return [business.owner]
  return []
}

function parseOwners(record: Record<string, unknown>): Array<Partial<LendiniOwnerInput> & { index: number }> {
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
): { ok: true; value: LendiniApplication } | { ok: false; fields: Record<string, string> } {
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
  const startDate = firstText(business, ["startDate", "businessStartDate", "inceptionDate", "inception_date", "dateEstablished"])

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
  if (!startDate) addField(fields, "startDate", "Business inception date is required.")
  else if (!isDate(startDate)) addField(fields, "startDate", "Use a valid date in YYYY-MM-DD format.")

  const parsedOwners = parseOwners(record)
  if (!parsedOwners.length) addField(fields, "owners", "At least one business owner is required.")
  const selected = selectPrimaryOwner(parsedOwners)
  if (selected) {
    const prefix = `owners.${selected.index}`
    if (!selected.firstName) addField(fields, `${prefix}.firstName`, "Owner first name is required.")
    if (!selected.lastName) addField(fields, `${prefix}.lastName`, "Owner last name is required.")
    if (!selected.street) addField(fields, `${prefix}.street`, "Owner street is required.")
    if (!selected.city) addField(fields, `${prefix}.city`, "Owner city is required.")
    if (!selected.state) addField(fields, `${prefix}.state`, "Owner state is required.")
    else if (!/^[A-Z]{2}$/.test(selected.state)) addField(fields, `${prefix}.state`, "Owner state must be a 2-letter code.")
    if (!selected.postalCode) addField(fields, `${prefix}.postalCode`, "Owner ZIP is required.")
    else if (!/^\d{5}(?:-?\d{4})?$/.test(selected.postalCode)) addField(fields, `${prefix}.postalCode`, "Owner ZIP must be 5 digits.")
    if (!selected.phone) addField(fields, `${prefix}.phone`, "Owner phone is required.")
    else if (digits(selected.phone).length < 10) addField(fields, `${prefix}.phone`, "Owner phone must include at least 10 digits.")
    if (!selected.email) addField(fields, `${prefix}.email`, "Owner email is required.")
    else if (!isEmail(selected.email)) addField(fields, `${prefix}.email`, "Enter a valid owner email address.")
    if (!selected.dateOfBirth) addField(fields, `${prefix}.dateOfBirth`, "Owner date of birth is required.")
    else if (!isDate(selected.dateOfBirth)) addField(fields, `${prefix}.dateOfBirth`, "Use a valid date in YYYY-MM-DD format.")
    if (!selected.ssn) addField(fields, `${prefix}.ssn`, "Owner SSN is required.")
    else if (selected.ssn.length !== 9) addField(fields, `${prefix}.ssn`, "Owner SSN must contain 9 digits.")
    if (selected.ownershipPercent === undefined) addField(fields, `${prefix}.ownershipPercent`, "Owner ownership percentage is required.")
    else if (selected.ownershipPercent < 0 || selected.ownershipPercent > 100) {
      addField(fields, `${prefix}.ownershipPercent`, "Ownership must be between 0 and 100%.")
    }
  }

  if (Object.keys(fields).length) return { ok: false, fields }
  if (!selected) {
    return { ok: false, fields: { owners: "At least one business owner is required." } }
  }
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
      owner: {
        firstName: selected.firstName!,
        lastName: selected.lastName!,
        street: selected.street!,
        city: selected.city!,
        state: selected.state!,
        postalCode: selected.postalCode!,
        phone: selected.phone!,
        email: selected.email!,
        dateOfBirth: selected.dateOfBirth!,
        ssn: selected.ssn!,
        ownershipPercent: selected.ownershipPercent!,
        isPrimary: selected.isPrimary,
        index: selected.index,
      },
    },
  }
}

export function mapApplication(application: LendiniApplication, documents: LendiniMappedDocument[] = []): LendiniMappedRequest {
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
      industry: formatIndustry(application.industry),
      entityType: mapEntityType(application.entityType),
      startDate: application.startDate,
    },
    owner: {
      firstName: application.owner.firstName,
      lastName: application.owner.lastName,
      street: application.owner.street,
      city: application.owner.city,
      state: application.owner.state,
      postalCode: application.owner.postalCode,
      phone: application.owner.phone,
      email: application.owner.email,
      dateOfBirth: application.owner.dateOfBirth,
      ssn: application.owner.ssn,
      ownershipPercent: application.owner.ownershipPercent,
    },
    documents,
  }
}
