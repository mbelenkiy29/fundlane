import test, { beforeEach } from "node:test"
import assert from "node:assert/strict"
import type { AdapterRuntime } from "../../src/lib/mca/submissions/adapters/contracts"
import { runWithAdapterRuntime } from "../../src/lib/mca/submissions/adapters/credentials"
import type { SubmissionJob } from "../../src/lib/mca/submissions/contracts"
import {
  bindIdeaFinancialApplication,
  DEFAULT_FICO,
  DEFAULT_NAICS,
  EXPIRED_CREDENTIAL_TOKEN,
  fixtureSubmitCallCount,
  IDEA_FINANCIAL_SLUG,
  ideaFinancialAdapter,
  listFixtureExternalRefs,
  mapLegalStructure,
  mapProviderStatus,
  ORIGINATOR_PHONE_ERROR,
  peekFixture,
  PROVIDER_STATUS_MAP,
  resetIdeaFinancialFixtures,
  setIdeaFinancialFixture,
  SYNTHETIC_OFFER_TERMS,
  SYNTHETIC_STIPS,
} from "../../src/lib/mca/submissions/adapters/idea-financial"

const SSN = "123456789"
const USERNAME = "idea-iso-user"
const PASSWORD = "idea-development-password-never-leak"
const CLIENT_ID = "idea-client-id-never-leak"
const CLIENT_SECRET = "idea-client-secret-never-leak"

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

function application(overrides: Record<string, unknown> = {}) {
  return {
    legalName: "Harbor Coffee LLC",
    ein: "12-3456789",
    entityType: "llc",
    contactPhone: "2125550199",
    address: { line1: "100 Front Street", city: "New York", state: "NY", postalCode: "10004" },
    annualRevenue: 720000,
    originatorPhone: "9175550100",
    owners: [owner()],
    ...overrides,
  }
}

function job(overrides: Partial<SubmissionJob> = {}): SubmissionJob {
  return {
    id: overrides.id ?? "job-idea-1",
    workspaceId: overrides.workspaceId ?? "workspace-idea",
    dealId: overrides.dealId ?? "deal-idea-1",
    funderId: overrides.funderId ?? "funder-idea-1",
    displayFunderName: overrides.displayFunderName ?? "Idea Financial",
    routeKind: "api",
    route: overrides.route ?? {
      id: "route-idea",
      kind: "api",
      label: "API",
      destination: IDEA_FINANCIAL_SLUG,
      documentExceptions: [],
      active: true,
    },
    state: overrides.state ?? "sending",
    confirmationKey: overrides.confirmationKey ?? "conf-idea-1",
    attemptKey: overrides.attemptKey ?? "attempt-idea-1",
    dealVersion: overrides.dealVersion ?? 1,
    documentVersions: overrides.documentVersions ?? [],
    packageDocumentIds: overrides.packageDocumentIds ?? [],
    preflightErrors: overrides.preflightErrors ?? [],
    createdAt: overrides.createdAt ?? "2026-01-01T00:00:00.000Z",
    updatedAt: overrides.updatedAt ?? "2026-01-01T00:00:00.000Z",
    ...overrides,
  }
}

function runtime(secrets: AdapterRuntime["secrets"], correlationId = "corr-idea-1"): AdapterRuntime {
  return {
    credentialId: "cred-idea-1",
    workspaceId: "workspace-idea",
    funderId: "funder-idea-1",
    adapterSlug: IDEA_FINANCIAL_SLUG,
    environment: "development",
    capabilities: ideaFinancialAdapter.capabilities,
    secrets,
    correlationId,
  }
}

function credentials(): AdapterRuntime["secrets"] {
  return { username: USERNAME, password: PASSWORD, clientId: CLIENT_ID, clientSecret: CLIENT_SECRET }
}

function assertNoSecrets(value: unknown) {
  const text = typeof value === "string" ? value : JSON.stringify(value)
  assert.equal(text.includes(PASSWORD), false)
  assert.equal(text.includes(CLIENT_SECRET), false)
  assert.equal(text.includes(CLIENT_ID), false)
  assert.equal(text.includes(EXPIRED_CREDENTIAL_TOKEN), false)
  assert.equal(text.includes(SSN), false)
  assert.equal(text.includes("111223333"), false)
  assert.equal(text.includes("987654321"), false)
}

beforeEach(() => {
  resetIdeaFinancialFixtures()
})

test("MIC-137: required-field rejection", () => {
  const empty = ideaFinancialAdapter.validate({})
  assert.equal(empty.ok, false)
  if (empty.ok) throw new Error("expected field errors")
  assert.equal(empty.fields.legalName, "Business name is required.")
  assert.equal(empty.fields.entityType, "Legal structure is required.")
  assert.equal(empty.fields.ein, "EIN / Tax ID is required.")
  assert.equal(empty.fields.phone, "Business phone is required.")
  assert.equal(empty.fields.owners, "At least one business owner is required.")
  assert.equal(empty.fields.originatorPhone, ORIGINATOR_PHONE_ERROR)
  assert.match(empty.fields.monthlyRevenue ?? "", /annual revenue or statement deposit/i)

  const invalid = ideaFinancialAdapter.validate(application({
    ein: "12-345",
    originatorPhone: undefined,
    owners: [owner({ ssn: "1234", firstName: "", ownershipPercent: undefined })],
  }))
  assert.equal(invalid.ok, false)
  if (invalid.ok) throw new Error("expected invalid field errors")
  assert.equal(invalid.fields.ein, "EIN must contain 9 digits.")
  assert.equal(invalid.fields.originatorPhone, ORIGINATOR_PHONE_ERROR)
  assert.equal(invalid.fields["owners.0.firstName"], "Owner first name is required.")
  assert.equal(invalid.fields["owners.0.ssn"], "Owner SSN must contain 9 digits.")
  assert.equal(invalid.fields["owners.0.ownershipPercent"], "Owner ownership percentage is required.")

  const submitterFallback = ideaFinancialAdapter.validate(application({
    originatorPhone: undefined,
    submitterPhone: "6465550199",
  }))
  assert.equal(submitterFallback.ok, true)

  const fromDeposits = ideaFinancialAdapter.validate(application({
    annualRevenue: undefined,
    monthlyRevenue: undefined,
    requestedAmount: undefined,
    statementDeposits: [48000, 52000, 50000],
  }))
  assert.equal(fromDeposits.ok, true)

  assert.equal(ideaFinancialAdapter.validate(application()).ok, true)
})

test("MIC-137: accepted submission maps all owners, revenue, defaults, and offer-capable status", async () => {
  assert.equal(ideaFinancialAdapter.slug, "idea-financial")
  assert.deepEqual(ideaFinancialAdapter.capabilities, {
    submit: true,
    statusPoll: true,
    webhooks: false,
    offers: true,
  })
  assert.equal(typeof ideaFinancialAdapter.getStatus, "function")
  assert.equal(ideaFinancialAdapter.parseWebhook, undefined)
  assert.equal(mapLegalStructure("llc"), "LLC")
  assert.equal(mapLegalStructure("sole_proprietor"), "Sole Proprietorship")
  assert.equal(mapLegalStructure("nonprofit"), "Other")

  const payload = application({
    requestedAmount: undefined,
    ficoScore: undefined,
    naicsCode: undefined,
    originatorPhone: undefined,
    submitter: { phone: "6465550199" },
    owners: [
      owner({ firstName: "Sam", lastName: "Lee", ownershipPercent: 15, email: "sam.lee@merchant.example", ssn: "111223333" }),
      owner({ firstName: "Alex", lastName: "Rivera", ownershipPercent: 55 }),
      owner({ firstName: "Jordan", lastName: "Nguyen", ownershipPercent: 30, email: "jordan.nguyen@merchant.example", ssn: "987654321" }),
    ],
  })
  bindIdeaFinancialApplication("attempt-idea-1", payload)
  const submitted = await runWithAdapterRuntime(runtime(credentials()), () => ideaFinancialAdapter.submit(job()))
  assert.equal(submitted.ok, true)
  assert.equal(submitted.correlationId, "corr-idea-1")
  assert.equal(submitted.externalRef, "idea_attempt-idea-1")
  assert.equal(submitted.rawStatus, "Processing")
  assert.equal(submitted.fields?.applicationNumber, "idea_attempt-idea-1")
  assert.notEqual(mapProviderStatus(submitted.rawStatus ?? "").normalized, "approved")
  assertNoSecrets(submitted)

  const stored = peekFixture("attempt-idea-1")
  assert.ok(stored)
  assert.equal(stored.mapped?.legalName, "Harbor Coffee LLC")
  assert.equal(stored.mapped?.entityType, "LLC")
  assert.equal(stored.mapped?.ein, "123456789")
  assert.equal(stored.mapped?.annualRevenue, 720000)
  assert.equal(stored.mapped?.monthlyRevenue, 60000)
  assert.equal(stored.mapped?.requestedAmount, 120000)
  assert.equal(stored.mapped?.requestedAmountInferred, true)
  assert.equal(stored.mapped?.ficoScore, DEFAULT_FICO)
  assert.equal(stored.mapped?.naicsCode, DEFAULT_NAICS)
  assert.equal(stored.mapped?.originatorPhoneSource, "submitter")
  assert.deepEqual(stored.mapped?.owners, [
    { firstName: "Sam", lastName: "Lee", ownershipPercent: 15 },
    { firstName: "Alex", lastName: "Rivera", ownershipPercent: 55 },
    { firstName: "Jordan", lastName: "Nguyen", ownershipPercent: 30 },
  ])
  assert.equal(stored.mapped?.owners?.length, 3)

  const status = await runWithAdapterRuntime(runtime(credentials(), "corr-status-1"), () => ideaFinancialAdapter.getStatus!(job()))
  assert.equal(status.normalized, "submitted")
  assert.equal(status.rawStatus, "Processing")
  assert.equal(status.unknown, false)
  assert.equal(status.terms, undefined)
  assert.equal(status.correlationId, "corr-status-1")
  assert.equal(status.eventId, "idea-event-attempt-idea-1")
  assertNoSecrets(status)
})

test("MIC-137: document receipt is stable on replay", async () => {
  const attempt = job({
    attemptKey: "attempt-docs",
    packageDocumentIds: ["doc-app", "doc-bank"],
    documentVersions: [
      { documentId: "doc-app", checksum: "checksum-app", category: "api_application" },
      { documentId: "doc-bank", checksum: "checksum-bank", category: "statement" },
    ],
  })
  bindIdeaFinancialApplication("attempt-docs", application({ owners: [owner()] }))
  const first = await ideaFinancialAdapter.submit(attempt)
  assert.equal(first.ok, true)
  assert.equal(first.fields?.applicationNumber, "idea_attempt-docs")
  assert.equal(first.fields?.["documents.0.documentId"], "doc-app")
  assert.equal(first.fields?.["documents.0.category"], "application")
  assert.equal(first.fields?.["documents.0.receiptId"], "idea_doc_attempt-docs_doc-app")
  assert.equal(first.fields?.["documents.1.documentId"], "doc-bank")
  assert.equal(first.fields?.["documents.1.category"], "bank_statements")
  assert.equal(first.fields?.["documents.1.receiptId"], "idea_doc_attempt-docs_doc-bank")
  assertNoSecrets(first)

  const replay = await ideaFinancialAdapter.submit(attempt)
  assert.equal(replay.ok, true)
  assert.equal(replay.externalRef, first.externalRef)
  assert.deepEqual(replay.fields, first.fields)
  assert.deepEqual(listFixtureExternalRefs(), ["idea_attempt-docs"])
  assert.equal(peekFixture("attempt-docs")?.submitCalls, 2)
  assert.equal(fixtureSubmitCallCount(), 2)
})

test("MIC-137: timeout, expired credential, and replay do not duplicate submissions", async () => {
  const timeoutJob = job({
    attemptKey: "attempt-timeout",
    route: {
      id: "route-idea-timeout",
      kind: "api",
      label: "API",
      destination: "idea-financial:timeout",
      documentExceptions: [],
      active: true,
    },
  })
  const timedOut = await ideaFinancialAdapter.submit(timeoutJob)
  assert.equal(timedOut.ok, false)
  assert.equal(timedOut.errorCode, "provider_unavailable")
  assert.match(timedOut.errorMessage ?? "", /timed out/i)
  assert.equal(timedOut.externalRef, "idea_attempt-timeout")

  const recovered = await ideaFinancialAdapter.submit(timeoutJob)
  assert.equal(recovered.ok, true)
  assert.equal(recovered.externalRef, timedOut.externalRef)
  assert.deepEqual(listFixtureExternalRefs(), ["idea_attempt-timeout"])

  const expiredJob = job({ attemptKey: "attempt-expired" })
  const expired = await runWithAdapterRuntime(
    runtime({ username: USERNAME, password: EXPIRED_CREDENTIAL_TOKEN, clientId: CLIENT_ID, clientSecret: CLIENT_SECRET }, "corr-expired"),
    () => ideaFinancialAdapter.submit(expiredJob),
  )
  assert.equal(expired.ok, false)
  assert.equal(expired.errorCode, "provider_unavailable")
  assert.match(expired.errorMessage ?? "", /expired/i)
  assert.equal(expired.externalRef, undefined)
  assert.equal(expired.correlationId, "corr-expired")
  assertNoSecrets(expired)
  await assert.rejects(
    () => runWithAdapterRuntime(
      runtime({ username: USERNAME, password: PASSWORD, clientId: CLIENT_ID, clientSecret: EXPIRED_CREDENTIAL_TOKEN }),
      () => ideaFinancialAdapter.getStatus!(expiredJob),
    ),
    (error: { status?: number; code?: string; message?: string }) => (
      error.status === 503 && error.code === "provider_unavailable" && /expired/i.test(error.message ?? "")
    ),
  )
  assert.equal(listFixtureExternalRefs().includes("idea_attempt-expired"), false)

  const acceptedJob = job({ attemptKey: "attempt-replay" })
  bindIdeaFinancialApplication("attempt-replay", application({ owners: [owner()] }))
  const first = await ideaFinancialAdapter.submit(acceptedJob)
  const replay = await runWithAdapterRuntime(
    runtime({ username: USERNAME, password: EXPIRED_CREDENTIAL_TOKEN, clientId: CLIENT_ID, clientSecret: CLIENT_SECRET }, "corr-replay"),
    () => ideaFinancialAdapter.submit(acceptedJob),
  )
  assert.equal(first.ok, true)
  assert.equal(replay.ok, true)
  assert.equal(replay.externalRef, first.externalRef)
  assert.equal(replay.correlationId, "corr-replay")
  assert.deepEqual(new Set(listFixtureExternalRefs()), new Set(["idea_attempt-timeout", "idea_attempt-replay"]))
  assertNoSecrets(replay)

  setIdeaFinancialFixture("idea-financial:expired-credential")
  const destinationExpired = await ideaFinancialAdapter.submit(job({ attemptKey: "attempt-expired-destination" }))
  assert.equal(destinationExpired.ok, false)
  assert.equal(destinationExpired.externalRef, undefined)
})

test("MIC-137: status, offers, links, and stips map without inventing terms", async () => {
  assert.deepEqual(mapProviderStatus("Draft"), { rawStatus: "Draft", normalized: "submitted", unknown: false })
  assert.deepEqual(mapProviderStatus("Processing"), { rawStatus: "Processing", normalized: "submitted", unknown: false })
  assert.deepEqual(mapProviderStatus("Submission Incomplete"), { rawStatus: "Submission Incomplete", normalized: "pending", unknown: false })
  assert.deepEqual(mapProviderStatus("Dormant"), { rawStatus: "Dormant", normalized: "pending", unknown: false })
  assert.deepEqual(mapProviderStatus("Conditional Offer"), { rawStatus: "Conditional Offer", normalized: "approved", unknown: false })
  assert.deepEqual(mapProviderStatus("Offer"), { rawStatus: "Offer", normalized: "approved", unknown: false })
  assert.deepEqual(mapProviderStatus("Closing"), { rawStatus: "Closing", normalized: "approved", unknown: false })
  assert.deepEqual(mapProviderStatus("Contract Ready"), { rawStatus: "Contract Ready", normalized: "approved", unknown: false })
  assert.deepEqual(mapProviderStatus("Contract Out"), { rawStatus: "Contract Out", normalized: "approved", unknown: false })
  assert.deepEqual(mapProviderStatus("Closing Incomplete"), { rawStatus: "Closing Incomplete", normalized: "approved", unknown: false })
  assert.deepEqual(mapProviderStatus("Funded"), { rawStatus: "Funded", normalized: "funded", unknown: false })
  assert.deepEqual(mapProviderStatus("Closed"), { rawStatus: "Closed", normalized: "funded", unknown: false })
  assert.deepEqual(mapProviderStatus("Open"), { rawStatus: "Open", normalized: "funded", unknown: false })
  assert.deepEqual(mapProviderStatus("Declined"), { rawStatus: "Declined", normalized: "declined", unknown: false })
  assert.deepEqual(mapProviderStatus("Not Interested"), { rawStatus: "Not Interested", normalized: "declined", unknown: false })
  assert.deepEqual(mapProviderStatus("Abandoned"), { rawStatus: "Abandoned", normalized: "declined", unknown: false })
  assert.equal(mapProviderStatus("CREDIT_COMMITTEE_HOLD").unknown, true)
  assert.equal(Object.keys(PROVIDER_STATUS_MAP).length, 16)

  const pending = mapProviderStatus("Submission Incomplete", ["bank statements"])
  assert.equal(pending.normalized, "pending")
  assert.equal(pending.unknown, false)
  assert.match(pending.rawStatus, /bank statements/)

  const withStips = mapProviderStatus("Offer", [], [...SYNTHETIC_STIPS])
  assert.equal(withStips.normalized, "approved")
  assert.match(withStips.rawStatus, /stips required/)
  assert.match(withStips.rawStatus, /voided check/)

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
    const submitted = await ideaFinancialAdapter.submit(next)
    assert.equal(submitted.ok, true)
    return { submitted, status: await ideaFinancialAdapter.getStatus!(next) }
  }

  const incomplete = await statusFor("idea-financial:incomplete", "attempt-incomplete")
  assert.equal(incomplete.submitted.rawStatus, "Submission Incomplete")
  assert.equal(incomplete.status.normalized, "pending")
  assert.equal(incomplete.status.terms, undefined)
  assert.match(incomplete.status.rawStatus, /outstanding document requests/)

  const offer = await statusFor("idea-financial:offer", "attempt-offer")
  assert.equal(offer.status.normalized, "approved")
  assert.deepEqual(offer.status.terms, SYNTHETIC_OFFER_TERMS)
  assert.equal(offer.status.terms?.offerLink, SYNTHETIC_OFFER_TERMS.offerLink)
  assert.match(offer.status.rawStatus, /stips required/)
  assert.match(offer.status.rawStatus, /voided check/)

  const funded = await statusFor("idea-financial:funded", "attempt-funded")
  assert.equal(funded.status.rawStatus.startsWith("Funded"), true)
  assert.equal(funded.status.normalized, "funded")
  assert.deepEqual(funded.status.terms, SYNTHETIC_OFFER_TERMS)

  const declined = await statusFor("idea-financial:declined", "attempt-declined")
  assert.equal(declined.status.rawStatus, "Declined")
  assert.equal(declined.status.normalized, "declined")
  assert.equal(declined.status.terms, undefined)

  const unknown = mapProviderStatus("CREDIT_COMMITTEE_HOLD")
  assert.equal(unknown.normalized, "unknown")
  assert.equal(unknown.unknown, true)
  assert.equal(unknown.rawStatus, "CREDIT_COMMITTEE_HOLD")
})
