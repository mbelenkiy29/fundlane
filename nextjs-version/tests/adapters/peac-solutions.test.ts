import test, { beforeEach } from "node:test"
import assert from "node:assert/strict"
import type { AdapterRuntime } from "../../src/lib/mca/submissions/adapters/contracts"
import { runWithAdapterRuntime } from "../../src/lib/mca/submissions/adapters/credentials"
import type { SubmissionJob } from "../../src/lib/mca/submissions/contracts"
import {
  bindPeacSolutionsApplication,
  EXPIRED_CREDENTIAL_TOKEN,
  fixtureSubmitCallCount,
  listFixtureExternalRefs,
  mapProviderStatus,
  MAX_OWNERS,
  MAX_REQUESTED_AMOUNT,
  MIN_REPRESENTED_OWNERSHIP,
  PEAC_SOLUTIONS_FIXTURE_TRANSPORT,
  PEAC_SOLUTIONS_SLUG,
  peacSolutionsAdapter,
  peacSolutionsApplicationId,
  peekFixture,
  PROVIDER_STATUS_MAP,
  resetPeacSolutionsFixtures,
  setPeacSolutionsFixture,
  SYNTHETIC_OFFER_TERMS,
} from "../../src/lib/mca/submissions/adapters/peac-solutions"

const SSN = "123456789"
const SECOND_SSN = "111223333"
const THIRD_SSN = "987654321"
const API_KEY = "peac-solutions-development-token-never-leak"

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
    entityType: "llc",
    industry: "Food Services",
    startDate: "2019-06-01",
    contactPhone: "2125550199",
    businessEmail: "ops@harborcoffee.example",
    ein: "12-3456789",
    address: { line1: "100 Front Street", city: "New York", state: "NY", postalCode: "10004" },
    annualRevenue: 720000,
    requestedAmount: 75000,
    fundingPurpose: "Working Capital",
    owners: [
      owner({ firstName: "Sam", lastName: "Lee", ownershipPercent: 20, isPrimary: false, email: "sam.lee@merchant.example", ssn: SECOND_SSN }),
      owner({ firstName: "Alex", lastName: "Rivera", ownershipPercent: 55, isPrimary: true }),
      owner({ firstName: "Jordan", lastName: "Nguyen", ownershipPercent: 25, isPrimary: false, email: "jordan.nguyen@merchant.example", ssn: THIRD_SSN }),
    ],
    ...overrides,
  }
}

function job(overrides: Partial<SubmissionJob> = {}): SubmissionJob {
  return {
    id: overrides.id ?? "job-peac-1",
    workspaceId: overrides.workspaceId ?? "workspace-peac",
    dealId: overrides.dealId ?? "deal-peac-1",
    funderId: overrides.funderId ?? "funder-peac-1",
    displayFunderName: overrides.displayFunderName ?? "PEAC Solutions",
    routeKind: "api",
    route: overrides.route ?? {
      id: "route-peac",
      kind: "api",
      label: "API",
      destination: PEAC_SOLUTIONS_SLUG,
      documentExceptions: [],
      active: true,
    },
    state: overrides.state ?? "sending",
    confirmationKey: overrides.confirmationKey ?? "conf-peac-1",
    attemptKey: overrides.attemptKey ?? "attempt-peac-1",
    dealVersion: overrides.dealVersion ?? 1,
    documentVersions: overrides.documentVersions ?? [],
    packageDocumentIds: overrides.packageDocumentIds ?? [],
    preflightErrors: overrides.preflightErrors ?? [],
    createdAt: overrides.createdAt ?? "2026-01-01T00:00:00.000Z",
    updatedAt: overrides.updatedAt ?? "2026-01-01T00:00:00.000Z",
    ...overrides,
  }
}

function runtime(secrets: AdapterRuntime["secrets"], correlationId = "corr-peac-1"): AdapterRuntime {
  return {
    credentialId: "cred-peac-1",
    workspaceId: "workspace-peac",
    funderId: "funder-peac-1",
    adapterSlug: PEAC_SOLUTIONS_SLUG,
    environment: "development",
    capabilities: peacSolutionsAdapter.capabilities,
    secrets,
    correlationId,
  }
}

function assertNoSecrets(value: unknown) {
  const serialized = typeof value === "string" ? value : JSON.stringify(value)
  assert.equal(serialized.includes(API_KEY), false)
  assert.equal(serialized.includes(EXPIRED_CREDENTIAL_TOKEN), false)
  assert.equal(serialized.includes(SSN), false)
  assert.equal(serialized.includes(SECOND_SSN), false)
  assert.equal(serialized.includes(THIRD_SSN), false)
}

beforeEach(() => {
  resetPeacSolutionsFixtures()
})

test("MIC-138: required-field rejection", () => {
  const empty = peacSolutionsAdapter.validate({})
  assert.equal(empty.ok, false)
  if (empty.ok) throw new Error("expected field errors")
  assert.equal(empty.fields.legalName, "Business name is required.")
  assert.equal(empty.fields.entityType, "Entity type is required.")
  assert.equal(empty.fields.phone, "Business phone is required.")
  assert.equal(empty.fields.businessEmail, "Business email is required.")
  assert.equal(empty.fields.fundingPurpose, "Purpose of funds is required.")
  assert.equal(empty.fields.requestedAmount, "Requested amount is required.")
  assert.equal(empty.fields.annualRevenue, "Enter annual revenue, monthly revenue, or statement deposit totals.")
  assert.equal(empty.fields.owners, "At least one business owner is required.")
  assert.equal(empty.fields["address.line1"], "Business street is required.")

  const fourOwners = peacSolutionsAdapter.validate(application({
    owners: [owner(), owner({ firstName: "Sam", email: "sam@merchant.example", ssn: SECOND_SSN, isPrimary: false, ownershipPercent: 20 }), owner({ firstName: "Jordan", email: "jordan@merchant.example", ssn: THIRD_SSN, isPrimary: false, ownershipPercent: 15 }), owner({ firstName: "Riley", email: "riley@merchant.example", ssn: "555667777", isPrimary: false, ownershipPercent: 5 })],
  }))
  assert.equal(fourOwners.ok, false)
  if (fourOwners.ok) throw new Error("expected owner cap")
  assert.equal(fourOwners.fields.owners, "PEAC Solutions accepts at most three owners.")
  assert.equal(MAX_OWNERS, 3)
  assert.equal(MIN_REPRESENTED_OWNERSHIP, 50)
  assert.equal(MAX_REQUESTED_AMOUNT, 250000)

  const underOwned = peacSolutionsAdapter.validate(application({
    owners: [
      owner({ ownershipPercent: 25 }),
      owner({ firstName: "Sam", lastName: "Lee", email: "sam.lee@merchant.example", ssn: SECOND_SSN, isPrimary: false, ownershipPercent: 24 }),
    ],
  }))
  assert.equal(underOwned.ok, false)
  if (underOwned.ok) throw new Error("expected ownership floor")
  assert.equal(underOwned.fields.owners, "Represented ownership must be at least 50%.")

  const overAmount = peacSolutionsAdapter.validate(application({ requestedAmount: 250001 }))
  assert.equal(overAmount.ok, false)
  if (overAmount.ok) throw new Error("expected amount bound")
  assert.equal(overAmount.fields.requestedAmount, "Requested amount must be at most $250,000.")

  const fromMonthly = peacSolutionsAdapter.validate(application({ annualRevenue: undefined, monthlyRevenue: 60000 }))
  assert.equal(fromMonthly.ok, true)

  const fromStatements = peacSolutionsAdapter.validate(application({
    annualRevenue: undefined,
    monthlyRevenue: undefined,
    statementDeposits: [58000, 61000, 60000],
  }))
  assert.equal(fromStatements.ok, true)

  const invalid = peacSolutionsAdapter.validate(application({
    fundingPurpose: "",
    requestedAmount: 0,
    ein: "12-345",
    owners: [owner({ ssn: "1234", firstName: "", ownershipPercent: undefined })],
  }))
  assert.equal(invalid.ok, false)
  if (invalid.ok) throw new Error("expected invalid field errors")
  assert.equal(invalid.fields.fundingPurpose, "Purpose of funds is required.")
  assert.equal(invalid.fields.requestedAmount, "Requested amount must be greater than zero.")
  assert.equal(invalid.fields.ein, "EIN must contain 9 digits.")
  assert.equal(invalid.fields["owners.0.firstName"], "Owner first name is required.")
  assert.equal(invalid.fields["owners.0.ssn"], "Owner SSN must contain 9 digits.")
  assert.equal(invalid.fields["owners.0.ownershipPercent"], "Owner ownership percentage is required.")
  assert.equal(peacSolutionsAdapter.validate(application()).ok, true)
})

test("MIC-138: accepted submission maps three owners, purpose, and offer-capable flags", async () => {
  assert.equal(peacSolutionsAdapter.slug, "peac-solutions")
  assert.deepEqual(peacSolutionsAdapter.capabilities, {
    submit: true,
    statusPoll: true,
    webhooks: false,
    offers: true,
  })
  assert.equal(typeof peacSolutionsAdapter.getStatus, "function")
  assert.equal(peacSolutionsAdapter.parseWebhook, undefined)
  assert.equal(PEAC_SOLUTIONS_FIXTURE_TRANSPORT.startsWith("fixture://"), true)

  const payload = application()
  bindPeacSolutionsApplication("attempt-peac-1", payload)
  const submitted = await runWithAdapterRuntime(runtime({ apiKey: API_KEY }), () => peacSolutionsAdapter.submit(job()))
  assert.equal(submitted.ok, true)
  assert.equal(submitted.correlationId, "corr-peac-1")
  assert.equal(submitted.externalRef, peacSolutionsApplicationId("attempt-peac-1"))
  assert.equal(submitted.rawStatus, "In Process")
  assert.equal(mapProviderStatus(submitted.rawStatus ?? "").normalized, "submitted")
  assertNoSecrets(submitted)

  const stored = peekFixture("attempt-peac-1")
  assert.ok(stored)
  assert.equal(stored.mapped?.entityType, "llc")
  assert.equal(stored.mapped?.fundingPurpose, "Working Capital")
  assert.equal(stored.mapped?.requestedAmount, 75000)
  assert.equal(stored.mapped?.annualRevenue, 720000)
  assert.equal(stored.mapped?.representedOwnership, 100)
  assert.deepEqual(stored.mapped?.owners, [
    { firstName: "Sam", lastName: "Lee", ownershipPercent: 20 },
    { firstName: "Alex", lastName: "Rivera", ownershipPercent: 55 },
    { firstName: "Jordan", lastName: "Nguyen", ownershipPercent: 25 },
  ])
  assert.equal(stored.mapped?.owners?.length, 3)
  assert.equal(JSON.stringify(stored.mapped).includes(SSN), false)

  const status = await runWithAdapterRuntime(runtime({ apiKey: API_KEY }, "corr-status-1"), () => peacSolutionsAdapter.getStatus!(job()))
  assert.equal(status.normalized, "submitted")
  assert.equal(status.rawStatus, "In Process")
  assert.equal(status.unknown, false)
  assert.equal(status.terms, undefined)
  assert.equal(status.correlationId, "corr-status-1")
  assert.equal(status.eventId, "peac-event-attempt-peac-1")
  assertNoSecrets(status)
})

test("MIC-138: recommended document receipt is stable on replay", async () => {
  const attempt = job({
    attemptKey: "attempt-docs",
    packageDocumentIds: ["doc-app", "doc-bank"],
    documentVersions: [
      { documentId: "doc-app", checksum: "checksum-app", category: "api_application" },
      { documentId: "doc-bank", checksum: "checksum-bank", category: "statement" },
    ],
  })
  bindPeacSolutionsApplication("attempt-docs", application())
  const first = await peacSolutionsAdapter.submit(attempt)
  assert.equal(first.ok, true)
  assert.equal(first.fields?.["documents.0.documentId"], "doc-app")
  assert.equal(first.fields?.["documents.0.category"], "application")
  assert.equal(first.fields?.["documents.0.receiptId"], "peac_doc_attempt-docs_doc-app")
  assert.equal(first.fields?.["documents.1.documentId"], "doc-bank")
  assert.equal(first.fields?.["documents.1.category"], "bank_statements")
  assert.equal(first.fields?.["documents.1.receiptId"], "peac_doc_attempt-docs_doc-bank")
  assertNoSecrets(first)

  const replay = await peacSolutionsAdapter.submit(attempt)
  assert.equal(replay.ok, true)
  assert.equal(replay.externalRef, first.externalRef)
  assert.deepEqual(replay.fields, first.fields)
  assert.deepEqual(listFixtureExternalRefs(), ["peac_attempt-docs"])
  assert.equal(peekFixture("attempt-docs")?.submitCalls, 2)
  assert.equal(fixtureSubmitCallCount(), 2)

  const withoutDocs = peacSolutionsAdapter.validate(application({ documents: undefined }))
  assert.equal(withoutDocs.ok, true)
  const noDocSubmit = await peacSolutionsAdapter.submit(job({ attemptKey: "attempt-no-docs" }))
  assert.equal(noDocSubmit.ok, true)
  assert.equal(noDocSubmit.fields, undefined)
})

test("MIC-138: timeout, expired credential, and replay do not duplicate submissions", async () => {
  const timeoutJob = job({
    attemptKey: "attempt-timeout",
    route: {
      id: "route-peac-timeout",
      kind: "api",
      label: "API",
      destination: "peac-solutions:timeout",
      documentExceptions: [],
      active: true,
    },
  })
  const timedOut = await peacSolutionsAdapter.submit(timeoutJob)
  assert.equal(timedOut.ok, false)
  assert.equal(timedOut.errorCode, "provider_unavailable")
  assert.match(timedOut.errorMessage ?? "", /timed out/i)
  assert.equal(timedOut.externalRef, "peac_attempt-timeout")

  const recovered = await peacSolutionsAdapter.submit(timeoutJob)
  assert.equal(recovered.ok, true)
  assert.equal(recovered.externalRef, timedOut.externalRef)
  assert.deepEqual(listFixtureExternalRefs(), ["peac_attempt-timeout"])

  const expiredJob = job({ attemptKey: "attempt-expired" })
  const expired = await runWithAdapterRuntime(runtime({ apiKey: EXPIRED_CREDENTIAL_TOKEN }, "corr-expired"), () => peacSolutionsAdapter.submit(expiredJob))
  assert.equal(expired.ok, false)
  assert.equal(expired.errorCode, "provider_unavailable")
  assert.match(expired.errorMessage ?? "", /expired/i)
  assert.equal(expired.externalRef, undefined)
  assert.equal(expired.correlationId, "corr-expired")
  assertNoSecrets(expired)
  await assert.rejects(
    () => runWithAdapterRuntime(runtime({ apiKey: EXPIRED_CREDENTIAL_TOKEN }), () => peacSolutionsAdapter.getStatus!(expiredJob)),
    (error: { status?: number; code?: string; message?: string }) => (
      error.status === 503 && error.code === "provider_unavailable" && /expired/i.test(error.message ?? "")
    ),
  )
  assert.equal(listFixtureExternalRefs().includes("peac_attempt-expired"), false)

  const acceptedJob = job({ attemptKey: "attempt-replay" })
  bindPeacSolutionsApplication("attempt-replay", application())
  const first = await peacSolutionsAdapter.submit(acceptedJob)
  const replay = await runWithAdapterRuntime(runtime({ apiKey: EXPIRED_CREDENTIAL_TOKEN }, "corr-replay"), () => peacSolutionsAdapter.submit(acceptedJob))
  assert.equal(first.ok, true)
  assert.equal(replay.ok, true)
  assert.equal(replay.externalRef, first.externalRef)
  assert.equal(replay.correlationId, "corr-replay")
  assert.deepEqual(new Set(listFixtureExternalRefs()), new Set(["peac_attempt-timeout", "peac_attempt-replay"]))
  assertNoSecrets(replay)

  setPeacSolutionsFixture("peac-solutions:expired-credential")
  const destinationExpired = await peacSolutionsAdapter.submit(job({ attemptKey: "attempt-expired-destination" }))
  assert.equal(destinationExpired.ok, false)
  assert.equal(destinationExpired.externalRef, undefined)
})

test("MIC-138: maps process/stips/offers/declines and preserves unknown outcomes", async () => {
  assert.equal(mapProviderStatus("In Process").normalized, "submitted")
  assert.equal(mapProviderStatus("Incomplete").normalized, "pending")
  assert.equal(mapProviderStatus("Booked").normalized, "approved")
  assert.equal(mapProviderStatus("Offers Ready").normalized, "approved")
  assert.equal(mapProviderStatus("Offers Selected").normalized, "approved")
  assert.equal(mapProviderStatus("Contracts Out").normalized, "approved")
  assert.equal(mapProviderStatus("Final Diligence").normalized, "approved")
  assert.equal(mapProviderStatus("In Pricing").normalized, "approved")
  assert.equal(mapProviderStatus("Ready for Funding").normalized, "approved")
  assert.equal(mapProviderStatus("Funded").normalized, "funded")
  assert.equal(mapProviderStatus("Withdrawn").normalized, "declined")
  assert.equal(mapProviderStatus("No PQ Offers Available").normalized, "declined")
  assert.equal(Object.keys(PROVIDER_STATUS_MAP).length, 12)
  assert.equal(mapProviderStatus("CREDIT_COMMITTEE_HOLD").unknown, true)

  const pending = mapProviderStatus("Incomplete", ["bank statements", "application"])
  assert.equal(pending.normalized, "pending")
  assert.equal(pending.unknown, false)
  assert.match(pending.rawStatus, /outstanding stipulations/)
  assert.match(pending.rawStatus, /bank statements/)

  const incompleteJob = job({
    attemptKey: "attempt-incomplete",
    route: {
      id: "route-peac-incomplete",
      kind: "api",
      label: "API",
      destination: "peac-solutions:incomplete",
      documentExceptions: [],
      active: true,
    },
  })
  const incompleteSubmit = await peacSolutionsAdapter.submit(incompleteJob)
  assert.equal(incompleteSubmit.ok, true)
  assert.equal(incompleteSubmit.rawStatus, "Incomplete")
  const incomplete = await peacSolutionsAdapter.getStatus!(incompleteJob)
  assert.equal(incomplete.normalized, "pending")
  assert.equal(incomplete.unknown, false)
  assert.equal(incomplete.terms, undefined)
  assert.match(incomplete.rawStatus, /outstanding stipulations/)
  assert.match(incomplete.rawStatus, /application/)

  const offersJob = job({
    attemptKey: "attempt-offers",
    route: {
      id: "route-peac-offers",
      kind: "api",
      label: "API",
      destination: "peac-solutions:offers-ready",
      documentExceptions: [],
      active: true,
    },
  })
  const offersSubmit = await peacSolutionsAdapter.submit(offersJob)
  assert.equal(offersSubmit.ok, true)
  assert.equal(offersSubmit.rawStatus, "Offers Ready")
  const offers = await peacSolutionsAdapter.getStatus!(offersJob)
  assert.equal(offers.normalized, "approved")
  assert.equal(offers.unknown, false)
  assert.equal(offers.terms?.amount, SYNTHETIC_OFFER_TERMS.amount)
  assert.equal(offers.terms?.rate, SYNTHETIC_OFFER_TERMS.rate)
  assert.equal(offers.terms?.term, SYNTHETIC_OFFER_TERMS.term)
  assert.equal(offers.terms?.offerLink, SYNTHETIC_OFFER_TERMS.offerLink)

  const bookedJob = job({
    attemptKey: "attempt-booked",
    route: {
      id: "route-peac-booked",
      kind: "api",
      label: "API",
      destination: "peac-solutions:booked",
      documentExceptions: [],
      active: true,
    },
  })
  await peacSolutionsAdapter.submit(bookedJob)
  const booked = await peacSolutionsAdapter.getStatus!(bookedJob)
  assert.equal(booked.normalized, "approved")
  assert.equal(booked.terms?.offerLink, SYNTHETIC_OFFER_TERMS.offerLink)

  const fundedJob = job({
    attemptKey: "attempt-funded",
    route: {
      id: "route-peac-funded",
      kind: "api",
      label: "API",
      destination: "peac-solutions:funded",
      documentExceptions: [],
      active: true,
    },
  })
  await peacSolutionsAdapter.submit(fundedJob)
  const funded = await peacSolutionsAdapter.getStatus!(fundedJob)
  assert.equal(funded.normalized, "funded")
  assert.equal(funded.terms?.amount, SYNTHETIC_OFFER_TERMS.amount)

  const declinedJob = job({
    attemptKey: "attempt-declined",
    route: {
      id: "route-peac-declined",
      kind: "api",
      label: "API",
      destination: "peac-solutions:no-pq-offers",
      documentExceptions: [],
      active: true,
    },
  })
  await peacSolutionsAdapter.submit(declinedJob)
  const declined = await peacSolutionsAdapter.getStatus!(declinedJob)
  assert.equal(declined.rawStatus, "No PQ Offers Available")
  assert.equal(declined.normalized, "declined")
  assert.equal(declined.terms, undefined)

  const withdrawnJob = job({
    attemptKey: "attempt-withdrawn",
    route: {
      id: "route-peac-withdrawn",
      kind: "api",
      label: "API",
      destination: "peac-solutions:withdrawn",
      documentExceptions: [],
      active: true,
    },
  })
  const withdrawnSubmit = await peacSolutionsAdapter.submit(withdrawnJob)
  assert.equal(withdrawnSubmit.ok, true)
  assert.equal(withdrawnSubmit.rawStatus, "Withdrawn")
  const withdrawn = await peacSolutionsAdapter.getStatus!(withdrawnJob)
  assert.equal(withdrawn.rawStatus, "Withdrawn")
  assert.equal(withdrawn.normalized, "declined")
  assert.equal(withdrawn.terms, undefined)

  const unknown = mapProviderStatus("CREDIT_COMMITTEE_HOLD")
  assert.deepEqual(unknown, { rawStatus: "CREDIT_COMMITTEE_HOLD", normalized: "unknown", unknown: true })
})
