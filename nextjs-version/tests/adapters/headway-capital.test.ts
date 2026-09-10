import test, { beforeEach } from "node:test"
import assert from "node:assert/strict"
import type { AdapterRuntime } from "../../src/lib/mca/submissions/adapters/contracts"
import { runWithAdapterRuntime } from "../../src/lib/mca/submissions/adapters/credentials"
import type { SubmissionJob } from "../../src/lib/mca/submissions/contracts"
import {
  bindHeadwayCapitalApplication,
  EXPIRED_CREDENTIAL_TOKEN,
  fixtureSubmitCallCount,
  HEADWAY_CAPITAL_SLUG,
  headwayCapitalAdapter,
  listFixtureExternalRefs,
  mapProviderStatus,
  peekFixture,
  PROVIDER_STATUS_MAP,
  resetHeadwayCapitalFixtures,
  setHeadwayCapitalFixture,
  SYNTHETIC_OFFER_TERMS,
} from "../../src/lib/mca/submissions/adapters/headway-capital"

const SSN = "123456789"
const USERNAME = "headway-iso-user"
const PASSWORD = "headway-development-password-never-leak"

function owner(overrides: Record<string, unknown> = {}) {
  return {
    firstName: "Alex",
    lastName: "Rivera",
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
    email: "ops@harborcoffee.example",
    ein: "12-3456789",
    entityType: "llc",
    industry: "Food Services",
    startDate: "2019-06-01",
    contactPhone: "2125550199",
    address: { line1: "100 Front Street", city: "New York", state: "NY", postalCode: "10004" },
    annualRevenue: 720000,
    requestedAmount: 50000,
    loanPurpose: "Working capital",
    owners: [owner()],
    documents: [
      { documentId: "doc-app", category: "api_application", checksum: "checksum-app" },
      { documentId: "doc-bank", category: "statement", checksum: "checksum-bank" },
    ],
    ...overrides,
  }
}

function job(overrides: Partial<SubmissionJob> = {}): SubmissionJob {
  return {
    id: overrides.id ?? "job-hwc-1",
    workspaceId: overrides.workspaceId ?? "workspace-hwc",
    dealId: overrides.dealId ?? "deal-hwc-1",
    funderId: overrides.funderId ?? "funder-hwc-1",
    displayFunderName: overrides.displayFunderName ?? "Headway Capital",
    routeKind: "api",
    route: overrides.route ?? {
      id: "route-hwc",
      kind: "api",
      label: "API",
      destination: HEADWAY_CAPITAL_SLUG,
      documentExceptions: [],
      active: true,
    },
    state: overrides.state ?? "sending",
    confirmationKey: overrides.confirmationKey ?? "conf-hwc-1",
    attemptKey: overrides.attemptKey ?? "attempt-hwc-1",
    dealVersion: overrides.dealVersion ?? 1,
    documentVersions: overrides.documentVersions ?? [],
    packageDocumentIds: overrides.packageDocumentIds ?? [],
    preflightErrors: overrides.preflightErrors ?? [],
    createdAt: overrides.createdAt ?? "2026-01-01T00:00:00.000Z",
    updatedAt: overrides.updatedAt ?? "2026-01-01T00:00:00.000Z",
    ...overrides,
  }
}

function runtime(secrets: AdapterRuntime["secrets"], correlationId = "corr-hwc-1"): AdapterRuntime {
  return {
    credentialId: "cred-hwc-1",
    workspaceId: "workspace-hwc",
    funderId: "funder-hwc-1",
    adapterSlug: HEADWAY_CAPITAL_SLUG,
    environment: "development",
    capabilities: headwayCapitalAdapter.capabilities,
    secrets,
    correlationId,
  }
}

function assertNoSecrets(value: unknown) {
  const text = typeof value === "string" ? value : JSON.stringify(value)
  assert.equal(text.includes(PASSWORD), false)
  assert.equal(text.includes(EXPIRED_CREDENTIAL_TOKEN), false)
  assert.equal(text.includes(SSN), false)
  assert.equal(text.includes("111223333"), false)
}

beforeEach(() => {
  resetHeadwayCapitalFixtures()
})

test("MIC-134: required-field rejection", () => {
  const empty = headwayCapitalAdapter.validate({})
  assert.equal(empty.ok, false)
  if (empty.ok) throw new Error("expected field errors")
  assert.equal(empty.fields.legalName, "Business name is required.")
  assert.equal(empty.fields.email, "Business email is required.")
  assert.equal(empty.fields.ein, "EIN / Tax ID is required.")
  assert.equal(empty.fields.annualRevenue, "Annual revenue is required.")
  assert.equal(empty.fields.requestedAmount, "Requested loan amount is required.")
  assert.equal(empty.fields.loanPurpose, "Loan purpose is required.")
  assert.equal(empty.fields.owners, "At least one business owner is required.")
  assert.equal(empty.fields["documents.application"], "An application file is required.")
  assert.equal(empty.fields["documents.bankStatements"], "Bank statements are required.")

  const invalid = headwayCapitalAdapter.validate(application({
    ein: "12-345",
    email: "not-an-email",
    annualRevenue: 0,
    requestedAmount: -10,
    owners: [owner({ ssn: "1234", firstName: "", email: "bad" })],
    documents: [{ documentId: "doc-app", category: "api_application", checksum: "checksum-app" }],
  }))
  assert.equal(invalid.ok, false)
  if (invalid.ok) throw new Error("expected invalid field errors")
  assert.equal(invalid.fields.ein, "EIN must contain 9 digits.")
  assert.equal(invalid.fields.email, "Enter a valid business email address.")
  assert.equal(invalid.fields.annualRevenue, "Annual revenue must be greater than 0.")
  assert.equal(invalid.fields.requestedAmount, "Requested loan amount must be greater than 0.")
  assert.equal(invalid.fields["owners.0.firstName"], "Owner first name is required.")
  assert.equal(invalid.fields["owners.0.ssn"], "Owner SSN must contain 9 digits.")
  assert.equal(invalid.fields["owners.0.email"], "Enter a valid owner email address.")
  assert.equal(invalid.fields["documents.bankStatements"], "Bank statements are required.")
  assert.equal(headwayCapitalAdapter.validate(application()).ok, true)
})

test("MIC-134: accepted submission maps account id, financials, and offer-capable status poll", async () => {
  assert.equal(headwayCapitalAdapter.slug, "headway-capital")
  assert.deepEqual(headwayCapitalAdapter.capabilities, {
    submit: true,
    statusPoll: true,
    webhooks: false,
    offers: true,
  })
  assert.equal(typeof headwayCapitalAdapter.getStatus, "function")
  assert.equal(headwayCapitalAdapter.parseWebhook, undefined)

  const payload = application({
    owners: [
      owner({ firstName: "Sam", lastName: "Lee", email: "sam.lee@merchant.example", ssn: "111223333" }),
      owner({ firstName: "Alex", lastName: "Rivera" }),
    ],
  })
  bindHeadwayCapitalApplication("attempt-hwc-1", payload)
  const submitted = await runWithAdapterRuntime(runtime({ username: USERNAME, password: PASSWORD }), () => headwayCapitalAdapter.submit(job()))
  assert.equal(submitted.ok, true)
  assert.equal(submitted.correlationId, "corr-hwc-1")
  assert.equal(submitted.externalRef, "hwc_attempt-hwc-1")
  assert.equal(submitted.rawStatus, "In Underwriting")
  assert.equal(submitted.fields?.accountId, "hwc_attempt-hwc-1")
  assert.notEqual(mapProviderStatus(submitted.rawStatus ?? "").normalized, "approved")
  assertNoSecrets(submitted)

  const stored = peekFixture("attempt-hwc-1")
  assert.ok(stored)
  assert.equal(stored.mapped?.legalName, "Harbor Coffee LLC")
  assert.equal(stored.mapped?.email, "ops@harborcoffee.example")
  assert.equal(stored.mapped?.entityType, "llc")
  assert.equal(stored.mapped?.annualRevenue, 720000)
  assert.equal(stored.mapped?.requestedAmount, 50000)
  assert.equal(stored.mapped?.loanPurpose, "Working capital")
  assert.deepEqual(stored.mapped?.owners, [
    { firstName: "Sam", lastName: "Lee" },
    { firstName: "Alex", lastName: "Rivera" },
  ])

  const status = await runWithAdapterRuntime(runtime({ username: USERNAME, password: PASSWORD }, "corr-status-1"), () => headwayCapitalAdapter.getStatus!(job()))
  assert.equal(status.normalized, "submitted")
  assert.equal(status.rawStatus, "In Underwriting")
  assert.equal(status.unknown, false)
  assert.equal(status.terms, undefined)
  assert.equal(status.correlationId, "corr-status-1")
  assert.equal(status.eventId, "hwc-event-attempt-hwc-1")
  assertNoSecrets(status)
})

test("MIC-134: document receipt is stable on replay", async () => {
  const attempt = job({
    attemptKey: "attempt-docs",
    packageDocumentIds: ["doc-app", "doc-bank"],
    documentVersions: [
      { documentId: "doc-app", checksum: "checksum-app", category: "api_application" },
      { documentId: "doc-bank", checksum: "checksum-bank", category: "statement" },
    ],
  })
  bindHeadwayCapitalApplication("attempt-docs", application({ owners: [owner()] }))
  const first = await headwayCapitalAdapter.submit(attempt)
  assert.equal(first.ok, true)
  assert.equal(first.fields?.accountId, "hwc_attempt-docs")
  assert.equal(first.fields?.["documents.0.documentId"], "doc-app")
  assert.equal(first.fields?.["documents.0.category"], "application")
  assert.equal(first.fields?.["documents.0.receiptId"], "hwc_doc_attempt-docs_doc-app")
  assert.equal(first.fields?.["documents.1.documentId"], "doc-bank")
  assert.equal(first.fields?.["documents.1.category"], "bank_statements")
  assert.equal(first.fields?.["documents.1.receiptId"], "hwc_doc_attempt-docs_doc-bank")
  assertNoSecrets(first)

  const replay = await headwayCapitalAdapter.submit(attempt)
  assert.equal(replay.ok, true)
  assert.equal(replay.externalRef, first.externalRef)
  assert.deepEqual(replay.fields, first.fields)
  assert.deepEqual(listFixtureExternalRefs(), ["hwc_attempt-docs"])
  assert.equal(peekFixture("attempt-docs")?.submitCalls, 2)
  assert.equal(fixtureSubmitCallCount(), 2)
})

test("MIC-134: timeout, expired credential, and replay do not duplicate submissions", async () => {
  const timeoutJob = job({
    attemptKey: "attempt-timeout",
    route: {
      id: "route-hwc-timeout",
      kind: "api",
      label: "API",
      destination: "headway-capital:timeout",
      documentExceptions: [],
      active: true,
    },
  })
  const timedOut = await headwayCapitalAdapter.submit(timeoutJob)
  assert.equal(timedOut.ok, false)
  assert.equal(timedOut.errorCode, "provider_unavailable")
  assert.match(timedOut.errorMessage ?? "", /timed out/i)
  assert.equal(timedOut.externalRef, "hwc_attempt-timeout")

  const recovered = await headwayCapitalAdapter.submit(timeoutJob)
  assert.equal(recovered.ok, true)
  assert.equal(recovered.externalRef, timedOut.externalRef)
  assert.deepEqual(listFixtureExternalRefs(), ["hwc_attempt-timeout"])

  const expiredJob = job({ attemptKey: "attempt-expired" })
  const expired = await runWithAdapterRuntime(runtime({ username: USERNAME, password: EXPIRED_CREDENTIAL_TOKEN }, "corr-expired"), () => headwayCapitalAdapter.submit(expiredJob))
  assert.equal(expired.ok, false)
  assert.equal(expired.errorCode, "provider_unavailable")
  assert.match(expired.errorMessage ?? "", /expired/i)
  assert.equal(expired.externalRef, undefined)
  assert.equal(expired.correlationId, "corr-expired")
  assertNoSecrets(expired)
  await assert.rejects(
    () => runWithAdapterRuntime(runtime({ username: USERNAME, password: EXPIRED_CREDENTIAL_TOKEN }), () => headwayCapitalAdapter.getStatus!(expiredJob)),
    (error: { status?: number; code?: string; message?: string }) => (
      error.status === 503 && error.code === "provider_unavailable" && /expired/i.test(error.message ?? "")
    ),
  )
  assert.equal(listFixtureExternalRefs().includes("hwc_attempt-expired"), false)

  const acceptedJob = job({ attemptKey: "attempt-replay" })
  bindHeadwayCapitalApplication("attempt-replay", application({ owners: [owner()] }))
  const first = await headwayCapitalAdapter.submit(acceptedJob)
  const replay = await runWithAdapterRuntime(runtime({ username: USERNAME, password: EXPIRED_CREDENTIAL_TOKEN }, "corr-replay"), () => headwayCapitalAdapter.submit(acceptedJob))
  assert.equal(first.ok, true)
  assert.equal(replay.ok, true)
  assert.equal(replay.externalRef, first.externalRef)
  assert.equal(replay.correlationId, "corr-replay")
  assert.deepEqual(new Set(listFixtureExternalRefs()), new Set(["hwc_attempt-timeout", "hwc_attempt-replay"]))
  assertNoSecrets(replay)

  setHeadwayCapitalFixture("headway-capital:expired-credential")
  const destinationExpired = await headwayCapitalAdapter.submit(job({ attemptKey: "attempt-expired-destination" }))
  assert.equal(destinationExpired.ok, false)
  assert.equal(destinationExpired.externalRef, undefined)
})

test("MIC-134: incomplete, underwriting, offer-ready, issued, and declined map without inventing terms", async () => {
  assert.deepEqual(mapProviderStatus("Application Incomplete"), { rawStatus: "Application Incomplete", normalized: "pending", unknown: false })
  assert.deepEqual(mapProviderStatus("In Underwriting"), { rawStatus: "In Underwriting", normalized: "submitted", unknown: false })
  assert.deepEqual(mapProviderStatus("Action Required"), { rawStatus: "Action Required", normalized: "pending", unknown: false })
  assert.deepEqual(mapProviderStatus("Offer Ready"), { rawStatus: "Offer Ready", normalized: "approved", unknown: false })
  assert.deepEqual(mapProviderStatus("Contract Unsigned"), { rawStatus: "Contract Unsigned", normalized: "approved", unknown: false })
  assert.deepEqual(mapProviderStatus("Funding Pending"), { rawStatus: "Funding Pending", normalized: "approved", unknown: false })
  assert.deepEqual(mapProviderStatus("Issued"), { rawStatus: "Issued", normalized: "funded", unknown: false })
  assert.deepEqual(mapProviderStatus("Declined"), { rawStatus: "Declined", normalized: "declined", unknown: false })
  assert.equal(mapProviderStatus("CREDIT_COMMITTEE_HOLD").unknown, true)
  assert.equal(Object.keys(PROVIDER_STATUS_MAP).length, 8)

  const pending = mapProviderStatus("Application Incomplete", ["bank statements", "application"])
  assert.equal(pending.normalized, "pending")
  assert.equal(pending.unknown, false)
  assert.match(pending.rawStatus, /bank statements/)
  assert.match(pending.rawStatus, /application/)

  async function statusFor(destination: string, attemptKey: string) {
    const next = job({
      attemptKey,
      route: {
        id: `route-${attemptKey}`,
        kind: "api",
        label: "API",
        destination,
        documentExceptions: [],
        active: true,
      },
    })
    const submitted = await headwayCapitalAdapter.submit(next)
    assert.equal(submitted.ok, true)
    return { submitted, status: await headwayCapitalAdapter.getStatus!(next) }
  }

  const incomplete = await statusFor("headway-capital:incomplete", "attempt-incomplete")
  assert.equal(incomplete.submitted.rawStatus, "Application Incomplete")
  assert.equal(incomplete.status.normalized, "pending")
  assert.equal(incomplete.status.terms, undefined)

  const actionRequired = await statusFor("headway-capital:action-required", "attempt-action")
  assert.equal(actionRequired.status.rawStatus, "Action Required")
  assert.equal(actionRequired.status.normalized, "pending")
  assert.equal(actionRequired.status.terms, undefined)

  const offerReady = await statusFor("headway-capital:offer-ready", "attempt-offer")
  assert.equal(offerReady.status.rawStatus, "Offer Ready")
  assert.equal(offerReady.status.normalized, "approved")
  assert.deepEqual(offerReady.status.terms, SYNTHETIC_OFFER_TERMS)

  const issued = await statusFor("headway-capital:issued", "attempt-issued")
  assert.equal(issued.status.rawStatus, "Issued")
  assert.equal(issued.status.normalized, "funded")
  assert.deepEqual(issued.status.terms, SYNTHETIC_OFFER_TERMS)

  const declined = await statusFor("headway-capital:declined", "attempt-declined")
  assert.equal(declined.status.rawStatus, "Declined")
  assert.equal(declined.status.normalized, "declined")
  assert.equal(declined.status.terms, undefined)

  const missingJob = job({
    attemptKey: "attempt-missing-info",
    route: {
      id: "route-hwc-missing",
      kind: "api",
      label: "API",
      destination: "headway-capital:outstanding-documents",
      documentExceptions: [],
      active: true,
    },
  })
  const submitted = await headwayCapitalAdapter.submit(missingJob)
  assert.equal(submitted.ok, true)
  assert.equal(submitted.rawStatus, "Application Incomplete")
  const status = await headwayCapitalAdapter.getStatus!(missingJob)
  assert.equal(status.normalized, "pending")
  assert.equal(status.unknown, false)
  assert.equal(status.terms, undefined)
  assert.match(status.rawStatus, /outstanding document requests/)
  assert.match(status.rawStatus, /bank statements/)
})
