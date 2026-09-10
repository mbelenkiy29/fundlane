import test, { beforeEach } from "node:test"
import assert from "node:assert/strict"
import type { AdapterRuntime } from "../../src/lib/mca/submissions/adapters/contracts"
import { runWithAdapterRuntime } from "../../src/lib/mca/submissions/adapters/credentials"
import type { SubmissionJob } from "../../src/lib/mca/submissions/contracts"
import {
  applicationIdForAttempt,
  bindPlexeApplication,
  DEFAULT_FUNDING_PURPOSE,
  EXPIRED_CREDENTIAL_TOKEN,
  fixtureSubmitCallCount,
  listFixtureExternalRefs,
  mapProviderStatus,
  peekFixture,
  plexeAdapter,
  PLEXE_SLUG,
  PROVIDER_STATUS_MAP,
  REQUESTED_AMOUNT_MULTIPLIER,
  resetPlexeFixtures,
  selectHighestOwner,
  setPlexeFixture,
  validateApplication,
} from "../../src/lib/mca/submissions/adapters/plexe"

const SSN = "219887654"
const API_KEY = "plexe-development-token-never-leak"

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
    address: { line1: "100 Front Street", city: "New York", state: "NY", postalCode: "10004" },
    annualRevenue: 600000,
    confirmInferredTerms: true,
    owners: [
      owner({ firstName: "Sam", lastName: "Lee", ownershipPercent: 15, isPrimary: false, email: "sam.lee@merchant.example", ssn: "111223333" }),
      owner({ firstName: "Alex", lastName: "Rivera", ownershipPercent: 55, isPrimary: true }),
      owner({ firstName: "Jordan", lastName: "Nguyen", ownershipPercent: 30, isPrimary: false, email: "jordan.nguyen@merchant.example", ssn: "987654321" }),
    ],
    ...overrides,
  }
}

function job(overrides: Partial<SubmissionJob> = {}): SubmissionJob {
  return {
    id: overrides.id ?? "job-plexe-1",
    workspaceId: overrides.workspaceId ?? "workspace-plexe",
    dealId: overrides.dealId ?? "deal-plexe-1",
    funderId: overrides.funderId ?? "funder-plexe-1",
    displayFunderName: overrides.displayFunderName ?? "Plexe",
    routeKind: "api",
    route: overrides.route ?? {
      id: "route-plexe",
      kind: "api",
      label: "API",
      destination: PLEXE_SLUG,
      documentExceptions: [],
      active: true,
    },
    state: overrides.state ?? "sending",
    confirmationKey: overrides.confirmationKey ?? "conf-plexe-1",
    attemptKey: overrides.attemptKey ?? "attempt-plexe-1",
    dealVersion: overrides.dealVersion ?? 1,
    documentVersions: overrides.documentVersions ?? [],
    packageDocumentIds: overrides.packageDocumentIds ?? [],
    preflightErrors: overrides.preflightErrors ?? [],
    createdAt: overrides.createdAt ?? "2026-01-01T00:00:00.000Z",
    updatedAt: overrides.updatedAt ?? "2026-01-01T00:00:00.000Z",
    ...overrides,
  }
}

function runtime(secrets: AdapterRuntime["secrets"], correlationId = "corr-plexe-1"): AdapterRuntime {
  return {
    credentialId: "cred-plexe-1",
    workspaceId: "workspace-plexe",
    funderId: "funder-plexe-1",
    adapterSlug: PLEXE_SLUG,
    environment: "development",
    capabilities: plexeAdapter.capabilities,
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
  resetPlexeFixtures()
})

test("MIC-135: required-field rejection", () => {
  const empty = plexeAdapter.validate({})
  assert.equal(empty.ok, false)
  if (empty.ok) throw new Error("expected field errors")
  assert.equal(empty.fields.legalName, "Business name is required.")
  assert.equal(empty.fields.postalCode, "Business ZIP is required.")
  assert.equal(empty.fields.owners, "At least one business owner is required.")
  assert.match(empty.fields.annualRevenue ?? "", /annual revenue or statement deposit/i)
  assert.match(empty.fields.statementDeposits ?? "", /annual revenue or statement deposit/i)

  const incompleteOwner = plexeAdapter.validate(application({
    owners: [
      owner({ firstName: "Sam", lastName: "Lee", ownershipPercent: 15, isPrimary: true, email: "sam.lee@merchant.example" }),
      owner({ firstName: "Alex", lastName: "Rivera", ownershipPercent: 55, isPrimary: false, email: "" }),
    ],
  }))
  assert.equal(incompleteOwner.ok, false)
  if (incompleteOwner.ok) throw new Error("expected highest-owner field errors")
  assert.equal(incompleteOwner.fields["owners.1.email"], "Owner email is required.")
  assert.equal(incompleteOwner.fields["owners.0.email"], undefined)

  const noRevenue = plexeAdapter.validate(application({
    annualRevenue: undefined,
    monthlyRevenue: undefined,
    statementDeposits: [],
    confirmInferredTerms: true,
    owners: [owner()],
  }))
  assert.equal(noRevenue.ok, false)
  if (noRevenue.ok) throw new Error("expected revenue field errors")
  assert.match(noRevenue.fields.annualRevenue ?? "", /annual revenue or statement deposit/i)

  const unconfirmed = plexeAdapter.validate(application({
    confirmInferredTerms: false,
    requestedAmount: undefined,
    fundingPurpose: undefined,
    owners: [owner()],
  }))
  assert.equal(unconfirmed.ok, false)
  if (unconfirmed.ok) throw new Error("expected inferred-term confirmation")
  assert.match(unconfirmed.fields.requestedAmount ?? "", /inferred requested amount of 100000/)
  assert.match(unconfirmed.fields.requestedAmount ?? "", /monthly revenue 50000/)
  assert.match(unconfirmed.fields.fundingPurpose ?? "", /Working Capital/)

  const explicitTerms = plexeAdapter.validate(application({
    confirmInferredTerms: false,
    requestedAmount: 80000,
    fundingPurpose: "Expansion",
    owners: [owner()],
  }))
  assert.equal(explicitTerms.ok, true)

  const depositsOnly = plexeAdapter.validate(application({
    annualRevenue: undefined,
    statementDeposits: [48000, 52000, 50000],
    confirmInferredTerms: true,
    owners: [owner()],
  }))
  assert.equal(depositsOnly.ok, true)
  const depositsMapped = validateApplication(application({
    annualRevenue: undefined,
    statementDeposits: [48000, 52000, 50000],
    confirmInferredTerms: true,
    owners: [owner()],
  }))
  assert.equal(depositsMapped.ok, true)
  if (!depositsMapped.ok) throw new Error("expected deposits-only application")
  assert.equal(depositsMapped.value.revenueSource, "statement_deposits")
  assert.equal(depositsMapped.value.monthlyRevenue, 50000)
  assert.equal(depositsMapped.value.requestedAmount, 100000)
  assert.equal(depositsMapped.value.fundingPurpose, DEFAULT_FUNDING_PURPOSE)

  assert.equal(plexeAdapter.validate(application()).ok, true)
})

test("MIC-135: accepted submission maps highest owner, inferred terms, and status-only capabilities", async () => {
  assert.equal(plexeAdapter.slug, "plexe")
  assert.deepEqual(plexeAdapter.capabilities, {
    submit: true,
    statusPoll: true,
    webhooks: false,
    offers: false,
  })
  assert.equal(typeof plexeAdapter.getStatus, "function")
  assert.equal(plexeAdapter.parseWebhook, undefined)
  assert.equal(REQUESTED_AMOUNT_MULTIPLIER, 2)
  assert.equal(selectHighestOwner([
    { firstName: "Sam", ownershipPercent: 15, isPrimary: true },
    { firstName: "Alex", ownershipPercent: 55, isPrimary: false },
  ])?.firstName, "Alex")

  const payload = application()
  bindPlexeApplication("attempt-plexe-1", payload)
  const submitted = await runWithAdapterRuntime(runtime({ apiKey: API_KEY }), () => plexeAdapter.submit(job()))
  assert.equal(submitted.ok, true)
  assert.equal(submitted.correlationId, "corr-plexe-1")
  assert.equal(submitted.externalRef, applicationIdForAttempt("attempt-plexe-1"))
  assert.equal(submitted.rawStatus, "Sent")
  assert.equal(submitted.fields?.applicationId, submitted.externalRef)
  assertNoSecrets(submitted)

  const stored = peekFixture("attempt-plexe-1")
  assert.ok(stored)
  assert.equal(stored.mapped?.legalName, "Harbor Coffee LLC")
  assert.equal(stored.mapped?.ownerFirstName, "Alex")
  assert.equal(stored.mapped?.ownerLastName, "Rivera")
  assert.equal(stored.mapped?.ownershipPercent, 55)
  assert.equal(stored.mapped?.monthlyRevenue, 50000)
  assert.equal(stored.mapped?.requestedAmount, 100000)
  assert.equal(stored.mapped?.requestedAmountInferred, true)
  assert.equal(stored.mapped?.fundingPurpose, DEFAULT_FUNDING_PURPOSE)
  assert.equal(stored.mapped?.fundingPurposeInferred, true)
  assert.equal(stored.mapped?.revenueSource, "annual_revenue")

  const mapped = validateApplication(payload)
  assert.equal(mapped.ok, true)
  if (!mapped.ok) throw new Error("expected valid application")
  assert.equal(mapped.value.owner.ssnLast4, "7654")
  assert.equal("ssn" in mapped.value.owner, false)
  assert.equal(JSON.stringify(mapped.value.owner).includes(SSN), false)

  const status = await runWithAdapterRuntime(runtime({ apiKey: API_KEY }, "corr-status-1"), () => plexeAdapter.getStatus!(job()))
  assert.equal(status.normalized, "submitted")
  assert.equal(status.rawStatus, "Sent")
  assert.equal(status.unknown, false)
  assert.equal(status.terms, undefined)
  assert.equal(status.correlationId, "corr-status-1")
  assert.equal(status.eventId, "plexe-event-attempt-plexe-1")
  assertNoSecrets(status)
})

test("MIC-135: bank statement document receipt is stable on replay", async () => {
  const attempt = job({
    attemptKey: "attempt-docs",
    packageDocumentIds: ["doc-app", "doc-bank"],
    documentVersions: [
      { documentId: "doc-app", checksum: "checksum-app", category: "api_application" },
      { documentId: "doc-bank", checksum: "checksum-bank", category: "statement" },
    ],
  })
  bindPlexeApplication("attempt-docs", application({ owners: [owner()] }))
  const first = await plexeAdapter.submit(attempt)
  assert.equal(first.ok, true)
  assert.equal(first.fields?.documentReceipt, "accepted")
  assert.equal(first.fields?.documentsReceived, "1")
  assert.equal(first.fields?.["documents.0.documentId"], "doc-bank")
  assert.equal(first.fields?.["documents.0.category"], "bank_statements")
  assert.equal(first.fields?.["documents.0.receiptId"], "plexe_doc_attempt-docs_doc-bank")
  assert.equal(first.fields?.["documents.1.documentId"], undefined)
  assertNoSecrets(first)

  const replay = await plexeAdapter.submit(attempt)
  assert.equal(replay.ok, true)
  assert.equal(replay.externalRef, first.externalRef)
  assert.deepEqual(replay.fields, first.fields)
  assert.deepEqual(listFixtureExternalRefs(), ["plexe_attempt-docs"])
  assert.equal(peekFixture("attempt-docs")?.submitCalls, 2)
  assert.equal(fixtureSubmitCallCount(), 2)
})

test("MIC-135: timeout, expired credential, and replay do not duplicate submissions", async () => {
  const timeoutJob = job({
    attemptKey: "attempt-timeout",
    route: {
      id: "route-plexe-timeout",
      kind: "api",
      label: "API",
      destination: "plexe:timeout",
      documentExceptions: [],
      active: true,
    },
  })
  const timedOut = await plexeAdapter.submit(timeoutJob)
  assert.equal(timedOut.ok, false)
  assert.equal(timedOut.errorCode, "provider_unavailable")
  assert.match(timedOut.errorMessage ?? "", /timed out/i)
  assert.equal(timedOut.externalRef, "plexe_attempt-timeout")

  const recovered = await plexeAdapter.submit(timeoutJob)
  assert.equal(recovered.ok, true)
  assert.equal(recovered.externalRef, timedOut.externalRef)
  assert.equal(recovered.rawStatus, "Sent")
  assert.deepEqual(listFixtureExternalRefs(), ["plexe_attempt-timeout"])

  const expiredJob = job({ attemptKey: "attempt-expired" })
  const expired = await runWithAdapterRuntime(runtime({ apiKey: EXPIRED_CREDENTIAL_TOKEN }, "corr-expired"), () => plexeAdapter.submit(expiredJob))
  assert.equal(expired.ok, false)
  assert.equal(expired.errorCode, "provider_unavailable")
  assert.match(expired.errorMessage ?? "", /expired/i)
  assert.equal(expired.externalRef, undefined)
  assert.equal(expired.correlationId, "corr-expired")
  assertNoSecrets(expired)
  await assert.rejects(
    () => runWithAdapterRuntime(runtime({ apiKey: EXPIRED_CREDENTIAL_TOKEN }), () => plexeAdapter.getStatus!(expiredJob)),
    (error: { status?: number; code?: string; message?: string }) => (
      error.status === 503 && error.code === "provider_unavailable" && /expired/i.test(error.message ?? "")
    ),
  )
  assert.equal(listFixtureExternalRefs().includes("plexe_attempt-expired"), false)

  const acceptedJob = job({ attemptKey: "attempt-replay" })
  bindPlexeApplication("attempt-replay", application({ owners: [owner()] }))
  const first = await plexeAdapter.submit(acceptedJob)
  const replay = await runWithAdapterRuntime(runtime({ apiKey: EXPIRED_CREDENTIAL_TOKEN }, "corr-replay"), () => plexeAdapter.submit(acceptedJob))
  assert.equal(first.ok, true)
  assert.equal(replay.ok, true)
  assert.equal(replay.externalRef, first.externalRef)
  assert.equal(replay.correlationId, "corr-replay")
  assert.deepEqual(new Set(listFixtureExternalRefs()), new Set(["plexe_attempt-timeout", "plexe_attempt-replay"]))
  assertNoSecrets(replay)

  setPlexeFixture("plexe:expired-credential")
  const destinationExpired = await plexeAdapter.submit(job({ attemptKey: "attempt-expired-destination" }))
  assert.equal(destinationExpired.ok, false)
  assert.equal(destinationExpired.externalRef, undefined)
})

test("MIC-135: status retrieval maps documented outcomes without inventing offers", async () => {
  assert.deepEqual(mapProviderStatus("Sent"), { rawStatus: "Sent", normalized: "submitted", unknown: false })
  assert.deepEqual(mapProviderStatus("In Review"), { rawStatus: "In Review", normalized: "pending", unknown: false })
  assert.deepEqual(mapProviderStatus("Approved"), { rawStatus: "Approved", normalized: "approved", unknown: false })
  assert.deepEqual(mapProviderStatus("Funded"), { rawStatus: "Funded", normalized: "funded", unknown: false })
  assert.deepEqual(mapProviderStatus("Declined"), { rawStatus: "Declined", normalized: "declined", unknown: false })
  assert.equal(mapProviderStatus("CREDIT_COMMITTEE_HOLD").unknown, true)
  assert.equal(Object.keys(PROVIDER_STATUS_MAP).length, 11)

  const declinedJob = job({
    attemptKey: "attempt-declined",
    route: {
      id: "route-plexe-declined",
      kind: "api",
      label: "API",
      destination: "plexe:declined",
      documentExceptions: [],
      active: true,
    },
  })
  const submitted = await plexeAdapter.submit(declinedJob)
  assert.equal(submitted.ok, true)
  assert.equal(submitted.rawStatus, "Sent")
  const declinedStatus = await plexeAdapter.getStatus!(declinedJob)
  assert.equal(declinedStatus.normalized, "declined")
  assert.equal(declinedStatus.rawStatus, "Declined")
  assert.equal(declinedStatus.unknown, false)
  assert.equal(declinedStatus.terms, undefined)

  const unknownJob = job({
    attemptKey: "attempt-unknown",
    route: {
      id: "route-plexe-unknown",
      kind: "api",
      label: "API",
      destination: "plexe:unknown",
      documentExceptions: [],
      active: true,
    },
  })
  const unknownSubmit = await plexeAdapter.submit(unknownJob)
  assert.equal(unknownSubmit.ok, true)
  assert.equal(unknownSubmit.rawStatus, "Sent")
  const unknownStatus = await plexeAdapter.getStatus!(unknownJob)
  assert.equal(unknownStatus.normalized, "unknown")
  assert.equal(unknownStatus.unknown, true)
  assert.equal(unknownStatus.rawStatus, "CREDIT_COMMITTEE_HOLD")
  assert.equal(unknownStatus.terms, undefined)
})
