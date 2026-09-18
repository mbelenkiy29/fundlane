import { ENTITY_TYPES, type DealAddress, type DealOwnerInput, type DealWriteInput, type EntityType } from "../deals/schema"

export { ENTITY_TYPES }

export const FUNDLANE_FORM_ID = "fundlane"
export const FUNDLANE_FORM_NAME = "Fundlane application"
export const INVITE_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/

export const US_STATES = [
  "AL","AK","AZ","AR","CA","CO","CT","DE","FL","GA","HI","ID","IL","IN","IA","KS","KY","LA","ME","MD",
  "MA","MI","MN","MS","MO","MT","NE","NV","NH","NJ","NM","NY","NC","ND","OH","OK","OR","PA","RI","SC",
  "SD","TN","TX","UT","VT","VA","WA","WV","WI","WY","DC",
] as const

export const ENTITY_TYPE_LABELS: Record<EntityType, string> = {
  llc: "LLC",
  corporation: "Corporation",
  s_corporation: "S corporation",
  partnership: "Partnership",
  sole_proprietor: "Sole proprietor",
  nonprofit: "Nonprofit",
  other: "Other",
}

export const OPTIONAL_FIELD_KEYS = ["dbaName", "naicsCode", "ficoScore", "fundingPurpose", "driversLicense", "voidedCheck"] as const
export type OptionalFieldKey = (typeof OPTIONAL_FIELD_KEYS)[number]
export type OptionalFields = Partial<Record<OptionalFieldKey, boolean>>

export const DEFAULT_OPTIONAL_FIELDS: OptionalFields = {
  dbaName: true,
  naicsCode: false,
  ficoScore: false,
  fundingPurpose: true,
  driversLicense: false,
  voidedCheck: false,
}

export type FunnelStepId =
  | "welcome"
  | "legalName"
  | "dbaName"
  | "entityType"
  | "ein"
  | "address"
  | "startDate"
  | "industry"
  | "monthlyRevenue"
  | "requestedAmount"
  | "fundingPurpose"
  | "contact"
  | "owners"
  | "statements"
  | "extras"
  | "review"

export interface FunnelStep {
  id: FunnelStepId
  title: string
  hint?: string
}

export const FUNNEL_STEPS: FunnelStep[] = [
  { id: "welcome", title: "Ready when you are", hint: "Have your business details and recent bank statements handy." },
  { id: "legalName", title: "What is the legal business name?" },
  { id: "dbaName", title: "Does the business use a DBA?", hint: "Leave blank if it operates under the legal name." },
  { id: "entityType", title: "What type of entity is this?" },
  { id: "ein", title: "What is the employer identification number?" },
  { id: "address", title: "Where is the business located?" },
  { id: "startDate", title: "When did the business start?" },
  { id: "industry", title: "What industry is the business in?" },
  { id: "monthlyRevenue", title: "About how much does it deposit each month?" },
  { id: "requestedAmount", title: "How much funding are they looking for?" },
  { id: "fundingPurpose", title: "What will the funding be used for?" },
  { id: "contact", title: "Who should we reach about this application?" },
  { id: "owners", title: "Who owns the business?" },
  { id: "statements", title: "Upload recent bank statements" },
  { id: "extras", title: "Optional supporting documents" },
  { id: "review", title: "Review and submit" },
]

export function visibleSteps(optional: OptionalFields = {}): FunnelStep[] {
  const flags = { ...DEFAULT_OPTIONAL_FIELDS, ...optional }
  return FUNNEL_STEPS.filter(step => {
    if (step.id === "dbaName") return Boolean(flags.dbaName)
    if (step.id === "fundingPurpose") return Boolean(flags.fundingPurpose)
    if (step.id === "extras") return Boolean(flags.driversLicense || flags.voidedCheck)
    return true
  })
}

export interface InvitationDraft {
  schemaVersion: 1
  step: FunnelStepId
  answers: DealWriteInput
  updatedAt: string
}

export function emptyDraft(step: FunnelStepId = "welcome"): InvitationDraft {
  return { schemaVersion: 1, step, answers: {}, updatedAt: new Date().toISOString() }
}

function text(value: unknown, max = 200): string | undefined {
  if (typeof value !== "string") return undefined
  const trimmed = value.trim().slice(0, max)
  return trimmed || undefined
}

function money(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value.replace(/[$,]/g, ""))
    if (Number.isFinite(parsed)) return parsed
  }
  return undefined
}

function address(value: unknown): DealAddress | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
  const item = value as Record<string, unknown>
  const next: DealAddress = {
    line1: text(item.line1, 120),
    line2: text(item.line2, 120),
    city: text(item.city, 80),
    state: text(item.state, 2)?.toUpperCase(),
    postalCode: text(item.postalCode, 16),
    country: text(item.country, 40) ?? "US",
  }
  return Object.values(next).some(Boolean) ? next : undefined
}

function owners(value: unknown): DealOwnerInput[] | undefined {
  if (!Array.isArray(value)) return undefined
  const next = value.slice(0, 6).map(item => {
    const owner = item && typeof item === "object" && !Array.isArray(item) ? item as Record<string, unknown> : {}
    const percent = money(owner.ownershipPercent)
    const last4 = text(owner.identityLast4, 8)?.replace(/\D/g, "").slice(0, 4)
    return {
      firstName: text(owner.firstName, 80),
      lastName: text(owner.lastName, 80),
      ownershipPercent: percent,
      isPrimary: owner.isPrimary === true,
      identityLast4: last4?.length === 4 ? last4 : undefined,
      email: text(owner.email, 254),
      phone: text(owner.phone, 32),
    }
  })
  return next.length ? next : undefined
}

export function sanitizeAnswers(raw: unknown): DealWriteInput {
  const source = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : {}
  const entityType = text(source.entityType, 32)
  return {
    legalName: text(source.legalName, 150),
    dbaName: text(source.dbaName, 150),
    ein: text(source.ein, 12),
    entityType: entityType && ENTITY_TYPES.includes(entityType as EntityType) ? entityType as EntityType : undefined,
    address: address(source.address),
    contactName: text(source.contactName, 120),
    contactEmail: text(source.contactEmail, 254),
    contactPhone: text(source.contactPhone, 32),
    startDate: text(source.startDate, 10),
    industry: text(source.industry, 80),
    naicsCode: text(source.naicsCode, 6),
    monthlyRevenue: money(source.monthlyRevenue),
    ficoScore: money(source.ficoScore) === undefined ? undefined : Math.round(money(source.ficoScore)!),
    fundingPurpose: text(source.fundingPurpose, 300),
    requestedAmount: money(source.requestedAmount),
    owners: owners(source.owners),
  }
}

export function dollarsToCents(amount: number | undefined): number | null {
  if (amount === undefined || !Number.isFinite(amount) || amount <= 0) return null
  return Math.round(amount * 100)
}

export function stepError(step: FunnelStepId, answers: DealWriteInput, optional: OptionalFields = {}): string | undefined {
  const flags = { ...DEFAULT_OPTIONAL_FIELDS, ...optional }
  switch (step) {
    case "legalName": return answers.legalName ? undefined : "Enter the legal business name."
    case "entityType": return answers.entityType ? undefined : "Choose an entity type."
    case "ein": return answers.ein && /^\d{2}-?\d{7}$/.test(answers.ein) ? undefined : "Enter a 9-digit EIN."
    case "address": {
      if (!answers.address?.line1) return "Enter the street address."
      if (!answers.address.city) return "Enter the city."
      if (!answers.address.state || !US_STATES.includes(answers.address.state as typeof US_STATES[number])) return "Choose a US state."
      if (!answers.address.postalCode) return "Enter the ZIP code."
      return undefined
    }
    case "startDate": return answers.startDate && /^\d{4}-\d{2}-\d{2}$/.test(answers.startDate) ? undefined : "Enter the business start date."
    case "industry": return answers.industry ? undefined : "Enter the industry."
    case "monthlyRevenue": return answers.monthlyRevenue !== undefined && answers.monthlyRevenue >= 0 ? undefined : "Enter typical monthly deposits."
    case "requestedAmount": return answers.requestedAmount !== undefined && answers.requestedAmount > 0 ? undefined : "Enter the amount they want to borrow."
    case "fundingPurpose": return !flags.fundingPurpose || answers.fundingPurpose ? undefined : "Enter the funding purpose."
    case "contact": return answers.contactName && answers.contactPhone ? undefined : "Enter a contact name and phone number."
    case "owners": {
      if (!answers.owners?.length) return "Add at least one owner."
      if (answers.owners.some(owner => !owner.firstName || !owner.lastName)) return "Each owner needs a first and last name."
      const total = answers.owners.reduce((sum, owner) => sum + (owner.ownershipPercent ?? 0), 0)
      if (Math.abs(total - 100) > 0.01) return "Ownership percentages must add up to 100%."
      if (answers.owners.some(owner => owner.identityLast4 && !/^\d{4}$/.test(owner.identityLast4))) return "Use only the last four digits of an SSN."
      return undefined
    }
    default: return undefined
  }
}

export function isFunnelStep(value: string): value is FunnelStepId {
  return FUNNEL_STEPS.some(step => step.id === value)
}
