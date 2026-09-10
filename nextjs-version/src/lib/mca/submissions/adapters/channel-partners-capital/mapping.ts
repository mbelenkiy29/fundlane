import "server-only"

import { ENTITY_TYPES } from "../../../deals/schema"
import type { SubmissionJob } from "../../contracts"

const USPS_STATES = new Set([
  "AL", "AK", "AZ", "AR", "CA", "CO", "CT", "DE", "DC", "FL", "GA", "HI", "ID", "IL", "IN", "IA",
  "KS", "KY", "LA", "ME", "MD", "MA", "MI", "MN", "MS", "MO", "MT", "NE", "NV", "NH", "NJ", "NM",
  "NY", "NC", "ND", "OH", "OK", "OR", "PA", "RI", "SC", "SD", "TN", "TX", "UT", "VT", "VA", "WA",
  "WV", "WI", "WY",
])

const ENTITY_LABELS: Record<(typeof ENTITY_TYPES)[number], string> = {
  llc: "LLC",
  corporation: "Corporation",
  s_corporation: "S-Corporation",
  partnership: "Partnership",
  sole_proprietor: "Sole Proprietor",
  nonprofit: "Nonprofit",
  other: "Other",
}

const ENTITY_ALIASES: Record<string, (typeof ENTITY_TYPES)[number]> = {
  llc: "llc",
  corporation: "corporation",
  corp: "corporation",
  s_corporation: "s_corporation",
  "s-corporation": "s_corporation",
  "s corporation": "s_corporation",
  partnership: "partnership",
  sole_proprietor: "sole_proprietor",
  "sole proprietor": "sole_proprietor",
  "sole proprietorship": "sole_proprietor",
  nonprofit: "nonprofit",
  other: "other",
}

export interface ChannelPartnersAddress {
  line1: string
  city: string
  state: string
  postalCode: string
}

export interface ChannelPartnersOwner {
  firstName: string
  lastName: string
  ownershipPercent: number
  isPrimary: boolean
  ssnLast4: string
  phone: string
  email: string
  address: ChannelPartnersAddress
}

export interface ChannelPartnersDocument {
  documentId: string
  category: string
  checksum: string
}

export interface ChannelPartnersApplication {
  legalName: string
  contactPhone: string
  address: ChannelPartnersAddress
  stateOfIncorporation: string
  naicsCode: string
  entityType: (typeof ENTITY_TYPES)[number]
  legalStructure: string
  startDate: string
  primaryOwner: ChannelPartnersOwner
}

export interface ChannelPartnersCapitalRequest {
  workspaceId: string
  dealId: string
  jobId: string
  attemptKey: string
  business: {
    name: string
    phone: string
    address: { street: string; city: string; state: string; postalCode: string }
    stateOfIncorporation: string
    naics: string
    legalStructure: string
    startDate: string
  }
  owner: {
    firstName: string
    lastName: string
    ssnLast4: string
    phone: string
    email: string
    ownershipPercent: number
    address: { street: string; city: string; state: string; postalCode: string }
  }
  documents: ChannelPartnersDocument[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : ""
}

function digits(value: unknown): string {
  return text(value).replace(/\D/g, "")
}

function asNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return undefined
}

function readAddress(value: unknown): Partial<ChannelPartnersAddress> {
  if (!isRecord(value)) return {}
  return {
    line1: text(value.line1) || text(value.street),
    city: text(value.city),
    state: text(value.state).toUpperCase(),
    postalCode: text(value.postalCode) || text(value.zip) || text(value.zipCode),
  }
}

function missingAddressFields(prefix: string, address: Partial<ChannelPartnersAddress>, fields: Record<string, string>): void {
  if (!address.line1) fields[`${prefix}.line1`] = "Enter a street address."
  if (!address.city) fields[`${prefix}.city`] = "Enter a city."
  if (!address.state || !USPS_STATES.has(address.state)) fields[`${prefix}.state`] = "Enter a two-letter US state."
  if (!address.postalCode) fields[`${prefix}.postalCode`] = "Enter a postal code."
}

function completeAddress(address: Partial<ChannelPartnersAddress>): ChannelPartnersAddress | undefined {
  if (!address.line1 || !address.city || !address.state || !USPS_STATES.has(address.state) || !address.postalCode) return undefined
  return {
    line1: address.line1,
    city: address.city,
    state: address.state,
    postalCode: address.postalCode,
  }
}

function entityTypeOf(value: unknown): (typeof ENTITY_TYPES)[number] | undefined {
  const raw = text(value).toLowerCase().replace(/[_-]+/g, " ").trim()
  if (!raw) return undefined
  const compact = raw.replace(/\s+/g, "_")
  if ((ENTITY_TYPES as readonly string[]).includes(compact)) return compact as (typeof ENTITY_TYPES)[number]
  return ENTITY_ALIASES[raw] ?? ENTITY_ALIASES[compact]
}

function ssnLast4Of(owner: Record<string, unknown>): string | undefined {
  const ssn = digits(owner.ssn || owner.socialSecurityNumber)
  if (ssn.length === 9) return ssn.slice(-4)
  if (ssn.length === 4) return ssn
  const last4 = digits(owner.identityLast4)
  return last4.length === 4 ? last4 : undefined
}

interface RawOwner {
  firstName: string
  lastName: string
  ownershipPercent?: number
  isPrimary: boolean
  ssnLast4?: string
  phone: string
  email: string
  address: Partial<ChannelPartnersAddress>
  source: Record<string, unknown>
}

function readOwners(value: unknown): RawOwner[] {
  if (!Array.isArray(value)) return []
  return value.filter(isRecord).map((owner) => ({
    firstName: text(owner.firstName),
    lastName: text(owner.lastName),
    ownershipPercent: asNumber(owner.ownershipPercent),
    isPrimary: owner.isPrimary === true,
    ssnLast4: ssnLast4Of(owner),
    phone: text(owner.phone),
    email: text(owner.email),
    address: readAddress(owner.address),
    source: owner,
  }))
}

export function selectPrimaryOwner(owners: RawOwner[]): RawOwner | undefined {
  const primaries = owners.filter((owner) => owner.isPrimary)
  if (primaries.length === 1) return primaries[0]
  if (primaries.length > 1) return undefined
  if (!owners.length) return undefined
  return [...owners].sort((left, right) => (right.ownershipPercent ?? -1) - (left.ownershipPercent ?? -1))[0]
}

export function documentsFromJob(job: SubmissionJob): ChannelPartnersDocument[] {
  const allowed = new Set(job.packageDocumentIds)
  const selected = allowed.size
    ? job.documentVersions.filter((document) => allowed.has(document.documentId))
    : job.documentVersions
  return selected.map((document) => ({
    documentId: document.documentId,
    category: document.category,
    checksum: document.checksum,
  }))
}

export function validateChannelPartnersApplication(
  input: unknown,
): { ok: true; value: ChannelPartnersApplication } | { ok: false; fields: Record<string, string> } {
  if (!isRecord(input)) {
    return { ok: false, fields: { application: "Provide the merchant application." } }
  }
  const fields: Record<string, string> = {}
  const legalName = text(input.legalName) || text(input.businessName)
  if (!legalName) fields.legalName = "Enter the legal business name."
  const contactPhone = text(input.contactPhone) || text(input.businessPhone)
  if (!contactPhone) fields.contactPhone = "Enter the business phone number."
  const address = readAddress(input.address)
  missingAddressFields("address", address, fields)
  const stateOfIncorporation = text(input.stateOfIncorporation || input.incorporationState).toUpperCase()
  if (!stateOfIncorporation || !USPS_STATES.has(stateOfIncorporation)) {
    fields.stateOfIncorporation = "Enter the two-letter state of incorporation."
  }
  const naicsCode = digits(input.naicsCode || input.naics)
  if (!/^\d{6}$/.test(naicsCode)) fields.naicsCode = "Enter a 6-digit NAICS code."
  const entityType = entityTypeOf(input.entityType || input.legalStructure)
  if (!entityType) fields.entityType = "Choose a legal structure."
  const startDate = text(input.startDate)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate) || Number.isNaN(Date.parse(`${startDate}T00:00:00.000Z`))) {
    fields.startDate = "Enter the business start date as YYYY-MM-DD."
  }

  const owners = readOwners(input.owners)
  const primaries = owners.filter((owner) => owner.isPrimary)
  if (primaries.length > 1) fields.owners = "Only one primary owner is allowed."
  const selected = selectPrimaryOwner(owners)
  if (!selected) {
    fields.primaryOwner = "Add a primary owner with first name, last name, and ownership percentage."
  } else {
    if (!selected.firstName) fields["primaryOwner.firstName"] = "Enter the primary owner's first name."
    if (!selected.lastName) fields["primaryOwner.lastName"] = "Enter the primary owner's last name."
    if (selected.ownershipPercent === undefined || selected.ownershipPercent < 0 || selected.ownershipPercent > 100) {
      fields["primaryOwner.ownershipPercent"] = "Enter the primary owner's ownership percentage."
    }
    if (!selected.ssnLast4) fields["primaryOwner.ssn"] = "Enter the primary owner's Social Security Number or last four digits."
    if (!selected.phone) fields["primaryOwner.phone"] = "Enter the primary owner's phone number."
    if (!selected.email || !/^\S+@\S+\.\S+$/.test(selected.email)) {
      fields["primaryOwner.email"] = "Enter the primary owner's email address."
    }
    missingAddressFields("primaryOwner.address", selected.address, fields)
  }

  const completedAddress = completeAddress(address)
  const ownerAddress = selected ? completeAddress(selected.address) : undefined
  if (
    Object.keys(fields).length
    || !selected
    || !completedAddress
    || !ownerAddress
    || !entityType
    || selected.ownershipPercent === undefined
    || !selected.ssnLast4
  ) {
    return { ok: false, fields }
  }

  return {
    ok: true,
    value: {
      legalName,
      contactPhone,
      address: completedAddress,
      stateOfIncorporation,
      naicsCode,
      entityType,
      legalStructure: ENTITY_LABELS[entityType],
      startDate,
      primaryOwner: {
        firstName: selected.firstName,
        lastName: selected.lastName,
        ownershipPercent: selected.ownershipPercent,
        isPrimary: selected.isPrimary || owners.length === 1,
        ssnLast4: selected.ssnLast4,
        phone: selected.phone,
        email: selected.email,
        address: ownerAddress,
      },
    },
  }
}

export function mapChannelPartnersCapitalRequest(
  application: ChannelPartnersApplication,
  job: SubmissionJob,
  documents = documentsFromJob(job),
): ChannelPartnersCapitalRequest {
  const owner = application.primaryOwner
  return {
    workspaceId: job.workspaceId,
    dealId: job.dealId,
    jobId: job.id,
    attemptKey: job.attemptKey,
    business: {
      name: application.legalName,
      phone: application.contactPhone,
      address: {
        street: application.address.line1,
        city: application.address.city,
        state: application.address.state,
        postalCode: application.address.postalCode,
      },
      stateOfIncorporation: application.stateOfIncorporation,
      naics: application.naicsCode,
      legalStructure: application.legalStructure,
      startDate: application.startDate,
    },
    owner: {
      firstName: owner.firstName,
      lastName: owner.lastName,
      ssnLast4: owner.ssnLast4,
      phone: owner.phone,
      email: owner.email,
      ownershipPercent: owner.ownershipPercent,
      address: {
        street: owner.address.line1,
        city: owner.address.city,
        state: owner.address.state,
        postalCode: owner.address.postalCode,
      },
    },
    documents,
  }
}
