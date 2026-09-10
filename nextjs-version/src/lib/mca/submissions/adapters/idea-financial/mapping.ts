import "server-only"

import type { AdapterStatusResult, SubmissionJob } from "../../contracts"

export const IDEA_FINANCIAL_SLUG = "idea-financial"
export const DEFAULT_FICO = 650
export const DEFAULT_NAICS = "999999"
export const DEFAULT_REQUESTED_AMOUNT = 25_000
export const REQUESTED_AMOUNT_MULTIPLIER = 2
export const ORIGINATOR_PHONE_ERROR = "Agent/Originator phone number (required by Idea Financial)"

export const IDEA_LEGAL_STRUCTURES = [
  "LLC",
  "Corporation",
  "Sole Proprietorship",
  "Partnership",
  "Other",
] as const
export type IdeaLegalStructure = (typeof IDEA_LEGAL_STRUCTURES)[number]

export const PROVIDER_STATUS_MAP = {
  draft: "submitted",
  processing: "submitted",
  "submission incomplete": "pending",
  dormant: "pending",
  "conditional offer": "approved",
  offer: "approved",
  closing: "approved",
  "contract ready": "approved",
  "contract out": "approved",
  "closing incomplete": "approved",
  funded: "funded",
  closed: "funded",
  open: "funded",
  declined: "declined",
  "not interested": "declined",
  abandoned: "declined",
} as const

export type IdeaDocumentCategory = "application" | "bank_statements" | "other"
export type IdeaRevenueSource = "annual_revenue" | "monthly_revenue" | "statement_deposits"
export type IdeaPhoneSource = "originator" | "submitter"

export interface IdeaOwnerInput {
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
  index: number
}

export interface IdeaApplication {
  legalName: string
  street: string
  city: string
  state: string
  postalCode: string
  phone: string
  ein: string
  entityType: string
  industry: string
  naicsCode: string
  startDate: string
  ficoScore: number
  annualRevenue: number
  monthlyRevenue: number
  statementDeposits: number[]
  revenueSource: IdeaRevenueSource
  requestedAmount: number
  requestedAmountInferred: boolean
  originatorPhone: string
  originatorPhoneSource: IdeaPhoneSource
  owners: IdeaOwnerInput[]
}

export interface IdeaMappedOwner {
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

export interface IdeaMappedDocument {
  documentId: string
  category: IdeaDocumentCategory
  checksum: string
}

export interface IdeaMappedRequest {
  business: {
    legalName: string
    street: string
    city: string
    state: string
    postalCode: string
    phone: string
    ein: string
    entityType: IdeaLegalStructure
    industry: string
    naicsCode: string
    startDate: string
  }
  financial: {
    annualRevenue: number
    monthlyRevenue: number
    statementDeposits: number[]
    revenueSource: IdeaRevenueSource
    requestedAmount: number
    requestedAmountInferred: boolean
    ficoScore: number
  }
  originator: {
    phone: string
    source: IdeaPhoneSource
  }
  owners: IdeaMappedOwner[]
  documents: IdeaMappedDocument[]
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
}): { monthlyRevenue: number; annualRevenue: number; source: IdeaRevenueSource } | undefined {
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
      source: "monthly_revenue",
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

export function deriveRequestedAmount(input: {
  requestedAmount?: number
  monthlyRevenue?: number
}): { requestedAmount: number; inferred: boolean } {
  if (input.requestedAmount != null && input.requestedAmount > 0) {
    return { requestedAmount: roundDollars(input.requestedAmount), inferred: false }
  }
  if (input.monthlyRevenue != null && input.monthlyRevenue > 0) {
    return { requestedAmount: roundDollars(input.monthlyRevenue * REQUESTED_AMOUNT_MULTIPLIER), inferred: true }
  }
  return { requestedAmount: DEFAULT_REQUESTED_AMOUNT, inferred: true }
}

export function mapLegalStructure(value: string): IdeaLegalStructure {
  const key = value.trim().toLowerCase().replace(/[\s-]+/g, "_")
  if (key === "llc") return "LLC"
  if (key === "corporation" || key === "corp" || key === "s_corporation" || key === "s_corp") return "Corporation"
  if (key === "sole_proprietor" || key === "sole_proprietorship") return "Sole Proprietorship"
  if (key === "partnership") return "Partnership"
  const exact = IDEA_LEGAL_STRUCTURES.find((item) => item.toLowerCase().replace(/[\s-]+/g, "_") === key)
  return exact ?? "Other"
}

export function mapDocumentCategory(category: string): IdeaDocumentCategory {
  const key = category.trim().toLowerCase()
  if (key === "application" || key === "api_application") return "application"
  if (key === "statement" || key === "bank_statement" || key === "bank_statements") return "bank_statements"
  return "other"
}

export function mapJobDocuments(job: SubmissionJob): IdeaMappedDocument[] {
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

export function resolveOriginatorPhone(input: unknown): { phone: string; source: IdeaPhoneSource } {
  const record = asRecord(input) ?? {}
  const originator = nested(record, "originator") ?? nested(record, "agent")
  const submitter = nested(record, "submitter") ?? nested(record, "submittedBy") ?? nested(record, "actor")
  const originatorPhone = firstText(record, ["originatorPhone", "agentPhone"])
    || firstText(originator, ["phone", "mobile", "mobilePhone"])
  if (originatorPhone) return { phone: originatorPhone, source: "originator" }
  const submitterPhone = firstText(record, ["submitterPhone"])
    || firstText(submitter, ["phone", "mobile", "mobilePhone"])
  if (submitterPhone) return { phone: submitterPhone, source: "submitter" }
  return { phone: "", source: "originator" }
}

function parseOwners(record: Record<string, unknown>): Array<Partial<IdeaOwnerInput> & { index: number }> {
  const business = nested(record, "business")
  const source = Array.isArray(record.owners)
    ? record.owners
    : Array.isArray(business?.owners)
      ? business.owners
      : record.owner
        ? [record.owner]
        : []
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
    }
  })
}

export function validateApplication(
  input: unknown,
): { ok: true; value: IdeaApplication } | { ok: false; fields: Record<string, string> } {
  const record = asRecord(input)
  if (!record) {
    return { ok: false, fields: { application: "An application payload is required." } }
  }
  const business = nested(record, "business") ?? record
  const financial = nested(record, "financial") ?? record
  const address = readAddress(business)
  const fields: Record<string, string> = {}
  const legalName = firstText(business, ["legalName", "businessName", "companyName", "name"])
  const phone = firstText(business, ["phone", "contactPhone", "businessPhone"])
  const ein = digits(firstText(business, ["ein", "taxId"]))
  const entityType = firstText(business, ["entityType", "legalStructure"])
  const industry = firstText(business, ["industry", "industryName"])
  const naicsInput = digits(firstText(business, ["naicsCode", "naics"]) || firstText(record, ["naicsCode", "naics"]))
  const startDate = firstText(business, ["startDate", "businessStartDate"])
  const ficoInput = money(business.ficoScore ?? record.ficoScore ?? financial.ficoScore)
  const annualRevenue = money(financial.annualRevenue ?? record.annualRevenue ?? financial.grossAnnualRevenue)
  const monthlyRevenueInput = money(financial.monthlyRevenue ?? record.monthlyRevenue)
  const requestedAmount = money(
    financial.requestedAmount ?? record.requestedAmount ?? financial.amountRequested ?? record.amountRequested,
  )
  const statementDeposits = parseStatementDeposits(record)
  const agent = resolveOriginatorPhone(record)

  if (!legalName) addField(fields, "legalName", "Business name is required.")
  if (!entityType) addField(fields, "entityType", "Legal structure is required.")
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
  if (startDate && !isDate(startDate)) addField(fields, "startDate", "Use a valid date in YYYY-MM-DD format.")
  if (naicsInput && naicsInput.length !== 6) addField(fields, "naicsCode", "NAICS must contain 6 digits.")
  if (ficoInput != null && (ficoInput < 300 || ficoInput > 850)) addField(fields, "ficoScore", "FICO score must be between 300 and 850.")
  if (requestedAmount != null && requestedAmount <= 0) addField(fields, "requestedAmount", "Requested amount must be greater than zero.")

  if (!agent.phone) addField(fields, "originatorPhone", ORIGINATOR_PHONE_ERROR)
  else if (digits(agent.phone).length < 10) addField(fields, "originatorPhone", ORIGINATOR_PHONE_ERROR)

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
    else if (owner.ownershipPercent < 0 || owner.ownershipPercent > 100) {
      addField(fields, `${prefix}.ownershipPercent`, "Ownership must be between 0 and 100%.")
    }
  }

  const revenue = resolveMonthlyRevenue({
    annualRevenue: annualRevenue != null && annualRevenue > 0 ? annualRevenue : undefined,
    monthlyRevenue: monthlyRevenueInput != null && monthlyRevenueInput > 0 ? monthlyRevenueInput : undefined,
    statementDeposits,
  })
  if (!revenue) {
    addField(fields, "monthlyRevenue", "Enter annual revenue or statement deposit totals so monthly revenue can be calculated.")
    addField(fields, "statementDeposits", "Enter annual revenue or statement deposit totals so monthly revenue can be calculated.")
  }

  const amount = deriveRequestedAmount({
    requestedAmount: requestedAmount != null && requestedAmount > 0 ? requestedAmount : undefined,
    monthlyRevenue: revenue?.monthlyRevenue,
  })

  if (Object.keys(fields).length || !revenue) return { ok: false, fields }
  return {
    ok: true,
    value: {
      legalName,
      street: address.street,
      city: address.city,
      state: address.state,
      postalCode: address.postalCode,
      phone,
      ein,
      entityType,
      industry,
      naicsCode: naicsInput || DEFAULT_NAICS,
      startDate,
      ficoScore: ficoInput != null && ficoInput >= 300 && ficoInput <= 850 ? roundDollars(ficoInput) : DEFAULT_FICO,
      annualRevenue: revenue.annualRevenue,
      monthlyRevenue: revenue.monthlyRevenue,
      statementDeposits,
      revenueSource: revenue.source,
      requestedAmount: amount.requestedAmount,
      requestedAmountInferred: amount.inferred,
      originatorPhone: agent.phone,
      originatorPhoneSource: agent.source,
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
        index: owner.index,
      })),
    },
  }
}

export function mapApplication(application: IdeaApplication, documents: IdeaMappedDocument[] = []): IdeaMappedRequest {
  return {
    business: {
      legalName: application.legalName,
      street: application.street,
      city: application.city,
      state: application.state,
      postalCode: application.postalCode,
      phone: application.phone,
      ein: application.ein,
      entityType: mapLegalStructure(application.entityType),
      industry: application.industry,
      naicsCode: application.naicsCode || DEFAULT_NAICS,
      startDate: application.startDate,
    },
    financial: {
      annualRevenue: application.annualRevenue,
      monthlyRevenue: application.monthlyRevenue,
      statementDeposits: application.statementDeposits,
      revenueSource: application.revenueSource,
      requestedAmount: application.requestedAmount,
      requestedAmountInferred: application.requestedAmountInferred,
      ficoScore: application.ficoScore || DEFAULT_FICO,
    },
    originator: {
      phone: application.originatorPhone,
      source: application.originatorPhoneSource,
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
    documents,
  }
}

export function mapProviderStatus(
  rawStatus: string,
  outstandingDocuments: string[] = [],
  stips: string[] = [],
): Pick<AdapterStatusResult, "rawStatus" | "normalized" | "unknown"> {
  if (outstandingDocuments.length) {
    const base = rawStatus.trim() || "Submission Incomplete"
    return {
      rawStatus: `${base}: outstanding document requests: ${outstandingDocuments.join(", ")}`,
      normalized: "pending",
      unknown: false,
    }
  }
  const key = rawStatus.trim().toLowerCase().replace(/[_-]+/g, " ").replace(/\s+/g, " ")
  const normalized = PROVIDER_STATUS_MAP[key as keyof typeof PROVIDER_STATUS_MAP]
  if (normalized) {
    if (stips.length && (normalized === "approved" || normalized === "funded")) {
      return {
        rawStatus: `${rawStatus}: stips required: ${stips.join(", ")}`,
        normalized,
        unknown: false,
      }
    }
    return { rawStatus, normalized, unknown: false }
  }
  return { rawStatus, normalized: "unknown", unknown: true }
}
