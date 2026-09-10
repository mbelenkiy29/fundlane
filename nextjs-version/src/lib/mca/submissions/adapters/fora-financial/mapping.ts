import "server-only"

import type { AdapterStatusResult, SubmissionJob } from "../../contracts"

export const FORA_FINANCIAL_SLUG = "fora-financial"

export const FORA_ENTITY_TYPES = [
  "LLC",
  "Corporation",
  "S-Corporation",
  "Partnership",
  "Sole Proprietor",
  "Other",
] as const
export type ForaEntityType = (typeof FORA_ENTITY_TYPES)[number]

export const FORA_INDUSTRIES = [
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
export type ForaIndustry = (typeof FORA_INDUSTRIES)[number]

export const PROVIDER_STATUS_MAP = {
  "incomplete application": "pending",
  "in progress": "submitted",
  approved: "approved",
  declined: "declined",
  "contracts in": "approved",
  "pending funding": "approved",
  funded: "funded",
} as const

export type ForaDocumentCategory = "application" | "bank_statements" | "other"

export interface ForaOwnerInput {
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
  creditPullConsent: true
  isPrimary?: boolean
  index: number
}

export interface ForaApplication {
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
  annualRevenue: number
  monthlyRevenue: number
  statementDeposits: number[]
  revenueSource: "annual_revenue" | "monthly_revenue" | "statement_deposits"
  businessCreditPullConsent: true
  owner: ForaOwnerInput
}

export interface ForaMappedDocument {
  documentId: string
  category: ForaDocumentCategory
  checksum: string
}

export interface ForaMappedRequest {
  business: {
    legalName: string
    dba: string
    street: string
    city: string
    state: string
    postalCode: string
    phone: string
    ein: string
    industry: ForaIndustry
    entityType: ForaEntityType
    startDate: string
    creditPullConsent: true
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
    creditPullConsent: true
  }
  financial: {
    requestedAmount: number
    annualRevenue: number
    monthlyRevenue: number
    statementDeposits: number[]
    revenueSource: ForaApplication["revenueSource"]
  }
  documents: ForaMappedDocument[]
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

function normalizeKey(value: string): string {
  return value.trim().toLowerCase().replace(/[\s-]+/g, "_")
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

const INDUSTRY_ALIASES: Record<string, ForaIndustry> = {
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

export function mapEntityType(value: string): ForaEntityType {
  const key = normalizeKey(value)
  if (key === "llc") return "LLC"
  if (key === "corporation" || key === "corp" || key === "c_corporation" || key === "c_corp") return "Corporation"
  if (key === "s_corporation" || key === "s_corp") return "S-Corporation"
  if (key === "partnership") return "Partnership"
  if (key === "sole_proprietor" || key === "sole_proprietorship") return "Sole Proprietor"
  if (key === "other" || key === "nonprofit" || key === "non_profit") return "Other"
  const exact = FORA_ENTITY_TYPES.find((item) => normalizeKey(item) === key)
  return exact ?? "Other"
}

export function mapIndustry(value: string): ForaIndustry {
  const trimmed = value.trim()
  if (!trimmed) return "Other"
  const exact = FORA_INDUSTRIES.find((item) => item.toLowerCase() === trimmed.toLowerCase())
  if (exact) return exact
  return INDUSTRY_ALIASES[normalizeKey(trimmed)] ?? "Other"
}

export function mapDocumentCategory(category: string): ForaDocumentCategory {
  const key = category.trim().toLowerCase().replace(/[\s-]+/g, "_")
  if (key === "application" || key === "api_application" || key === "signed_application") return "application"
  if (key === "statement" || key === "bank_statement" || key === "bank_statements") return "bank_statements"
  return "other"
}

export function mapJobDocuments(job: SubmissionJob): ForaMappedDocument[] {
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

export function readConsentFlag(value: unknown): boolean | undefined {
  if (value === undefined || value === null || value === "") return undefined
  if (value === true || value === 1) return true
  if (value === false || value === 0) return false
  if (typeof value === "string") {
    const key = value.trim().toLowerCase()
    if (key === "true" || key === "yes" || key === "granted" || key === "1") return true
    if (key === "false" || key === "no" || key === "denied" || key === "0") return false
  }
  return undefined
}

function firstConsent(...values: unknown[]): boolean | undefined {
  for (const value of values) {
    const parsed = readConsentFlag(value)
    if (parsed !== undefined) return parsed
  }
  return undefined
}

function numbersFrom(value: unknown): number[] {
  if (value == null) return []
  if (Array.isArray(value)) {
    return value.flatMap((item) => {
      const direct = money(item)
      if (direct != null) return [direct]
      const record = asRecord(item)
      if (!record) return []
      const nestedMoney = money(record.deposits) ?? money(record.depositTotal) ?? money(record.total) ?? money(record.amount)
      return nestedMoney != null ? [nestedMoney] : []
    })
  }
  const single = money(value)
  return single != null ? [single] : []
}

export function parseStatementDeposits(record: Record<string, unknown>): number[] {
  const financial = nested(record, "financial")
  const collected = [
    ...numbersFrom(record.statementDeposits),
    ...numbersFrom(record.bankStatementDeposits),
    ...numbersFrom(record.deposits),
    ...numbersFrom(financial?.statementDeposits),
    ...numbersFrom(financial?.bankStatementDeposits),
    ...numbersFrom(financial?.deposits),
  ]
  const documents = Array.isArray(record.documents) ? record.documents : []
  for (const item of documents) {
    const document = asRecord(item)
    if (!document) continue
    const category = firstText(document, ["category", "kind"]).toLowerCase()
    if (category !== "statement" && category !== "bank_statement" && category !== "bank_statements") continue
    const amount = money(document.depositTotal) ?? money(document.deposits) ?? money(document.totalDeposits)
    if (amount != null && amount > 0) collected.push(amount)
  }
  return collected.filter((value) => value > 0)
}

export function resolveFinancials(input: {
  annualRevenue?: number
  monthlyRevenue?: number
  statementDeposits: number[]
}): { monthlyRevenue: number; annualRevenue: number; source: ForaApplication["revenueSource"] } | undefined {
  if (input.annualRevenue != null && input.annualRevenue > 0) {
    return {
      monthlyRevenue: Math.round(input.annualRevenue / 12),
      annualRevenue: Math.round(input.annualRevenue),
      source: "annual_revenue",
    }
  }
  if (input.monthlyRevenue != null && input.monthlyRevenue > 0) {
    return {
      monthlyRevenue: Math.round(input.monthlyRevenue),
      annualRevenue: Math.round(input.monthlyRevenue * 12),
      source: "monthly_revenue",
    }
  }
  if (!input.statementDeposits.length) return undefined
  const monthlyRevenue = Math.round(
    input.statementDeposits.reduce((sum, value) => sum + value, 0) / input.statementDeposits.length,
  )
  if (monthlyRevenue <= 0) return undefined
  return {
    monthlyRevenue,
    annualRevenue: Math.round(monthlyRevenue * 12),
    source: "statement_deposits",
  }
}

function parseOwners(record: Record<string, unknown>): Array<Partial<Omit<ForaOwnerInput, "creditPullConsent">> & { index: number; creditPullConsent?: boolean }> {
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
      creditPullConsent: firstConsent(owner.creditPullConsent, owner.creditPull, owner.consent),
      isPrimary: owner.isPrimary === true,
    }
  })
}

export function validateApplication(
  input: unknown,
): { ok: true; value: ForaApplication } | { ok: false; fields: Record<string, string> } {
  const record = asRecord(input)
  if (!record) {
    return { ok: false, fields: { application: "An application payload is required." } }
  }
  const business = nested(record, "business") ?? record
  const financial = nested(record, "financial") ?? record
  const consent = nested(record, "creditPullConsent") ?? nested(record, "consent")
  const address = readAddress(business)
  const fields: Record<string, string> = {}
  const legalName = firstText(business, ["legalName", "businessName", "companyName", "name"])
  const dba = firstText(business, ["dba", "dbaName"])
  const phone = firstText(business, ["phone", "contactPhone", "businessPhone"])
  const ein = digits(firstText(business, ["ein", "taxId"]))
  const industry = firstText(business, ["industry", "industryName"])
  const entityType = firstText(business, ["entityType", "legalStructure"])
  const startDate = firstText(business, ["startDate", "inceptionDate", "businessStartDate"])
  const requestedAmount = money(
    financial.requestedAmount ?? record.requestedAmount ?? financial.fundingAmount ?? record.fundingAmount ?? financial.amountRequested,
  )
  const annualRevenue = money(financial.annualRevenue ?? record.annualRevenue ?? financial.grossAnnualRevenue)
  const monthlyRevenueInput = money(financial.monthlyRevenue ?? record.monthlyRevenue)
  const statementDeposits = parseStatementDeposits(record)
  const rootConsent = asRecord(record.creditPullConsent) ? undefined : readConsentFlag(record.creditPullConsent)
  const businessCreditPullConsent = firstConsent(
    business.creditPullConsent,
    business.businessCreditPullConsent,
    record.businessCreditPullConsent,
    consent?.business,
    consent?.businessCreditPull,
    rootConsent,
  )

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
  if (requestedAmount === undefined) addField(fields, "requestedAmount", "Funding amount is required.")
  else if (requestedAmount <= 0) addField(fields, "requestedAmount", "Funding amount must be greater than 0.")
  if (businessCreditPullConsent === undefined) {
    addField(fields, "businessCreditPullConsent", "Recorded business credit-pull consent is required.")
  } else if (businessCreditPullConsent !== true) {
    addField(fields, "businessCreditPullConsent", "Business credit-pull consent must be recorded as granted.")
  }

  const parsedOwners = parseOwners(record)
  if (!parsedOwners.length) addField(fields, "owners", "A primary owner is required.")
  if (parsedOwners.length > 1 && parsedOwners.every((owner) => owner.ownershipPercent == null)) {
    addField(fields, "owners", "Ownership percentage is required to select the highest-ownership owner.")
  }
  const selected = selectPrimaryOwner(parsedOwners)
  const ownerCreditPullConsent = selected
    ? firstConsent(
      selected.creditPullConsent,
      record.ownerCreditPullConsent,
      consent?.owner,
      consent?.primaryOwner,
      consent?.ownerCreditPull,
      rootConsent,
    )
    : firstConsent(record.ownerCreditPullConsent, consent?.owner, consent?.primaryOwner, consent?.ownerCreditPull, rootConsent)
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
  if (ownerCreditPullConsent === undefined) {
    addField(fields, "ownerCreditPullConsent", "Recorded primary-owner credit-pull consent is required.")
  } else if (ownerCreditPullConsent !== true) {
    addField(fields, "ownerCreditPullConsent", "Primary-owner credit-pull consent must be recorded as granted.")
  }

  const revenue = resolveFinancials({
    annualRevenue: annualRevenue != null && annualRevenue > 0 ? annualRevenue : undefined,
    monthlyRevenue: monthlyRevenueInput != null && monthlyRevenueInput > 0 ? monthlyRevenueInput : undefined,
    statementDeposits,
  })
  if (!revenue) {
    addField(fields, "annualRevenue", "Enter annual revenue, monthly revenue, or statement deposit totals.")
    addField(fields, "statementDeposits", "Enter annual revenue, monthly revenue, or statement deposit totals.")
  }

  if (Object.keys(fields).length || !selected || !revenue || requestedAmount === undefined || requestedAmount <= 0) {
    return { ok: false, fields }
  }
  if (businessCreditPullConsent !== true || ownerCreditPullConsent !== true) {
    return { ok: false, fields }
  }
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
      requestedAmount,
      annualRevenue: revenue.annualRevenue,
      monthlyRevenue: revenue.monthlyRevenue,
      statementDeposits,
      revenueSource: revenue.source,
      businessCreditPullConsent: true,
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
        creditPullConsent: true,
        isPrimary: selected.isPrimary,
        index: selected.index,
      },
    },
  }
}

export function mapApplication(application: ForaApplication, documents: ForaMappedDocument[] = []): ForaMappedRequest {
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
      industry: mapIndustry(application.industry),
      entityType: mapEntityType(application.entityType),
      startDate: application.startDate,
      creditPullConsent: true,
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
      creditPullConsent: true,
    },
    financial: {
      requestedAmount: application.requestedAmount,
      annualRevenue: application.annualRevenue,
      monthlyRevenue: application.monthlyRevenue,
      statementDeposits: application.statementDeposits,
      revenueSource: application.revenueSource,
    },
    documents,
  }
}

export function mapProviderStatus(
  rawStatus: string,
): Pick<AdapterStatusResult, "rawStatus" | "normalized" | "unknown"> {
  const key = rawStatus.trim().toLowerCase().replace(/[_-]+/g, " ").replace(/\s+/g, " ")
  const normalized = PROVIDER_STATUS_MAP[key as keyof typeof PROVIDER_STATUS_MAP]
  if (normalized) {
    return { rawStatus, normalized, unknown: false }
  }
  return { rawStatus, normalized: "unknown", unknown: true }
}
