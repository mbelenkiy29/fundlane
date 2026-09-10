import test, { beforeEach } from "node:test"
import assert from "node:assert/strict"
import type { AdapterRuntime } from "../../src/lib/mca/submissions/adapters/contracts"
import { runWithAdapterRuntime } from "../../src/lib/mca/submissions/adapters/credentials"
import type { SubmissionJob } from "../../src/lib/mca/submissions/contracts"
import {
  applicationIdForAttempt,
  bindForaFinancialApplication,
  EXPIRED_CREDENTIAL_TOKEN,
  fixtureSubmitCallCount,
  FORA_FINANCIAL_SLUG,
  foraFinancialAdapter,
  listFixtureExternalRefs,
  mapEntityType,
  mapIndustry,
  mapProviderStatus,
  peekFixture,
  PROVIDER_STATUS_MAP,
  resetForaFinancialFixtures,
  selectPrimaryOwner,
  setForaFinancialFixture,
} from "../../src/lib/mca/submissions/adapters/fora-financial"

const SSN = "123456789"
const API_KEY = "fora-development-token-never-leak"

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
    creditPullConsent: true,
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
    annualRevenue: 600000,
    requestedAmount: 75000,
    businessCreditPullConsent: true,
    ownerCreditPullConsent: true,
    owners: [
      owner({ firstName: "Sam", lastName: "Lee", ownershipPercent: 15, isPrimary: false, email: "sam.lee@merchant.example", ssn: "111223333", creditPullConsent: false }),
      owner({ firstName: "Alex", lastName: "Rivera", ownershipPercent: 55, isPrimary: true }),
      owner({ firstName: "Jordan", lastName: "Nguyen", ownershipPercent: 30, isPrimary: false, email: "jordan.nguyen@merchant.example", ssn: "987654321", creditPullConsent: true }),
    ],
    ...overrides,
  }
}

function job(overrides: Partial<SubmissionJob> = {}): SubmissionJob {
  return {
    id: overrides.id ?? "job-fora-1",
    workspaceId: overrides.workspaceId ?? "workspace-fora",
    dealId: overrides.dealId ?? "deal-fora-1",
    funderId: overrides.funderId ?? "funder-fora-1",
    displayFunderName: overrides.displayFunderName ?? "Fora Financial",
    routeKind: "api",
    route: overrides.route ?? {
      id: "route-fora",
      kind: "api",
      label: "API",
      destination: FORA_FINANCIAL_SLUG,
      documentExceptions: [],
      active: true,
    },
    state: overrides.state ?? "sending",
    confirmationKey: overrides.confirmationKey ?? "conf-fora-1",
    attemptKey: overrides.attemptKey ?? "attempt-fora-1",
    dealVersion: overrides.dealVersion ?? 1,
    documentVersions: overrides.documentVersions ?? [],
    packageDocumentIds: overrides.packageDocumentIds ?? [],
    preflightErrors: overrides.preflightErrors ?? [],
    createdAt: overrides.createdAt ?? "2026-01-01T00:00:00.000Z",
    updatedAt: overrides.updatedAt ?? "2026-01-01T00:00:00.000Z",
    ...overrides,
  }
}

function runtime(secrets: AdapterRuntime["secrets"], correlationId = "corr-fora-1"): AdapterRuntime {
  return {
    credentialId: "cred-fora-1",
    workspaceId: "workspace-fora",
    funderId: "funder-fora-1",
    adapterSlug: FORA_FINANCIAL_SLUG,
    environment: "development",
    capabilities: foraFinancialAdapter.capabilities,
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
  assert.equal(text.includes("987654321"), false)
}

beforeEach(() => {
  resetForaFinancialFixtures()
})

test("MIC-136: required-field rejection", () => {
  const empty = foraFinancialAdapter.validate({})
  assert.equal(empty.ok, false)
  if (empty.ok) throw new Error("expected field errors")
  assert.equal(empty.fields.legalName, "Business name is required.")
  assert.equal(empty.fields.dba, "DBA is required.")
  assert.equal(empty.fields.ein, "EIN / Tax ID is required.")
  assert.equal(empty.fields.industry, "Industry is required.")
  assert.equal(empty.fields.entityType, "Entity type is required.")
  assert.equal(empty.fields.startDate, "Business start date is required.")
  assert.equal(empty.fields.requestedAmount, "Funding amount is required.")
  assert.equal(empty.fields.owners, "A primary owner is required.")
  assert.equal(empty.fields.annualRevenue, "Enter annual revenue, monthly revenue, or statement deposit totals.")
  assert.equal(empty.fields.businessCreditPullConsent, "Recorded business credit-pull consent is required.")
  assert.equal(empty.fields.ownerCreditPullConsent, "Recorded primary-owner credit-pull consent is required.")

  const assumed = foraFinancialAdapter.validate(application({
    businessCreditPullConsent: undefined,
    ownerCreditPullConsent: undefined,
    owners: [owner({ creditPullConsent: undefined })],
  }))
  assert.equal(assumed.ok, false)
  if (assumed.ok) throw new Error("expected missing consent errors")
  assert.equal(assumed.fields.businessCreditPullConsent, "Recorded business credit-pull consent is required.")
  assert.equal(assumed.fields.ownerCreditPullConsent, "Recorded primary-owner credit-pull consent is required.")

  const denied = foraFinancialAdapter.validate(application({
    businessCreditPullConsent: false,
    ownerCreditPullConsent: false,
    owners: [owner({ creditPullConsent: false })],
  }))
  assert.equal(denied.ok, false)
  if (denied.ok) throw new Error("expected denied consent errors")
  assert.equal(denied.fields.businessCreditPullConsent, "Business credit-pull consent must be recorded as granted.")
  assert.equal(denied.fields.ownerCreditPullConsent, "Primary-owner credit-pull consent must be recorded as granted.")

  const invalid = foraFinancialAdapter.validate(application({
    ein: "12-345",
    requestedAmount: 0,
    owners: [owner({ ssn: "1234", firstName: "", ownershipPercent: undefined })],
  }))
  assert.equal(invalid.ok, false)
  if (invalid.ok) throw new Error("expected invalid field errors")
  assert.equal(invalid.fields.ein, "EIN must contain 9 digits.")
  assert.equal(invalid.fields.requestedAmount, "Funding amount must be greater than 0.")
  assert.equal(invalid.fields["owners.0.firstName"], "Owner first name is required.")
  assert.equal(invalid.fields["owners.0.ssn"], "Owner SSN must contain 9 digits.")
  assert.equal(invalid.fields["owners.0.ownershipPercent"], "Owner ownership percentage is required.")
  assert.equal(foraFinancialAdapter.validate(application()).ok, true)
  assert.equal(foraFinancialAdapter.validate(application({
    annualRevenue: undefined,
    statementDeposits: [48000, 52000, 50000],
  })).ok, true)
})

test("MIC-136: accepted submission maps primary owner, recorded consent, and status-only capabilities", async () => {
  assert.equal(foraFinancialAdapter.slug, "fora-financial")
  assert.deepEqual(foraFinancialAdapter.capabilities, {
    submit: true,
    statusPoll: true,
    webhooks: false,
    offers: false,
  })
  assert.equal(typeof foraFinancialAdapter.getStatus, "function")
  assert.equal(foraFinancialAdapter.parseWebhook, undefined)
  assert.equal(mapEntityType("s_corporation"), "S-Corporation")
  assert.equal(mapEntityType("nonprofit"), "Other")
  assert.equal(mapIndustry("restaurant"), "Food Services")
  assert.equal(mapIndustry("unknown niche"), "Other")
  assert.equal(selectPrimaryOwner([
    { ownershipPercent: 15, isPrimary: false },
    { ownershipPercent: 55, isPrimary: true },
    { ownershipPercent: 30, isPrimary: false },
  ])?.ownershipPercent, 55)

  const payload = application()
  bindForaFinancialApplication("attempt-fora-1", payload)
  const submitted = await runWithAdapterRuntime(runtime({ apiKey: API_KEY }), () => foraFinancialAdapter.submit(job()))
  assert.equal(submitted.ok, true)
  assert.equal(submitted.correlationId, "corr-fora-1")
  assert.equal(submitted.externalRef, applicationIdForAttempt("attempt-fora-1"))
  assert.equal(submitted.rawStatus, "In Progress")
  assert.equal(submitted.fields?.applicationId, "fora_attempt-fora-1")
  assertNoSecrets(submitted)

  const stored = peekFixture("attempt-fora-1")
  assert.ok(stored)
  assert.equal(stored.mapped?.legalName, "Harbor Coffee LLC")
  assert.equal(stored.mapped?.dba, "Harbor Coffee")
  assert.equal(stored.mapped?.entityType, "S-Corporation")
  assert.equal(stored.mapped?.industry, "Food Services")
  assert.equal(stored.mapped?.ownerFirstName, "Alex")
  assert.equal(stored.mapped?.ownerLastName, "Rivera")
  assert.equal(stored.mapped?.ownershipPercent, 55)
  assert.equal(stored.mapped?.requestedAmount, 75000)
  assert.equal(stored.mapped?.annualRevenue, 600000)
  assert.equal(stored.mapped?.monthlyRevenue, 50000)
  assert.equal(stored.mapped?.revenueSource, "annual_revenue")
  assert.equal(stored.mapped?.businessCreditPullConsent, true)
  assert.equal(stored.mapped?.ownerCreditPullConsent, true)

  const status = await runWithAdapterRuntime(runtime({ apiKey: API_KEY }, "corr-status-1"), () => foraFinancialAdapter.getStatus!(job()))
  assert.equal(status.normalized, "submitted")
  assert.equal(status.rawStatus, "In Progress")
  assert.equal(status.unknown, false)
  assert.equal(status.terms, undefined)
  assert.equal(status.correlationId, "corr-status-1")
  assert.equal(status.eventId, "fora-event-attempt-fora-1")
  assertNoSecrets(status)
})

test("MIC-136: document receipt is stable on replay", async () => {
  const attempt = job({
    attemptKey: "attempt-docs",
    packageDocumentIds: ["doc-app", "doc-bank", "doc-other"],
    documentVersions: [
      { documentId: "doc-app", checksum: "checksum-app", category: "api_application" },
      { documentId: "doc-bank", checksum: "checksum-bank", category: "statement" },
      { documentId: "doc-other", checksum: "checksum-other", category: "voided_check" },
    ],
  })
  bindForaFinancialApplication("attempt-docs", application({ owners: [owner()] }))
  const first = await foraFinancialAdapter.submit(attempt)
  assert.equal(first.ok, true)
  assert.equal(first.fields?.documentReceipt, "accepted")
  assert.equal(first.fields?.documentsReceived, "2")
  assert.equal(first.fields?.["documents.0.documentId"], "doc-app")
  assert.equal(first.fields?.["documents.0.category"], "application")
  assert.equal(first.fields?.["documents.0.receiptId"], "fora_doc_attempt-docs_doc-app")
  assert.equal(first.fields?.["documents.1.documentId"], "doc-bank")
  assert.equal(first.fields?.["documents.1.category"], "bank_statements")
  assert.equal(first.fields?.["documents.1.receiptId"], "fora_doc_attempt-docs_doc-bank")
  assert.equal(first.fields?.["documents.2.documentId"], undefined)
  assertNoSecrets(first)

  const replay = await foraFinancialAdapter.submit(attempt)
  assert.equal(replay.ok, true)
  assert.equal(replay.externalRef, first.externalRef)
  assert.deepEqual(replay.fields, first.fields)
  assert.deepEqual(listFixtureExternalRefs(), ["fora_attempt-docs"])
  assert.equal(peekFixture("attempt-docs")?.submitCalls, 2)
  assert.equal(fixtureSubmitCallCount(), 2)
})

test("MIC-136: timeout, expired credential, and replay do not duplicate submissions", async () => {
  const timeoutJob = job({
    attemptKey: "attempt-timeout",
    route: {
      id: "route-fora-timeout",
      kind: "api",
      label: "API",
      destination: "fora-financial:timeout",
      documentExceptions: [],
      active: true,
    },
  })
  const timedOut = await foraFinancialAdapter.submit(timeoutJob)
  assert.equal(timedOut.ok, false)
  assert.equal(timedOut.errorCode, "provider_unavailable")
  assert.match(timedOut.errorMessage ?? "", /timed out/i)
  assert.equal(timedOut.externalRef, applicationIdForAttempt("attempt-timeout"))

  const recovered = await foraFinancialAdapter.submit(timeoutJob)
  assert.equal(recovered.ok, true)
  assert.equal(recovered.externalRef, timedOut.externalRef)
  assert.deepEqual(listFixtureExternalRefs(), ["fora_attempt-timeout"])

  const expiredJob = job({ attemptKey: "attempt-expired" })
  const expired = await runWithAdapterRuntime(runtime({ apiKey: EXPIRED_CREDENTIAL_TOKEN }, "corr-expired"), () => foraFinancialAdapter.submit(expiredJob))
  assert.equal(expired.ok, false)
  assert.equal(expired.errorCode, "provider_unavailable")
  assert.match(expired.errorMessage ?? "", /expired/i)
  assert.equal(expired.externalRef, undefined)
  assert.equal(expired.correlationId, "corr-expired")
  assertNoSecrets(expired)
  await assert.rejects(
    () => runWithAdapterRuntime(runtime({ apiKey: EXPIRED_CREDENTIAL_TOKEN }), () => foraFinancialAdapter.getStatus!(expiredJob)),
    (error: { status?: number; code?: string; message?: string }) => (
      error.status === 503 && error.code === "provider_unavailable" && /expired/i.test(error.message ?? "")
    ),
  )
  assert.equal(listFixtureExternalRefs().includes("fora_attempt-expired"), false)

  const acceptedJob = job({ attemptKey: "attempt-replay" })
  bindForaFinancialApplication("attempt-replay", application({ owners: [owner()] }))
  const first = await foraFinancialAdapter.submit(acceptedJob)
  const replay = await runWithAdapterRuntime(runtime({ apiKey: EXPIRED_CREDENTIAL_TOKEN }, "corr-replay"), () => foraFinancialAdapter.submit(acceptedJob))
  assert.equal(first.ok, true)
  assert.equal(replay.ok, true)
  assert.equal(replay.externalRef, first.externalRef)
  assert.equal(replay.correlationId, "corr-replay")
  assert.deepEqual(new Set(listFixtureExternalRefs()), new Set(["fora_attempt-timeout", "fora_attempt-replay"]))
  assertNoSecrets(replay)

  setForaFinancialFixture("fora-financial:expired-credential")
  const destinationExpired = await foraFinancialAdapter.submit(job({ attemptKey: "attempt-expired-destination" }))
  assert.equal(destinationExpired.ok, false)
  assert.equal(destinationExpired.externalRef, undefined)
})

test("MIC-136: funding-stage status mapping does not invent offers", async () => {
  assert.deepEqual(mapProviderStatus("In Progress"), { rawStatus: "In Progress", normalized: "submitted", unknown: false })
  assert.deepEqual(mapProviderStatus("Incomplete Application"), { rawStatus: "Incomplete Application", normalized: "pending", unknown: false })
  assert.deepEqual(mapProviderStatus("Approved"), { rawStatus: "Approved", normalized: "approved", unknown: false })
  assert.deepEqual(mapProviderStatus("Contracts In"), { rawStatus: "Contracts In", normalized: "approved", unknown: false })
  assert.deepEqual(mapProviderStatus("Pending Funding"), { rawStatus: "Pending Funding", normalized: "approved", unknown: false })
  assert.deepEqual(mapProviderStatus("Funded"), { rawStatus: "Funded", normalized: "funded", unknown: false })
  assert.deepEqual(mapProviderStatus("Declined"), { rawStatus: "Declined", normalized: "declined", unknown: false })
  assert.equal(mapProviderStatus("CREDIT_COMMITTEE_HOLD").unknown, true)
  assert.equal(Object.keys(PROVIDER_STATUS_MAP).length, 7)

  const incompleteJob = job({
    attemptKey: "attempt-incomplete",
    route: {
      id: "route-fora-incomplete",
      kind: "api",
      label: "API",
      destination: "fora-financial:incomplete",
      documentExceptions: [],
      active: true,
    },
  })
  bindForaFinancialApplication("attempt-incomplete", application({ owners: [owner()] }))
  const incomplete = await foraFinancialAdapter.submit(incompleteJob)
  assert.equal(incomplete.ok, true)
  assert.equal(incomplete.rawStatus, "Incomplete Application")
  const incompleteStatus = await foraFinancialAdapter.getStatus!(incompleteJob)
  assert.equal(incompleteStatus.normalized, "pending")
  assert.equal(incompleteStatus.terms, undefined)

  const fundedJob = job({
    attemptKey: "attempt-funded",
    route: {
      id: "route-fora-funded",
      kind: "api",
      label: "API",
      destination: "fora-financial:pending-funding",
      documentExceptions: [],
      active: true,
    },
  })
  bindForaFinancialApplication("attempt-funded", application({ owners: [owner()] }))
  const submitted = await foraFinancialAdapter.submit(fundedJob)
  assert.equal(submitted.ok, true)
  assert.equal(submitted.rawStatus, "In Progress")
  const pendingFunding = await foraFinancialAdapter.getStatus!(fundedJob)
  assert.equal(pendingFunding.rawStatus, "Pending Funding")
  assert.equal(pendingFunding.normalized, "approved")
  assert.equal(pendingFunding.unknown, false)
  assert.equal(pendingFunding.terms, undefined)

  const declinedJob = job({
    attemptKey: "attempt-declined",
    route: {
      id: "route-fora-declined",
      kind: "api",
      label: "API",
      destination: "fora-financial:declined",
      documentExceptions: [],
      active: true,
    },
  })
  const declined = await foraFinancialAdapter.getStatus!(declinedJob)
  assert.equal(declined.rawStatus, "Declined")
  assert.equal(declined.normalized, "declined")
  assert.equal(declined.terms, undefined)
})
