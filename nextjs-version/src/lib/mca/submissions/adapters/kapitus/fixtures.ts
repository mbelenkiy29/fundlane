import type { AdapterStatusResult } from "../../contracts"
import type { KapitusApplication } from "./mapping"
import { KAPITUS_SLUG } from "./mapping"

export { KAPITUS_SLUG }

export const KAPITUS_FIXTURE_TRANSPORT = "fixture://kapitus/applications"

export const KAPITUS_FIXTURE_SCENARIOS = [
  "accepted",
  "document-receipt",
  "timeout",
  "expired-credential",
  "credit-review",
  "update-requested",
  "incomplete",
  "not-delivered",
  "approved",
  "contract-sent",
  "contract-received",
  "closing",
  "closing-documents-missing",
  "funded",
  "declined",
  "application-expired",
  "unknown",
] as const

export type KapitusFixtureScenario = (typeof KAPITUS_FIXTURE_SCENARIOS)[number]

const SCENARIO_SET = new Set<string>(KAPITUS_FIXTURE_SCENARIOS)

const SCENARIO_ALIASES: Record<string, KapitusFixtureScenario> = {
  expired: "expired-credential",
  expired_credential: "expired-credential",
  "expired-credentials": "expired-credential",
  documents: "document-receipt",
  document_receipt: "document-receipt",
  ack: "accepted",
  received: "accepted",
  "application-received": "accepted",
  expired_application: "application-expired",
  "application-expired": "application-expired",
}

const SCENARIO_STATUS: Record<KapitusFixtureScenario, string> = {
  accepted: "Application Received",
  "document-receipt": "Application Received",
  timeout: "Application Received",
  "expired-credential": "",
  "credit-review": "Credit Review",
  "update-requested": "Update Requested",
  incomplete: "Incomplete",
  "not-delivered": "Not Delivered",
  approved: "Approved",
  "contract-sent": "Contract Sent",
  "contract-received": "Contract Received",
  closing: "Closing",
  "closing-documents-missing": "Closing Documents Missing",
  funded: "Funded",
  declined: "Declined",
  "application-expired": "Expired",
  unknown: "CREDIT_COMMITTEE_HOLD",
}

const APPROVED_TERMS: NonNullable<AdapterStatusResult["terms"]> = {
  amount: 75000,
  rate: 1.35,
  term: 10,
  frequency: "weekly",
  commission: 8,
  offerLink: "https://offers.example.test/kapitus/synthetic-offer",
}

export const kapitusAcceptedApplication: KapitusApplication = {
  legalName: "Harbor Grain Bakery LLC",
  dbaName: "Harbor Grain",
  address: {
    street: "410 Market Street",
    city: "Hoboken",
    state: "NJ",
    postalCode: "07030",
  },
  businessEmail: "ops@harborgrain.example.test",
  ein: "12-3456789",
  industry: "Retail bakeries",
  entityType: "llc",
  startDate: "2019-04-12",
  annualRevenue: 840000,
  requestedAmount: 75000,
  owners: [
    {
      firstName: "Mira",
      lastName: "Khan",
      ownershipPercent: 80,
      isPrimary: true,
      email: "mira@harborgrain.example.test",
      dateOfBirth: "1984-06-20",
      ssn: "000000001",
      address: {
        street: "88 River Road",
        city: "Hoboken",
        state: "NJ",
        postalCode: "07030",
      },
    },
    {
      firstName: "Jonah",
      lastName: "Cole",
      ownershipPercent: 20,
      email: "jonah@harborgrain.example.test",
      dateOfBirth: "1990-01-02",
      ssn: "000000002",
      address: {
        street: "12 Willow Ave",
        city: "Hoboken",
        state: "NJ",
        postalCode: "07030",
      },
    },
  ],
  documents: [
    {
      documentId: "doc-app-1",
      kind: "signed_application",
      category: "application",
      signed: true,
      checksum: "checksum-app",
    },
    {
      documentId: "doc-stmt-1",
      kind: "bank_statement",
      category: "statement",
      checksum: "checksum-stmt",
    },
  ],
}

export function kapitusExternalRef(attemptKey: string): string {
  return `kapitus-app-${attemptKey}`
}

export function kapitusCorrelationId(attemptKey: string): string {
  return `kapitus-${attemptKey}`
}

export function kapitusEventId(attemptKey: string, rawStatus: string): string {
  const token = rawStatus.trim().toLowerCase().replace(/[\s-]+/g, "_").replace(/[^a-z0-9_]/g, "") || "none"
  return `kapitus-evt-${attemptKey}-${token}`
}

export function scenarioStatus(scenario: KapitusFixtureScenario): string {
  return SCENARIO_STATUS[scenario]
}

export function scenarioTerms(scenario: KapitusFixtureScenario): AdapterStatusResult["terms"] | undefined {
  if (scenario === "approved" || scenario === "funded") return { ...APPROVED_TERMS }
  return undefined
}

export function resolveKapitusScenario(destination: string, override?: KapitusFixtureScenario): KapitusFixtureScenario {
  if (override) return override
  const raw = destination.trim().toLowerCase()
  const suffix = raw.startsWith(KAPITUS_SLUG) ? raw.slice(KAPITUS_SLUG.length).replace(/^[:/#._-]+/, "") : raw
  const key = suffix || KAPITUS_SLUG
  if (!key || key === KAPITUS_SLUG) return "accepted"
  if (SCENARIO_SET.has(key)) return key as KapitusFixtureScenario
  return SCENARIO_ALIASES[key] ?? "accepted"
}
