import test, { beforeEach } from "node:test"
import assert from "node:assert/strict"
import type { AdapterRuntime } from "../../src/lib/mca/submissions/adapters/contracts"
import { runWithAdapterRuntime } from "../../src/lib/mca/submissions/adapters/credentials"
import type { SubmissionJob } from "../../src/lib/mca/submissions/contracts"
import {
  bindOnDeckApplication,
  EXPIRED_CREDENTIAL_TOKEN,
  fixtureSubmitCallCount,
  listFixtureExternalRefs,
  mapProviderStatus,
  ONDECK_FIXTURE_TRANSPORT,
  ONDECK_SLUG,
  ondeckAdapter,
  ondeckAppId,
  ondeckPortalUrl,
  peekFixture,
  PROVIDER_STATUS_MAP,
  resetOnDeckFixtures,
  setOnDeckFixture,
  submittedAverageDailyBalance,
  SYNTHETIC_OFFER_TERMS,
} from "../../src/lib/mca/submissions/adapters/ondeck"

const SSN = "123456789"
const API_KEY = "ondeck-development-api-key-never-leak"
const USERNAME = "ondeck-dev-user-never-leak"
const PASSWORD = "ondeck-dev-password-never-leak"

function owner(overrides: Record<string, unknown> = {}) {
  return {
    firstName: "Alex",
    lastName: "Rivera",
    ownershipPercent: 60,
    isPrimary: true,
    dateOfBirth: "1984-04-12",
    ssn: SSN,
    email: "alex.rivera@merchant.example",
    phone: "2125550101",
    address: { line1: "10 Owner Way", city: "New York", state: "NY", postalCode: "10001" },
    ...overrides,
  }
}

function statements(overrides: Array<Record<string, unknown>> | undefined = undefined) {
  return overrides ?? [
    { period: "2026-01", totalRevenue: 48000, averageDailyBalance: 3200 },
    { period: "2026-02", deposits: { value: 51000, unknown: false, confidence: 1 }, averageDailyBalance: { value: 4100, unknown: false, confidence: 1 } },
  ]
}

function application(overrides: Record<string, unknown> = {}) {
  return {
    legalName: "Harbor Coffee LLC",
    dbaName: "Harbor Coffee",
    ein: "12-3456789",
    entityType: "llc",
    industry: "Food Services",
    startDate: "2019-06-01",
    contactPhone: "2125550199",
    address: { line1: "100 Front Street", city: "New York", state: "NY", postalCode: "10004" },
    owners: [owner()],
    statements: statements(),
    ...overrides,
  }
}

function job(overrides: Partial<SubmissionJob> = {}): SubmissionJob {
  return {
    id: overrides.id ?? "job-ondeck-1",
    workspaceId: overrides.workspaceId ?? "workspace-ondeck",
    dealId: overrides.dealId ?? "deal-ondeck-1",
    funderId: overrides.funderId ?? "funder-ondeck-1",
    displayFunderName: overrides.displayFunderName ?? "OnDeck",
    routeKind: "api",
    route: overrides.route ?? {
      id: "route-ondeck",
      kind: "api",
      label: "API",
      destination: ONDECK_SLUG,
      documentExceptions: [],
      active: true,
    },
    state: overrides.state ?? "sending",
    confirmationKey: overrides.confirmationKey ?? "conf-ondeck-1",
    attemptKey: overrides.attemptKey ?? "attempt-ondeck-1",
    dealVersion: overrides.dealVersion ?? 1,
    documentVersions: overrides.documentVersions ?? [],
    packageDocumentIds: overrides.packageDocumentIds ?? [],
    preflightErrors: overrides.preflightErrors ?? [],
    createdAt: overrides.createdAt ?? "2026-01-01T00:00:00.000Z",
    updatedAt: overrides.updatedAt ?? "2026-01-01T00:00:00.000Z",
    ...overrides,
  }
}

function runtime(secrets: AdapterRuntime["secrets"], correlationId = "corr-ondeck-1"): AdapterRuntime {
  return {
    credentialId: "cred-ondeck-1",
    workspaceId: "workspace-ondeck",
    funderId: "funder-ondeck-1",
    adapterSlug: ONDECK_SLUG,
    environment: "development",
    capabilities: ondeckAdapter.capabilities,
    secrets,
    correlationId,
  }
}

function developmentSecrets(): AdapterRuntime["secrets"] {
  return { apiKey: API_KEY, username: USERNAME, password: PASSWORD }
}

function assertNoSecrets(value: unknown) {
  const text = typeof value === "string" ? value : JSON.stringify(value)
  assert.equal(text.includes(API_KEY), false)
  assert.equal(text.includes(USERNAME), false)
  assert.equal(text.includes(PASSWORD), false)
  assert.equal(text.includes(EXPIRED_CREDENTIAL_TOKEN), false)
  assert.equal(text.includes(SSN), false)
}

beforeEach(() => {
  resetOnDeckFixtures()
})

test("MIC-144: required-field rejection", () => {
  const empty = ondeckAdapter.validate({})
  assert.equal(empty.ok, false)
  if (empty.ok) throw new Error("expected field errors")
  assert.equal(empty.fields.legalName, "Business name is required.")
  assert.equal(empty.fields.ein, "EIN / Tax ID is required.")
  assert.equal(empty.fields.industry, "Industry is required.")
  assert.equal(empty.fields.entityType, "Entity type is required.")
  assert.equal(empty.fields.phone, "Business phone is required.")
  assert.equal(empty.fields.owners, "At least one business owner is required.")
  assert.equal(empty.fields.statements, "At least one statement with revenue and average daily balance is required.")
  assert.equal(empty.fields["documents.application"], undefined)
  assert.equal(empty.fields["documents.bankStatements"], undefined)

  const missingAdb = ondeckAdapter.validate(application({
    statements: [{ period: "2026-01", revenue: 48000 }],
  }))
  assert.equal(missingAdb.ok, false)
  if (missingAdb.ok) throw new Error("expected average daily balance error")
  assert.equal(missingAdb.fields["statements.0.averageDailyBalance"], "Statement average daily balance is required.")

  const missingRevenue = ondeckAdapter.validate(application({
    statements: [{ period: "2026-01", averageDailyBalance: 3200 }],
  }))
  assert.equal(missingRevenue.ok, false)
  if (missingRevenue.ok) throw new Error("expected revenue error")
  assert.equal(missingRevenue.fields["statements.0.revenue"], "Statement revenue is required.")

  const unknownMetric = ondeckAdapter.validate(application({
    statements: [{ period: "2026-01", revenue: 48000, averageDailyBalance: { value: null, unknown: true, confidence: 0 } }],
  }))
  assert.equal(unknownMetric.ok, false)
  if (unknownMetric.ok) throw new Error("expected unknown average daily balance error")
  assert.equal(unknownMetric.fields["statements.0.averageDailyBalance"], "Statement average daily balance is required.")

  const fromAggregate = ondeckAdapter.validate(application({
    statements: undefined,
    monthlyRevenue: 45000,
    averageDailyBalance: 0,
  }))
  assert.equal(fromAggregate.ok, true)

  const negativeAdb = ondeckAdapter.validate(application({
    statements: [{ period: "2026-01", revenue: 48000, averageDailyBalance: -250.5 }],
  }))
  assert.equal(negativeAdb.ok, true)
  assert.equal(submittedAverageDailyBalance(-250.5), 0)
  assert.equal(submittedAverageDailyBalance(4100), 4100)

  const missingOwnerPhone = ondeckAdapter.validate(application({
    owners: [owner({ phone: "" })],
  }))
  assert.equal(missingOwnerPhone.ok, false)
  if (missingOwnerPhone.ok) throw new Error("expected owner phone error")
  assert.equal(missingOwnerPhone.fields["owners.0.phone"], "Owner phone is required.")

  const invalid = ondeckAdapter.validate(application({
    ein: "12-345",
    owners: [owner({ ssn: "1234", firstName: "", ownershipPercent: undefined, dateOfBirth: "", phone: "555" })],
    statements: [{ period: "January", revenue: -1, averageDailyBalance: -10 }],
  }))
  assert.equal(invalid.ok, false)
  if (invalid.ok) throw new Error("expected invalid field errors")
  assert.equal(invalid.fields.ein, "EIN must contain 9 digits.")
  assert.equal(invalid.fields["owners.0.firstName"], "Owner first name is required.")
  assert.equal(invalid.fields["owners.0.ssn"], "Owner SSN must contain 9 digits.")
  assert.equal(invalid.fields["owners.0.dateOfBirth"], "Owner date of birth is required.")
  assert.equal(invalid.fields["owners.0.ownershipPercent"], "Owner ownership percentage is required.")
  assert.equal(invalid.fields["owners.0.phone"], "Owner phone must include at least 10 digits.")
  assert.equal(invalid.fields["statements.0.period"], "Use a statement period in YYYY-MM or YYYY-MM-DD format.")
  assert.equal(invalid.fields["statements.0.revenue"], "Statement revenue must be 0 or greater.")
  assert.equal(invalid.fields["statements.0.averageDailyBalance"], undefined)
  assert.equal(ondeckAdapter.validate(application({ documents: undefined })).ok, true)
})

test("MIC-144: accepted submission returns App ID, portal link, and offer-capable flags", async () => {
  assert.equal(ondeckAdapter.slug, "ondeck")
  assert.deepEqual(ondeckAdapter.capabilities, {
    submit: true,
    statusPoll: true,
    webhooks: false,
    offers: true,
  })
  assert.equal(typeof ondeckAdapter.getStatus, "function")
  assert.equal(ondeckAdapter.parseWebhook, undefined)
  assert.equal(ONDECK_FIXTURE_TRANSPORT.startsWith("fixture://"), true)

  const payload = application({
    statements: [{ period: "2026-01", revenue: 48000, averageDailyBalance: -125.5 }],
  })
  bindOnDeckApplication("attempt-ondeck-1", payload)
  const submitted = await runWithAdapterRuntime(runtime(developmentSecrets()), () => ondeckAdapter.submit(job()))
  assert.equal(submitted.ok, true)
  assert.equal(submitted.correlationId, "corr-ondeck-1")
  assert.equal(submitted.externalRef, ondeckAppId("attempt-ondeck-1"))
  assert.equal(submitted.rawStatus, "Application Received")
  assert.equal(submitted.fields?.appId, "ondeck_attempt-ondeck-1")
  assert.equal(submitted.fields?.portalUrl, ondeckPortalUrl("ondeck_attempt-ondeck-1"))
  assert.equal(mapProviderStatus(submitted.rawStatus ?? "").normalized, "submitted")
  assertNoSecrets(submitted)

  const stored = peekFixture("attempt-ondeck-1")
  assert.ok(stored)
  assert.equal(stored.mapped?.legalName, "Harbor Coffee LLC")
  assert.equal(stored.mapped?.entityType, "llc")
  assert.deepEqual(stored.mapped?.owners, [
    { firstName: "Alex", lastName: "Rivera", ownershipPercent: 60, phone: "2125550101" },
  ])
  assert.deepEqual(stored.mapped?.statements, [
    {
      period: "2026-01",
      revenue: 48000,
      averageDailyBalance: -125.5,
      submittedAverageDailyBalance: 0,
      negativeBalanceClamped: true,
    },
  ])
  assert.equal((payload.statements as Array<{ averageDailyBalance: number }>)[0].averageDailyBalance, -125.5)
  assert.equal(JSON.stringify(stored.mapped).includes(SSN), false)

  const status = await runWithAdapterRuntime(runtime(developmentSecrets(), "corr-status-1"), () => ondeckAdapter.getStatus!(job()))
  assert.equal(status.normalized, "submitted")
  assert.equal(status.rawStatus, "Application Received")
  assert.equal(status.unknown, false)
  assert.equal(status.terms, undefined)
  assert.equal(status.correlationId, "corr-status-1")
  assert.equal(status.eventId, "ondeck-event-attempt-ondeck-1")
  assertNoSecrets(status)
})

test("MIC-144: document receipt is stable on replay", async () => {
  const attempt = job({
    attemptKey: "attempt-docs",
    packageDocumentIds: ["doc-app", "doc-bank"],
    documentVersions: [
      { documentId: "doc-app", checksum: "checksum-app", category: "api_application" },
      { documentId: "doc-bank", checksum: "checksum-bank", category: "statement" },
    ],
  })
  bindOnDeckApplication("attempt-docs", application())
  const first = await ondeckAdapter.submit(attempt)
  assert.equal(first.ok, true)
  assert.equal(first.fields?.portalUrl, ondeckPortalUrl("ondeck_attempt-docs"))
  assert.equal(first.fields?.["documents.0.documentId"], "doc-app")
  assert.equal(first.fields?.["documents.0.category"], "application")
  assert.equal(first.fields?.["documents.0.receiptId"], "ondeck_doc_attempt-docs_doc-app")
  assert.equal(first.fields?.["documents.1.documentId"], "doc-bank")
  assert.equal(first.fields?.["documents.1.category"], "bank_statements")
  assert.equal(first.fields?.["documents.1.receiptId"], "ondeck_doc_attempt-docs_doc-bank")
  assertNoSecrets(first)

  const replay = await ondeckAdapter.submit(attempt)
  assert.equal(replay.ok, true)
  assert.equal(replay.externalRef, first.externalRef)
  assert.equal(replay.fields?.portalUrl, first.fields?.portalUrl)
  assert.equal(replay.fields?.appId, first.fields?.appId)
  assert.equal(replay.fields?.["documents.0.receiptId"], first.fields?.["documents.0.receiptId"])
  assert.equal(replay.fields?.["documents.1.receiptId"], first.fields?.["documents.1.receiptId"])
  assert.deepEqual(listFixtureExternalRefs(), ["ondeck_attempt-docs"])
  assert.equal(peekFixture("attempt-docs")?.submitCalls, 2)
  assert.equal(fixtureSubmitCallCount(), 2)

  const withoutFiles = await ondeckAdapter.submit(job({
    attemptKey: "attempt-no-docs",
    documentVersions: [],
    packageDocumentIds: [],
  }))
  assert.equal(withoutFiles.ok, true)
  assert.equal(withoutFiles.externalRef, "ondeck_attempt-no-docs")
  assert.equal(withoutFiles.fields?.appId, "ondeck_attempt-no-docs")
  assert.equal(withoutFiles.fields?.["documents.0.receiptId"], undefined)
})

test("MIC-144: timeout, expired credential, and replay do not duplicate submissions", async () => {
  const timeoutJob = job({
    attemptKey: "attempt-timeout",
    route: {
      id: "route-ondeck-timeout",
      kind: "api",
      label: "API",
      destination: "ondeck:timeout",
      documentExceptions: [],
      active: true,
    },
  })
  const timedOut = await ondeckAdapter.submit(timeoutJob)
  assert.equal(timedOut.ok, false)
  assert.equal(timedOut.errorCode, "provider_unavailable")
  assert.match(timedOut.errorMessage ?? "", /timed out/i)
  assert.equal(timedOut.externalRef, "ondeck_attempt-timeout")

  const recovered = await ondeckAdapter.submit(timeoutJob)
  assert.equal(recovered.ok, true)
  assert.equal(recovered.externalRef, timedOut.externalRef)
  assert.equal(recovered.fields?.appId, "ondeck_attempt-timeout")
  assert.equal(recovered.fields?.portalUrl, ondeckPortalUrl("ondeck_attempt-timeout"))
  assert.deepEqual(listFixtureExternalRefs(), ["ondeck_attempt-timeout"])

  const expiredJob = job({ attemptKey: "attempt-expired" })
  const expired = await runWithAdapterRuntime(runtime({ apiKey: EXPIRED_CREDENTIAL_TOKEN, username: USERNAME, password: PASSWORD }, "corr-expired"), () => ondeckAdapter.submit(expiredJob))
  assert.equal(expired.ok, false)
  assert.equal(expired.errorCode, "provider_unavailable")
  assert.match(expired.errorMessage ?? "", /expired/i)
  assert.equal(expired.externalRef, undefined)
  assert.equal(expired.correlationId, "corr-expired")
  assertNoSecrets(expired)
  await assert.rejects(
    () => runWithAdapterRuntime(runtime({ apiKey: API_KEY, username: EXPIRED_CREDENTIAL_TOKEN, password: PASSWORD }), () => ondeckAdapter.getStatus!(expiredJob)),
    (error: { status?: number; code?: string; message?: string }) => (
      error.status === 503 && error.code === "provider_unavailable" && /expired/i.test(error.message ?? "")
    ),
  )
  assert.equal(listFixtureExternalRefs().includes("ondeck_attempt-expired"), false)

  const acceptedJob = job({ attemptKey: "attempt-replay" })
  bindOnDeckApplication("attempt-replay", application())
  const first = await ondeckAdapter.submit(acceptedJob)
  const replay = await runWithAdapterRuntime(runtime({ apiKey: API_KEY, username: USERNAME, password: EXPIRED_CREDENTIAL_TOKEN }, "corr-replay"), () => ondeckAdapter.submit(acceptedJob))
  assert.equal(first.ok, true)
  assert.equal(replay.ok, true)
  assert.equal(replay.externalRef, first.externalRef)
  assert.equal(replay.correlationId, "corr-replay")
  assert.deepEqual(new Set(listFixtureExternalRefs()), new Set(["ondeck_attempt-timeout", "ondeck_attempt-replay"]))
  assertNoSecrets(replay)

  setOnDeckFixture("ondeck:expired-credential")
  const destinationExpired = await ondeckAdapter.submit(job({ attemptKey: "attempt-expired-destination" }))
  assert.equal(destinationExpired.ok, false)
  assert.equal(destinationExpired.externalRef, undefined)
})

test("MIC-144: maps submitted/offer/declined and preserves unsupported outcomes", async () => {
  assert.equal(mapProviderStatus("Application Received").normalized, "submitted")
  assert.equal(mapProviderStatus("Received").normalized, "submitted")
  assert.equal(mapProviderStatus("Submitted").normalized, "submitted")
  assert.equal(mapProviderStatus("New Submission").normalized, "submitted")
  assert.equal(mapProviderStatus("Offer").normalized, "approved")
  assert.equal(mapProviderStatus("Offered").normalized, "approved")
  assert.equal(mapProviderStatus("Approved").normalized, "approved")
  assert.equal(mapProviderStatus("Declined").normalized, "declined")
  assert.equal(mapProviderStatus("Decline").normalized, "declined")
  assert.equal(mapProviderStatus("Rejected").normalized, "declined")
  assert.equal(Object.keys(PROVIDER_STATUS_MAP).length, 12)
  assert.deepEqual(mapProviderStatus("Hold"), { rawStatus: "Hold", normalized: "unknown", unknown: true })
  assert.equal(mapProviderStatus("CREDIT_COMMITTEE_HOLD").unknown, true)
  assert.equal(mapProviderStatus("Funded").unknown, true)

  const offerJob = job({
    attemptKey: "attempt-offer",
    route: {
      id: "route-ondeck-offer",
      kind: "api",
      label: "API",
      destination: "ondeck:offer",
      documentExceptions: [],
      active: true,
    },
  })
  const offerSubmit = await ondeckAdapter.submit(offerJob)
  assert.equal(offerSubmit.ok, true)
  assert.equal(offerSubmit.rawStatus, "Offer")
  assert.equal(offerSubmit.fields?.portalUrl, ondeckPortalUrl("ondeck_attempt-offer"))
  const offer = await ondeckAdapter.getStatus!(offerJob)
  assert.equal(offer.normalized, "approved")
  assert.equal(offer.unknown, false)
  assert.equal(offer.terms?.amount, SYNTHETIC_OFFER_TERMS.amount)
  assert.equal(offer.terms?.rate, SYNTHETIC_OFFER_TERMS.rate)
  assert.equal(offer.terms?.term, SYNTHETIC_OFFER_TERMS.term)
  assert.equal(offer.terms?.offerLink, SYNTHETIC_OFFER_TERMS.offerLink)

  const declinedJob = job({
    attemptKey: "attempt-declined",
    route: {
      id: "route-ondeck-declined",
      kind: "api",
      label: "API",
      destination: "ondeck:declined",
      documentExceptions: [],
      active: true,
    },
  })
  await ondeckAdapter.submit(declinedJob)
  const declined = await ondeckAdapter.getStatus!(declinedJob)
  assert.equal(declined.rawStatus, "Declined")
  assert.equal(declined.normalized, "declined")
  assert.equal(declined.terms, undefined)

  const holdJob = job({
    attemptKey: "attempt-hold",
    route: {
      id: "route-ondeck-hold",
      kind: "api",
      label: "API",
      destination: "ondeck:hold",
      documentExceptions: [],
      active: true,
    },
  })
  const holdSubmit = await ondeckAdapter.submit(holdJob)
  assert.equal(holdSubmit.ok, true)
  assert.equal(holdSubmit.rawStatus, "Hold")
  const hold = await ondeckAdapter.getStatus!(holdJob)
  assert.equal(hold.rawStatus, "Hold")
  assert.equal(hold.normalized, "unknown")
  assert.equal(hold.unknown, true)
  assert.equal(hold.terms, undefined)
})
