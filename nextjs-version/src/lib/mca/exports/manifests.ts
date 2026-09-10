import { PAYMENT_EXPORT_DENIED_KEYS, type ExportField, type ExportFieldManifest, type ExportKind } from "./contracts"

const dealsFields = [
  { key: "dealId", header: "Deal ID", identifier: true },
  { key: "displayId", header: "Display ID", identifier: true },
  { key: "legalName", header: "Legal name" },
  { key: "dbaName", header: "DBA name" },
  { key: "status", header: "Status" },
  { key: "requestedAmount", header: "Requested amount" },
  { key: "monthlyRevenue", header: "Monthly revenue" },
  { key: "createdAt", header: "Created at" },
  { key: "updatedAt", header: "Updated at" },
  { key: "draftState", header: "Draft state" },
  { key: "funderNames", header: "Funders" },
  { key: "originatorMembershipIds", header: "Originator membership IDs", identifier: true },
  { key: "closerMembershipIds", header: "Closer membership IDs", identifier: true },
  { key: "contactName", header: "Contact name" },
  { key: "contactEmail", header: "Contact email" },
  { key: "contactPhone", header: "Contact phone" },
  { key: "primaryOwnerName", header: "Primary owner name" },
] as const satisfies readonly ExportField[]

const offersFields = [
  { key: "offerId", header: "Offer ID", identifier: true },
  { key: "dealId", header: "Deal ID", identifier: true },
  { key: "displayId", header: "Display ID", identifier: true },
  { key: "legalName", header: "Legal name" },
  { key: "funderName", header: "Funder" },
  { key: "source", header: "Source" },
  { key: "amountCents", header: "Amount (cents)" },
  { key: "factorRate", header: "Factor rate" },
  { key: "termMonths", header: "Term (months)" },
  { key: "paymentAmountCents", header: "Payment amount (cents)" },
  { key: "paymentFrequency", header: "Payment frequency" },
  { key: "product", header: "Product" },
  { key: "revisionState", header: "Revision state" },
  { key: "selected", header: "Selected" },
  { key: "createdAt", header: "Created at" },
] as const satisfies readonly ExportField[]

const ownerSlot = (index: number): ExportField[] => {
  const n = String(index)
  return [
    { key: `owner${n}FirstName`, header: `Owner ${n} first name` },
    { key: `owner${n}LastName`, header: `Owner ${n} last name` },
    { key: `owner${n}Email`, header: `Owner ${n} email` },
    { key: `owner${n}Phone`, header: `Owner ${n} phone` },
    { key: `owner${n}IdentityLast4`, header: `Owner ${n} identity last 4`, identifier: true },
    { key: `owner${n}DateOfBirth`, header: `Owner ${n} date of birth` },
    { key: `owner${n}OwnershipPercent`, header: `Owner ${n} ownership %` },
    { key: `owner${n}IsPrimary`, header: `Owner ${n} primary` },
  ]
}

const allDealsOwnersFields = [
  { key: "dealId", header: "Deal ID", identifier: true },
  { key: "displayId", header: "Display ID", identifier: true },
  { key: "legalName", header: "Company name" },
  { key: "dbaName", header: "DBA" },
  { key: "ein", header: "EIN", identifier: true },
  { key: "entityType", header: "Legal structure" },
  { key: "contactName", header: "Business contact name" },
  { key: "contactEmail", header: "Business email" },
  { key: "contactPhone", header: "Business phone" },
  { key: "addressLine1", header: "Street" },
  { key: "addressCity", header: "City" },
  { key: "addressState", header: "State" },
  { key: "addressPostalCode", header: "Postal code", identifier: true },
  { key: "monthlyRevenue", header: "Monthly revenue" },
  { key: "requestedAmount", header: "Amount requested" },
  { key: "status", header: "Deal status" },
  { key: "createdAt", header: "Created at" },
  { key: "ficoScore", header: "Deal FICO score" },
  { key: "fundingPurpose", header: "Purpose of funds" },
  { key: "industry", header: "Industry" },
  { key: "naicsCode", header: "NAICS", identifier: true },
  { key: "startDate", header: "Business start date" },
  { key: "primaryOriginatorMembershipId", header: "Primary originator membership ID", identifier: true },
  { key: "primaryOriginatorName", header: "Primary originator" },
  { key: "ownerCount", header: "Owner count" },
  ...ownerSlot(1),
  ...ownerSlot(2),
  ...ownerSlot(3),
  ...ownerSlot(4),
  ...ownerSlot(5),
] as const satisfies readonly ExportField[]

const fundedDealsFields = [
  { key: "dealId", header: "Deal ID", identifier: true },
  { key: "displayId", header: "Display ID", identifier: true },
  { key: "legalName", header: "Company name" },
  { key: "dbaName", header: "DBA" },
  { key: "dealStatus", header: "Deal status" },
  { key: "fundingEventId", header: "Funding event ID", identifier: true },
  { key: "offerId", header: "Offer ID", identifier: true },
  { key: "advanceId", header: "Advance ID", identifier: true },
  { key: "funderName", header: "Funder" },
  { key: "fundedAt", header: "Funded at" },
  { key: "fundedAmountCents", header: "Funded amount (cents)" },
  { key: "fundingSource", header: "Funding source" },
  { key: "fundingState", header: "Funding state" },
  { key: "primaryOriginatorMembershipId", header: "Primary originator membership ID", identifier: true },
] as const satisfies readonly ExportField[]

export const FIELD_MANIFESTS: Record<ExportKind, ExportFieldManifest> = {
  deals: {
    kind: "deals",
    label: "Visible deals",
    description: "Role-scoped Deals table export. Same authorized query as the Deals screen. Omits payments, commissions, EIN, and owner identity fields.",
    fields: dealsFields,
    isPaymentExport: false,
  },
  offers: {
    kind: "offers",
    label: "Visible offers",
    description: "Role-scoped Offers table export for deals the actor can see. Omits commissions, buy rate, fees, and ledger rows.",
    fields: offersFields,
    isPaymentExport: false,
  },
  all_deals_owners: {
    kind: "all_deals_owners",
    label: "All deals and owners",
    description: "Admin workspace export of every deal and up to five owners. Explicit field manifest. Not a payment export.",
    fields: allDealsOwnersFields,
    isPaymentExport: false,
  },
  funded_deals: {
    kind: "funded_deals",
    label: "Funded deals",
    description: "Admin workspace export of committed funding events. Includes funded amount and date, not ledger or distribution rows.",
    fields: fundedDealsFields,
    isPaymentExport: false,
  },
}

export const OWNER_SLOT_COUNT = 5

export function manifestFor(kind: ExportKind): ExportFieldManifest {
  return FIELD_MANIFESTS[kind]
}

export function assertManifestOmitsPayments(kind: ExportKind): void {
  const denied = new Set<string>(PAYMENT_EXPORT_DENIED_KEYS)
  for (const field of FIELD_MANIFESTS[kind].fields) {
    if (denied.has(field.key)) throw new Error(`Export manifest ${kind} includes payment field ${field.key}.`)
  }
}

for (const kind of Object.keys(FIELD_MANIFESTS) as ExportKind[]) assertManifestOmitsPayments(kind)
