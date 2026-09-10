import test, { beforeEach } from "node:test"
import assert from "node:assert/strict"
import type { AdapterRuntime } from "../../src/lib/mca/submissions/adapters/contracts"
import { runWithAdapterRuntime } from "../../src/lib/mca/submissions/adapters/credentials"
import type { SubmissionJob } from "../../src/lib/mca/submissions/contracts"
import {
  bindForwardFinancingApplication,
  EXPIRED_CREDENTIAL_TOKEN,
  fixtureSubmitCallCount,
  FORWARD_FINANCING_SLUG,
  forwardFinancingAdapter,
  listFixtureExternalRefs,
  mapEntityType,
  mapIndustry,
  mapProviderStatus,
  peekFixture,
  PROVIDER_STATUS_MAP,
  resetForwardFinancingFixtures,
  setForwardFinancingFixture,
} from "../../src/lib/mca/submissions/adapters/forward-financing"

const SSN = "123456789"
const API_KEY = "ff-development-token-never-leak"

function owner(overrides: Record<string, unknown> = {}) {
  return {
    firstName: "Alex",
    lastName: "Rivera",
    ownershipPercent: 60,
    isPrimary: true,
    ssn: SSN,
    email: "alex.rivera@merchant.example",
    phone: "2125550101",
    ...overrides,
  }
}

function application(overrides: Record<string, unknown> = {}) {
  return {
    legalName: "Harbor Coffee LLC",
    dbaName: "Harbor Coffee",
    ein: "12-3456789",
    entityType: "s_corporation",
    industry: "Food Services",
    startDate: "2019-06-01",
    contactPhone: "2125550199",
    address: { line1: "100 Front Street", city: "New York", state: "NY", postalCode: "10004" },
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
    id: overrides.id ?? "job-ff-1",
    workspaceId: overrides.workspaceId ?? "workspace-ff",
    dealId: overrides.dealId ?? "deal-ff-1",
    funderId: overrides.funderId ?? "funder-ff-1",
    displayFunderName: overrides.displayFunderName ?? "Forward Financing",
    routeKind: "api",
    route: overrides.route ?? {
      id: "route-ff",
      kind: "api",
      label: "API",
      destination: FORWARD_FINANCING_SLUG,
      documentExceptions: [],
      active: true,
    },
    state: overrides.state ?? "sending",
    confirmationKey: overrides.confirmationKey ?? "conf-ff-1",
    attemptKey: overrides.attemptKey ?? "attempt-ff-1",
    dealVersion: overrides.dealVersion ?? 1,
    documentVersions: overrides.documentVersions ?? [],
    packageDocumentIds: overrides.packageDocumentIds ?? [],
    preflightErrors: overrides.preflightErrors ?? [],
    createdAt: overrides.createdAt ?? "2026-01-01T00:00:00.000Z",
    updatedAt: overrides.updatedAt ?? "2026-01-01T00:00:00.000Z",
    ...overrides,
  }
}

function runtime(secrets: AdapterRuntime["secrets"], correlationId = "corr-ff-1"): AdapterRuntime {
  return {
    credentialId: "cred-ff-1",
    workspaceId: "workspace-ff",
    funderId: "funder-ff-1",
    adapterSlug: FORWARD_FINANCING_SLUG,
    environment: "development",
    capabilities: forwardFinancingAdapter.capabilities,
    secrets,
    correlationId,
  }
}

function missingInfoRoute(destination = "forward-financing:missing-info"): SubmissionJob["route"] {
  return {
    id: "route-ff-missing",
    kind: "api",
    label: "API",
    destination,
    documentExceptions: [],
    active: true,
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
  resetForwardFinancingFixtures()
})

test("MIC-131: required-field rejection", () => {
  const empty = forwardFinancingAdapter.validate({})
  assert.equal(empty.ok, false)
  if (empty.ok) throw new Error("expected field errors")
  assert.equal(empty.fields.legalName, "Business name is required.")
  assert.equal(empty.fields.ein, "EIN / Tax ID is required.")
  assert.equal(empty.fields.owners, "At least one business owner is required.")
  assert.equal(empty.fields.industry, "Industry is required.")
  assert.equal(empty.fields.entityType, "Entity type is required.")
  assert.equal(empty.fields.phone, "Business phone is required.")
  assert.equal(empty.fields.startDate, "Business start date is required.")

  const unmappedIndustry = forwardFinancingAdapter.validate(application({
    industry: "crypto mining",
    owners: [owner()],
  }))
  assert.equal(unmappedIndustry.ok, false)
  if (unmappedIndustry.ok) throw new Error("expected industry picklist error")
  assert.match(unmappedIndustry.fields.industry ?? "", /picklist/i)

  const invalid = forwardFinancingAdapter.validate(application({
    ein: "12-345",
    owners: [owner({ ssn: "1234", firstName: "", ownershipPercent: undefined })],
  }))
  assert.equal(invalid.ok, false)
  if (invalid.ok) throw new Error("expected invalid field errors")
  assert.equal(invalid.fields.ein, "EIN must contain 9 digits.")
  assert.equal(invalid.fields["owners.0.firstName"], "Owner first name is required.")
  assert.equal(invalid.fields["owners.0.ssn"], "Owner SSN must contain 9 digits.")
  assert.equal(invalid.fields["owners.0.ownershipPercent"], "Owner ownership percentage is required.")
  assert.equal(forwardFinancingAdapter.validate(application()).ok, true)
})

test("MIC-131: accepted submission maps owners, industry, and status-only capabilities", async () => {
  assert.equal(forwardFinancingAdapter.slug, "forward-financing")
  assert.deepEqual(forwardFinancingAdapter.capabilities, {
    submit: true,
    statusPoll: true,
    webhooks: false,
    offers: false,
  })
  assert.equal(typeof forwardFinancingAdapter.getStatus, "function")
  assert.equal(forwardFinancingAdapter.parseWebhook, undefined)
  assert.equal(mapEntityType("s_corporation"), "S-Corporation")
  assert.equal(mapEntityType("nonprofit"), "Other")
  assert.equal(mapIndustry("Food Services"), "Restaurants")
  assert.equal(mapIndustry("crypto mining"), undefined)

  const payload = application()
  bindForwardFinancingApplication("attempt-ff-1", payload)
  const submitted = await runWithAdapterRuntime(runtime({ apiKey: API_KEY }), () => forwardFinancingAdapter.submit(job()))
  assert.equal(submitted.ok, true)
  assert.equal(submitted.correlationId, "corr-ff-1")
  assert.equal(submitted.externalRef, "ff_attempt-ff-1")
  assert.equal(submitted.rawStatus, "Submitted")
  assert.equal(submitted.fields?.documentsComplete, "true")
  assertNoSecrets(submitted)

  const stored = peekFixture("attempt-ff-1")
  assert.ok(stored)
  assert.equal(stored.mapped?.entityType, "S-Corporation")
  assert.equal(stored.mapped?.industry, "Restaurants")
  assert.deepEqual(stored.mapped?.owners, [
    { firstName: "Alex", lastName: "Rivera", ownershipPercent: 55, ssnLast4: "6789" },
    { firstName: "Jordan", lastName: "Nguyen", ownershipPercent: 30, ssnLast4: "4321" },
  ])
  assert.equal(stored.mapped?.owners?.length, 2)

  const status = await runWithAdapterRuntime(runtime({ apiKey: API_KEY }, "corr-status-1"), () => forwardFinancingAdapter.getStatus!(job()))
  assert.equal(status.normalized, "submitted")
  assert.equal(status.rawStatus, "Submitted")
  assert.equal(status.unknown, false)
  assert.equal(status.terms, undefined)
  assert.equal(status.correlationId, "corr-status-1")
  assert.equal(status.eventId, "ff-event-attempt-ff-1")
  assertNoSecrets(status)
})

test("MIC-131: document receipt is stable on replay and post-submit upload", async () => {
  const attempt = job({
    attemptKey: "attempt-docs",
    packageDocumentIds: ["doc-app", "doc-bank"],
    documentVersions: [
      { documentId: "doc-app", checksum: "checksum-app", category: "api_application" },
      { documentId: "doc-bank", checksum: "checksum-bank", category: "statement" },
    ],
  })
  bindForwardFinancingApplication("attempt-docs", application({ owners: [owner()] }))
  const first = await forwardFinancingAdapter.submit(attempt)
  assert.equal(first.ok, true)
  assert.equal(first.fields?.["documents.0.documentId"], "doc-app")
  assert.equal(first.fields?.["documents.0.category"], "application")
  assert.equal(first.fields?.["documents.0.receiptId"], "ff_doc_attempt-docs_doc-app")
  assert.equal(first.fields?.["documents.1.documentId"], "doc-bank")
  assert.equal(first.fields?.["documents.1.category"], "bank_statements")
  assert.equal(first.fields?.["documents.1.receiptId"], "ff_doc_attempt-docs_doc-bank")
  assertNoSecrets(first)

  const replay = await forwardFinancingAdapter.submit(attempt)
  assert.equal(replay.ok, true)
  assert.equal(replay.externalRef, first.externalRef)
  assert.equal(replay.fields?.["documents.0.receiptId"], first.fields?.["documents.0.receiptId"])
  assert.equal(replay.fields?.["documents.1.receiptId"], first.fields?.["documents.1.receiptId"])
  assert.deepEqual(listFixtureExternalRefs(), ["ff_attempt-docs"])
  assert.equal(peekFixture("attempt-docs")?.submitCalls, 2)
  assert.equal(fixtureSubmitCallCount(), 2)
})

test("MIC-131: timeout, expired credential, and replay do not duplicate submissions", async () => {
  const timeoutJob = job({
    attemptKey: "attempt-timeout",
    route: {
      id: "route-ff-timeout",
      kind: "api",
      label: "API",
      destination: "forward-financing:timeout",
      documentExceptions: [],
      active: true,
    },
  })
  const timedOut = await forwardFinancingAdapter.submit(timeoutJob)
  assert.equal(timedOut.ok, false)
  assert.equal(timedOut.errorCode, "provider_unavailable")
  assert.match(timedOut.errorMessage ?? "", /timed out/i)
  assert.equal(timedOut.externalRef, "ff_attempt-timeout")

  const recovered = await forwardFinancingAdapter.submit(timeoutJob)
  assert.equal(recovered.ok, true)
  assert.equal(recovered.externalRef, timedOut.externalRef)
  assert.deepEqual(listFixtureExternalRefs(), ["ff_attempt-timeout"])

  const expiredJob = job({ attemptKey: "attempt-expired" })
  const expired = await runWithAdapterRuntime(runtime({ apiKey: EXPIRED_CREDENTIAL_TOKEN }, "corr-expired"), () => forwardFinancingAdapter.submit(expiredJob))
  assert.equal(expired.ok, false)
  assert.equal(expired.errorCode, "provider_unavailable")
  assert.match(expired.errorMessage ?? "", /expired/i)
  assert.equal(expired.externalRef, undefined)
  assert.equal(expired.correlationId, "corr-expired")
  assertNoSecrets(expired)
  await assert.rejects(
    () => runWithAdapterRuntime(runtime({ apiKey: EXPIRED_CREDENTIAL_TOKEN }), () => forwardFinancingAdapter.getStatus!(expiredJob)),
    (error: { status?: number; code?: string; message?: string }) => (
      error.status === 503 && error.code === "provider_unavailable" && /expired/i.test(error.message ?? "")
    ),
  )
  assert.equal(listFixtureExternalRefs().includes("ff_attempt-expired"), false)

  const acceptedJob = job({ attemptKey: "attempt-replay" })
  bindForwardFinancingApplication("attempt-replay", application({ owners: [owner()] }))
  const first = await forwardFinancingAdapter.submit(acceptedJob)
  const replay = await runWithAdapterRuntime(runtime({ apiKey: EXPIRED_CREDENTIAL_TOKEN }, "corr-replay"), () => forwardFinancingAdapter.submit(acceptedJob))
  assert.equal(first.ok, true)
  assert.equal(replay.ok, true)
  assert.equal(replay.externalRef, first.externalRef)
  assert.equal(replay.correlationId, "corr-replay")
  assert.deepEqual(new Set(listFixtureExternalRefs()), new Set(["ff_attempt-timeout", "ff_attempt-replay"]))
  assertNoSecrets(replay)

  setForwardFinancingFixture("forward-financing:expired-credential")
  const destinationExpired = await forwardFinancingAdapter.submit(job({ attemptKey: "attempt-expired-destination" }))
  assert.equal(destinationExpired.ok, false)
  assert.equal(destinationExpired.externalRef, undefined)
})

test("MIC-131: missing-info stays pending until documents are complete", async () => {
  assert.deepEqual(mapProviderStatus("Submitted"), { rawStatus: "Submitted", normalized: "submitted", unknown: false })
  assert.deepEqual(mapProviderStatus("Approved"), { rawStatus: "Approved", normalized: "approved", unknown: false })
  assert.deepEqual(mapProviderStatus("Offered"), { rawStatus: "Offered", normalized: "approved", unknown: false })
  assert.deepEqual(mapProviderStatus("Declined"), { rawStatus: "Declined", normalized: "declined", unknown: false })
  assert.deepEqual(mapProviderStatus("Funded"), { rawStatus: "Funded", normalized: "funded", unknown: false })
  assert.equal(mapProviderStatus("CREDIT_COMMITTEE_HOLD").unknown, true)
  assert.equal(Object.keys(PROVIDER_STATUS_MAP).length, 9)
  assert.equal(mapProviderStatus("Offered").normalized, "approved")

  const pending = mapProviderStatus("Missing Info", ["bank statements", "voided check"])
  assert.equal(pending.normalized, "pending")
  assert.equal(pending.unknown, false)
  assert.match(pending.rawStatus, /bank statements/)
  assert.match(pending.rawStatus, /voided check/)

  const incompleteJob = job({
    attemptKey: "attempt-missing-info",
    route: missingInfoRoute(),
  })
  const submitted = await forwardFinancingAdapter.submit(incompleteJob)
  assert.equal(submitted.ok, true)
  assert.equal(submitted.rawStatus, "Missing Info")
  assert.equal(submitted.fields?.documentsComplete, "false")
  const status = await forwardFinancingAdapter.getStatus!(incompleteJob)
  assert.equal(status.normalized, "pending")
  assert.equal(status.unknown, false)
  assert.equal(status.terms, undefined)
  assert.match(status.rawStatus, /outstanding document requests/)
  assert.match(status.rawStatus, /bank statements/)

  const completedJob = job({
    ...incompleteJob,
    packageDocumentIds: ["doc-bank", "doc-check"],
    documentVersions: [
      { documentId: "doc-bank", checksum: "checksum-bank", category: "statement" },
      { documentId: "doc-check", checksum: "checksum-check", category: "voided_check" },
    ],
  })
  const completed = await forwardFinancingAdapter.submit(completedJob)
  assert.equal(completed.ok, true)
  assert.equal(completed.externalRef, submitted.externalRef)
  assert.equal(completed.rawStatus, "Submitted")
  assert.equal(completed.fields?.documentsComplete, "true")
  assert.equal(completed.fields?.["documents.0.receiptId"], "ff_doc_attempt-missing-info_doc-bank")
  assert.equal(completed.fields?.["documents.1.receiptId"], "ff_doc_attempt-missing-info_doc-check")
  const ready = await forwardFinancingAdapter.getStatus!(completedJob)
  assert.equal(ready.normalized, "submitted")
  assert.equal(ready.rawStatus, "Submitted")
  assert.equal(ready.terms, undefined)
  assert.deepEqual(listFixtureExternalRefs(), ["ff_attempt-missing-info"])

  const approvedJob = job({
    attemptKey: "attempt-approved",
    route: {
      id: "route-ff-approved",
      kind: "api",
      label: "API",
      destination: "forward-financing:approved",
      documentExceptions: [],
      active: true,
    },
  })
  const approved = await forwardFinancingAdapter.submit(approvedJob)
  assert.equal(approved.ok, true)
  assert.equal(approved.rawStatus, "Approved")
  const approvedStatus = await forwardFinancingAdapter.getStatus!(approvedJob)
  assert.equal(approvedStatus.normalized, "approved")
  assert.equal(approvedStatus.terms, undefined)

  const declinedJob = job({
    attemptKey: "attempt-declined",
    route: {
      id: "route-ff-declined",
      kind: "api",
      label: "API",
      destination: "forward-financing:declined",
      documentExceptions: [],
      active: true,
    },
  })
  const declined = await forwardFinancingAdapter.submit(declinedJob)
  assert.equal(declined.ok, true)
  assert.equal(declined.rawStatus, "Declined")
  const declinedStatus = await forwardFinancingAdapter.getStatus!(declinedJob)
  assert.equal(declinedStatus.normalized, "declined")
  assert.equal(declinedStatus.terms, undefined)
})
