import { FUNDER_ROUTE_KINDS, type FunderRouteKind } from "./contracts"

export const FUNDER_FIELD_LIMITS = {
  legalName: 200,
  nickname: 120,
  website: 300,
  domain: 200,
  product: 80,
  contactName: 120,
  contactEmail: 200,
  contactPhone: 40,
  contactRole: 80,
  routeLabel: 120,
  routeDestination: 500,
  documentException: 80,
  groupName: 120,
  maxDomains: 30,
  maxProducts: 30,
  maxContacts: 50,
  maxRoutes: 20,
  maxDocumentExceptions: 30,
} as const

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export function textValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : ""
}

export function isWebsiteUrl(value: string): boolean {
  try {
    const url = new URL(value.includes("://") ? value : `https://${value}`)
    return (url.protocol === "http:" || url.protocol === "https:") && Boolean(url.hostname.includes("."))
  } catch {
    return false
  }
}

function add(errors: Record<string, string[]>, field: string, message: string) {
  errors[field] = [...(errors[field] ?? []), message]
}

function tooLong(field: string, value: string, max: number, errors: Record<string, string[]>) {
  if (value.length > max) add(errors, field, `Use at most ${max} characters.`)
}

function listValues(value: unknown, field: string, maxItems: number, maxLength: number, errors: Record<string, string[]>): void {
  if (value === undefined) return
  if (!Array.isArray(value)) {
    add(errors, field, "Provide a list of values.")
    return
  }
  if (value.length > maxItems) add(errors, field, `Use at most ${maxItems} values.`)
  for (const [index, entry] of value.entries()) {
    const next = textValue(entry)
    if (next) tooLong(`${field}.${index}`, next, maxLength, errors)
  }
}

export interface FunderProfileInput {
  legalName?: unknown
  nickname?: unknown
  website?: unknown
  domains?: unknown
  products?: unknown
  contacts?: unknown
  routes?: unknown
}

export function validateFunderProfile(
  input: FunderProfileInput,
  options: { requireLegalName?: boolean } = {},
): Record<string, string[]> {
  const errors: Record<string, string[]> = {}
  const legalName = textValue(input.legalName)
  if (options.requireLegalName !== false && (input.legalName !== undefined || options.requireLegalName)) {
    if (!legalName) add(errors, "legalName", "Enter the funder legal name.")
    else tooLong("legalName", legalName, FUNDER_FIELD_LIMITS.legalName, errors)
  } else if (legalName) {
    tooLong("legalName", legalName, FUNDER_FIELD_LIMITS.legalName, errors)
  }

  const nickname = textValue(input.nickname)
  if (nickname) tooLong("nickname", nickname, FUNDER_FIELD_LIMITS.nickname, errors)

  const website = textValue(input.website)
  if (website) {
    tooLong("website", website, FUNDER_FIELD_LIMITS.website, errors)
    if (website.length <= FUNDER_FIELD_LIMITS.website && !isWebsiteUrl(website)) {
      add(errors, "website", "Enter a valid website URL.")
    }
  }

  listValues(input.domains, "domains", FUNDER_FIELD_LIMITS.maxDomains, FUNDER_FIELD_LIMITS.domain, errors)
  listValues(input.products, "products", FUNDER_FIELD_LIMITS.maxProducts, FUNDER_FIELD_LIMITS.product, errors)

  if (input.contacts !== undefined) {
    if (!Array.isArray(input.contacts)) add(errors, "contacts", "Provide a list of contacts.")
    else if (input.contacts.length > FUNDER_FIELD_LIMITS.maxContacts) add(errors, "contacts", "Use at most 50 contacts.")
    else {
      for (const [index, entry] of input.contacts.entries()) {
        const row = entry && typeof entry === "object" && !Array.isArray(entry) ? entry as Record<string, unknown> : {}
        const name = textValue(row.name)
        const email = textValue(row.email)
        const phone = textValue(row.phone)
        const role = textValue(row.role)
        if (name) tooLong(`contacts.${index}.name`, name, FUNDER_FIELD_LIMITS.contactName, errors)
        if (email) {
          tooLong(`contacts.${index}.email`, email, FUNDER_FIELD_LIMITS.contactEmail, errors)
          if (email.length <= FUNDER_FIELD_LIMITS.contactEmail && !EMAIL.test(email)) {
            add(errors, `contacts.${index}.email`, "Enter a valid email address.")
          }
        }
        if (phone) tooLong(`contacts.${index}.phone`, phone, FUNDER_FIELD_LIMITS.contactPhone, errors)
        if (role) tooLong(`contacts.${index}.role`, role, FUNDER_FIELD_LIMITS.contactRole, errors)
      }
    }
  }

  if (input.routes !== undefined) {
    if (!Array.isArray(input.routes)) add(errors, "routes", "Provide a list of routes.")
    else if (input.routes.length > FUNDER_FIELD_LIMITS.maxRoutes) add(errors, "routes", "Use at most 20 routes.")
    else {
      for (const [index, entry] of input.routes.entries()) {
        const row = entry && typeof entry === "object" && !Array.isArray(entry) ? entry as Record<string, unknown> : {}
        const kind = textValue(row.kind)
        const label = textValue(row.label)
        const destination = textValue(row.destination)
        if (!kind && !label && !destination) continue
        if (!FUNDER_ROUTE_KINDS.includes(kind as FunderRouteKind)) {
          add(errors, `routes.${index}.kind`, "Choose email, API, manual portal, or custom webhook.")
        }
        if (!label) add(errors, `routes.${index}.label`, "Enter a route label.")
        else tooLong(`routes.${index}.label`, label, FUNDER_FIELD_LIMITS.routeLabel, errors)
        if (!destination) add(errors, `routes.${index}.destination`, "Enter a route destination.")
        else tooLong(`routes.${index}.destination`, destination, FUNDER_FIELD_LIMITS.routeDestination, errors)
        listValues(
          row.documentExceptions ?? [],
          `routes.${index}.documentExceptions`,
          FUNDER_FIELD_LIMITS.maxDocumentExceptions,
          FUNDER_FIELD_LIMITS.documentException,
          errors,
        )
      }
    }
  }

  return errors
}

export function validateGroupName(name: unknown, options: { required?: boolean } = {}): Record<string, string[]> {
  const errors: Record<string, string[]> = {}
  const next = textValue(name)
  if (options.required !== false && !next) add(errors, "name", "Enter a group name.")
  else if (next) tooLong("name", next, FUNDER_FIELD_LIMITS.groupName, errors)
  return errors
}
