import test, { beforeEach } from "node:test"
import assert from "node:assert/strict"
import type { AdapterRuntime } from "../../src/lib/mca/submissions/adapters/contracts"
import { runWithAdapterRuntime } from "../../src/lib/mca/submissions/adapters/credentials"
import type { SubmissionJob } from "../../src/lib/mca/submissions/contracts"
import {
  bindRapidFinanceApplication,
  EXPIRED_CREDENTIAL_TOKEN,
  FALLBACK_STATUS_TOKENS,
  fixtureSubmitCallCount,
  listFixtureExternalRefs,
  mapProviderStatus,
  peekFixture,
  PROVIDER_STATUS_MAP,
  RAPID_FINANCE_FIXTURE_TRANSPORT,
  RAPID_FINANCE_SLUG,
  rapidFinanceAdapter,
  rapidFinanceDealId,
  rapidFinancePortalUrl,
  resetRapidFinanceFixtures,
  setRapidFinanceFixture,
  SYNTHETIC_OFFER_TERMS,
} from "../../src/lib/mca/submissions/adapters/rapid-finance"

const SSN = "123456789"
const API_KEY = "rapid-finance-development-token-never-leak"

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

function documents(overrides: Array<Record<string, unknown>> | undefined = undefined) {
  return overrides ?? [
    { documentId: "doc-app", category: "application", checksum: "checksum-app" },
    { documentId: "doc-bank", category: "statement", checksum: "checksum-bank" },
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
    businessEmail: "ops@harborcoffee.example",
    address: { line1: "100 Front Street", city: "New York", state: "NY", postalCode: "10004" },
    annualRevenue: 720000,
    owners: [owner()],
    documents: documents(),
    ...overrides,
  }
}

function job(overrides: Partial<SubmissionJob> = {}): SubmissionJob {
  return {
    id: overrides.id ?? "job-rf-1",
    workspaceId: overrides.workspaceId ?? "workspace-rf",
    dealId: overrides.dealId ?? "deal-rf-1",
    funderId: overrides.funderId ?? "funder-rf-1",
    displayFunderName: overrides.displayFunderName ?? "Rapid Finance",
    routeKind: "api",
    route: overrides.route ?? {
      id: "route-rf",
      kind: "api",
      label: "API",
      destination: RAPID_FINANCE_SLUG,
      documentExceptions: [],
      active: true,
    },
    state: overrides.state ?? "sending",
    confirmationKey: overrides.confirmationKey ?? "conf-rf-1",
    attemptKey: overrides.attemptKey ?? "attempt-rf-1",
    dealVersion: overrides.dealVersion ?? 1,
    documentVersions: overrides.documentVersions ?? [
      { documentId: "doc-app", checksum: "checksum-app", category: "application" },
      { documentId: "doc-bank", checksum: "checksum-bank", category: "statement" },
    ],
    packageDocumentIds: overrides.packageDocumentIds ?? ["doc-app", "doc-bank"],
    preflightErrors: overrides.preflightErrors ?? [],
    createdAt: overrides.createdAt ?? "2026-01-01T00:00:00.000Z",
    updatedAt: overrides.updatedAt ?? "2026-01-01T00:00:00.000Z",
    ...overrides,
  }
}

function runtime(secrets: AdapterRuntime["secrets"], correlationId = "corr-rf-1"): AdapterRuntime {
  return {
    credentialId: "cred-rf-1",
    workspaceId: "workspace-rf",
    funderId: "funder-rf-1",
    adapterSlug: RAPID_FINANCE_SLUG,
    environment: "development",
    capabilities: rapidFinanceAdapter.capabilities,
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
  resetRapidFinanceFixtures()
})

test("MIC-133: required-field rejection", () => {
  const empty = rapidFinanceAdapter.validate({})
  assert.equal(empty.ok, false)
  if (empty.ok) throw new Error("expected field errors")
  assert.equal(empty.fields.legalName, "Business name is required.")
  assert.equal(empty.fields.ein, "EIN / Tax ID is required.")
  assert.equal(empty.fields.industry, "Industry is required.")
  assert.equal(empty.fields.entityType, "Entity type is required.")
  assert.equal(empty.fields.businessEmail, "Business email is required.")
  assert.equal(empty.fields.phone, "Business phone is required.")
  assert.equal(empty.fields.owners, "At least one business owner is required.")
  assert.equal(empty.fields.annualRevenue, "Annual revenue is required.")
  assert.equal(empty.fields["documents.application"], "Upload the signed application.")
  assert.equal(empty.fields["documents.bankStatements"], "Upload bank statements.")

  const noRevenue = rapidFinanceAdapter.validate(application({ annualRevenue: undefined, monthlyRevenue: undefined }))
  assert.equal(noRevenue.ok, false)
  if (noRevenue.ok) throw new Error("expected annual revenue error")
  assert.equal(noRevenue.fields.annualRevenue, "Annual revenue is required.")

  const fromMonthly = rapidFinanceAdapter.validate(application({ annualRevenue: undefined, monthlyRevenue: 60000 }))
  assert.equal(fromMonthly.ok, true)

  const invalid = rapidFinanceAdapter.validate(application({
    ein: "12-345",
    owners: [owner({ ssn: "1234", firstName: "", ownershipPercent: undefined, dateOfBirth: "" })],
    documents: [{ documentId: "doc-other", category: "voided_check", checksum: "checksum-other" }],
  }))
  assert.equal(invalid.ok, false)
  if (invalid.ok) throw new Error("expected invalid field errors")
  assert.equal(invalid.fields.ein, "EIN must contain 9 digits.")
  assert.equal(invalid.fields["owners.0.firstName"], "Owner first name is required.")
  assert.equal(invalid.fields["owners.0.ssn"], "Owner SSN must contain 9 digits.")
  assert.equal(invalid.fields["owners.0.dateOfBirth"], "Owner date of birth is required.")
  assert.equal(invalid.fields["owners.0.ownershipPercent"], "Owner ownership percentage is required.")
  assert.equal(invalid.fields["documents.application"], "Upload the signed application.")
  assert.equal(invalid.fields["documents.bankStatements"], "Upload bank statements.")
  assert.equal(rapidFinanceAdapter.validate(application()).ok, true)
})

test("MIC-133: accepted submission returns Deal ID, portal navigation, and offer-capable flags", async () => {
  assert.equal(rapidFinanceAdapter.slug, "rapid-finance")
  assert.deepEqual(rapidFinanceAdapter.capabilities, {
    submit: true,
    statusPoll: true,
    webhooks: false,
    offers: true,
  })
  assert.equal(typeof rapidFinanceAdapter.getStatus, "function")
  assert.equal(rapidFinanceAdapter.parseWebhook, undefined)
  assert.equal(RAPID_FINANCE_FIXTURE_TRANSPORT.startsWith("fixture://"), true)

  const payload = application()
  bindRapidFinanceApplication("attempt-rf-1", payload)
  const submitted = await runWithAdapterRuntime(runtime({ apiKey: API_KEY }), () => rapidFinanceAdapter.submit(job()))
  assert.equal(submitted.ok, true)
  assert.equal(submitted.correlationId, "corr-rf-1")
  assert.equal(submitted.externalRef, rapidFinanceDealId("attempt-rf-1"))
  assert.equal(submitted.rawStatus, "SubmittedDeal")
  assert.equal(submitted.fields?.dealId, "rf_attempt-rf-1")
  assert.equal(submitted.fields?.portalUrl, rapidFinancePortalUrl("rf_attempt-rf-1"))
  assert.equal(mapProviderStatus(submitted.rawStatus ?? "").normalized, "submitted")
  assertNoSecrets(submitted)

  const stored = peekFixture("attempt-rf-1")
  assert.ok(stored)
  assert.equal(stored.mapped?.annualRevenue, 720000)
  assert.equal(stored.mapped?.entityType, "llc")
  assert.deepEqual(stored.mapped?.owners, [
    { firstName: "Alex", lastName: "Rivera", ownershipPercent: 60 },
  ])
  assert.equal(JSON.stringify(stored.mapped).includes(SSN), false)

  const status = await runWithAdapterRuntime(runtime({ apiKey: API_KEY }, "corr-status-1"), () => rapidFinanceAdapter.getStatus!(job()))
  assert.equal(status.normalized, "submitted")
  assert.equal(status.rawStatus, "SubmittedDeal")
  assert.equal(status.unknown, false)
  assert.equal(status.terms, undefined)
  assert.equal(status.correlationId, "corr-status-1")
  assert.equal(status.eventId, "rf-event-attempt-rf-1")
  assertNoSecrets(status)
})

test("MIC-133: document receipt is stable on replay", async () => {
  const attempt = job({
    attemptKey: "attempt-docs",
    packageDocumentIds: ["doc-app", "doc-bank"],
    documentVersions: [
      { documentId: "doc-app", checksum: "checksum-app", category: "api_application" },
      { documentId: "doc-bank", checksum: "checksum-bank", category: "statement" },
    ],
  })
  bindRapidFinanceApplication("attempt-docs", application())
  const first = await rapidFinanceAdapter.submit(attempt)
  assert.equal(first.ok, true)
  assert.equal(first.fields?.["documents.0.documentId"], "doc-app")
  assert.equal(first.fields?.["documents.0.category"], "application")
  assert.equal(first.fields?.["documents.0.receiptId"], "rf_doc_attempt-docs_doc-app")
  assert.equal(first.fields?.["documents.1.documentId"], "doc-bank")
  assert.equal(first.fields?.["documents.1.category"], "bank_statements")
  assert.equal(first.fields?.["documents.1.receiptId"], "rf_doc_attempt-docs_doc-bank")
  assertNoSecrets(first)

  const replay = await rapidFinanceAdapter.submit(attempt)
  assert.equal(replay.ok, true)
  assert.equal(replay.externalRef, first.externalRef)
  assert.equal(replay.fields?.portalUrl, first.fields?.portalUrl)
  assert.equal(replay.fields?.["documents.0.receiptId"], first.fields?.["documents.0.receiptId"])
  assert.equal(replay.fields?.["documents.1.receiptId"], first.fields?.["documents.1.receiptId"])
  assert.deepEqual(listFixtureExternalRefs(), ["rf_attempt-docs"])
  assert.equal(peekFixture("attempt-docs")?.submitCalls, 2)
  assert.equal(fixtureSubmitCallCount(), 2)

  const missingDocs = await rapidFinanceAdapter.submit(job({
    attemptKey: "attempt-missing-docs",
    documentVersions: [{ documentId: "doc-other", checksum: "checksum-other", category: "voided_check" }],
  }))
  assert.equal(missingDocs.ok, false)
  assert.equal(missingDocs.errorCode, "validation_failed")
  assert.equal(missingDocs.externalRef, undefined)
  assert.equal(missingDocs.fields?.["documents.application"], "Upload the signed application.")
  assert.equal(missingDocs.fields?.["documents.bankStatements"], "Upload bank statements.")

  const corrected = await rapidFinanceAdapter.submit(job({ attemptKey: "attempt-missing-docs" }))
  assert.equal(corrected.ok, true)
  assert.equal(corrected.externalRef, "rf_attempt-missing-docs")
})

test("MIC-133: timeout, expired credential, and replay do not duplicate submissions", async () => {
  const timeoutJob = job({
    attemptKey: "attempt-timeout",
    route: {
      id: "route-rf-timeout",
      kind: "api",
      label: "API",
      destination: "rapid-finance:timeout",
      documentExceptions: [],
      active: true,
    },
  })
  const timedOut = await rapidFinanceAdapter.submit(timeoutJob)
  assert.equal(timedOut.ok, false)
  assert.equal(timedOut.errorCode, "provider_unavailable")
  assert.match(timedOut.errorMessage ?? "", /timed out/i)
  assert.equal(timedOut.externalRef, "rf_attempt-timeout")

  const recovered = await rapidFinanceAdapter.submit(timeoutJob)
  assert.equal(recovered.ok, true)
  assert.equal(recovered.externalRef, timedOut.externalRef)
  assert.equal(recovered.fields?.dealId, "rf_attempt-timeout")
  assert.deepEqual(listFixtureExternalRefs(), ["rf_attempt-timeout"])

  const expiredJob = job({ attemptKey: "attempt-expired" })
  const expired = await runWithAdapterRuntime(runtime({ apiKey: EXPIRED_CREDENTIAL_TOKEN }, "corr-expired"), () => rapidFinanceAdapter.submit(expiredJob))
  assert.equal(expired.ok, false)
  assert.equal(expired.errorCode, "provider_unavailable")
  assert.match(expired.errorMessage ?? "", /expired/i)
  assert.equal(expired.externalRef, undefined)
  assert.equal(expired.correlationId, "corr-expired")
  assertNoSecrets(expired)
  await assert.rejects(
    () => runWithAdapterRuntime(runtime({ apiKey: EXPIRED_CREDENTIAL_TOKEN }), () => rapidFinanceAdapter.getStatus!(expiredJob)),
    (error: { status?: number; code?: string; message?: string }) => (
      error.status === 503 && error.code === "provider_unavailable" && /expired/i.test(error.message ?? "")
    ),
  )
  assert.equal(listFixtureExternalRefs().includes("rf_attempt-expired"), false)

  const acceptedJob = job({ attemptKey: "attempt-replay" })
  bindRapidFinanceApplication("attempt-replay", application())
  const first = await rapidFinanceAdapter.submit(acceptedJob)
  const replay = await runWithAdapterRuntime(runtime({ apiKey: EXPIRED_CREDENTIAL_TOKEN }, "corr-replay"), () => rapidFinanceAdapter.submit(acceptedJob))
  assert.equal(first.ok, true)
  assert.equal(replay.ok, true)
  assert.equal(replay.externalRef, first.externalRef)
  assert.equal(replay.correlationId, "corr-replay")
  assert.deepEqual(new Set(listFixtureExternalRefs()), new Set(["rf_attempt-timeout", "rf_attempt-replay"]))
  assertNoSecrets(replay)

  setRapidFinanceFixture("rapid-finance:expired-credential")
  const destinationExpired = await rapidFinanceAdapter.submit(job({ attemptKey: "attempt-expired-destination" }))
  assert.equal(destinationExpired.ok, false)
  assert.equal(destinationExpired.externalRef, undefined)
})

test("MIC-133: maps sent/pending/approved/declined/funded and preserves withdrawn/rescinded", async () => {
  assert.equal(mapProviderStatus("SENT").normalized, "submitted")
  assert.equal(mapProviderStatus("InProgress").normalized, "submitted")
  assert.equal(mapProviderStatus("SubmittedDeal").normalized, "submitted")
  assert.equal(mapProviderStatus("Approved").normalized, "approved")
  assert.equal(mapProviderStatus("ApprovedWithStips").normalized, "approved")
  assert.equal(mapProviderStatus("Quoted").normalized, "approved")
  assert.equal(mapProviderStatus("PrequalPass").normalized, "approved")
  assert.equal(mapProviderStatus("Declined").normalized, "declined")
  assert.equal(mapProviderStatus("PreQualFail").normalized, "declined")
  assert.equal(mapProviderStatus("Unqualified_WillingReconsiderLater").normalized, "declined")
  assert.equal(mapProviderStatus("Rejected").normalized, "declined")
  assert.equal(mapProviderStatus("Funded").normalized, "funded")
  assert.equal(mapProviderStatus("ConditionallySubmitted").normalized, "pending")
  assert.equal(mapProviderStatus("Pending").normalized, "pending")
  assert.equal(Object.keys(PROVIDER_STATUS_MAP).length, 14)
  assert.equal(FALLBACK_STATUS_TOKENS.length, 5)

  assert.deepEqual(mapProviderStatus("Withdrawn"), { rawStatus: "Withdrawn", normalized: "unknown", unknown: true })
  assert.deepEqual(mapProviderStatus("ContractsOut"), { rawStatus: "ContractsOut", normalized: "unknown", unknown: true })
  assert.deepEqual(mapProviderStatus("RescindByClient"), { rawStatus: "RescindByClient", normalized: "unknown", unknown: true })
  assert.deepEqual(mapProviderStatus("RescindByRapidFinance"), { rawStatus: "RescindByRapidFinance", normalized: "unknown", unknown: true })
  assert.equal(mapProviderStatus("CREDIT_COMMITTEE_HOLD").unknown, true)

  const pendingJob = job({
    attemptKey: "attempt-pending",
    route: {
      id: "route-rf-pending",
      kind: "api",
      label: "API",
      destination: "rapid-finance:pending",
      documentExceptions: [],
      active: true,
    },
  })
  const pendingSubmit = await rapidFinanceAdapter.submit(pendingJob)
  assert.equal(pendingSubmit.ok, true)
  assert.equal(pendingSubmit.rawStatus, "Pending")
  const pending = await rapidFinanceAdapter.getStatus!(pendingJob)
  assert.equal(pending.normalized, "pending")
  assert.equal(pending.terms, undefined)

  const approvedJob = job({
    attemptKey: "attempt-approved",
    route: {
      id: "route-rf-approved",
      kind: "api",
      label: "API",
      destination: "rapid-finance:approved",
      documentExceptions: [],
      active: true,
    },
  })
  const approvedSubmit = await rapidFinanceAdapter.submit(approvedJob)
  assert.equal(approvedSubmit.ok, true)
  assert.equal(approvedSubmit.rawStatus, "Approved")
  const approved = await rapidFinanceAdapter.getStatus!(approvedJob)
  assert.equal(approved.normalized, "approved")
  assert.equal(approved.unknown, false)
  assert.equal(approved.terms?.amount, SYNTHETIC_OFFER_TERMS.amount)
  assert.equal(approved.terms?.rate, SYNTHETIC_OFFER_TERMS.rate)
  assert.equal(approved.terms?.term, SYNTHETIC_OFFER_TERMS.term)
  assert.equal(approved.terms?.offerLink, SYNTHETIC_OFFER_TERMS.offerLink)

  const fundedJob = job({
    attemptKey: "attempt-funded",
    route: {
      id: "route-rf-funded",
      kind: "api",
      label: "API",
      destination: "rapid-finance:funded",
      documentExceptions: [],
      active: true,
    },
  })
  await rapidFinanceAdapter.submit(fundedJob)
  const funded = await rapidFinanceAdapter.getStatus!(fundedJob)
  assert.equal(funded.normalized, "funded")
  assert.equal(funded.terms?.amount, SYNTHETIC_OFFER_TERMS.amount)

  const declinedJob = job({
    attemptKey: "attempt-declined",
    route: {
      id: "route-rf-declined",
      kind: "api",
      label: "API",
      destination: "rapid-finance:declined",
      documentExceptions: [],
      active: true,
    },
  })
  await rapidFinanceAdapter.submit(declinedJob)
  const declined = await rapidFinanceAdapter.getStatus!(declinedJob)
  assert.equal(declined.rawStatus, "Declined")
  assert.equal(declined.normalized, "declined")
  assert.equal(declined.terms, undefined)

  const withdrawnJob = job({
    attemptKey: "attempt-withdrawn",
    route: {
      id: "route-rf-withdrawn",
      kind: "api",
      label: "API",
      destination: "rapid-finance:withdrawn",
      documentExceptions: [],
      active: true,
    },
  })
  const withdrawnSubmit = await rapidFinanceAdapter.submit(withdrawnJob)
  assert.equal(withdrawnSubmit.ok, true)
  assert.equal(withdrawnSubmit.rawStatus, "Withdrawn")
  const withdrawn = await rapidFinanceAdapter.getStatus!(withdrawnJob)
  assert.equal(withdrawn.rawStatus, "Withdrawn")
  assert.equal(withdrawn.normalized, "unknown")
  assert.equal(withdrawn.unknown, true)
  assert.equal(withdrawn.terms, undefined)

  const rescindedJob = job({
    attemptKey: "attempt-rescinded",
    route: {
      id: "route-rf-rescinded",
      kind: "api",
      label: "API",
      destination: "rapid-finance:rescinded",
      documentExceptions: [],
      active: true,
    },
  })
  await rapidFinanceAdapter.submit(rescindedJob)
  const rescinded = await rapidFinanceAdapter.getStatus!(rescindedJob)
  assert.equal(rescinded.rawStatus, "RescindByRapidFinance")
  assert.equal(rescinded.unknown, true)
  assert.equal(rescinded.terms, undefined)
})
