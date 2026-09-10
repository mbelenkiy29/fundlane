import "server-only"

import type { AdapterStatusResult, SubmissionJob } from "../../contracts"

export const PEAC_SOLUTIONS_SLUG = "peac-solutions"
export const MAX_OWNERS = 3
export const MIN_REPRESENTED_OWNERSHIP = 50
export const MAX_REQUESTED_AMOUNT = 250000

export const PROVIDER_STATUS_MAP = {
  "in process": "submitted",
  incomplete: "pending",
  booked: "approved",
  "offers ready": "approved",
  "offers selected": "approved",
  "contracts out": "approved",
  "final diligence": "approved",
  "in pricing": "approved",
  "ready for funding": "approved",
  funded: "funded",
  withdrawn: "declined",
  "no pq offers available": "declined",
} as const

export type PeacDocumentCategory = "application" | "bank_statements" | "other"

export interface PeacOwnerInput {
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

export interface PeacApplication {
  legalName: string
  dba?: string
  entityType: string
  street: string
  city: string
  state: string
  postalCode: string
  phone: string
  businessEmail: string
  ein?: string
  industry?: string
  startDate?: string
  fundingPurpose: string
  requestedAmount: number
  annualRevenue: number
  revenueSource: "annual_revenue" | "monthly_revenue" | "statement_deposits"
  owners: PeacOwnerInput[]
}

export interface PeacMappedOwner {
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

export interface PeacMappedDocument {
  documentId: string
  category: PeacDocumentCategory
  checksum: string
}

export interface PeacMappedRequest {
  business: {
    legalName: string
    dba: string
    entityType: string
    street: string
    city: string
    state: string
    postalCode: string
    phone: string
    email: string
    ein: string
    industry: string
    startDate: string
  }
  financial: {
    fundingPurpose: string
    requestedAmount: number
    annualRevenue: number
    revenueSource: PeacApplication["revenueSource"]
    representedOwnership: number
  }
  owners: PeacMappedOwner[]
  documents: PeacMappedDocument[]
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
    return Number.isFinite(parsed) ? parsed : undefined
  }
  return undefined
}

function roundDollars(value: number): number {
  return Math.round(value)
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

export function resolveAnnualRevenue(input: {
  annualRevenue?: number
  monthlyRevenue?: number
  statementDeposits: number[]
}): { annualRevenue: number; source: PeacApplication["revenueSource"] } | undefined {
  if (input.annualRevenue != null && input.annualRevenue > 0) {
    return { annualRevenue: roundDollars(input.annualRevenue), source: "annual_revenue" }
  }
  if (input.monthlyRevenue != null && input.monthlyRevenue > 0) {
    return { annualRevenue: roundDollars(input.monthlyRevenue * 12), source: "monthly_revenue" }
  }
  if (!input.statementDeposits.length) return undefined
  const monthly = input.statementDeposits.reduce((sum, value) => sum + value, 0) / input.statementDeposits.length
  if (monthly <= 0) return undefined
  return { annualRevenue: roundDollars(monthly * 12), source: "statement_deposits" }
}

export function representedOwnership(owners: Array<{ ownershipPercent?: number }>): number {
  return owners.reduce((sum, owner) => sum + (owner.ownershipPercent ?? 0), 0)
}

export function mapDocumentCategory(category: string): PeacDocumentCategory {
  const key = category.trim().toLowerCase()
  if (key === "application" || key === "api_application" || key === "app") return "application"
  if (key === "statement" || key === "bank_statement" || key === "bank_statements" || key === "banks") return "bank_statements"
  return "other"
}

export function mapJobDocuments(job: SubmissionJob): PeacMappedDocument[] {
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

function parseOwners(record: Record<string, unknown>): Array<Partial<PeacOwnerInput> & { index: number }> {
  const source = Array.isArray(record.owners) ? record.owners : record.owner ? [record.owner] : []
  return source.map((item, index) => {
    const owner = asRecord(item) ?? {}
    const address = readAddress(owner)
    const percentValue = owner.ownershipPercent ?? owner.ownership ?? owner.percentage
    const percent = money(percentValue)
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
      ownershipPercent: percent,
      isPrimary: owner.isPrimary === true,
    }
  })
}

export function validateApplication(
  input: unknown,
): { ok: true; value: PeacApplication } | { ok: false; fields: Record<string, string> } {
  const record = asRecord(input)
  if (!record) {
    return { ok: false, fields: { application: "An application payload is required." } }
  }
  const business = nested(record, "business") ?? record
  const financial = nested(record, "financial") ?? record
  const address = readAddress(business)
  const fields: Record<string, string> = {}
  const legalName = firstText(business, ["legalName", "businessName", "name"])
  const dba = firstText(business, ["dba", "dbaName"])
  const entityType = firstText(business, ["entityType", "legalStructure", "businessType"])
  const phone = firstText(business, ["phone", "contactPhone", "businessPhone"])
  const businessEmail = firstText(business, ["businessEmail", "contactEmail", "email"])
  const einDigits = digits(firstText(business, ["ein", "taxId"]))
  const industry = firstText(business, ["industry"])
  const startDate = firstText(business, ["startDate", "businessStartDate"])
  const fundingPurpose = firstText(financial, ["fundingPurpose", "purposeOfFunds", "purpose", "useOfFunds", "loanPurpose"])
    || firstText(record, ["fundingPurpose", "purposeOfFunds", "purpose", "useOfFunds", "loanPurpose"])
  const requestedAmount = money(financial.requestedAmount)
    ?? money(financial.amountRequested)
    ?? money(record.requestedAmount)
    ?? money(record.amountRequested)
  const annualRevenueInput = money(financial.annualRevenue)
    ?? money(financial.grossAnnualRevenue)
    ?? money(record.annualRevenue)
    ?? money(record.grossAnnualRevenue)
  const monthlyRevenueInput = money(financial.monthlyRevenue) ?? money(record.monthlyRevenue)
  const statementDeposits = parseStatementDeposits(record)

  if (!legalName) addField(fields, "legalName", "Business name is required.")
  if (!entityType) addField(fields, "entityType", "Entity type is required.")
  if (!address.street) addField(fields, "address.line1", "Business street is required.")
  if (!address.city) addField(fields, "address.city", "Business city is required.")
  if (!address.state) addField(fields, "address.state", "Business state is required.")
  else if (!/^[A-Z]{2}$/.test(address.state)) addField(fields, "address.state", "Business state must be a 2-letter code.")
  if (!address.postalCode) addField(fields, "address.postalCode", "Business ZIP is required.")
  else if (!/^\d{5}(?:-?\d{4})?$/.test(address.postalCode)) addField(fields, "address.postalCode", "Business ZIP must be 5 digits.")
  if (!phone) addField(fields, "phone", "Business phone is required.")
  else if (digits(phone).length < 10) addField(fields, "phone", "Business phone must include at least 10 digits.")
  if (!businessEmail) addField(fields, "businessEmail", "Business email is required.")
  else if (!isEmail(businessEmail)) addField(fields, "businessEmail", "Enter a valid business email address.")
  if (einDigits && einDigits.length !== 9) addField(fields, "ein", "EIN must contain 9 digits.")
  if (startDate && !isDate(startDate)) addField(fields, "startDate", "Use a valid date in YYYY-MM-DD format.")
  if (!fundingPurpose) addField(fields, "fundingPurpose", "Purpose of funds is required.")
  if (requestedAmount == null) addField(fields, "requestedAmount", "Requested amount is required.")
  else if (requestedAmount <= 0) addField(fields, "requestedAmount", "Requested amount must be greater than zero.")
  else if (requestedAmount > MAX_REQUESTED_AMOUNT) {
    addField(fields, "requestedAmount", "Requested amount must be at most $250,000.")
  }

  const revenue = resolveAnnualRevenue({
    annualRevenue: annualRevenueInput != null && annualRevenueInput > 0 ? annualRevenueInput : undefined,
    monthlyRevenue: monthlyRevenueInput != null && monthlyRevenueInput > 0 ? monthlyRevenueInput : undefined,
    statementDeposits,
  })
  if (!revenue) {
    addField(fields, "annualRevenue", "Enter annual revenue, monthly revenue, or statement deposit totals.")
  } else if (annualRevenueInput != null && annualRevenueInput <= 0) {
    addField(fields, "annualRevenue", "Annual revenue must be greater than zero.")
  }

  const parsedOwners = parseOwners(record)
  if (!parsedOwners.length) addField(fields, "owners", "At least one business owner is required.")
  else if (parsedOwners.length > MAX_OWNERS) {
    addField(fields, "owners", "PEAC Solutions accepts at most three owners.")
  }

  const selected = parsedOwners.slice(0, MAX_OWNERS)
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
    else if (owner.ownershipPercent < 0 || owner.ownershipPercent > 100) {
      addField(fields, `${prefix}.ownershipPercent`, "Ownership must be between 0 and 100%.")
    }
  }

  const ownershipTotal = representedOwnership(selected)
  if (
    parsedOwners.length > 0
    && parsedOwners.length <= MAX_OWNERS
    && selected.every((owner) => owner.ownershipPercent !== undefined)
    && ownershipTotal < MIN_REPRESENTED_OWNERSHIP
  ) {
    addField(fields, "owners", "Represented ownership must be at least 50%.")
  }

  if (Object.keys(fields).length || !revenue || requestedAmount == null) return { ok: false, fields }
  return {
    ok: true,
    value: {
      legalName,
      dba: dba || undefined,
      entityType,
      street: address.street,
      city: address.city,
      state: address.state,
      postalCode: address.postalCode,
      phone,
      businessEmail,
      ein: einDigits || undefined,
      industry: industry || undefined,
      startDate: startDate || undefined,
      fundingPurpose,
      requestedAmount: roundDollars(requestedAmount),
      annualRevenue: revenue.annualRevenue,
      revenueSource: revenue.source,
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

export function mapApplication(application: PeacApplication, documents: PeacMappedDocument[] = []): PeacMappedRequest {
  return {
    business: {
      legalName: application.legalName,
      dba: application.dba ?? "",
      entityType: application.entityType,
      street: application.street,
      city: application.city,
      state: application.state,
      postalCode: application.postalCode,
      phone: application.phone,
      email: application.businessEmail,
      ein: application.ein ?? "",
      industry: application.industry ?? "",
      startDate: application.startDate ?? "",
    },
    financial: {
      fundingPurpose: application.fundingPurpose,
      requestedAmount: application.requestedAmount,
      annualRevenue: application.annualRevenue,
      revenueSource: application.revenueSource,
      representedOwnership: representedOwnership(application.owners),
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
      ssnLast4: owner.ssn.slice(-4),
      ownershipPercent: owner.ownershipPercent,
    })),
    documents,
  }
}

export function mapProviderStatus(
  rawStatus: string,
  outstandingDocuments: string[] = [],
): Pick<AdapterStatusResult, "rawStatus" | "normalized" | "unknown"> {
  if (outstandingDocuments.length) {
    const base = rawStatus.trim() || "Incomplete"
    return {
      rawStatus: `${base}: outstanding stipulations: ${outstandingDocuments.join(", ")}`,
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
