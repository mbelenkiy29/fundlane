import "server-only"

import type { AdapterStatusResult, SubmissionJob } from "../../contracts"

export const PLEXE_SLUG = "plexe"
export const DEFAULT_FUNDING_PURPOSE = "Working Capital"
export const REQUESTED_AMOUNT_MULTIPLIER = 2

export const PROVIDER_STATUS_MAP = {
  sent: "submitted",
  submitted: "submitted",
  "new submission": "submitted",
  "application received": "submitted",
  "in review": "pending",
  pending: "pending",
  processing: "pending",
  approved: "approved",
  declined: "declined",
  rejected: "declined",
  funded: "funded",
} as const

export type PlexeDocumentCategory = "bank_statements" | "other"

export interface PlexeOwnerInput {
  firstName: string
  lastName: string
  street: string
  city: string
  state: string
  postalCode: string
  phone: string
  email: string
  dateOfBirth: string
  ownershipPercent: number
  ssnLast4?: string
  isPrimary?: boolean
  index: number
}

export interface PlexeApplication {
  legalName: string
  dba: string
  street: string
  city: string
  state: string
  postalCode: string
  phone: string
  ein: string
  industry: string
  naicsCode: string
  entityType: string
  startDate: string
  website: string
  ficoScore?: number
  averageMonthlyDeposits?: number
  annualRevenue: number
  monthlyRevenue: number
  statementDeposits: number[]
  revenueSource: "annual_revenue" | "statement_deposits"
  requestedAmount: number
  requestedAmountInferred: boolean
  fundingPurpose: string
  fundingPurposeInferred: boolean
  owner: PlexeOwnerInput
}

export interface PlexeMappedDocument {
  documentId: string
  category: PlexeDocumentCategory
  checksum: string
}

export interface PlexeMappedRequest {
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
    naicsCode: string
    entityType: string
    startDate: string
    website: string
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
    ownershipPercent: number
    ssnLast4?: string
  }
  funding: {
    annualRevenue: number
    monthlyRevenue: number
    statementDeposits: number[]
    revenueSource: "annual_revenue" | "statement_deposits"
    requestedAmount: number
    requestedAmountInferred: boolean
    fundingPurpose: string
    fundingPurposeInferred: boolean
  }
  notes: string[]
  documents: PlexeMappedDocument[]
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

function roundDollars(value: number): number {
  return Math.round(value)
}

function isConfirmed(value: unknown): boolean {
  return value === true || value === "true" || value === 1 || value === "1"
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

export function resolveMonthlyRevenue(input: {
  annualRevenue?: number
  monthlyRevenue?: number
  statementDeposits: number[]
}): { monthlyRevenue: number; annualRevenue: number; source: "annual_revenue" | "statement_deposits" } | undefined {
  if (input.annualRevenue != null && input.annualRevenue > 0) {
    return {
      monthlyRevenue: roundDollars(input.annualRevenue / 12),
      annualRevenue: roundDollars(input.annualRevenue),
      source: "annual_revenue",
    }
  }
  if (input.monthlyRevenue != null && input.monthlyRevenue > 0) {
    return {
      monthlyRevenue: roundDollars(input.monthlyRevenue),
      annualRevenue: roundDollars(input.monthlyRevenue * 12),
      source: "annual_revenue",
    }
  }
  if (!input.statementDeposits.length) return undefined
  const monthlyRevenue = roundDollars(
    input.statementDeposits.reduce((sum, value) => sum + value, 0) / input.statementDeposits.length,
  )
  if (monthlyRevenue <= 0) return undefined
  return {
    monthlyRevenue,
    annualRevenue: roundDollars(monthlyRevenue * 12),
    source: "statement_deposits",
  }
}

export function inferFundingTerms(input: {
  requestedAmount?: number
  fundingPurpose?: string
  monthlyRevenue: number
}): {
  requestedAmount: number
  requestedAmountInferred: boolean
  fundingPurpose: string
  fundingPurposeInferred: boolean
} {
  const requestedAmountInferred = input.requestedAmount == null
  const fundingPurposeInferred = !input.fundingPurpose
  return {
    requestedAmount: requestedAmountInferred
      ? roundDollars(input.monthlyRevenue * REQUESTED_AMOUNT_MULTIPLIER)
      : roundDollars(input.requestedAmount!),
    requestedAmountInferred,
    fundingPurpose: fundingPurposeInferred ? DEFAULT_FUNDING_PURPOSE : input.fundingPurpose!,
    fundingPurposeInferred,
  }
}

export function mapDocumentCategory(category: string): PlexeDocumentCategory {
  const key = category.trim().toLowerCase()
  if (key === "statement" || key === "bank_statement" || key === "bank_statements") return "bank_statements"
  return "other"
}

export function mapJobDocuments(job: SubmissionJob): PlexeMappedDocument[] {
  return job.documentVersions
    .map((document) => ({
      documentId: document.documentId,
      category: mapDocumentCategory(document.category),
      checksum: document.checksum,
    }))
    .filter((document) => document.category === "bank_statements")
}

export function selectHighestOwner<T extends { ownershipPercent?: number; isPrimary?: boolean }>(owners: T[]): T | undefined {
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

function parseOwners(record: Record<string, unknown>): Array<Partial<PlexeOwnerInput> & { index: number }> {
  const source = Array.isArray(record.owners) ? record.owners : record.owner ? [record.owner] : []
  return source.map((item, index) => {
    const owner = asRecord(item) ?? {}
    const address = readAddress(owner)
    const percentValue = owner.ownershipPercent ?? owner.ownership ?? owner.percentage
    const percent = money(percentValue)
    const ssn = digits(firstText(owner, ["ssn", "socialSecurityNumber"]))
    const last4 = digits(firstText(owner, ["ssnLast4", "identityLast4"])) || (ssn.length >= 4 ? ssn.slice(-4) : "")
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
      ownershipPercent: percent,
      ssnLast4: last4.length === 4 ? last4 : undefined,
      isPrimary: owner.isPrimary === true,
    }
  })
}

export function validateApplication(
  input: unknown,
): { ok: true; value: PlexeApplication } | { ok: false; fields: Record<string, string> } {
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
  const phone = firstText(business, ["phone", "contactPhone"])
  const einDigits = digits(firstText(business, ["ein", "taxId"]))
  const industry = firstText(business, ["industry"])
  const naicsCode = digits(firstText(business, ["naicsCode", "naics"]))
  const entityType = firstText(business, ["entityType", "legalStructure"])
  const startDate = firstText(business, ["startDate", "businessStartDate"])
  const website = firstText(business, ["website", "url"])
  const ficoScore = money(business.ficoScore ?? record.ficoScore ?? financial.ficoScore)
  const averageMonthlyDeposits = money(
    business.averageMonthlyDeposits ?? record.averageMonthlyDeposits ?? financial.averageMonthlyDeposits,
  )
  const annualRevenue = money(financial.annualRevenue ?? record.annualRevenue ?? financial.grossAnnualRevenue)
  const monthlyRevenueInput = money(financial.monthlyRevenue ?? record.monthlyRevenue)
  const requestedAmount = money(
    financial.requestedAmount ?? record.requestedAmount ?? financial.amountRequested ?? record.amountRequested,
  )
  const fundingPurpose = firstText(financial, ["fundingPurpose", "purposeOfFunds", "purpose"])
    || firstText(record, ["fundingPurpose", "purposeOfFunds", "purpose"])
  const statementDeposits = parseStatementDeposits(record)
  const confirmInferredTerms = isConfirmed(record.confirmInferredTerms ?? financial.confirmInferredTerms)
  const confirmInferredAmount = confirmInferredTerms || isConfirmed(record.confirmInferredAmount ?? financial.confirmInferredAmount)
  const confirmInferredPurpose = confirmInferredTerms || isConfirmed(record.confirmInferredPurpose ?? financial.confirmInferredPurpose)

  if (!legalName) addField(fields, "legalName", "Business name is required.")
  if (!address.postalCode) addField(fields, "postalCode", "Business ZIP is required.")
  else if (!/^\d{5}(?:-?\d{4})?$/.test(address.postalCode)) addField(fields, "postalCode", "Business ZIP must be 5 digits.")
  if (einDigits && einDigits.length !== 9) addField(fields, "ein", "EIN must contain 9 digits.")
  if (startDate && !isDate(startDate)) addField(fields, "startDate", "Use a valid date in YYYY-MM-DD format.")
  if (address.state && !/^[A-Z]{2}$/.test(address.state)) addField(fields, "address.state", "Business state must be a 2-letter code.")
  if (requestedAmount != null && requestedAmount <= 0) addField(fields, "requestedAmount", "Requested amount must be greater than zero.")

  const parsedOwners = parseOwners(record)
  if (!parsedOwners.length) addField(fields, "owners", "At least one business owner is required.")
  if (parsedOwners.length > 1 && parsedOwners.every((owner) => owner.ownershipPercent == null)) {
    addField(fields, "owners", "Ownership percentage is required to select the highest-ownership owner.")
  }
  const selected = selectHighestOwner(parsedOwners.map((owner) => ({
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
    if (!selected.phone) addField(fields, `${prefix}.phone`, "Owner phone is required.")
    else if (digits(selected.phone).length < 10) addField(fields, `${prefix}.phone`, "Owner phone must include at least 10 digits.")
    if (!selected.email) addField(fields, `${prefix}.email`, "Owner email is required.")
    else if (!isEmail(selected.email)) addField(fields, `${prefix}.email`, "Enter a valid owner email address.")
    if (!selected.dateOfBirth) addField(fields, `${prefix}.dateOfBirth`, "Owner date of birth is required.")
    else if (!isDate(selected.dateOfBirth)) addField(fields, `${prefix}.dateOfBirth`, "Use a valid date in YYYY-MM-DD format.")
    if (selected.ownershipPercent == null) addField(fields, `${prefix}.ownershipPercent`, "Owner ownership percentage is required.")
    else if (selected.ownershipPercent < 0 || selected.ownershipPercent > 100) {
      addField(fields, `${prefix}.ownershipPercent`, "Ownership must be between 0 and 100%.")
    }
  }

  const revenue = resolveMonthlyRevenue({
    annualRevenue: annualRevenue != null && annualRevenue > 0 ? annualRevenue : undefined,
    monthlyRevenue: monthlyRevenueInput != null && monthlyRevenueInput > 0 ? monthlyRevenueInput : undefined,
    statementDeposits,
  })
  if (!revenue) {
    addField(fields, "annualRevenue", "Enter annual revenue or statement deposit totals so monthly revenue can be calculated.")
    addField(fields, "statementDeposits", "Enter annual revenue or statement deposit totals so monthly revenue can be calculated.")
  }

  const inferred = revenue
    ? inferFundingTerms({
      requestedAmount: requestedAmount != null && requestedAmount > 0 ? requestedAmount : undefined,
      fundingPurpose,
      monthlyRevenue: revenue.monthlyRevenue,
    })
    : undefined
  if (inferred?.requestedAmountInferred && !confirmInferredAmount) {
    addField(
      fields,
      "requestedAmount",
      `Confirm the inferred requested amount of ${inferred.requestedAmount} (2× monthly revenue ${revenue!.monthlyRevenue}).`,
    )
  }
  if (inferred?.fundingPurposeInferred && !confirmInferredPurpose) {
    addField(
      fields,
      "fundingPurpose",
      `Confirm the inferred purpose of funds (${DEFAULT_FUNDING_PURPOSE}).`,
    )
  }

  if (Object.keys(fields).length || !selected || !revenue || !inferred) return { ok: false, fields }
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
      ein: einDigits,
      industry,
      naicsCode,
      entityType,
      startDate,
      website,
      ficoScore: ficoScore != null && ficoScore > 0 ? ficoScore : undefined,
      averageMonthlyDeposits: averageMonthlyDeposits != null && averageMonthlyDeposits > 0 ? averageMonthlyDeposits : undefined,
      annualRevenue: revenue.annualRevenue,
      monthlyRevenue: revenue.monthlyRevenue,
      statementDeposits,
      revenueSource: revenue.source,
      requestedAmount: inferred.requestedAmount,
      requestedAmountInferred: inferred.requestedAmountInferred,
      fundingPurpose: inferred.fundingPurpose,
      fundingPurposeInferred: inferred.fundingPurposeInferred,
      owner: {
        firstName: selected.firstName!,
        lastName: selected.lastName!,
        street: selected.street!,
        city: selected.city!,
        state: selected.state!,
        postalCode: selected.postalCode ?? "",
        phone: selected.phone!,
        email: selected.email!,
        dateOfBirth: selected.dateOfBirth!,
        ownershipPercent: selected.ownershipPercent!,
        ssnLast4: selected.ssnLast4,
        isPrimary: selected.isPrimary,
        index: selected.index,
      },
    },
  }
}

export function mapApplication(application: PlexeApplication, documents: PlexeMappedDocument[] = []): PlexeMappedRequest {
  const notes: string[] = []
  if (application.ficoScore != null) notes.push(`FICO ${application.ficoScore}`)
  if (application.averageMonthlyDeposits != null) {
    notes.push(`Average monthly deposits ${application.averageMonthlyDeposits}`)
  }
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
      naicsCode: application.naicsCode,
      entityType: application.entityType,
      startDate: application.startDate,
      website: application.website,
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
      ownershipPercent: application.owner.ownershipPercent,
      ssnLast4: application.owner.ssnLast4,
    },
    funding: {
      annualRevenue: application.annualRevenue,
      monthlyRevenue: application.monthlyRevenue,
      statementDeposits: application.statementDeposits,
      revenueSource: application.revenueSource,
      requestedAmount: application.requestedAmount,
      requestedAmountInferred: application.requestedAmountInferred,
      fundingPurpose: application.fundingPurpose,
      fundingPurposeInferred: application.fundingPurposeInferred,
    },
    notes,
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
