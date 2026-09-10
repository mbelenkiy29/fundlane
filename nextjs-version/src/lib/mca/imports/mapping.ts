import type { DealWriteInput, EntityType } from "../deals/schema"
import { ENTITY_TYPES } from "../deals/schema"
import type { ImportableField } from "./contracts"
import { IMPORTABLE_FIELDS } from "./contracts"

const aliases: Record<string, ImportableField> = {
  legalname: "legalName", businessname: "legalName", merchantname: "legalName", company: "legalName",
  dba: "dbaName", dbaname: "dbaName", ein: "ein", taxid: "ein", entitytype: "entityType",
  contact: "contactName", contactname: "contactName", email: "contactEmail", contactemail: "contactEmail",
  phone: "contactPhone", contactphone: "contactPhone", startdate: "startDate", industry: "industry", naics: "naicsCode",
  monthlyrevenue: "monthlyRevenue", revenue: "monthlyRevenue", fico: "ficoScore", credit: "ficoScore",
  fundingpurpose: "fundingPurpose", requestedamount: "requestedAmount", amountrequested: "requestedAmount",
  address: "address.line1", address1: "address.line1", address2: "address.line2", city: "address.city", state: "address.state",
  zipcode: "address.postalCode", postalcode: "address.postalCode", originator: "originatorMembershipId", repid: "originatorMembershipId",
}

export function normalizeHeader(value: string): string { return value.normalize("NFKC").toLocaleLowerCase().replace(/[^a-z0-9]/g, "") }

export function heuristicMapping(headers: string[]): { mapping: Record<string, ImportableField>; confidence: Record<string, number> } {
  const mapping: Record<string, ImportableField> = {}
  const confidence: Record<string, number> = {}
  for (const header of headers) {
    const field = aliases[normalizeHeader(header)]
    if (field) { mapping[header] = field; confidence[header] = 0.72 }
  }
  return { mapping, confidence }
}

function numberValue(raw: string): number | undefined {
  if (!raw.trim()) return undefined
  const parsed = Number(raw.replace(/[$,%\s,]/g, ""))
  return Number.isFinite(parsed) ? parsed : undefined
}

function entityValue(raw: string): EntityType | undefined {
  const normalized = raw.trim().toLocaleLowerCase().replace(/[ .-]+/g, "_")
  if (ENTITY_TYPES.includes(normalized as EntityType)) return normalized as EntityType
  if (normalized === "corp" || normalized === "c_corp") return "corporation"
  if (normalized === "s_corp") return "s_corporation"
  if (normalized === "sole_prop") return "sole_proprietor"
  return undefined
}

export function mapRow(headers: string[], row: string[], mapping: Record<string, ImportableField>): {
  application: DealWriteInput; sourceValues: Record<string, string>; explicitOriginator?: string; errors: string[]
} {
  const application: DealWriteInput = { fieldSource: "import" }
  const address: NonNullable<DealWriteInput["address"]> = {}
  const errors: string[] = []
  const sourceValues: Record<string, string> = {}
  let explicitOriginator: string | undefined
  for (const [index, header] of headers.entries()) {
    const field = mapping[header]
    const raw = row[index]?.trim() ?? ""
    sourceValues[header] = raw
    if (!field || !raw) continue
    if (field === "originatorMembershipId") { explicitOriginator = raw; continue }
    if (field.startsWith("address.")) { address[field.slice(8) as keyof typeof address] = raw; continue }
    if (["monthlyRevenue", "requestedAmount", "ficoScore"].includes(field)) {
      const value = numberValue(raw)
      if (value === undefined) errors.push(`${header} must be a number.`)
      else Object.assign(application, { [field]: value })
      continue
    }
    if (field === "entityType") {
      const value = entityValue(raw)
      if (!value) errors.push(`${header} has an unsupported entity type.`)
      else application.entityType = value
      continue
    }
    Object.assign(application, { [field]: raw })
  }
  if (Object.keys(address).length) application.address = address
  if (!application.legalName?.trim() && !application.dbaName?.trim()) errors.push("A legal name or DBA name is required.")
  return { application, sourceValues, explicitOriginator, errors }
}

export function assertMapping(mapping: Record<string, string>, headers: string[]): Record<string, ImportableField> {
  const allowed = new Set<string>(IMPORTABLE_FIELDS)
  const result: Record<string, ImportableField> = {}
  for (const [header, field] of Object.entries(mapping)) {
    if (!headers.includes(header) || !allowed.has(field)) continue
    if (Object.values(result).includes(field as ImportableField) && field !== "originatorMembershipId") continue
    result[header] = field as ImportableField
  }
  return result
}
