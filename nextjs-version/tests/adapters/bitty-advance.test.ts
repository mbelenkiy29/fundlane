import test, { beforeEach } from "node:test"
import assert from "node:assert/strict"
import type { AdapterRuntime } from "../../src/lib/mca/submissions/adapters/contracts"
import { runWithAdapterRuntime } from "../../src/lib/mca/submissions/adapters/credentials"
import type { SubmissionJob } from "../../src/lib/mca/submissions/contracts"
import {
  bindBittyAdvanceApplication,
  BITTY_ADVANCE_FIXTURE_TRANSPORT,
  BITTY_ADVANCE_SLUG,
  bittyAdvanceAdapter,
  bittyAdvanceDealId,
  bittyAdvancePortalUrl,
  EXPIRED_CREDENTIAL_TOKEN,
  fixtureSubmitCallCount,
  listFixtureExternalRefs,
  mapProviderStatus,
  peekFixture,
  PROVIDER_STATUS_MAP,
  resetBittyAdvanceFixtures,
  setBittyAdvanceFixture,
  SYNTHETIC_OFFER_TERMS,
} from "../../src/lib/mca/submissions/adapters/bitty-advance"

const SSN = "123456789"
const API_KEY = "bitty-advance-development-token-never-leak"

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
    { period: "2026-01", revenue: 48000, negativeDays: 2 },
    { period: "2026-02", deposits: { value: 51000, unknown: false, confidence: 1 }, negativeDays: 0 },
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
    id: overrides.id ?? "job-bitty-1",
    workspaceId: overrides.workspaceId ?? "workspace-bitty",
    dealId: overrides.dealId ?? "deal-bitty-1",
    funderId: overrides.funderId ?? "funder-bitty-1",
    displayFunderName: overrides.displayFunderName ?? "Bitty Advance",
    routeKind: "api",
    route: overrides.route ?? {
      id: "route-bitty",
      kind: "api",
      label: "API",
      destination: BITTY_ADVANCE_SLUG,
      documentExceptions: [],
      active: true,
    },
    state: overrides.state ?? "sending",
    confirmationKey: overrides.confirmationKey ?? "conf-bitty-1",
    attemptKey: overrides.attemptKey ?? "attempt-bitty-1",
    dealVersion: overrides.dealVersion ?? 1,
    documentVersions: overrides.documentVersions ?? [],
    packageDocumentIds: overrides.packageDocumentIds ?? [],
    preflightErrors: overrides.preflightErrors ?? [],
    merchantIdentityKey: overrides.merchantIdentityKey ?? `deal:${overrides.dealId ?? "deal-fixture"}`,
    packageFingerprint: overrides.packageFingerprint ?? "",
    createdAt: overrides.createdAt ?? "2026-01-01T00:00:00.000Z",
    updatedAt: overrides.updatedAt ?? "2026-01-01T00:00:00.000Z",
    ...overrides,
  }
}

function runtime(secrets: AdapterRuntime["secrets"], correlationId = "corr-bitty-1"): AdapterRuntime {
  return {
    credentialId: "cred-bitty-1",
    workspaceId: "workspace-bitty",
    funderId: "funder-bitty-1",
    adapterSlug: BITTY_ADVANCE_SLUG,
    environment: "development",
    capabilities: bittyAdvanceAdapter.capabilities,
    secrets,
    correlationId,
  }
}

function assertNoSecrets(value: unknown) {
  const text = typeof value === "string" ? value : JSON.stringify(value)
  assert.equal(text.includes(API_KEY), false)
  assert.equal(text.includes(EXPIRED_CREDENTIAL_TOKEN), false)
  assert.equal(text.includes(SSN), false)
}

beforeEach(() => {
  resetBittyAdvanceFixtures()
})

test("MIC-140: required-field rejection", () => {
  const empty = bittyAdvanceAdapter.validate({})
  assert.equal(empty.ok, false)
  if (empty.ok) throw new Error("expected field errors")
  assert.equal(empty.fields.legalName, "Business name is required.")
  assert.equal(empty.fields.ein, "EIN / Tax ID is required.")
  assert.equal(empty.fields.industry, "Industry is required.")
  assert.equal(empty.fields.entityType, "Entity type is required.")
  assert.equal(empty.fields.phone, "Business phone is required.")
  assert.equal(empty.fields.owners, "At least one business owner is required.")
  assert.equal(empty.fields.statements, "At least one statement with revenue and negative days is required.")
  assert.equal(empty.fields["documents.application"], undefined)
  assert.equal(empty.fields["documents.bankStatements"], undefined)

  const missingMetrics = bittyAdvanceAdapter.validate(application({
    statements: [{ period: "2026-01", revenue: 48000 }],
  }))
  assert.equal(missingMetrics.ok, false)
  if (missingMetrics.ok) throw new Error("expected negative days error")
  assert.equal(missingMetrics.fields["statements.0.negativeDays"], "Statement negative days are required.")

  const missingRevenue = bittyAdvanceAdapter.validate(application({
    statements: [{ period: "2026-01", negativeDays: 2 }],
  }))
  assert.equal(missingRevenue.ok, false)
  if (missingRevenue.ok) throw new Error("expected revenue error")
  assert.equal(missingRevenue.fields["statements.0.revenue"], "Statement revenue is required.")

  const unknownMetric = bittyAdvanceAdapter.validate(application({
    statements: [{ period: "2026-01", revenue: 48000, negativeDays: { value: null, unknown: true, confidence: 0 } }],
  }))
  assert.equal(unknownMetric.ok, false)
  if (unknownMetric.ok) throw new Error("expected unknown negative days error")
  assert.equal(unknownMetric.fields["statements.0.negativeDays"], "Statement negative days are required.")

  const fromAggregate = bittyAdvanceAdapter.validate(application({
    statements: undefined,
    monthlyRevenue: 45000,
    negativeDays: 0,
  }))
  assert.equal(fromAggregate.ok, true)

  const invalid = bittyAdvanceAdapter.validate(application({
    ein: "12-345",
    owners: [owner({ ssn: "1234", firstName: "", ownershipPercent: undefined, dateOfBirth: "" })],
    statements: [{ period: "January", revenue: -1, negativeDays: 1.5 }],
  }))
  assert.equal(invalid.ok, false)
  if (invalid.ok) throw new Error("expected invalid field errors")
  assert.equal(invalid.fields.ein, "EIN must contain 9 digits.")
  assert.equal(invalid.fields["owners.0.firstName"], "Owner first name is required.")
  assert.equal(invalid.fields["owners.0.ssn"], "Owner SSN must contain 9 digits.")
  assert.equal(invalid.fields["owners.0.dateOfBirth"], "Owner date of birth is required.")
  assert.equal(invalid.fields["owners.0.ownershipPercent"], "Owner ownership percentage is required.")
  assert.equal(invalid.fields["statements.0.period"], "Use a statement period in YYYY-MM or YYYY-MM-DD format.")
  assert.equal(invalid.fields["statements.0.revenue"], "Statement revenue must be 0 or greater.")
  assert.equal(invalid.fields["statements.0.negativeDays"], "Negative days must be a whole number of 0 or greater.")
  assert.equal(bittyAdvanceAdapter.validate(application({ documents: undefined })).ok, true)
})

test("MIC-140: accepted submission returns Deal ID, portal link, and offer-capable flags", async () => {
  assert.equal(bittyAdvanceAdapter.slug, "bitty-advance")
  assert.deepEqual(bittyAdvanceAdapter.capabilities, {
    submit: true,
    statusPoll: true,
    webhooks: false,
    offers: true,
  })
  assert.equal(typeof bittyAdvanceAdapter.getStatus, "function")
  assert.equal(bittyAdvanceAdapter.parseWebhook, undefined)
  assert.equal(BITTY_ADVANCE_FIXTURE_TRANSPORT.startsWith("fixture://"), true)

  const payload = application()
  bindBittyAdvanceApplication("attempt-bitty-1", payload)
  const submitted = await runWithAdapterRuntime(runtime({ apiKey: API_KEY }), () => bittyAdvanceAdapter.submit(job()))
  assert.equal(submitted.ok, true)
  assert.equal(submitted.correlationId, "corr-bitty-1")
  assert.equal(submitted.externalRef, bittyAdvanceDealId("attempt-bitty-1"))
  assert.equal(submitted.rawStatus, "Submitted")
  assert.equal(submitted.fields?.dealId, "bitty_attempt-bitty-1")
  assert.equal(submitted.fields?.portalUrl, bittyAdvancePortalUrl("bitty_attempt-bitty-1"))
  assert.equal(mapProviderStatus(submitted.rawStatus ?? "").normalized, "submitted")
  assertNoSecrets(submitted)

  const stored = peekFixture("attempt-bitty-1")
  assert.ok(stored)
  assert.equal(stored.mapped?.legalName, "Harbor Coffee LLC")
  assert.equal(stored.mapped?.entityType, "llc")
  assert.deepEqual(stored.mapped?.owners, [
    { firstName: "Alex", lastName: "Rivera", ownershipPercent: 60 },
  ])
  assert.deepEqual(stored.mapped?.statements, [
    { period: "2026-01", revenue: 48000, negativeDays: 2 },
    { period: "2026-02", revenue: 51000, negativeDays: 0 },
  ])
  assert.equal(JSON.stringify(stored.mapped).includes(SSN), false)

  const status = await runWithAdapterRuntime(runtime({ apiKey: API_KEY }, "corr-status-1"), () => bittyAdvanceAdapter.getStatus!(job()))
  assert.equal(status.normalized, "submitted")
  assert.equal(status.rawStatus, "Submitted")
  assert.equal(status.unknown, false)
  assert.equal(status.terms, undefined)
  assert.equal(status.correlationId, "corr-status-1")
  assert.equal(status.eventId, "bitty-event-attempt-bitty-1")
  assertNoSecrets(status)
})

test("MIC-140: document receipt is stable on replay", async () => {
  const attempt = job({
    attemptKey: "attempt-docs",
    packageDocumentIds: ["doc-app", "doc-bank"],
    documentVersions: [
      { documentId: "doc-app", checksum: "checksum-app", category: "api_application" },
      { documentId: "doc-bank", checksum: "checksum-bank", category: "statement" },
    ],
  })
  bindBittyAdvanceApplication("attempt-docs", application())
  const first = await bittyAdvanceAdapter.submit(attempt)
  assert.equal(first.ok, true)
  assert.equal(first.fields?.portalUrl, bittyAdvancePortalUrl("bitty_attempt-docs"))
  assert.equal(first.fields?.["documents.0.documentId"], "doc-app")
  assert.equal(first.fields?.["documents.0.category"], "application")
  assert.equal(first.fields?.["documents.0.receiptId"], "bitty_doc_attempt-docs_doc-app")
  assert.equal(first.fields?.["documents.1.documentId"], "doc-bank")
  assert.equal(first.fields?.["documents.1.category"], "bank_statements")
  assert.equal(first.fields?.["documents.1.receiptId"], "bitty_doc_attempt-docs_doc-bank")
  assertNoSecrets(first)

  const replay = await bittyAdvanceAdapter.submit(attempt)
  assert.equal(replay.ok, true)
  assert.equal(replay.externalRef, first.externalRef)
  assert.equal(replay.fields?.portalUrl, first.fields?.portalUrl)
  assert.equal(replay.fields?.["documents.0.receiptId"], first.fields?.["documents.0.receiptId"])
  assert.equal(replay.fields?.["documents.1.receiptId"], first.fields?.["documents.1.receiptId"])
  assert.deepEqual(listFixtureExternalRefs(), ["bitty_attempt-docs"])
  assert.equal(peekFixture("attempt-docs")?.submitCalls, 2)
  assert.equal(fixtureSubmitCallCount(), 2)

  const withoutFiles = await bittyAdvanceAdapter.submit(job({
    attemptKey: "attempt-no-docs",
    documentVersions: [],
    packageDocumentIds: [],
  }))
  assert.equal(withoutFiles.ok, true)
  assert.equal(withoutFiles.externalRef, "bitty_attempt-no-docs")
  assert.equal(withoutFiles.fields?.dealId, "bitty_attempt-no-docs")
  assert.equal(withoutFiles.fields?.["documents.0.receiptId"], undefined)
})

test("MIC-140: timeout, expired credential, and replay do not duplicate submissions", async () => {
  const timeoutJob = job({
    attemptKey: "attempt-timeout",
    route: {
      id: "route-bitty-timeout",
      kind: "api",
      label: "API",
      destination: "bitty-advance:timeout",
      documentExceptions: [],
      active: true,
    },
  })
  const timedOut = await bittyAdvanceAdapter.submit(timeoutJob)
  assert.equal(timedOut.ok, false)
  assert.equal(timedOut.errorCode, "provider_unavailable")
  assert.match(timedOut.errorMessage ?? "", /timed out/i)
  assert.equal(timedOut.externalRef, "bitty_attempt-timeout")

  const recovered = await bittyAdvanceAdapter.submit(timeoutJob)
  assert.equal(recovered.ok, true)
  assert.equal(recovered.externalRef, timedOut.externalRef)
  assert.equal(recovered.fields?.dealId, "bitty_attempt-timeout")
  assert.equal(recovered.fields?.portalUrl, bittyAdvancePortalUrl("bitty_attempt-timeout"))
  assert.deepEqual(listFixtureExternalRefs(), ["bitty_attempt-timeout"])

  const expiredJob = job({ attemptKey: "attempt-expired" })
  const expired = await runWithAdapterRuntime(runtime({ apiKey: EXPIRED_CREDENTIAL_TOKEN }, "corr-expired"), () => bittyAdvanceAdapter.submit(expiredJob))
  assert.equal(expired.ok, false)
  assert.equal(expired.errorCode, "provider_unavailable")
  assert.match(expired.errorMessage ?? "", /expired/i)
  assert.equal(expired.externalRef, undefined)
  assert.equal(expired.correlationId, "corr-expired")
  assertNoSecrets(expired)
  await assert.rejects(
    () => runWithAdapterRuntime(runtime({ apiKey: EXPIRED_CREDENTIAL_TOKEN }), () => bittyAdvanceAdapter.getStatus!(expiredJob)),
    (error: { status?: number; code?: string; message?: string }) => (
      error.status === 503 && error.code === "provider_unavailable" && /expired/i.test(error.message ?? "")
    ),
  )
  assert.equal(listFixtureExternalRefs().includes("bitty_attempt-expired"), false)

  const acceptedJob = job({ attemptKey: "attempt-replay" })
  bindBittyAdvanceApplication("attempt-replay", application())
  const first = await bittyAdvanceAdapter.submit(acceptedJob)
  const replay = await runWithAdapterRuntime(runtime({ apiKey: EXPIRED_CREDENTIAL_TOKEN }, "corr-replay"), () => bittyAdvanceAdapter.submit(acceptedJob))
  assert.equal(first.ok, true)
  assert.equal(replay.ok, true)
  assert.equal(replay.externalRef, first.externalRef)
  assert.equal(replay.correlationId, "corr-replay")
  assert.deepEqual(new Set(listFixtureExternalRefs()), new Set(["bitty_attempt-timeout", "bitty_attempt-replay"]))
  assertNoSecrets(replay)

  setBittyAdvanceFixture("bitty-advance:expired-credential")
  const destinationExpired = await bittyAdvanceAdapter.submit(job({ attemptKey: "attempt-expired-destination" }))
  assert.equal(destinationExpired.ok, false)
  assert.equal(destinationExpired.externalRef, undefined)
})

test("MIC-140: maps submitted/offer/declined and preserves unsupported outcomes", async () => {
  assert.equal(mapProviderStatus("Submitted").normalized, "submitted")
  assert.equal(mapProviderStatus("Received").normalized, "submitted")
  assert.equal(mapProviderStatus("New Submission").normalized, "submitted")
  assert.equal(mapProviderStatus("Offer").normalized, "approved")
  assert.equal(mapProviderStatus("Offered").normalized, "approved")
  assert.equal(mapProviderStatus("Approved").normalized, "approved")
  assert.equal(mapProviderStatus("Declined").normalized, "declined")
  assert.equal(mapProviderStatus("Decline").normalized, "declined")
  assert.equal(mapProviderStatus("Rejected").normalized, "declined")
  assert.equal(Object.keys(PROVIDER_STATUS_MAP).length, 11)
  assert.deepEqual(mapProviderStatus("Hold"), { rawStatus: "Hold", normalized: "unknown", unknown: true })
  assert.equal(mapProviderStatus("CREDIT_COMMITTEE_HOLD").unknown, true)
  assert.equal(mapProviderStatus("Funded").unknown, true)

  const offerJob = job({
    attemptKey: "attempt-offer",
    route: {
      id: "route-bitty-offer",
      kind: "api",
      label: "API",
      destination: "bitty-advance:offer",
      documentExceptions: [],
      active: true,
    },
  })
  const offerSubmit = await bittyAdvanceAdapter.submit(offerJob)
  assert.equal(offerSubmit.ok, true)
  assert.equal(offerSubmit.rawStatus, "Offer")
  assert.equal(offerSubmit.fields?.portalUrl, bittyAdvancePortalUrl("bitty_attempt-offer"))
  const offer = await bittyAdvanceAdapter.getStatus!(offerJob)
  assert.equal(offer.normalized, "approved")
  assert.equal(offer.unknown, false)
  assert.equal(offer.terms?.amount, SYNTHETIC_OFFER_TERMS.amount)
  assert.equal(offer.terms?.rate, SYNTHETIC_OFFER_TERMS.rate)
  assert.equal(offer.terms?.term, SYNTHETIC_OFFER_TERMS.term)
  assert.equal(offer.terms?.offerLink, SYNTHETIC_OFFER_TERMS.offerLink)

  const declinedJob = job({
    attemptKey: "attempt-declined",
    route: {
      id: "route-bitty-declined",
      kind: "api",
      label: "API",
      destination: "bitty-advance:declined",
      documentExceptions: [],
      active: true,
    },
  })
  await bittyAdvanceAdapter.submit(declinedJob)
  const declined = await bittyAdvanceAdapter.getStatus!(declinedJob)
  assert.equal(declined.rawStatus, "Declined")
  assert.equal(declined.normalized, "declined")
  assert.equal(declined.terms, undefined)

  const holdJob = job({
    attemptKey: "attempt-hold",
    route: {
      id: "route-bitty-hold",
      kind: "api",
      label: "API",
      destination: "bitty-advance:hold",
      documentExceptions: [],
      active: true,
    },
  })
  const holdSubmit = await bittyAdvanceAdapter.submit(holdJob)
  assert.equal(holdSubmit.ok, true)
  assert.equal(holdSubmit.rawStatus, "Hold")
  const hold = await bittyAdvanceAdapter.getStatus!(holdJob)
  assert.equal(hold.rawStatus, "Hold")
  assert.equal(hold.normalized, "unknown")
  assert.equal(hold.unknown, true)
  assert.equal(hold.terms, undefined)
})
