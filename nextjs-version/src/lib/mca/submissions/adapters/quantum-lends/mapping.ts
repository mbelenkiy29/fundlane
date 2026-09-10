import { ENTITY_TYPES, type DealAddress, type EntityType } from "../../../deals/schema"

export const QUANTUM_LENDS_ENTITY_TYPE = {
  llc: "LLC",
  corporation: "Corporation",
  s_corporation: "S-Corporation",
  partnership: "Partnership",
  sole_proprietor: "Sole Proprietorship",
  nonprofit: "Nonprofit",
  other: "Other",
} as const satisfies Record<EntityType, string>

const INDUSTRY_NAICS: Record<string, string> = {
  accounting: "541211",
  "auto repair": "811111",
  "beauty salon": "812112",
  bars: "722410",
  "child care": "624410",
  childcare: "624410",
  cleaning: "561720",
  "coffee shop": "722515",
  construction: "236115",
  consulting: "541611",
  "convenience store": "445131",
  dental: "621210",
  ecommerce: "454110",
  "e commerce": "454110",
  "electrical contractor": "238210",
  "fast food": "722513",
  "fitness center": "713940",
  "food service": "722511",
  "food services": "722511",
  "full service restaurants": "722511",
  "gas station": "457110",
  gym: "713940",
  healthcare: "621111",
  hotel: "721110",
  hvac: "238220",
  janitorial: "561720",
  landscaping: "561730",
  legal: "541110",
  manufacturing: "339999",
  medical: "621111",
  plumbing: "238220",
  qsr: "722513",
  "real estate": "531210",
  restaurant: "722511",
  restaurants: "722511",
  retail: "459999",
  salon: "812112",
  staffing: "561320",
  transportation: "484121",
  trucking: "484121",
  wholesale: "425120",
}

const ENTITY_ALIASES: Record<string, EntityType> = {
  corp: "corporation",
  corporation: "corporation",
  inc: "corporation",
  llc: "llc",
  llp: "partnership",
  nonprofit: "nonprofit",
  non_profit: "nonprofit",
  other: "other",
  partnership: "partnership",
  s_corp: "s_corporation",
  s_corporation: "s_corporation",
  scorp: "s_corporation",
  sole_prop: "sole_proprietor",
  sole_proprietor: "sole_proprietor",
  sole_proprietorship: "sole_proprietor",
  soleprop: "sole_proprietor",
}

export interface QuantumLendsOwnerInput {
  id?: string
  firstName?: string
  lastName?: string
  ownershipPercent?: number
  isPrimary?: boolean
  dateOfBirth?: string
  identityLast4?: string
  ssn?: string
  email?: string
  phone?: string
}

export interface QuantumLendsApplicationInput {
  legalName?: string
  dbaName?: string
  ein?: string
  entityType?: string
  address?: DealAddress
  contactPhone?: string
  contactEmail?: string
  startDate?: string
  industry?: string
  naicsCode?: string
  monthlyRevenue?: number
  annualRevenue?: number
  requestedAmount?: number
  owners?: QuantumLendsOwnerInput[]
}

export interface QuantumLendsMappedOwner {
  firstName: string
  lastName: string
  ownershipPercent: number
  isPrimary: boolean
  ssnLast4: string
  email?: string
  phone?: string
}

export interface QuantumLendsMappedRequest {
  merchant: {
    legalName: string
    dba: string
    phone: string
    ein?: string
    entityType: (typeof QUANTUM_LENDS_ENTITY_TYPE)[EntityType]
    industry: string
    naics: string
    startDate: string
    address: {
      line1: string
      line2?: string
      city: string
      state: string
      postalCode: string
      country: string
    }
  }
  funding: {
    requestedAmount: number
    annualRevenue: number
  }
  owners: QuantumLendsMappedOwner[]
}

export type QuantumLendsMapResult =
  | { ok: true; request: QuantumLendsMappedRequest }
  | { ok: false; fields: Record<string, string> }

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : ""
}

function digits(value: unknown): string {
  return text(value).replace(/\D/g, "")
}

function finiteNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return undefined
}

function entityTypeOf(value: unknown): EntityType | undefined {
  const normalized = text(value).toLowerCase().replace(/[\s-]+/g, "_")
  if ((ENTITY_TYPES as readonly string[]).includes(normalized)) return normalized as EntityType
  return ENTITY_ALIASES[normalized]
}

function ssnLast4(owner: QuantumLendsOwnerInput): string | undefined {
  const last4 = digits(owner.identityLast4)
  if (last4.length === 4) return last4
  const ssn = digits(owner.ssn)
  if (ssn.length >= 4) return ssn.slice(-4)
  return undefined
}

export function resolveAnnualRevenue(input: { annualRevenue?: number; monthlyRevenue?: number }): number | undefined {
  if (input.annualRevenue != null && Number.isFinite(input.annualRevenue) && input.annualRevenue > 0) {
    return input.annualRevenue
  }
  if (input.monthlyRevenue != null && Number.isFinite(input.monthlyRevenue) && input.monthlyRevenue > 0) {
    return input.monthlyRevenue * 12
  }
  return undefined
}

export function mapNaics(input: { industry?: string; naicsCode?: string }): { naics?: string; industry?: string } {
  const explicit = digits(input.naicsCode)
  if (explicit.length >= 2 && explicit.length <= 6) {
    return { naics: explicit, industry: text(input.industry) || explicit }
  }
  const industry = text(input.industry)
  if (/^\d{2,6}$/.test(industry)) return { naics: industry, industry }
  const key = industry.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()
  const mapped = INDUSTRY_NAICS[key]
  if (mapped) return { naics: mapped, industry }
  return { industry: industry || undefined }
}

export function choosePrimaryApplicant<T extends { ownershipPercent?: number; isPrimary?: boolean }>(owners: T[]): T[] {
  if (owners.length === 0) return []
  let primaryIndex = 0
  for (let index = 1; index < owners.length; index += 1) {
    const current = owners[index]!.ownershipPercent
    const best = owners[primaryIndex]!.ownershipPercent
    const currentShare = current ?? Number.NEGATIVE_INFINITY
    const bestShare = best ?? Number.NEGATIVE_INFINITY
    if (currentShare > bestShare) {
      primaryIndex = index
      continue
    }
    if (currentShare === bestShare && owners[index]!.isPrimary && !owners[primaryIndex]!.isPrimary) {
      primaryIndex = index
    }
  }
  return owners.map((owner, index) => ({ ...owner, isPrimary: index === primaryIndex }))
}

function parseOwners(value: unknown, fields: Record<string, string>): QuantumLendsMappedOwner[] {
  if (!Array.isArray(value) || value.length === 0) {
    fields.owners = "Add at least one owner with name, ownership percentage, and SSN last four."
    return []
  }
  const parsed: QuantumLendsMappedOwner[] = []
  for (const [index, entry] of value.entries()) {
    const owner = isObject(entry) ? entry as QuantumLendsOwnerInput : {}
    const firstName = text(owner.firstName)
    const lastName = text(owner.lastName)
    const ownershipPercent = finiteNumber(owner.ownershipPercent)
    const last4 = ssnLast4(owner)
    const prefix = `owners.${index}`
    if (!firstName) fields[`${prefix}.firstName`] = "Enter the owner's first name."
    if (!lastName) fields[`${prefix}.lastName`] = "Enter the owner's last name."
    if (ownershipPercent == null || ownershipPercent < 0 || ownershipPercent > 100) {
      fields[`${prefix}.ownershipPercent`] = "Enter an ownership percentage between 0 and 100."
    }
    if (!last4) fields[`${prefix}.identityLast4`] = "Enter the owner's SSN last four."
    parsed.push({
      firstName,
      lastName,
      ownershipPercent: ownershipPercent ?? 0,
      isPrimary: owner.isPrimary === true,
      ssnLast4: last4 ?? "",
      ...(text(owner.email) ? { email: text(owner.email) } : {}),
      ...(text(owner.phone) ? { phone: text(owner.phone) } : {}),
    })
  }
  if (!parsed.some((owner) => owner.ownershipPercent > 0)) {
    fields.owners = "Enter an ownership percentage greater than 0 for at least one owner."
  }
  return choosePrimaryApplicant(parsed)
}

export function mapApplication(input: unknown): QuantumLendsMapResult {
  const fields: Record<string, string> = {}
  if (!isObject(input)) {
    return { ok: false, fields: { application: "Provide the merchant application as an object." } }
  }
  const legalName = text(input.legalName)
  const dbaName = text(input.dbaName) || legalName
  const entityType = entityTypeOf(input.entityType)
  const address = isObject(input.address) ? input.address as DealAddress : {}
  const line1 = text(address.line1)
  const city = text(address.city)
  const state = text(address.state)
  const postalCode = text(address.postalCode)
  const phone = text(input.contactPhone)
  const startDate = text(input.startDate)
  const requestedAmount = finiteNumber(input.requestedAmount)
  const annualRevenue = resolveAnnualRevenue({
    annualRevenue: finiteNumber(input.annualRevenue),
    monthlyRevenue: finiteNumber(input.monthlyRevenue),
  })
  const naics = mapNaics({ industry: text(input.industry) || undefined, naicsCode: text(input.naicsCode) || undefined })
  const einDigits = digits(input.ein)
  const owners = parseOwners(input.owners, fields)

  if (!legalName) fields.legalName = "Enter the legal business name."
  if (!line1) fields["address.line1"] = "Enter the business street address."
  if (!city) fields["address.city"] = "Enter the business city."
  if (!state) fields["address.state"] = "Enter the business state."
  if (!postalCode) fields["address.postalCode"] = "Enter the business postal code."
  if (!phone) fields.contactPhone = "Enter the business phone number."
  if (!entityType) fields.entityType = "Select a business entity type."
  if (!startDate) fields.startDate = "Enter the business start date."
  else if (!/^\d{4}-\d{2}-\d{2}/.test(startDate)) fields.startDate = "Enter the business start date as YYYY-MM-DD."
  if (requestedAmount == null || requestedAmount <= 0) fields.requestedAmount = "Enter the requested funding amount."
  if (annualRevenue == null) fields.annualRevenue = "Enter annual revenue, or monthly revenue so annual revenue can be calculated."
  if (!naics.naics) fields.industry = "Enter an industry that maps to a NAICS code, or provide a NAICS code."
  if (entityType !== "sole_proprietor") {
    if (einDigits.length !== 9) fields.ein = "An EIN is required for this entity type."
  } else if (einDigits && einDigits.length !== 9) {
    fields.ein = "Enter a 9-digit EIN."
  }

  if (
    Object.keys(fields).length
    || !legalName
    || !entityType
    || !line1
    || !city
    || !state
    || !postalCode
    || !phone
    || !startDate
    || requestedAmount == null
    || annualRevenue == null
    || !naics.naics
  ) {
    return { ok: false, fields }
  }

  const request: QuantumLendsMappedRequest = {
    merchant: {
      legalName,
      dba: dbaName,
      phone,
      entityType: QUANTUM_LENDS_ENTITY_TYPE[entityType],
      industry: naics.industry || naics.naics,
      naics: naics.naics,
      startDate: startDate.slice(0, 10),
      address: {
        line1,
        city,
        state,
        postalCode,
        country: text(address.country) || "US",
        ...(text(address.line2) ? { line2: text(address.line2) } : {}),
      },
      ...(einDigits.length === 9 ? { ein: einDigits } : {}),
    },
    funding: {
      requestedAmount,
      annualRevenue,
    },
    owners,
  }
  return { ok: true, request }
}
