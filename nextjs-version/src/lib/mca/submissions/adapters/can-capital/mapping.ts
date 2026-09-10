import "server-only"

import type { AdapterSecretValues } from "../contracts"
import type { AdapterStatusResult, SubmissionJob } from "../../contracts"

export const CAN_CAPITAL_SLUG = "can-capital"
export const MINIMUM_OWNER_AGE = 18

export const CAN_CAPITAL_ENTITY_TYPES = [
  "LLC",
  "LLP",
  "Limited Partnership",
  "Corporation",
  "Partnership",
  "Sole Proprietor",
  "Nonprofit",
  "Other",
] as const
export type CanCapitalEntityType = (typeof CAN_CAPITAL_ENTITY_TYPES)[number]

export const FORMATION_REQUIRED_ENTITY_TYPES = [
  "LLC",
  "LLP",
  "Limited Partnership",
  "Corporation",
  "Partnership",
] as const
export type FormationRequiredEntityType = (typeof FORMATION_REQUIRED_ENTITY_TYPES)[number]

export const CREDENTIAL_COMPONENT_FIELDS = {
  consumerKey: "clientId",
  clientSecret: "clientSecret",
  generalEmail: "username",
  generalPassword: "password",
  partnerApiKey: "apiKey",
} as const

export const PROVIDER_STATUS_MAP = {
  "application received": "submitted",
  submitted: "submitted",
  "new submission": "submitted",
  "in review": "pending",
  pending: "pending",
  "missing information": "pending",
  approved: "approved",
  declined: "declined",
  rejected: "declined",
  funded: "funded",
} as const

export type CanCapitalDocumentCategory = "application" | "bank_statements" | "other"

export interface CanCapitalCredentialComponents {
  consumerKey: string
  clientSecret: string
  generalEmail: string
  generalPassword: string
  partnerApiKey: string
  salesRepEmail: string
}

export interface CanCapitalOwnerInput {
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

export interface CanCapitalApplication {
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
  requestedAmount: number
  stateOfFormation: string
  salesRepEmail: string
  owner: CanCapitalOwnerInput
}

export interface CanCapitalMappedDocument {
  documentId: string
  category: CanCapitalDocumentCategory
  checksum: string
}

export interface CanCapitalMappedRequest {
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
    entityType: CanCapitalEntityType
    startDate: string
    requestedAmount: number
    stateOfFormation: string
  }
  owner: {
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
  salesRepEmail: string
  documents: CanCapitalMappedDocument[]
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
    const parsed = Number(value.replace(/[$,\s]/g, ""))
    if (Number.isFinite(parsed)) return parsed
  }
  return undefined
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

function requirePhone(fields: Record<string, string>, field: string, phone: string, label: string): string {
  if (!phone) {
    addField(fields, field, `${label} phone is required.`)
    return ""
  }
  const value = digits(phone)
  if (value.length !== 10) {
    addField(fields, field, `${label} phone must be 10 digits.`)
    return ""
  }
  return value
}

export function mapEntityType(value: string): CanCapitalEntityType {
  const key = value.trim().toLowerCase().replace(/[\s-]+/g, "_")
  if (key === "llc") return "LLC"
  if (key === "llp" || key === "limited_liability_partnership") return "LLP"
  if (key === "limited_partnership" || key === "lp" || key === "ltd_partnership") return "Limited Partnership"
  if (
    key === "corporation"
    || key === "corp"
    || key === "inc"
    || key === "incorporated"
    || key === "s_corporation"
    || key === "s_corp"
  ) {
    return "Corporation"
  }
  if (key === "partnership" || key === "general_partnership" || key === "gp") return "Partnership"
  if (key === "sole_proprietor" || key === "sole_proprietorship" || key === "sole_prop") return "Sole Proprietor"
  if (key === "nonprofit" || key === "non_profit") return "Nonprofit"
  const exact = CAN_CAPITAL_ENTITY_TYPES.find((item) => item.toLowerCase().replace(/[\s-]+/g, "_") === key)
  return exact ?? "Other"
}

export function requiresStateOfFormation(entityType: string): entityType is FormationRequiredEntityType {
  const mapped = mapEntityType(entityType)
  return (FORMATION_REQUIRED_ENTITY_TYPES as readonly string[]).includes(mapped)
}

export function ownerAgeYears(dateOfBirth: string, asOf = new Date()): number | undefined {
  if (!isDate(dateOfBirth)) return undefined
  const [year, month, day] = dateOfBirth.split("-").map(Number)
  let age = asOf.getUTCFullYear() - year
  const asOfMonth = asOf.getUTCMonth() + 1
  const asOfDay = asOf.getUTCDate()
  if (asOfMonth < month || (asOfMonth === month && asOfDay < day)) age -= 1
  return age
}

export function mapCredentialComponents(
  secrets: AdapterSecretValues,
  salesRepEmail = "",
): CanCapitalCredentialComponents {
  return {
    consumerKey: secrets.clientId?.trim() ?? "",
    clientSecret: secrets.clientSecret?.trim() ?? "",
    generalEmail: secrets.username?.trim() ?? "",
    generalPassword: secrets.password?.trim() ?? "",
    partnerApiKey: secrets.apiKey?.trim() ?? "",
    salesRepEmail: salesRepEmail.trim(),
  }
}

export function mapDocumentCategory(category: string): CanCapitalDocumentCategory {
  const key = category.trim().toLowerCase()
  if (key === "application" || key === "api_application") return "application"
  if (key === "statement" || key === "bank_statement" || key === "bank_statements") return "bank_statements"
  return "other"
}

export function mapJobDocuments(job: SubmissionJob): CanCapitalMappedDocument[] {
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

function parseOwners(record: Record<string, unknown>): Array<Partial<CanCapitalOwnerInput> & { index: number }> {
  const source = Array.isArray(record.owners) ? record.owners : record.owner ? [record.owner] : []
  return source.map((item, index) => {
    const owner = asRecord(item) ?? {}
    const address = readAddress(owner)
    const percentValue = owner.ownershipPercent ?? owner.ownership ?? owner.percentage
    const percent = money(percentValue)
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
      ownershipPercent: percent,
      isPrimary: owner.isPrimary === true,
    }
  })
}

export function validateApplication(
  input: unknown,
): { ok: true; value: CanCapitalApplication } | { ok: false; fields: Record<string, string> } {
  const record = asRecord(input)
  if (!record) {
    return { ok: false, fields: { application: "An application payload is required." } }
  }
  const business = nested(record, "business") ?? record
  const financial = nested(record, "financial") ?? record
  const partner = nested(record, "partner")
  const address = readAddress(business)
  const fields: Record<string, string> = {}
  const legalName = firstText(business, ["legalName", "businessName", "companyName", "name"])
  const dba = firstText(business, ["dba", "dbaName"])
  const phone = firstText(business, ["phone", "contactPhone", "businessPhone"])
  const ein = digits(firstText(business, ["ein", "taxId"]))
  const industry = firstText(business, ["industry"])
  const entityType = firstText(business, ["entityType", "legalStructure"])
  const startDate = firstText(business, ["startDate", "businessStartDate", "inceptionDate"])
  const requestedAmount = money(
    financial.requestedAmount ?? record.requestedAmount ?? financial.fundingAmount ?? record.fundingAmount
      ?? financial.amountRequested ?? record.amountRequested,
  )
  const stateOfFormation = (
    firstText(business, ["stateOfFormation", "formationState", "stateOfIncorporation", "incorporationState"])
    || firstText(record, ["stateOfFormation", "formationState", "stateOfIncorporation", "incorporationState"])
  ).toUpperCase()
  const salesRepEmail = firstText(record, ["salesRepEmail"]) || firstText(partner, ["email", "salesRepEmail"])

  if (!legalName) addField(fields, "legalName", "Business name is required.")
  if (!dba) addField(fields, "dba", "DBA is required.")
  if (!address.street) addField(fields, "address.line1", "Business street is required.")
  if (!address.city) addField(fields, "address.city", "Business city is required.")
  if (!address.state) addField(fields, "address.state", "Business state is required.")
  else if (!/^[A-Z]{2}$/.test(address.state)) addField(fields, "address.state", "Business state must be a 2-letter code.")
  if (!address.postalCode) addField(fields, "address.postalCode", "Business ZIP is required.")
  else if (!/^\d{5}(?:-?\d{4})?$/.test(address.postalCode)) addField(fields, "address.postalCode", "Business ZIP must be 5 digits.")
  const businessPhone = requirePhone(fields, "phone", phone, "Business")
  if (!ein) addField(fields, "ein", "EIN / Tax ID is required.")
  else if (ein.length !== 9) addField(fields, "ein", "EIN must contain 9 digits.")
  if (!industry) addField(fields, "industry", "Industry is required.")
  if (!entityType) addField(fields, "entityType", "Entity type is required.")
  if (!startDate) addField(fields, "startDate", "Business inception date is required.")
  else if (!isDate(startDate)) addField(fields, "startDate", "Use a valid date in YYYY-MM-DD format.")
  if (requestedAmount === undefined) addField(fields, "requestedAmount", "Funding amount is required.")
  else if (requestedAmount <= 0) addField(fields, "requestedAmount", "Funding amount must be greater than 0.")
  if (salesRepEmail && !isEmail(salesRepEmail)) addField(fields, "salesRepEmail", "Enter a valid sales rep email address.")

  const mappedEntity = entityType ? mapEntityType(entityType) : undefined
  if (mappedEntity && requiresStateOfFormation(mappedEntity)) {
    if (!stateOfFormation) {
      addField(fields, "stateOfFormation", `State of formation is required for ${mappedEntity}.`)
    } else if (!/^[A-Z]{2}$/.test(stateOfFormation)) {
      addField(fields, "stateOfFormation", "State of formation must be a 2-letter code.")
    }
  } else if (stateOfFormation && !/^[A-Z]{2}$/.test(stateOfFormation)) {
    addField(fields, "stateOfFormation", "State of formation must be a 2-letter code.")
  }

  const parsedOwners = parseOwners(record)
  if (!parsedOwners.length) addField(fields, "owners", "At least one business owner is required.")
  if (parsedOwners.length > 1 && parsedOwners.every((owner) => owner.ownershipPercent == null)) {
    addField(fields, "owners", "Ownership percentage is required to select the primary owner.")
  }
  const selected = selectPrimaryOwner(parsedOwners.map((owner) => ({
    ...owner,
    ownershipPercent: owner.ownershipPercent ?? (parsedOwners.length === 1 ? 100 : undefined),
  })))
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
    const ownerPhone = requirePhone(fields, `${prefix}.phone`, selected.phone ?? "", "Owner")
    if (ownerPhone) selected.phone = ownerPhone
    if (!selected.email) addField(fields, `${prefix}.email`, "Owner email is required.")
    else if (!isEmail(selected.email)) addField(fields, `${prefix}.email`, "Enter a valid owner email address.")
    if (!selected.dateOfBirth) addField(fields, `${prefix}.dateOfBirth`, "Owner date of birth is required.")
    else if (!isDate(selected.dateOfBirth)) addField(fields, `${prefix}.dateOfBirth`, "Use a valid date in YYYY-MM-DD format.")
    else {
      const age = ownerAgeYears(selected.dateOfBirth)
      if (age === undefined || age < MINIMUM_OWNER_AGE) {
        addField(fields, `${prefix}.dateOfBirth`, "Owner must be 18 years or older.")
      }
    }
    if (!selected.ssn) addField(fields, `${prefix}.ssn`, "Owner SSN is required.")
    else if (selected.ssn.length !== 9) addField(fields, `${prefix}.ssn`, "Owner SSN must contain 9 digits.")
    if (selected.ownershipPercent === undefined) addField(fields, `${prefix}.ownershipPercent`, "Owner ownership percentage is required.")
    else if (selected.ownershipPercent < 0 || selected.ownershipPercent > 100) {
      addField(fields, `${prefix}.ownershipPercent`, "Ownership must be between 0 and 100%.")
    }
  }

  if (Object.keys(fields).length || !selected) return { ok: false, fields }
  return {
    ok: true,
    value: {
      legalName,
      dba,
      street: address.street,
      city: address.city,
      state: address.state,
      postalCode: address.postalCode,
      phone: businessPhone,
      ein,
      industry,
      entityType,
      startDate,
      requestedAmount: requestedAmount!,
      stateOfFormation,
      salesRepEmail,
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

export function mapApplication(
  application: CanCapitalApplication,
  documents: CanCapitalMappedDocument[] = [],
): CanCapitalMappedRequest {
  const entityType = mapEntityType(application.entityType)
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
      entityType,
      startDate: application.startDate,
      requestedAmount: application.requestedAmount,
      stateOfFormation: application.stateOfFormation,
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
    salesRepEmail: application.salesRepEmail,
    documents,
  }
}

export function mapProviderStatus(
  rawStatus: string,
  outstandingDocuments: string[] = [],
): Pick<AdapterStatusResult, "rawStatus" | "normalized" | "unknown"> {
  if (outstandingDocuments.length) {
    const base = rawStatus.trim() || "Missing Information"
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
