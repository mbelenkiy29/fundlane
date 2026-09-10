import "server-only"

import type { AdapterSubmitResult, SubmissionJob } from "../../contracts"
import type { ChannelPartnersCapitalRequest, ChannelPartnersDocument } from "./mapping"

export const CHANNEL_PARTNERS_CAPITAL_SLUG = "channel-partners-capital"

export const CHANNEL_PARTNERS_CAPITAL_FIXTURES = [
  "accepted",
  "missing-fields",
  "timeout",
  "expired",
  "documents",
] as const

export type ChannelPartnersCapitalFixture = (typeof CHANNEL_PARTNERS_CAPITAL_FIXTURES)[number]

export const CHANNEL_PARTNERS_CAPITAL_EXPIRED_API_KEY = "cpc-expired-credential"

export const CHANNEL_PARTNERS_CAPITAL_ACCEPTED_APPLICATION = {
  legalName: "Harbor Line Kitchen LLC",
  contactPhone: "2125550100",
  address: {
    line1: "100 Example Avenue",
    city: "New York",
    state: "NY",
    postalCode: "10001",
  },
  stateOfIncorporation: "DE",
  naicsCode: "722511",
  entityType: "llc",
  startDate: "2019-04-12",
  owners: [
    {
      firstName: "Ava",
      lastName: "Ramirez",
      ownershipPercent: 60,
      isPrimary: true,
      identityLast4: "0001",
      phone: "2125550101",
      email: "ava.ramirez@example.test",
      address: {
        line1: "12 Owner Lane",
        city: "Hoboken",
        state: "NJ",
        postalCode: "07030",
      },
    },
    {
      firstName: "Noah",
      lastName: "Chen",
      ownershipPercent: 40,
      isPrimary: false,
      identityLast4: "0002",
      phone: "2125550102",
      email: "noah.chen@example.test",
      address: {
        line1: "44 Partner Street",
        city: "Jersey City",
        state: "NJ",
        postalCode: "07302",
      },
    },
  ],
} as const

export const CHANNEL_PARTNERS_CAPITAL_MISSING_FIELDS_APPLICATION = {
  legalName: "Harbor Line Kitchen LLC",
  contactPhone: "2125550100",
  address: {
    line1: "100 Example Avenue",
    city: "New York",
    state: "NY",
    postalCode: "10001",
  },
  entityType: "llc",
  startDate: "2019-04-12",
} as const

export interface ChannelPartnersCapitalResponse {
  accountId: string
  status: "Sent"
  documents: Array<ChannelPartnersDocument & { received: true }>
}

export interface ChannelPartnersCapitalSubmissionRecord {
  request: ChannelPartnersCapitalRequest
  response: ChannelPartnersCapitalResponse
  result: AdapterSubmitResult
}

let fixtureOverride: ChannelPartnersCapitalFixture | undefined
const acceptedByAttemptKey = new Map<string, ChannelPartnersCapitalSubmissionRecord>()
let lastSubmission: ChannelPartnersCapitalSubmissionRecord | undefined

export function setChannelPartnersCapitalFixtureForTests(value?: ChannelPartnersCapitalFixture): void {
  fixtureOverride = value
}

export function resetChannelPartnersCapitalAdapterForTests(): void {
  fixtureOverride = undefined
  acceptedByAttemptKey.clear()
  lastSubmission = undefined
}

export function lastChannelPartnersCapitalSubmission(): ChannelPartnersCapitalSubmissionRecord | undefined {
  return lastSubmission
}

export function rememberChannelPartnersCapitalSubmission(record: ChannelPartnersCapitalSubmissionRecord): void {
  lastSubmission = record
  acceptedByAttemptKey.set(record.request.attemptKey, record)
}

export function acceptedChannelPartnersCapitalSubmission(attemptKey: string): ChannelPartnersCapitalSubmissionRecord | undefined {
  return acceptedByAttemptKey.get(attemptKey)
}

function isFixture(value: string): value is ChannelPartnersCapitalFixture {
  return (CHANNEL_PARTNERS_CAPITAL_FIXTURES as readonly string[]).includes(value)
}

export function resolveChannelPartnersCapitalFixture(job: SubmissionJob): ChannelPartnersCapitalFixture {
  if (fixtureOverride) return fixtureOverride
  const destination = job.route.destination.trim().toLowerCase()
  if (destination.startsWith(CHANNEL_PARTNERS_CAPITAL_SLUG)) {
    const suffix = destination.slice(CHANNEL_PARTNERS_CAPITAL_SLUG.length).replace(/^[:/#]+/, "")
    if (isFixture(suffix)) return suffix
  }
  const attemptSuffix = job.attemptKey.trim().toLowerCase().split(":")[0]
  if (isFixture(attemptSuffix)) return attemptSuffix
  return "accepted"
}

export function applicationForChannelPartnersCapitalFixture(fixture: ChannelPartnersCapitalFixture) {
  return fixture === "missing-fields"
    ? CHANNEL_PARTNERS_CAPITAL_MISSING_FIELDS_APPLICATION
    : CHANNEL_PARTNERS_CAPITAL_ACCEPTED_APPLICATION
}

export function accountIdForAttempt(attemptKey: string): string {
  return `CPC-ACC-${attemptKey.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 48) || "application"}`
}

export function documentReceiptsField(documents: ChannelPartnersDocument[]): string {
  return documents.map((document) => `${document.documentId}:${document.category}`).join(";")
}
