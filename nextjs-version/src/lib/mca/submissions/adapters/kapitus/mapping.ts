import type { AdapterStatusResult } from "../../contracts"

export const KAPITUS_SLUG = "kapitus"

export type KapitusNormalizedStatus = NonNullable<AdapterStatusResult["normalized"]>

export interface KapitusAddress {
  street?: string
  city?: string
  state?: string
  postalCode?: string
}

export interface KapitusOwner {
  firstName?: string
  lastName?: string
  email?: string
  dateOfBirth?: string
  ssn?: string
  ownershipPercent?: number
  isPrimary?: boolean
  address?: KapitusAddress
}

export interface KapitusDocument {
  documentId?: string
  checksum?: string
  category?: string
  kind?: string
  signed?: boolean
}

export interface KapitusApplication {
  legalName?: string
  dbaName?: string
  address?: KapitusAddress
  businessEmail?: string
  ein?: string
  industry?: string
  entityType?: string
  startDate?: string
  annualRevenue?: number
  requestedAmount?: number
  owners?: KapitusOwner[]
  documents?: KapitusDocument[]
}

export interface KapitusMappedDocument {
  kind: "signed_application" | "bank_statement"
  documentId?: string
  checksum?: string
}

export interface KapitusMappedRequest {
  business: {
    legalName: string
    dbaName: string
    address: KapitusAddress
    email: string
    ein: string
    industry: string
    entityType: string
    startDate: string
    annualRevenue: number
    requestedAmount: number
  }
  owner: {
    firstName: string
    lastName: string
    email: string
    dateOfBirth: string
    ssn: string
    ownershipPercent: number
    address: KapitusAddress
  }
  documents: KapitusMappedDocument[]
}

export interface KapitusMappedStatus {
  rawStatus: string
  normalized: KapitusNormalizedStatus
  unknown: boolean
}

const EMAIL_PATTERN = /^\S+@\S+\.\S+$/
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/
const EIN_PATTERN = /^\d{2}-?\d{7}$/
const SSN_PATTERN = /^\d{3}-?\d{2}-?\d{4}$/
const ZIP_PATTERN = /^\d{5}(?:-\d{4})?$/

// Public guide: first ack is sent, closing is approved, expired applications are declined.
const STATUS_BY_TOKEN: Record<string, Exclude<KapitusNormalizedStatus, "unknown">> = {
  application_received: "submitted",
  not_delivered: "submitted",
  credit_review: "pending",
  update_requested: "pending",
  incomplete: "pending",
  approved: "approved",
  contract_sent: "approved",
  contract_received: "approved",
  closing: "approved",
  closing_documents_missing: "approved",
  funded: "funded",
  declined: "declined",
  expired: "declined",
}

function text(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined
  const next = value.trim()
  return next || undefined
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function bool(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
  return value as Record<string, unknown>
}

function digits(value: string): string {
  return value.replace(/\D/g, "")
}

export function tokenStatus(raw: string): string {
  return raw.trim().toLowerCase().replace(/[\s-]+/g, "_").replace(/[^a-z0-9_]/g, "")
}

export function readAddress(value: unknown): KapitusAddress {
  const row = asRecord(value)
  if (!row) return {}
  return {
    street: text(row.street) ?? text(row.line1),
    city: text(row.city),
    state: text(row.state),
    postalCode: text(row.postalCode) ?? text(row.zip),
  }
}

function readOwner(value: unknown): KapitusOwner {
  const row = asRecord(value) ?? {}
  return {
    firstName: text(row.firstName),
    lastName: text(row.lastName),
    email: text(row.email),
    dateOfBirth: text(row.dateOfBirth),
    ssn: text(row.ssn),
    ownershipPercent: num(row.ownershipPercent),
    isPrimary: bool(row.isPrimary),
    address: readAddress(row.address),
  }
}

function readDocument(value: unknown): KapitusDocument {
  const row = asRecord(value) ?? {}
  return {
    documentId: text(row.documentId),
    checksum: text(row.checksum),
    category: text(row.category),
    kind: text(row.kind),
    signed: bool(row.signed),
  }
}

export function readKapitusApplication(input: unknown): KapitusApplication | undefined {
  const row = asRecord(input)
  if (!row) return undefined
  const monthlyRevenue = num(row.monthlyRevenue)
  const owners = Array.isArray(row.owners) ? row.owners.map(readOwner) : undefined
  const documents = Array.isArray(row.documents) ? row.documents.map(readDocument) : undefined
  return {
    legalName: text(row.legalName),
    dbaName: text(row.dbaName),
    address: readAddress(row.address),
    businessEmail: text(row.businessEmail) ?? text(row.contactEmail),
    ein: text(row.ein) ?? text(row.taxId),
    industry: text(row.industry),
    entityType: text(row.entityType),
    startDate: text(row.startDate),
    annualRevenue: num(row.annualRevenue) ?? num(row.grossAnnualRevenue) ?? (monthlyRevenue == null ? undefined : monthlyRevenue * 12),
    requestedAmount: num(row.requestedAmount),
    owners,
    documents,
  }
}

export function selectPrimaryOwner(owners: KapitusOwner[]): KapitusOwner | undefined {
  if (!owners.length) return undefined
  return [...owners].sort((left, right) => {
    const byPercent = (right.ownershipPercent ?? -1) - (left.ownershipPercent ?? -1)
    if (byPercent !== 0) return byPercent
    return Number(Boolean(right.isPrimary)) - Number(Boolean(left.isPrimary))
  })[0]
}

export function isSignedApplicationDocument(document: KapitusDocument): boolean {
  if (document.kind === "signed_application") return true
  return document.category === "application" && document.signed === true
}

export function isBankStatementDocument(document: KapitusDocument): boolean {
  return document.kind === "bank_statement" || document.category === "statement"
}

export function mapKapitusStatus(rawStatus: string): KapitusMappedStatus {
  const raw = rawStatus.trim()
  const normalized = STATUS_BY_TOKEN[tokenStatus(raw)]
  if (!normalized) {
    return { rawStatus: raw, normalized: "unknown", unknown: true }
  }
  return { rawStatus: raw, normalized, unknown: false }
}

function requireAddress(prefix: string, address: KapitusAddress | undefined, fields: Record<string, string>): void {
  if (!address?.street) fields[`${prefix}.street`] = "Enter a street address."
  if (!address?.city) fields[`${prefix}.city`] = "Enter a city."
  if (!address?.state) fields[`${prefix}.state`] = "Enter a state."
  if (!address?.postalCode) fields[`${prefix}.postalCode`] = "Enter a ZIP code."
  else if (!ZIP_PATTERN.test(address.postalCode)) fields[`${prefix}.postalCode`] = "Enter a 5-digit ZIP code."
}

export function collectKapitusFieldErrors(input: unknown): Record<string, string> {
  const fields: Record<string, string> = {}
  const application = readKapitusApplication(input)
  if (!application) {
    fields.application = "Provide the Kapitus application payload."
    return fields
  }

  if (!application.legalName) fields.legalName = "Enter the legal business name."
  if (!application.dbaName) fields.dbaName = "Enter the business DBA."
  requireAddress("address", application.address, fields)
  if (!application.businessEmail) fields.businessEmail = "Enter the business email."
  else if (!EMAIL_PATTERN.test(application.businessEmail)) fields.businessEmail = "Enter a valid business email."
  if (!application.ein) fields.ein = "Enter the Tax ID / EIN."
  else if (!EIN_PATTERN.test(application.ein)) fields.ein = "EIN must contain 9 digits."
  if (!application.industry) fields.industry = "Enter the industry."
  if (!application.entityType) fields.entityType = "Enter the entity type."
  if (!application.startDate) fields.startDate = "Enter the business start date."
  else if (!DATE_PATTERN.test(application.startDate) || Number.isNaN(Date.parse(`${application.startDate}T00:00:00.000Z`))) {
    fields.startDate = "Use a valid start date in YYYY-MM-DD format."
  }
  if (application.annualRevenue == null) fields.annualRevenue = "Enter gross annual revenue."
  else if (application.annualRevenue <= 0) fields.annualRevenue = "Gross annual revenue must be greater than zero."
  if (application.requestedAmount == null) fields.requestedAmount = "Enter the requested funding amount."
  else if (application.requestedAmount <= 0) fields.requestedAmount = "Requested funding amount must be greater than zero."

  const owners = application.owners ?? []
  const primary = selectPrimaryOwner(owners)
  if (!primary) {
    fields["owners.primary"] = "Add the primary owner (highest ownership percentage)."
  } else {
    if (!primary.firstName) fields["owners.primary.firstName"] = "Enter the primary owner's first name."
    if (!primary.lastName) fields["owners.primary.lastName"] = "Enter the primary owner's last name."
    requireAddress("owners.primary.address", primary.address, fields)
    if (!primary.email) fields["owners.primary.email"] = "Enter the primary owner's email."
    else if (!EMAIL_PATTERN.test(primary.email)) fields["owners.primary.email"] = "Enter a valid primary owner email."
    if (!primary.dateOfBirth) fields["owners.primary.dateOfBirth"] = "Enter the primary owner's date of birth."
    else if (!DATE_PATTERN.test(primary.dateOfBirth) || Number.isNaN(Date.parse(`${primary.dateOfBirth}T00:00:00.000Z`))) {
      fields["owners.primary.dateOfBirth"] = "Use a valid date of birth in YYYY-MM-DD format."
    }
    if (!primary.ssn) fields["owners.primary.ssn"] = "Enter the primary owner's Social Security Number."
    else if (!SSN_PATTERN.test(primary.ssn) || digits(primary.ssn).length !== 9) {
      fields["owners.primary.ssn"] = "Enter a 9-digit Social Security Number."
    }
    if (primary.ownershipPercent == null) fields["owners.primary.ownershipPercent"] = "Enter the primary owner's ownership percentage."
    else if (primary.ownershipPercent <= 0 || primary.ownershipPercent > 100) {
      fields["owners.primary.ownershipPercent"] = "Primary owner ownership must be greater than 0 and at most 100%."
    }
  }

  const documents = application.documents ?? []
  if (!documents.some(isSignedApplicationDocument)) {
    fields["documents.signedApplication"] = "Upload a signed application."
  }
  if (!documents.some(isBankStatementDocument)) {
    fields["documents.bankStatements"] = "Upload bank statements."
  }
  return fields
}

export function validateKapitusApplication(input: unknown): { ok: true } | { ok: false; fields: Record<string, string> } {
  const fields = collectKapitusFieldErrors(input)
  return Object.keys(fields).length ? { ok: false, fields } : { ok: true }
}

export function validateKapitusJobDocuments(
  documentVersions: Array<{ documentId: string; checksum: string; category: string }>,
): Record<string, string> {
  const fields: Record<string, string> = {}
  if (!documentVersions.some((document) => document.category === "application")) {
    fields["documents.signedApplication"] = "Upload a signed application."
  }
  if (!documentVersions.some((document) => document.category === "statement")) {
    fields["documents.bankStatements"] = "Upload bank statements."
  }
  return fields
}

export function mapKapitusApplication(input: unknown): KapitusMappedRequest {
  const fields = collectKapitusFieldErrors(input)
  const application = readKapitusApplication(input)
  const primary = application ? selectPrimaryOwner(application.owners ?? []) : undefined
  if (Object.keys(fields).length || !application || !primary) {
    throw new Error("Kapitus application is incomplete.")
  }
  return {
    business: {
      legalName: application.legalName!,
      dbaName: application.dbaName!,
      address: application.address ?? {},
      email: application.businessEmail!,
      ein: application.ein!,
      industry: application.industry!,
      entityType: application.entityType!,
      startDate: application.startDate!,
      annualRevenue: application.annualRevenue!,
      requestedAmount: application.requestedAmount!,
    },
    owner: {
      firstName: primary.firstName!,
      lastName: primary.lastName!,
      email: primary.email!,
      dateOfBirth: primary.dateOfBirth!,
      ssn: primary.ssn!,
      ownershipPercent: primary.ownershipPercent!,
      address: primary.address ?? {},
    },
    documents: (application.documents ?? []).flatMap<KapitusMappedRequest["documents"][number]>((document) => {
      if (isSignedApplicationDocument(document)) {
        return [{ kind: "signed_application" as const, documentId: document.documentId, checksum: document.checksum }]
      }
      if (isBankStatementDocument(document)) {
        return [{ kind: "bank_statement" as const, documentId: document.documentId, checksum: document.checksum }]
      }
      return []
    }),
  }
}

export function kapitusResultContainsSecret(value: unknown, secret: string): boolean {
  if (!secret) return false
  if (typeof value === "string") return value.includes(secret)
  if (Array.isArray(value)) return value.some((item) => kapitusResultContainsSecret(item, secret))
  if (value && typeof value === "object") {
    return Object.entries(value as Record<string, unknown>).some(([key, nested]) => {
      if (/^(ssn|socialSecurityNumber|clientSecret|password|apiKey)$/i.test(key)) return true
      return kapitusResultContainsSecret(nested, secret)
    })
  }
  return false
}
