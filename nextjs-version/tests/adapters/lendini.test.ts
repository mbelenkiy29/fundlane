import test, { beforeEach } from "node:test"
import assert from "node:assert/strict"
import type { AdapterRuntime } from "../../src/lib/mca/submissions/adapters/contracts"
import { runWithAdapterRuntime } from "../../src/lib/mca/submissions/adapters/credentials"
import type { SubmissionJob } from "../../src/lib/mca/submissions/contracts"
import {
  ACKNOWLEDGEMENT_STATUS,
  bindLendiniApplication,
  formatIndustry,
  LENDINI_FIXTURE_TRANSPORT,
  LENDINI_SLUG,
  lendiniAdapter,
  lendiniApplicationId,
  EXPIRED_CREDENTIAL_TOKEN,
  fixtureSubmitCallCount,
  listFixtureExternalRefs,
  mapEntityType,
  mapProviderStatus,
  MAX_OWNERS,
  peekFixture,
  PROVIDER_STATUS_MAP,
  resetLendiniFixtures,
  setLendiniFixture,
  SYNTHETIC_OFFER_TERMS,
} from "../../src/lib/mca/submissions/adapters/lendini"

const SSN = "123456789"
const SECONDARY_SSN = "987654321"
const API_KEY = "lendini-development-token-never-leak"

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

function application(overrides: Record<string, unknown> = {}) {
  return {
    legalName: "Harbor Coffee LLC",
    dbaName: "Harbor Coffee",
    ein: "12-3456789",
    entityType: "s_corporation",
    industry: "restaurant",
    startDate: "2019-06-01",
    contactPhone: "2125550199",
    address: { line1: "100 Front Street", city: "New York", state: "NY", postalCode: "10004" },
    owners: [
      owner({ firstName: "Sam", lastName: "Lee", ownershipPercent: 15, isPrimary: false, email: "sam.lee@merchant.example", ssn: SECONDARY_SSN }),
      owner({ firstName: "Alex", lastName: "Rivera", ownershipPercent: 55, isPrimary: true }),
      owner({ firstName: "Jordan", lastName: "Nguyen", ownershipPercent: 30, isPrimary: false, email: "jordan.nguyen@merchant.example", ssn: "111223333" }),
    ],
    ...overrides,
  }
}

function job(overrides: Partial<SubmissionJob> = {}): SubmissionJob {
  return {
    id: overrides.id ?? "job-lendini-1",
    workspaceId: overrides.workspaceId ?? "workspace-lendini",
    dealId: overrides.dealId ?? "deal-lendini-1",
    funderId: overrides.funderId ?? "funder-lendini-1",
    displayFunderName: overrides.displayFunderName ?? "Lendini",
    routeKind: "api",
    route: overrides.route ?? {
      id: "route-lendini",
      kind: "api",
      label: "API",
      destination: LENDINI_SLUG,
      documentExceptions: [],
      active: true,
    },
    state: overrides.state ?? "sending",
    confirmationKey: overrides.confirmationKey ?? "conf-lendini-1",
    attemptKey: overrides.attemptKey ?? "attempt-lendini-1",
    dealVersion: overrides.dealVersion ?? 1,
    documentVersions: overrides.documentVersions ?? [],
    packageDocumentIds: overrides.packageDocumentIds ?? [],
    preflightErrors: overrides.preflightErrors ?? [],
    createdAt: overrides.createdAt ?? "2026-01-01T00:00:00.000Z",
    updatedAt: overrides.updatedAt ?? "2026-01-01T00:00:00.000Z",
    ...overrides,
  }
}

function runtime(secrets: AdapterRuntime["secrets"], correlationId = "corr-lendini-1"): AdapterRuntime {
  return {
    credentialId: "cred-lendini-1",
    workspaceId: "workspace-lendini",
    funderId: "funder-lendini-1",
    adapterSlug: LENDINI_SLUG,
    environment: "development",
    capabilities: lendiniAdapter.capabilities,
    secrets,
    correlationId,
  }
}

function assertNoSecrets(value: unknown) {
  const text = typeof value === "string" ? value : JSON.stringify(value)
  assert.equal(text.includes(API_KEY), false)
  assert.equal(text.includes(EXPIRED_CREDENTIAL_TOKEN), false)
  assert.equal(text.includes(SSN), false)
  assert.equal(text.includes(SECONDARY_SSN), false)
}

beforeEach(() => {
  resetLendiniFixtures()
})

test("MIC-141: required-field rejection", () => {
  const empty = lendiniAdapter.validate({})
  assert.equal(empty.ok, false)
  if (empty.ok) throw new Error("expected field errors")
  assert.equal(empty.fields.legalName, "Business name is required.")
  assert.equal(empty.fields.ein, "EIN / Tax ID is required.")
  assert.equal(empty.fields.industry, "Industry is required.")
  assert.equal(empty.fields.entityType, "Entity type is required.")
  assert.equal(empty.fields.phone, "Business phone is required.")
  assert.equal(empty.fields.startDate, "Business inception date is required.")
  assert.equal(empty.fields.owners, "At least one business owner is required.")
  assert.equal(empty.fields["documents.application"], undefined)
  assert.equal(empty.fields["documents.bankStatements"], undefined)

  const incompletePrimary = lendiniAdapter.validate(application({
    owners: [
      owner({ firstName: "Sam", lastName: "Lee", ownershipPercent: 20, isPrimary: false, email: "sam.lee@merchant.example", ssn: SECONDARY_SSN }),
      owner({ firstName: "", lastName: "", ownershipPercent: 80, ssn: "1234", dateOfBirth: "", email: "" }),
    ],
  }))
  assert.equal(incompletePrimary.ok, false)
  if (incompletePrimary.ok) throw new Error("expected highest-ownership owner errors")
  assert.equal(incompletePrimary.fields["owners.1.firstName"], "Owner first name is required.")
  assert.equal(incompletePrimary.fields["owners.1.lastName"], "Owner last name is required.")
  assert.equal(incompletePrimary.fields["owners.1.ssn"], "Owner SSN must contain 9 digits.")
  assert.equal(incompletePrimary.fields["owners.1.dateOfBirth"], "Owner date of birth is required.")
  assert.equal(incompletePrimary.fields["owners.1.email"], "Owner email is required.")
  assert.equal(incompletePrimary.fields["owners.0.firstName"], undefined)

  const incompleteSecondary = lendiniAdapter.validate(application({
    owners: [
      owner({ firstName: "Sam", lastName: "", ownershipPercent: 15, isPrimary: false, ssn: "12", email: "not-an-email" }),
      owner({ firstName: "Alex", lastName: "Rivera", ownershipPercent: 85, isPrimary: true }),
    ],
  }))
  assert.equal(incompleteSecondary.ok, true)

  const invalid = lendiniAdapter.validate(application({
    ein: "12-345",
    startDate: "June 2019",
    contactPhone: "555",
    owners: [owner({ ssn: "1234", firstName: "", ownershipPercent: undefined, dateOfBirth: "" })],
  }))
  assert.equal(invalid.ok, false)
  if (invalid.ok) throw new Error("expected invalid field errors")
  assert.equal(invalid.fields.ein, "EIN must contain 9 digits.")
  assert.equal(invalid.fields.startDate, "Use a valid date in YYYY-MM-DD format.")
  assert.equal(invalid.fields.phone, "Business phone must include at least 10 digits.")
  assert.equal(invalid.fields["owners.0.firstName"], "Owner first name is required.")
  assert.equal(invalid.fields["owners.0.ssn"], "Owner SSN must contain 9 digits.")
  assert.equal(invalid.fields["owners.0.dateOfBirth"], "Owner date of birth is required.")
  assert.equal(invalid.fields["owners.0.ownershipPercent"], "Owner ownership percentage is required.")
  assert.equal(lendiniAdapter.validate(application({ documents: undefined })).ok, true)
})

test("MIC-141: accepted submission maps one owner, formatted industry/entity, and keeps acknowledgement", async () => {
  assert.equal(lendiniAdapter.slug, "lendini")
  assert.equal(MAX_OWNERS, 1)
  assert.deepEqual(lendiniAdapter.capabilities, {
    submit: true,
    statusPoll: true,
    webhooks: false,
    offers: true,
  })
  assert.equal(typeof lendiniAdapter.getStatus, "function")
  assert.equal(lendiniAdapter.parseWebhook, undefined)
  assert.equal(LENDINI_FIXTURE_TRANSPORT.startsWith("fixture://"), true)
  assert.equal(mapEntityType("s_corporation"), "Corp")
  assert.equal(mapEntityType("llc"), "LLC")
  assert.equal(mapEntityType("partnership"), "Partnership")
  assert.equal(formatIndustry("restaurant"), "Food Services")
  assert.equal(formatIndustry("food services"), "Food Services")
  assert.equal(formatIndustry("unknown niche"), "Unknown Niche")

  const payload = application()
  bindLendiniApplication("attempt-lendini-1", payload)
  const submitted = await runWithAdapterRuntime(runtime({ apiKey: API_KEY }), () => lendiniAdapter.submit(job()))
  assert.equal(submitted.ok, true)
  assert.equal(submitted.correlationId, "corr-lendini-1")
  assert.equal(submitted.externalRef, lendiniApplicationId("attempt-lendini-1"))
  assert.equal(submitted.rawStatus, ACKNOWLEDGEMENT_STATUS)
  assert.equal(submitted.fields?.applicationId, "lendini_attempt-lendini-1")
  assert.equal(submitted.fields?.acknowledgement, ACKNOWLEDGEMENT_STATUS)
  assert.equal(mapProviderStatus(submitted.rawStatus ?? "").normalized, "submitted")
  assertNoSecrets(submitted)

  const stored = peekFixture("attempt-lendini-1")
  assert.ok(stored)
  assert.equal(stored.mapped?.legalName, "Harbor Coffee LLC")
  assert.equal(stored.mapped?.entityType, "Corp")
  assert.equal(stored.mapped?.industry, "Food Services")
  assert.equal(stored.mapped?.startDate, "2019-06-01")
  assert.deepEqual(stored.mapped?.owners, [
    { firstName: "Alex", lastName: "Rivera", ownershipPercent: 55 },
  ])
  assert.equal(JSON.stringify(stored.mapped).includes(SSN), false)
  assert.equal(JSON.stringify(stored.mapped).includes("Sam"), false)

  const status = await runWithAdapterRuntime(runtime({ apiKey: API_KEY }, "corr-status-1"), () => lendiniAdapter.getStatus!(job()))
  assert.equal(status.normalized, "submitted")
  assert.equal(status.rawStatus, ACKNOWLEDGEMENT_STATUS)
  assert.equal(status.unknown, false)
  assert.equal(status.terms, undefined)
  assert.equal(status.correlationId, "corr-status-1")
  assert.equal(status.eventId, "lendini-event-attempt-lendini-1")
  assertNoSecrets(status)
})

test("MIC-141: document receipt is stable on replay", async () => {
  const attempt = job({
    attemptKey: "attempt-docs",
    packageDocumentIds: ["doc-app", "doc-bank"],
    documentVersions: [
      { documentId: "doc-app", checksum: "checksum-app", category: "api_application" },
      { documentId: "doc-bank", checksum: "checksum-bank", category: "statement" },
    ],
  })
  bindLendiniApplication("attempt-docs", application())
  const first = await lendiniAdapter.submit(attempt)
  assert.equal(first.ok, true)
  assert.equal(first.rawStatus, ACKNOWLEDGEMENT_STATUS)
  assert.equal(first.fields?.["documents.0.documentId"], "doc-app")
  assert.equal(first.fields?.["documents.0.category"], "application")
  assert.equal(first.fields?.["documents.0.receiptId"], "lendini_doc_attempt-docs_doc-app")
  assert.equal(first.fields?.["documents.1.documentId"], "doc-bank")
  assert.equal(first.fields?.["documents.1.category"], "bank_statements")
  assert.equal(first.fields?.["documents.1.receiptId"], "lendini_doc_attempt-docs_doc-bank")
  assertNoSecrets(first)

  const replay = await lendiniAdapter.submit(attempt)
  assert.equal(replay.ok, true)
  assert.equal(replay.externalRef, first.externalRef)
  assert.equal(replay.rawStatus, first.rawStatus)
  assert.equal(replay.fields?.acknowledgement, first.fields?.acknowledgement)
  assert.equal(replay.fields?.["documents.0.receiptId"], first.fields?.["documents.0.receiptId"])
  assert.equal(replay.fields?.["documents.1.receiptId"], first.fields?.["documents.1.receiptId"])
  assert.deepEqual(listFixtureExternalRefs(), ["lendini_attempt-docs"])
  assert.equal(peekFixture("attempt-docs")?.submitCalls, 2)
  assert.equal(fixtureSubmitCallCount(), 2)

  const withoutFiles = await lendiniAdapter.submit(job({
    attemptKey: "attempt-no-docs",
    documentVersions: [],
    packageDocumentIds: [],
  }))
  assert.equal(withoutFiles.ok, true)
  assert.equal(withoutFiles.externalRef, "lendini_attempt-no-docs")
  assert.equal(withoutFiles.fields?.applicationId, "lendini_attempt-no-docs")
  assert.equal(withoutFiles.fields?.["documents.0.receiptId"], undefined)
})

test("MIC-141: timeout, expired credential, and replay do not duplicate submissions", async () => {
  const timeoutJob = job({
    attemptKey: "attempt-timeout",
    route: {
      id: "route-lendini-timeout",
      kind: "api",
      label: "API",
      destination: "lendini:timeout",
      documentExceptions: [],
      active: true,
    },
  })
  const timedOut = await lendiniAdapter.submit(timeoutJob)
  assert.equal(timedOut.ok, false)
  assert.equal(timedOut.errorCode, "provider_unavailable")
  assert.match(timedOut.errorMessage ?? "", /timed out/i)
  assert.equal(timedOut.externalRef, "lendini_attempt-timeout")

  const recovered = await lendiniAdapter.submit(timeoutJob)
  assert.equal(recovered.ok, true)
  assert.equal(recovered.externalRef, timedOut.externalRef)
  assert.equal(recovered.rawStatus, ACKNOWLEDGEMENT_STATUS)
  assert.equal(recovered.fields?.applicationId, "lendini_attempt-timeout")
  assert.deepEqual(listFixtureExternalRefs(), ["lendini_attempt-timeout"])

  const expiredJob = job({ attemptKey: "attempt-expired" })
  const expired = await runWithAdapterRuntime(runtime({ apiKey: EXPIRED_CREDENTIAL_TOKEN }, "corr-expired"), () => lendiniAdapter.submit(expiredJob))
  assert.equal(expired.ok, false)
  assert.equal(expired.errorCode, "provider_unavailable")
  assert.match(expired.errorMessage ?? "", /expired/i)
  assert.equal(expired.externalRef, undefined)
  assert.equal(expired.correlationId, "corr-expired")
  assertNoSecrets(expired)
  await assert.rejects(
    () => runWithAdapterRuntime(runtime({ apiKey: EXPIRED_CREDENTIAL_TOKEN }), () => lendiniAdapter.getStatus!(expiredJob)),
    (error: { status?: number; code?: string; message?: string }) => (
      error.status === 503 && error.code === "provider_unavailable" && /expired/i.test(error.message ?? "")
    ),
  )
  assert.equal(listFixtureExternalRefs().includes("lendini_attempt-expired"), false)

  const acceptedJob = job({ attemptKey: "attempt-replay" })
  bindLendiniApplication("attempt-replay", application())
  const first = await lendiniAdapter.submit(acceptedJob)
  const replay = await runWithAdapterRuntime(runtime({ apiKey: EXPIRED_CREDENTIAL_TOKEN }, "corr-replay"), () => lendiniAdapter.submit(acceptedJob))
  assert.equal(first.ok, true)
  assert.equal(replay.ok, true)
  assert.equal(replay.externalRef, first.externalRef)
  assert.equal(replay.rawStatus, ACKNOWLEDGEMENT_STATUS)
  assert.equal(replay.correlationId, "corr-replay")
  assert.deepEqual(new Set(listFixtureExternalRefs()), new Set(["lendini_attempt-timeout", "lendini_attempt-replay"]))
  assertNoSecrets(replay)

  setLendiniFixture("lendini:expired-credential")
  const destinationExpired = await lendiniAdapter.submit(job({ attemptKey: "attempt-expired-destination" }))
  assert.equal(destinationExpired.ok, false)
  assert.equal(destinationExpired.externalRef, undefined)
})

test("MIC-141: polls offer/decline after acknowledgement and preserves unsupported outcomes", async () => {
  assert.equal(mapProviderStatus("Received").normalized, "submitted")
  assert.equal(mapProviderStatus("Submitted").normalized, "submitted")
  assert.equal(mapProviderStatus("Acknowledged").normalized, "submitted")
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
      id: "route-lendini-offer",
      kind: "api",
      label: "API",
      destination: "lendini:offer",
      documentExceptions: [],
      active: true,
    },
  })
  const offerSubmit = await lendiniAdapter.submit(offerJob)
  assert.equal(offerSubmit.ok, true)
  assert.equal(offerSubmit.rawStatus, ACKNOWLEDGEMENT_STATUS)
  assert.equal(offerSubmit.fields?.acknowledgement, ACKNOWLEDGEMENT_STATUS)
  const offer = await lendiniAdapter.getStatus!(offerJob)
  assert.equal(offer.rawStatus, "Offer")
  assert.equal(offer.normalized, "approved")
  assert.equal(offer.unknown, false)
  assert.equal(offer.terms?.amount, SYNTHETIC_OFFER_TERMS.amount)
  assert.equal(offer.terms?.rate, SYNTHETIC_OFFER_TERMS.rate)
  assert.equal(offer.terms?.term, SYNTHETIC_OFFER_TERMS.term)
  assert.equal(offer.terms?.offerLink, SYNTHETIC_OFFER_TERMS.offerLink)

  const declinedJob = job({
    attemptKey: "attempt-declined",
    route: {
      id: "route-lendini-declined",
      kind: "api",
      label: "API",
      destination: "lendini:declined",
      documentExceptions: [],
      active: true,
    },
  })
  const declinedSubmit = await lendiniAdapter.submit(declinedJob)
  assert.equal(declinedSubmit.rawStatus, ACKNOWLEDGEMENT_STATUS)
  const declined = await lendiniAdapter.getStatus!(declinedJob)
  assert.equal(declined.rawStatus, "Declined")
  assert.equal(declined.normalized, "declined")
  assert.equal(declined.terms, undefined)

  const holdJob = job({
    attemptKey: "attempt-hold",
    route: {
      id: "route-lendini-hold",
      kind: "api",
      label: "API",
      destination: "lendini:hold",
      documentExceptions: [],
      active: true,
    },
  })
  const holdSubmit = await lendiniAdapter.submit(holdJob)
  assert.equal(holdSubmit.ok, true)
  assert.equal(holdSubmit.rawStatus, ACKNOWLEDGEMENT_STATUS)
  const hold = await lendiniAdapter.getStatus!(holdJob)
  assert.equal(hold.rawStatus, "Hold")
  assert.equal(hold.normalized, "unknown")
  assert.equal(hold.unknown, true)
  assert.equal(hold.terms, undefined)
})
