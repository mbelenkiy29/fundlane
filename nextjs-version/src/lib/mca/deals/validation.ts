import { DEAL_STATUSES, ENTITY_TYPES, type DealRecord, type DealWriteInput } from "./schema"

export interface DealValidationResult {
  fieldErrors: Record<string, string[]>
  missingRequiredFields: string[]
}

function isDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00.000Z`))
}

export function validateDealInput(input: DealWriteInput): Record<string, string[]> {
  const errors: Record<string, string[]> = {}
  const add = (field: string, message: string) => { errors[field] = [...(errors[field] ?? []), message] }

  if (input.entityType && !ENTITY_TYPES.includes(input.entityType)) add("entityType", "Choose a valid entity type.")
  if (input.ein && !/^\d{2}-?\d{7}$/.test(input.ein)) add("ein", "EIN must contain 9 digits.")
  if (input.startDate && !isDate(input.startDate)) add("startDate", "Use a valid date in YYYY-MM-DD format.")
  if (input.naicsCode && !/^\d{6}$/.test(input.naicsCode)) add("naicsCode", "NAICS code must be 6 digits.")
  if (input.contactEmail && !/^\S+@\S+\.\S+$/.test(input.contactEmail)) add("contactEmail", "Enter a valid email address.")
  if (input.monthlyRevenue !== undefined && input.monthlyRevenue < 0) add("monthlyRevenue", "Monthly revenue cannot be negative.")
  if (input.requestedAmount !== undefined && input.requestedAmount <= 0) add("requestedAmount", "Requested amount must be greater than zero.")
  if (input.requestedTermMonths !== undefined && (!Number.isInteger(input.requestedTermMonths) || input.requestedTermMonths < 1 || input.requestedTermMonths > 60)) {
    add("requestedTermMonths", "Requested term must be a whole number between 1 and 60 months.")
  }
  if (input.ficoScore !== undefined && (input.ficoScore < 300 || input.ficoScore > 850)) add("ficoScore", "FICO score must be between 300 and 850.")

  input.owners?.forEach((owner, index) => {
    if (owner.ownershipPercent !== undefined && (owner.ownershipPercent < 0 || owner.ownershipPercent > 100)) add(`owners.${index}.ownershipPercent`, "Ownership must be between 0 and 100%.")
    if (owner.dateOfBirth && !isDate(owner.dateOfBirth)) add(`owners.${index}.dateOfBirth`, "Use a valid date in YYYY-MM-DD format.")
    if (owner.identityLast4 && !/^\d{4}$/.test(owner.identityLast4)) add(`owners.${index}.identityLast4`, "Enter exactly the last 4 digits.")
    if (owner.email && !/^\S+@\S+\.\S+$/.test(owner.email)) add(`owners.${index}.email`, "Enter a valid email address.")
  })
  if ((input.owners?.filter((owner) => owner.isPrimary).length ?? 0) > 1) add("owners", "Only one primary owner is allowed.")
  const ownershipTotal = input.owners?.reduce((total, owner) => total + (owner.ownershipPercent ?? 0), 0) ?? 0
  if (ownershipTotal > 100) add("owners", "Combined ownership cannot exceed 100%.")

  input.assignments?.forEach((assignment, index) => {
    if (!assignment.membershipId.trim()) add(`assignments.${index}.membershipId`, "Choose an active workspace member.")
    if (!(["originator", "closer"] as const).includes(assignment.kind)) add(`assignments.${index}.kind`, "Choose originator or closer.")
  })
  if (input.assignments && new Set(input.assignments.map((item) => `${item.kind}:${item.membershipId}`)).size !== input.assignments.length) add("assignments", "Each person can appear only once per assignment kind.")

  if (input.fieldSource && !(["manual", "import", "application_scan", "api", "system"] as const).includes(input.fieldSource)) add("fieldSource", "Choose a valid field source.")

  for (const kind of ["originator", "closer"] as const) {
    const primary = input.assignments?.filter((item) => item.kind === kind && item.isPrimary) ?? []
    if (primary.length > 1) add("assignments", `Only one primary ${kind} is allowed.`)
  }
  return errors
}

export function submissionMissingFields(record: Pick<DealRecord,
  "legalName" | "entityType" | "address" | "contactPhone" | "startDate" | "industry" | "monthlyRevenue" | "requestedAmount" | "fundingPurpose" | "owners"
>): string[] {
  const missing: string[] = []
  if (!record.legalName?.trim()) missing.push("legalName")
  if (!record.entityType) missing.push("entityType")
  if (!record.address?.line1?.trim()) missing.push("address.line1")
  if (!record.address?.city?.trim()) missing.push("address.city")
  if (!record.address?.state?.trim()) missing.push("address.state")
  if (!record.address?.postalCode?.trim()) missing.push("address.postalCode")
  if (!record.contactPhone?.trim()) missing.push("contactPhone")
  if (!record.startDate) missing.push("startDate")
  if (!record.industry?.trim()) missing.push("industry")
  if (!record.monthlyRevenue) missing.push("monthlyRevenue")
  if (!record.requestedAmount) missing.push("requestedAmount")
  if (!record.fundingPurpose?.trim()) missing.push("fundingPurpose")
  if (!record.owners.length) missing.push("owners")
  record.owners.forEach((owner, index) => {
    if (!owner.firstName?.trim()) missing.push(`owners.${index}.firstName`)
    if (!owner.lastName?.trim()) missing.push(`owners.${index}.lastName`)
    if (owner.ownershipPercent === undefined) missing.push(`owners.${index}.ownershipPercent`)
  })
  return missing
}

const SUBMISSION_MISSING_FIELD_LABELS: Record<string, string> = {
  legalName: "Legal name",
  entityType: "Entity type",
  "address.line1": "Street address",
  "address.city": "City",
  "address.state": "State",
  "address.postalCode": "ZIP code",
  contactPhone: "Contact phone",
  startDate: "Business start date",
  industry: "Industry",
  monthlyRevenue: "Monthly revenue",
  requestedAmount: "Requested funding",
  fundingPurpose: "Use of funds",
  owners: "Owners",
}

const SUBMISSION_MISSING_FIELD_ANCHORS: Record<string, string> = {
  legalName: "deal-field-legalName",
  entityType: "deal-field-entityType",
  "address.line1": "deal-field-line1",
  "address.city": "deal-field-city",
  "address.state": "deal-field-state",
  "address.postalCode": "deal-field-postalCode",
  contactPhone: "deal-field-contactPhone",
  startDate: "deal-field-startDate",
  industry: "deal-field-industry",
  monthlyRevenue: "deal-field-monthlyRevenue",
  requestedAmount: "deal-field-requestedAmount",
  fundingPurpose: "deal-field-fundingPurpose",
  owners: "deal-field-owners",
}

const OWNER_FIELD_LABELS = {
  firstName: "first name",
  lastName: "last name",
  ownershipPercent: "ownership %",
} as const

function ownerMissingField(field: string) {
  const match = /^owners\.(\d+)\.(firstName|lastName|ownershipPercent)$/.exec(field)
  if (!match) return null
  return { index: match[1], part: match[2] as keyof typeof OWNER_FIELD_LABELS }
}

/** Human name for a `submissionMissingFields` key. */
export function missingRequiredFieldLabel(field: string): string {
  const mapped = SUBMISSION_MISSING_FIELD_LABELS[field]
  if (mapped) return mapped
  const owner = ownerMissingField(field)
  if (owner) return `Owner ${Number(owner.index) + 1} ${OWNER_FIELD_LABELS[owner.part]}`
  return field.replace(/[._]/g, " ")
}

/** Form element id for a `submissionMissingFields` key. */
export function missingRequiredFieldAnchor(field: string): string {
  const mapped = SUBMISSION_MISSING_FIELD_ANCHORS[field]
  if (mapped) return mapped
  const owner = ownerMissingField(field)
  if (owner) return `deal-field-owners-${owner.index}-${owner.part}`
  return "deal-field-owners"
}

export function describeMissingRequiredFields(fields: string[]) {
  return fields.map((key) => ({
    key,
    label: missingRequiredFieldLabel(key),
    anchor: missingRequiredFieldAnchor(key),
  }))
}

export function assertDealStatus(value: unknown): value is (typeof DEAL_STATUSES)[number] {
  return typeof value === "string" && DEAL_STATUSES.includes(value as (typeof DEAL_STATUSES)[number])
}
