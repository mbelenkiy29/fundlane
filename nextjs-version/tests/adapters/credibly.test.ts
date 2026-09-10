import test, { beforeEach } from "node:test"
import assert from "node:assert/strict"
import type { AdapterRuntime } from "../../src/lib/mca/submissions/adapters/contracts"
import { runWithAdapterRuntime } from "../../src/lib/mca/submissions/adapters/credentials"
import type { SubmissionJob } from "../../src/lib/mca/submissions/contracts"
import {
  bindCrediblyApplication,
  CREDIBLY_API_VERSION,
  CREDIBLY_SLUG,
  crediblyAdapter,
  crediblyLoanId,
  crediblyPortalUrl,
  EXPIRED_CREDENTIAL_TOKEN,
  fixtureSubmitCallCount,
  listFixtureExternalRefs,
  mapEntityType,
  mapProviderStatus,
  peekFixture,
  PROVIDER_STATUS_MAP,
  resetCrediblyFixtures,
  setCrediblyFixture,
} from "../../src/lib/mca/submissions/adapters/credibly"

const SSN = "123456789"
const API_KEY = "credibly-development-token-never-leak"

function owner(overrides: Record<string, unknown> = {}) {
  return {
    firstName: "Alex",
    lastName: "Rivera",
    ownershipPercent: 60,
    dateOfBirth: "1984-04-12",
    ssn: SSN,
    email: "alex.rivera@merchant.example",
    phone: "2125550101",
    address: { line1: "10 Owner Way", city: "New York", state: "NY", postalCode: "10001" },
    ...overrides,
  }
}

function position(overrides: Record<string, unknown> = {}) {
  return {
    label: "Rapid Capital",
    estimatedPayment: 1200,
    ...overrides,
  }
}

function application(overrides: Record<string, unknown> = {}) {
  return {
    legalName: "Harbor Coffee LLC",
    ein: "12-3456789",
    entityType: "s_corporation",
    industry: "Food Services",
    startDate: "2019-06-01",
    contactPhone: "2125550199",
    address: { line1: "100 Front Street", city: "New York", state: "NY", postalCode: "10004" },
    owners: [owner()],
    positions: [position()],
    documents: [
      { documentId: "doc-app", category: "api_application", checksum: "checksum-app" },
      { documentId: "doc-bank", category: "statement", checksum: "checksum-bank" },
    ],
    ...overrides,
  }
}

function job(overrides: Partial<SubmissionJob> = {}): SubmissionJob {
  return {
    id: overrides.id ?? "job-crd-1",
    workspaceId: overrides.workspaceId ?? "workspace-crd",
    dealId: overrides.dealId ?? "deal-crd-1",
    funderId: overrides.funderId ?? "funder-crd-1",
    displayFunderName: overrides.displayFunderName ?? "Credibly",
    routeKind: "api",
    route: overrides.route ?? {
      id: "route-crd",
      kind: "api",
      label: "API",
      destination: CREDIBLY_SLUG,
      documentExceptions: [],
      active: true,
    },
    state: overrides.state ?? "sending",
    confirmationKey: overrides.confirmationKey ?? "conf-crd-1",
    attemptKey: overrides.attemptKey ?? "attempt-crd-1",
    dealVersion: overrides.dealVersion ?? 1,
    documentVersions: overrides.documentVersions ?? [],
    packageDocumentIds: overrides.packageDocumentIds ?? [],
    preflightErrors: overrides.preflightErrors ?? [],
    createdAt: overrides.createdAt ?? "2026-01-01T00:00:00.000Z",
    updatedAt: overrides.updatedAt ?? "2026-01-01T00:00:00.000Z",
    ...overrides,
  }
}

function runtime(secrets: AdapterRuntime["secrets"], correlationId = "corr-crd-1"): AdapterRuntime {
  return {
    credentialId: "cred-crd-1",
    workspaceId: "workspace-crd",
    funderId: "funder-crd-1",
    adapterSlug: CREDIBLY_SLUG,
    environment: "development",
    capabilities: crediblyAdapter.capabilities,
    secrets,
    correlationId,
  }
}

function assertNoSecrets(value: unknown) {
  const text = typeof value === "string" ? value : JSON.stringify(value)
  assert.equal(text.includes(API_KEY), false)
  assert.equal(text.includes(EXPIRED_CREDENTIAL_TOKEN), false)
  assert.equal(text.includes(SSN), false)
  assert.equal(text.includes("111223333"), false)
}

beforeEach(() => {
  resetCrediblyFixtures()
})

test("MIC-145: required-field rejection", () => {
  const empty = crediblyAdapter.validate({})
  assert.equal(empty.ok, false)
  if (empty.ok) throw new Error("expected field errors")
  assert.equal(empty.fields.legalName, "Business name is required.")
  assert.equal(empty.fields.industry, "Industry is required.")
  assert.equal(empty.fields.ein, "EIN / Tax ID is required.")
  assert.equal(empty.fields.entityType, "Entity type is required.")
  assert.equal(empty.fields.startDate, "Business start date is required.")
  assert.equal(empty.fields.owners, "At least one business owner is required.")
  assert.equal(empty.fields.positions, "Available positions are required.")
  assert.equal(empty.fields["documents.application"], "An application file is required.")
  assert.equal(empty.fields["documents.bankStatements"], "Bank statements are required.")

  const invalid = crediblyAdapter.validate(application({
    ein: "12-345",
    industry: "",
    owners: [owner({ ssn: "1234", firstName: "", ownershipPercent: undefined, address: { line1: "", city: "", state: "", postalCode: "" } })],
    positions: [position({ label: "", estimatedPayment: undefined })],
    documents: [{ documentId: "doc-app", category: "api_application", checksum: "checksum-app" }],
  }))
  assert.equal(invalid.ok, false)
  if (invalid.ok) throw new Error("expected invalid field errors")
  assert.equal(invalid.fields.ein, "EIN must contain 9 digits.")
  assert.equal(invalid.fields.industry, "Industry is required.")
  assert.equal(invalid.fields["owners.0.firstName"], "Owner first name is required.")
  assert.equal(invalid.fields["owners.0.street"], "Owner street is required.")
  assert.equal(invalid.fields["owners.0.ssn"], "Owner SSN must contain 9 digits.")
  assert.equal(invalid.fields["owners.0.ownershipPercent"], "Owner ownership percentage is required.")
  assert.equal(invalid.fields["positions.0.label"], "Position label is required.")
  assert.equal(invalid.fields["positions.0.estimatedPayment"], "Position payment is required.")
  assert.equal(invalid.fields["documents.bankStatements"], "Bank statements are required.")

  assert.equal(crediblyAdapter.validate(application({ positions: [] })).ok, true)
  assert.equal(crediblyAdapter.validate(application()).ok, true)
})

test("MIC-145: accepted submission maps Loan ID, files, positions, and status-only capabilities", async () => {
  assert.equal(crediblyAdapter.slug, "credibly")
  assert.deepEqual(crediblyAdapter.capabilities, {
    submit: true,
    statusPoll: true,
    webhooks: false,
    offers: false,
  })
  assert.equal(typeof crediblyAdapter.getStatus, "function")
  assert.equal(crediblyAdapter.parseWebhook, undefined)
  assert.equal(mapEntityType("s_corporation"), "Corporation")
  assert.equal(mapEntityType("nonprofit"), "Other")
  assert.equal(CREDIBLY_API_VERSION, "v2")

  const payload = application()
  bindCrediblyApplication("attempt-crd-1", payload)
  const submitted = await runWithAdapterRuntime(runtime({ apiKey: API_KEY }), () => crediblyAdapter.submit(job()))
  assert.equal(submitted.ok, true)
  assert.equal(submitted.correlationId, "corr-crd-1")
  assert.equal(submitted.externalRef, crediblyLoanId("attempt-crd-1"))
  assert.equal(submitted.rawStatus, "Submitted")
  assert.equal(submitted.fields?.loanId, "crd_attempt-crd-1")
  assert.equal(submitted.fields?.portalUrl, crediblyPortalUrl("crd_attempt-crd-1"))
  assertNoSecrets(submitted)

  const stored = peekFixture("attempt-crd-1")
  assert.ok(stored)
  assert.equal(stored.mapped?.apiVersion, "v2")
  assert.equal(stored.mapped?.entityType, "Corporation")
  assert.equal(stored.mapped?.industry, "Food Services")
  assert.deepEqual(stored.mapped?.owners, [
    { firstName: "Alex", lastName: "Rivera", ownershipPercent: 60 },
  ])
  assert.deepEqual(stored.mapped?.positions, [
    { label: "Rapid Capital", estimatedPayment: 1200 },
  ])
  assert.equal(JSON.stringify(stored.mapped).includes(SSN), false)

  const status = await runWithAdapterRuntime(runtime({ apiKey: API_KEY }, "corr-status-1"), () => crediblyAdapter.getStatus!(job()))
  assert.equal(status.normalized, "submitted")
  assert.equal(status.rawStatus, "Submitted")
  assert.equal(status.unknown, false)
  assert.equal(status.terms, undefined)
  assert.equal(status.correlationId, "corr-status-1")
  assert.equal(status.eventId, "crd-event-attempt-crd-1")
  assertNoSecrets(status)
})

test("MIC-145: document receipt is stable on replay", async () => {
  const attempt = job({
    attemptKey: "attempt-docs",
    packageDocumentIds: ["doc-app", "doc-bank"],
    documentVersions: [
      { documentId: "doc-app", checksum: "checksum-app", category: "api_application" },
      { documentId: "doc-bank", checksum: "checksum-bank", category: "statement" },
    ],
  })
  bindCrediblyApplication("attempt-docs", application())
  const first = await crediblyAdapter.submit(attempt)
  assert.equal(first.ok, true)
  assert.equal(first.fields?.["documents.0.documentId"], "doc-app")
  assert.equal(first.fields?.["documents.0.category"], "application")
  assert.equal(first.fields?.["documents.0.receiptId"], "crd_doc_attempt-docs_doc-app")
  assert.equal(first.fields?.["documents.1.documentId"], "doc-bank")
  assert.equal(first.fields?.["documents.1.category"], "bank_statements")
  assert.equal(first.fields?.["documents.1.receiptId"], "crd_doc_attempt-docs_doc-bank")
  assert.equal(first.fields?.loanId, first.externalRef)
  assert.equal(first.fields?.portalUrl, crediblyPortalUrl("crd_attempt-docs"))
  assertNoSecrets(first)

  const replay = await crediblyAdapter.submit(attempt)
  assert.equal(replay.ok, true)
  assert.equal(replay.externalRef, first.externalRef)
  assert.equal(replay.fields?.portalUrl, first.fields?.portalUrl)
  assert.deepEqual(replay.fields, first.fields)
  assert.deepEqual(listFixtureExternalRefs(), ["crd_attempt-docs"])
  assert.equal(peekFixture("attempt-docs")?.submitCalls, 2)
  assert.equal(fixtureSubmitCallCount(), 2)

  const missingDocs = await crediblyAdapter.submit(job({
    attemptKey: "attempt-missing-docs",
    documentVersions: [{ documentId: "doc-other", checksum: "checksum-other", category: "voided_check" }],
  }))
  assert.equal(missingDocs.ok, false)
  assert.equal(missingDocs.errorCode, "validation_failed")
  assert.equal(missingDocs.fields?.["documents.application"], "An application file is required.")
  assert.equal(missingDocs.fields?.["documents.bankStatements"], "Bank statements are required.")
  assert.equal(listFixtureExternalRefs().includes("crd_attempt-missing-docs"), false)
})

test("MIC-145: timeout, expired credential, and replay do not duplicate submissions", async () => {
  const timeoutJob = job({
    attemptKey: "attempt-timeout",
    route: {
      id: "route-crd-timeout",
      kind: "api",
      label: "API",
      destination: "credibly:timeout",
      documentExceptions: [],
      active: true,
    },
  })
  const timedOut = await crediblyAdapter.submit(timeoutJob)
  assert.equal(timedOut.ok, false)
  assert.equal(timedOut.errorCode, "provider_unavailable")
  assert.match(timedOut.errorMessage ?? "", /timed out/i)
  assert.equal(timedOut.externalRef, "crd_attempt-timeout")

  const recovered = await crediblyAdapter.submit(timeoutJob)
  assert.equal(recovered.ok, true)
  assert.equal(recovered.externalRef, timedOut.externalRef)
  assert.equal(recovered.fields?.loanId, "crd_attempt-timeout")
  assert.deepEqual(listFixtureExternalRefs(), ["crd_attempt-timeout"])

  const expiredJob = job({ attemptKey: "attempt-expired" })
  const expired = await runWithAdapterRuntime(runtime({ apiKey: EXPIRED_CREDENTIAL_TOKEN }, "corr-expired"), () => crediblyAdapter.submit(expiredJob))
  assert.equal(expired.ok, false)
  assert.equal(expired.errorCode, "provider_unavailable")
  assert.match(expired.errorMessage ?? "", /expired/i)
  assert.equal(expired.externalRef, undefined)
  assert.equal(expired.correlationId, "corr-expired")
  assertNoSecrets(expired)
  await assert.rejects(
    () => runWithAdapterRuntime(runtime({ apiKey: EXPIRED_CREDENTIAL_TOKEN }), () => crediblyAdapter.getStatus!(expiredJob)),
    (error: { status?: number; code?: string; message?: string }) => (
      error.status === 503 && error.code === "provider_unavailable" && /expired/i.test(error.message ?? "")
    ),
  )
  assert.equal(listFixtureExternalRefs().includes("crd_attempt-expired"), false)

  const acceptedJob = job({ attemptKey: "attempt-replay" })
  bindCrediblyApplication("attempt-replay", application())
  const first = await crediblyAdapter.submit(acceptedJob)
  const replay = await runWithAdapterRuntime(runtime({ apiKey: EXPIRED_CREDENTIAL_TOKEN }, "corr-replay"), () => crediblyAdapter.submit(acceptedJob))
  assert.equal(first.ok, true)
  assert.equal(replay.ok, true)
  assert.equal(replay.externalRef, first.externalRef)
  assert.equal(replay.correlationId, "corr-replay")
  assert.deepEqual(new Set(listFixtureExternalRefs()), new Set(["crd_attempt-timeout", "crd_attempt-replay"]))
  assertNoSecrets(replay)

  setCrediblyFixture("credibly:expired-credential")
  const destinationExpired = await crediblyAdapter.submit(job({ attemptKey: "attempt-expired-destination" }))
  assert.equal(destinationExpired.ok, false)
  assert.equal(destinationExpired.externalRef, undefined)
})

test("MIC-145: prequalified and Offers Ready do not create priced offers", async () => {
  assert.deepEqual(mapProviderStatus("Submitted"), { rawStatus: "Submitted", normalized: "submitted", unknown: false })
  assert.deepEqual(mapProviderStatus("Prequalified"), { rawStatus: "Prequalified", normalized: "pending", unknown: false })
  assert.deepEqual(mapProviderStatus("Offers Ready"), { rawStatus: "Offers Ready", normalized: "approved", unknown: false })
  assert.deepEqual(mapProviderStatus("Declined"), { rawStatus: "Declined", normalized: "declined", unknown: false })
  assert.deepEqual(mapProviderStatus("Funded"), { rawStatus: "Funded", normalized: "funded", unknown: false })
  assert.equal(mapProviderStatus("CREDIT_COMMITTEE_HOLD").unknown, true)
  assert.equal(Object.keys(PROVIDER_STATUS_MAP).length, 15)

  const prequalifiedJob = job({
    attemptKey: "attempt-prequalified",
    route: {
      id: "route-crd-pq",
      kind: "api",
      label: "API",
      destination: "credibly:prequalified",
      documentExceptions: [],
      active: true,
    },
  })
  bindCrediblyApplication("attempt-prequalified", application())
  const prequalified = await crediblyAdapter.submit(prequalifiedJob)
  assert.equal(prequalified.ok, true)
  assert.equal(prequalified.rawStatus, "Prequalified")
  assert.equal(prequalified.externalRef, "crd_attempt-prequalified")
  const prequalifiedStatus = await crediblyAdapter.getStatus!(prequalifiedJob)
  assert.equal(prequalifiedStatus.normalized, "pending")
  assert.equal(prequalifiedStatus.unknown, false)
  assert.equal(prequalifiedStatus.terms, undefined)
  assert.equal(prequalifiedStatus.rawStatus, "Prequalified")

  const offersJob = job({
    attemptKey: "attempt-offers-ready",
    route: {
      id: "route-crd-offers",
      kind: "api",
      label: "API",
      destination: "credibly:offers-ready",
      documentExceptions: [],
      active: true,
    },
  })
  bindCrediblyApplication("attempt-offers-ready", application())
  const offersReady = await crediblyAdapter.submit(offersJob)
  assert.equal(offersReady.ok, true)
  assert.equal(offersReady.rawStatus, "Offers Ready")
  const offersStatus = await crediblyAdapter.getStatus!(offersJob)
  assert.equal(offersStatus.normalized, "approved")
  assert.equal(offersStatus.unknown, false)
  assert.equal(offersStatus.terms, undefined)
  assert.equal(offersStatus.rawStatus, "Offers Ready")

  const declinedJob = job({
    attemptKey: "attempt-declined",
    route: {
      id: "route-crd-declined",
      kind: "api",
      label: "API",
      destination: "credibly:declined",
      documentExceptions: [],
      active: true,
    },
  })
  const declined = await crediblyAdapter.submit(declinedJob)
  assert.equal(declined.ok, true)
  assert.equal(declined.rawStatus, "Declined")
  const declinedStatus = await crediblyAdapter.getStatus!(declinedJob)
  assert.equal(declinedStatus.normalized, "declined")
  assert.equal(declinedStatus.terms, undefined)

  const missingJob = job({
    attemptKey: "attempt-missing-info",
    route: {
      id: "route-crd-missing",
      kind: "api",
      label: "API",
      destination: "credibly:outstanding-documents",
      documentExceptions: [],
      active: true,
    },
  })
  const submitted = await crediblyAdapter.submit(missingJob)
  assert.equal(submitted.ok, true)
  assert.equal(submitted.rawStatus, "In Review")
  const pending = await crediblyAdapter.getStatus!(missingJob)
  assert.equal(pending.normalized, "pending")
  assert.equal(pending.unknown, false)
  assert.equal(pending.terms, undefined)
  assert.match(pending.rawStatus, /outstanding document requests/)
  assert.match(pending.rawStatus, /bank statements/)

  const unknown = mapProviderStatus("Max Advance")
  assert.equal(unknown.unknown, true)
  assert.equal(unknown.normalized, "unknown")
  assert.equal(unknown.rawStatus, "Max Advance")
})
