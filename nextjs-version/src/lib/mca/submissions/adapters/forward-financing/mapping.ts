import "server-only"

import type { AdapterStatusResult, SubmissionJob } from "../../contracts"

export const FORWARD_FINANCING_SLUG = "forward-financing"
export const MAX_OWNERS = 2

export const FORWARD_ENTITY_TYPES = [
  "LLC",
  "Corporation",
  "S-Corporation",
  "Partnership",
  "Sole Proprietor",
  "Other",
] as const
export type ForwardEntityType = (typeof FORWARD_ENTITY_TYPES)[number]

export const FORWARD_INDUSTRIES = [
  "Restaurants",
  "Retail",
  "Construction",
  "Transportation",
  "Healthcare",
  "Professional Services",
  "Automotive",
  "Beauty",
  "Manufacturing",
  "Wholesale",
  "Other",
] as const
export type ForwardIndustry = (typeof FORWARD_INDUSTRIES)[number]

export const PROVIDER_STATUS_MAP = {
  submitted: "submitted",
  "application received": "submitted",
  "in review": "submitted",
  "missing info": "pending",
  approved: "approved",
  offered: "approved",
  "offer issued": "approved",
  declined: "declined",
  funded: "funded",
} as const

export type ForwardDocumentCategory = "application" | "bank_statements" | "voided_check" | "other"

export const DEFAULT_OUTSTANDING_DOCUMENTS = ["bank statements", "voided check"] as const

export interface ForwardOwnerInput {
  firstName: string
  lastName: string
  ssn: string
  ownershipPercent: number
  isPrimary?: boolean
  email?: string
  phone?: string
  dateOfBirth?: string
  street?: string
  city?: string
  state?: string
  postalCode?: string
  index: number
}

export interface ForwardApplication {
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
  monthlyRevenue?: number
  owners: ForwardOwnerInput[]
}

export interface ForwardMappedOwner {
  firstName: string
  lastName: string
  ownershipPercent: number
  ssnLast4: string
  email?: string
  phone?: string
}

export interface ForwardMappedDocument {
  documentId: string
  category: ForwardDocumentCategory
  checksum: string
}

export interface ForwardMappedRequest {
  business: {
    legalName: string
    dba: string
    street: string
    city: string
    state: string
    postalCode: string
    phone: string
    ein: string
    industry: ForwardIndustry
    entityType: ForwardEntityType
    startDate: string
    monthlyRevenue?: number
  }
  owners: ForwardMappedOwner[]
  documents: ForwardMappedDocument[]
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
    const parsed = Number(value.replace(/[$,]/g, ""))
    if (Number.isFinite(parsed)) return parsed
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

function normalizeKey(value: string): string {
  return value.trim().toLowerCase().replace(/[\s-]+/g, "_")
}

const INDUSTRY_ALIASES: Record<string, ForwardIndustry> = {
  automotive: "Automotive",
  auto_repair: "Automotive",
  beauty: "Beauty",
  salon: "Beauty",
  construction: "Construction",
  contractor: "Construction",
  hvac: "Construction",
  healthcare: "Healthcare",
  medical: "Healthcare",
  dental: "Healthcare",
  manufacturing: "Manufacturing",
  other: "Other",
  professional_services: "Professional Services",
  consulting: "Professional Services",
  legal: "Professional Services",
  accounting: "Professional Services",
  restaurants: "Restaurants",
  restaurant: "Restaurants",
  food_service: "Restaurants",
  food_services: "Restaurants",
  qsr: "Restaurants",
  cafe: "Restaurants",
  coffee: "Restaurants",
  retail: "Retail",
  store: "Retail",
  convenience: "Retail",
  transportation: "Transportation",
  trucking: "Transportation",
  logistics: "Transportation",
  wholesale: "Wholesale",
}

export function mapEntityType(value: string): ForwardEntityType {
  const key = normalizeKey(value)
  if (key === "llc") return "LLC"
  if (key === "corporation" || key === "corp") return "Corporation"
  if (key === "s_corporation" || key === "s_corp") return "S-Corporation"
  if (key === "partnership") return "Partnership"
  if (key === "sole_proprietor" || key === "sole_proprietorship") return "Sole Proprietor"
  if (key === "other" || key === "nonprofit" || key === "non_profit") return "Other"
  const exact = FORWARD_ENTITY_TYPES.find((item) => normalizeKey(item) === key)
  return exact ?? "Other"
}

export function mapIndustry(value: string): ForwardIndustry | undefined {
  const trimmed = value.trim()
  if (!trimmed) return undefined
  const exact = FORWARD_INDUSTRIES.find((item) => item.toLowerCase() === trimmed.toLowerCase())
  if (exact) return exact
  return INDUSTRY_ALIASES[normalizeKey(trimmed)]
}

export function mapDocumentCategory(category: string): ForwardDocumentCategory {
  const key = category.trim().toLowerCase().replace(/[\s-]+/g, "_")
  if (key === "application" || key === "api_application" || key === "signed_application") return "application"
  if (key === "statement" || key === "bank_statement" || key === "bank_statements") return "bank_statements"
  if (key === "voided_check" || key === "voidedcheck" || key === "check") return "voided_check"
  return "other"
}

export function mapJobDocuments(job: SubmissionJob): ForwardMappedDocument[] {
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

export function requestMatchesCategory(request: string, category: string): boolean {
  const key = request.trim().toLowerCase()
  if (key.includes("bank")) return category === "bank_statements"
  if (key.includes("voided") || key.includes("check")) return category === "voided_check"
  if (key.includes("application")) return category === "application"
  return false
}

export function documentsCoverOutstanding(
  outstanding: string[],
  documents: Array<{ category: string }>,
): boolean {
  if (!outstanding.length) return true
  return outstanding.every((request) => documents.some((document) => requestMatchesCategory(request, document.category)))
}

function parseOwners(record: Record<string, unknown>): Array<Partial<ForwardOwnerInput> & { index: number }> {
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
): { ok: true; value: ForwardApplication } | { ok: false; fields: Record<string, string> } {
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
  const monthlyRevenue = money(business.monthlyRevenue ?? record.monthlyRevenue)

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
  else if (!mapIndustry(industry)) addField(fields, "industry", "Industry must match a Forward Financing picklist value.")
  if (!entityType) addField(fields, "entityType", "Entity type is required.")
  if (!startDate) addField(fields, "startDate", "Business start date is required.")
  else if (!isDate(startDate)) addField(fields, "startDate", "Use a valid date in YYYY-MM-DD format.")
  if (monthlyRevenue !== undefined && monthlyRevenue < 0) {
    addField(fields, "monthlyRevenue", "Monthly revenue cannot be negative.")
  }

  const parsedOwners = parseOwners(record)
  if (!parsedOwners.length) addField(fields, "owners", "At least one business owner is required.")
  const selected = selectOwners(parsedOwners)
  for (const owner of selected) {
    const prefix = `owners.${owner.index}`
    if (!owner.firstName) addField(fields, `${prefix}.firstName`, "Owner first name is required.")
    if (!owner.lastName) addField(fields, `${prefix}.lastName`, "Owner last name is required.")
    if (owner.email && !isEmail(owner.email)) addField(fields, `${prefix}.email`, "Enter a valid owner email address.")
    if (owner.phone && digits(owner.phone).length < 10) addField(fields, `${prefix}.phone`, "Owner phone must include at least 10 digits.")
    if (owner.dateOfBirth && !isDate(owner.dateOfBirth)) addField(fields, `${prefix}.dateOfBirth`, "Use a valid date in YYYY-MM-DD format.")
    if (owner.state && !/^[A-Z]{2}$/.test(owner.state)) addField(fields, `${prefix}.state`, "Owner state must be a 2-letter code.")
    if (owner.postalCode && !/^\d{5}(?:-?\d{4})?$/.test(owner.postalCode)) addField(fields, `${prefix}.postalCode`, "Owner ZIP must be 5 digits.")
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
      monthlyRevenue,
      owners: selected.map((owner) => ({
        firstName: owner.firstName!,
        lastName: owner.lastName!,
        ssn: owner.ssn!,
        ownershipPercent: owner.ownershipPercent!,
        isPrimary: owner.isPrimary,
        email: owner.email || undefined,
        phone: owner.phone || undefined,
        dateOfBirth: owner.dateOfBirth || undefined,
        street: owner.street || undefined,
        city: owner.city || undefined,
        state: owner.state || undefined,
        postalCode: owner.postalCode || undefined,
        index: owner.index,
      })),
    },
  }
}

export function mapApplication(application: ForwardApplication, documents: ForwardMappedDocument[] = []): ForwardMappedRequest {
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
      industry: mapIndustry(application.industry) ?? "Other",
      entityType: mapEntityType(application.entityType),
      startDate: application.startDate,
      monthlyRevenue: application.monthlyRevenue,
    },
    owners: application.owners.slice(0, MAX_OWNERS).map((owner) => ({
      firstName: owner.firstName,
      lastName: owner.lastName,
      ownershipPercent: owner.ownershipPercent,
      ssnLast4: owner.ssn.slice(-4),
      email: owner.email,
      phone: owner.phone,
    })),
    documents,
  }
}

export function mapProviderStatus(
  rawStatus: string,
  outstandingDocuments: string[] = [],
): Pick<AdapterStatusResult, "rawStatus" | "normalized" | "unknown"> {
  if (outstandingDocuments.length) {
    const base = rawStatus.trim() || "Missing Info"
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
