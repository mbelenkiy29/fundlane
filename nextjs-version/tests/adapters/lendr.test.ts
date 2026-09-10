import test, { beforeEach } from "node:test"
import assert from "node:assert/strict"
import type { AdapterRuntime } from "../../src/lib/mca/submissions/adapters/contracts"
import { runWithAdapterRuntime } from "../../src/lib/mca/submissions/adapters/credentials"
import type { SubmissionJob } from "../../src/lib/mca/submissions/contracts"
import {
  bindLendrApplication,
  EXPIRED_CREDENTIAL_TOKEN,
  fixtureSubmitCallCount,
  LENDR_FIXTURE_TRANSPORT,
  LENDR_SLUG,
  lendrAdapter,
  lendrDealId,
  lendrPortalUrl,
  listFixtureExternalRefs,
  mapProviderStatus,
  peekFixture,
  PROVIDER_STATUS_MAP,
  resetLendrFixtures,
  setLendrFixture,
} from "../../src/lib/mca/submissions/adapters/lendr"

const SSN = "123456789"
const API_KEY = "lendr-development-token-never-leak"

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
    address: { line1: "100 Front Street", city: "New York", state: "NY", postalCode: "10004" },
    owners: [owner()],
    documents: documents(),
    ...overrides,
  }
}

function job(overrides: Partial<SubmissionJob> = {}): SubmissionJob {
  return {
    id: overrides.id ?? "job-lendr-1",
    workspaceId: overrides.workspaceId ?? "workspace-lendr",
    dealId: overrides.dealId ?? "deal-lendr-1",
    funderId: overrides.funderId ?? "funder-lendr-1",
    displayFunderName: overrides.displayFunderName ?? "Lendr",
    routeKind: "api",
    route: overrides.route ?? {
      id: "route-lendr",
      kind: "api",
      label: "API",
      destination: LENDR_SLUG,
      documentExceptions: [],
      active: true,
    },
    state: overrides.state ?? "sending",
    confirmationKey: overrides.confirmationKey ?? "conf-lendr-1",
    attemptKey: overrides.attemptKey ?? "attempt-lendr-1",
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

function runtime(secrets: AdapterRuntime["secrets"], correlationId = "corr-lendr-1"): AdapterRuntime {
  return {
    credentialId: "cred-lendr-1",
    workspaceId: "workspace-lendr",
    funderId: "funder-lendr-1",
    adapterSlug: LENDR_SLUG,
    environment: "development",
    capabilities: lendrAdapter.capabilities,
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
  resetLendrFixtures()
})

test("MIC-142: required-field rejection", () => {
  const empty = lendrAdapter.validate({})
  assert.equal(empty.ok, false)
  if (empty.ok) throw new Error("expected field errors")
  assert.equal(empty.fields.legalName, "Business name is required.")
  assert.equal(empty.fields.ein, "EIN / Tax ID is required.")
  assert.equal(empty.fields.industry, "Industry is required.")
  assert.equal(empty.fields.entityType, "Entity type is required.")
  assert.equal(empty.fields.phone, "Business phone is required.")
  assert.equal(empty.fields.owners, "At least one business owner is required.")
  assert.equal(empty.fields["documents.application"], "Upload the application file.")
  assert.equal(empty.fields["documents.bankStatements"], "Upload bank statements.")
  assert.equal(empty.fields.annualRevenue, undefined)
  assert.equal(empty.fields.businessEmail, undefined)

  const missingOwnerPhone = lendrAdapter.validate(application({
    owners: [owner({ phone: "" })],
  }))
  assert.equal(missingOwnerPhone.ok, false)
  if (missingOwnerPhone.ok) throw new Error("expected owner phone error")
  assert.equal(missingOwnerPhone.fields["owners.0.phone"], "Owner phone is required.")

  const invalid = lendrAdapter.validate(application({
    ein: "12-345",
    owners: [owner({ ssn: "1234", firstName: "", ownershipPercent: undefined, dateOfBirth: "", phone: "555" })],
    documents: [{ documentId: "doc-other", category: "voided_check", checksum: "checksum-other" }],
  }))
  assert.equal(invalid.ok, false)
  if (invalid.ok) throw new Error("expected invalid field errors")
  assert.equal(invalid.fields.ein, "EIN must contain 9 digits.")
  assert.equal(invalid.fields["owners.0.firstName"], "Owner first name is required.")
  assert.equal(invalid.fields["owners.0.ssn"], "Owner SSN must contain 9 digits.")
  assert.equal(invalid.fields["owners.0.dateOfBirth"], "Owner date of birth is required.")
  assert.equal(invalid.fields["owners.0.ownershipPercent"], "Owner ownership percentage is required.")
  assert.equal(invalid.fields["owners.0.phone"], "Owner phone must include at least 10 digits.")
  assert.equal(invalid.fields["documents.application"], "Upload the application file.")
  assert.equal(invalid.fields["documents.bankStatements"], "Upload bank statements.")
  assert.equal(lendrAdapter.validate(application()).ok, true)
})

test("MIC-142: accepted submission returns Deal ID, portal navigation, and status-only capabilities", async () => {
  assert.equal(lendrAdapter.slug, "lendr")
  assert.deepEqual(lendrAdapter.capabilities, {
    submit: true,
    statusPoll: true,
    webhooks: false,
    offers: false,
  })
  assert.equal(typeof lendrAdapter.getStatus, "function")
  assert.equal(lendrAdapter.parseWebhook, undefined)
  assert.equal(LENDR_FIXTURE_TRANSPORT.startsWith("fixture://"), true)

  const payload = application()
  bindLendrApplication("attempt-lendr-1", payload)
  const submitted = await runWithAdapterRuntime(runtime({ apiKey: API_KEY }), () => lendrAdapter.submit(job()))
  assert.equal(submitted.ok, true)
  assert.equal(submitted.correlationId, "corr-lendr-1")
  assert.equal(submitted.externalRef, lendrDealId("attempt-lendr-1"))
  assert.equal(submitted.rawStatus, "Submitted")
  assert.equal(submitted.fields?.dealId, "lendr_attempt-lendr-1")
  assert.equal(submitted.fields?.portalUrl, lendrPortalUrl("lendr_attempt-lendr-1"))
  assert.equal(mapProviderStatus(submitted.rawStatus ?? "").normalized, "submitted")
  assertNoSecrets(submitted)

  const stored = peekFixture("attempt-lendr-1")
  assert.ok(stored)
  assert.equal(stored.mapped?.legalName, "Harbor Coffee LLC")
  assert.equal(stored.mapped?.entityType, "llc")
  assert.deepEqual(stored.mapped?.owners, [
    { firstName: "Alex", lastName: "Rivera", ownershipPercent: 60, phone: "2125550101" },
  ])
  assert.equal(JSON.stringify(stored.mapped).includes(SSN), false)

  const status = await runWithAdapterRuntime(runtime({ apiKey: API_KEY }, "corr-status-1"), () => lendrAdapter.getStatus!(job()))
  assert.equal(status.normalized, "submitted")
  assert.equal(status.rawStatus, "Submitted")
  assert.equal(status.unknown, false)
  assert.equal(status.terms, undefined)
  assert.equal(status.correlationId, "corr-status-1")
  assert.equal(status.eventId, "lendr-event-attempt-lendr-1")
  assertNoSecrets(status)
})

test("MIC-142: document receipt is stable on replay", async () => {
  const attempt = job({
    attemptKey: "attempt-docs",
    packageDocumentIds: ["doc-app", "doc-bank"],
    documentVersions: [
      { documentId: "doc-app", checksum: "checksum-app", category: "api_application" },
      { documentId: "doc-bank", checksum: "checksum-bank", category: "statement" },
    ],
  })
  bindLendrApplication("attempt-docs", application())
  const first = await lendrAdapter.submit(attempt)
  assert.equal(first.ok, true)
  assert.equal(first.fields?.portalUrl, lendrPortalUrl("lendr_attempt-docs"))
  assert.equal(first.fields?.["documents.0.documentId"], "doc-app")
  assert.equal(first.fields?.["documents.0.category"], "application")
  assert.equal(first.fields?.["documents.0.receiptId"], "lendr_doc_attempt-docs_doc-app")
  assert.equal(first.fields?.["documents.1.documentId"], "doc-bank")
  assert.equal(first.fields?.["documents.1.category"], "bank_statements")
  assert.equal(first.fields?.["documents.1.receiptId"], "lendr_doc_attempt-docs_doc-bank")
  assertNoSecrets(first)

  const replay = await lendrAdapter.submit(attempt)
  assert.equal(replay.ok, true)
  assert.equal(replay.externalRef, first.externalRef)
  assert.equal(replay.fields?.portalUrl, first.fields?.portalUrl)
  assert.equal(replay.fields?.["documents.0.receiptId"], first.fields?.["documents.0.receiptId"])
  assert.equal(replay.fields?.["documents.1.receiptId"], first.fields?.["documents.1.receiptId"])
  assert.deepEqual(listFixtureExternalRefs(), ["lendr_attempt-docs"])
  assert.equal(peekFixture("attempt-docs")?.submitCalls, 2)
  assert.equal(fixtureSubmitCallCount(), 2)

  const missingDocs = await lendrAdapter.submit(job({
    attemptKey: "attempt-missing-docs",
    documentVersions: [{ documentId: "doc-other", checksum: "checksum-other", category: "voided_check" }],
  }))
  assert.equal(missingDocs.ok, false)
  assert.equal(missingDocs.errorCode, "validation_failed")
  assert.equal(missingDocs.externalRef, undefined)
  assert.equal(missingDocs.fields?.["documents.application"], "Upload the application file.")
  assert.equal(missingDocs.fields?.["documents.bankStatements"], "Upload bank statements.")

  const corrected = await lendrAdapter.submit(job({ attemptKey: "attempt-missing-docs" }))
  assert.equal(corrected.ok, true)
  assert.equal(corrected.externalRef, "lendr_attempt-missing-docs")
})

test("MIC-142: timeout, expired credential, and replay do not duplicate submissions", async () => {
  const timeoutJob = job({
    attemptKey: "attempt-timeout",
    route: {
      id: "route-lendr-timeout",
      kind: "api",
      label: "API",
      destination: "lendr:timeout",
      documentExceptions: [],
      active: true,
    },
  })
  const timedOut = await lendrAdapter.submit(timeoutJob)
  assert.equal(timedOut.ok, false)
  assert.equal(timedOut.errorCode, "provider_unavailable")
  assert.match(timedOut.errorMessage ?? "", /timed out/i)
  assert.equal(timedOut.externalRef, "lendr_attempt-timeout")

  const recovered = await lendrAdapter.submit(timeoutJob)
  assert.equal(recovered.ok, true)
  assert.equal(recovered.externalRef, timedOut.externalRef)
  assert.equal(recovered.fields?.dealId, "lendr_attempt-timeout")
  assert.equal(recovered.fields?.portalUrl, lendrPortalUrl("lendr_attempt-timeout"))
  assert.deepEqual(listFixtureExternalRefs(), ["lendr_attempt-timeout"])

  const expiredJob = job({ attemptKey: "attempt-expired" })
  const expired = await runWithAdapterRuntime(runtime({ apiKey: EXPIRED_CREDENTIAL_TOKEN }, "corr-expired"), () => lendrAdapter.submit(expiredJob))
  assert.equal(expired.ok, false)
  assert.equal(expired.errorCode, "provider_unavailable")
  assert.match(expired.errorMessage ?? "", /expired/i)
  assert.equal(expired.externalRef, undefined)
  assert.equal(expired.correlationId, "corr-expired")
  assertNoSecrets(expired)
  await assert.rejects(
    () => runWithAdapterRuntime(runtime({ apiKey: EXPIRED_CREDENTIAL_TOKEN }), () => lendrAdapter.getStatus!(expiredJob)),
    (error: { status?: number; code?: string; message?: string }) => (
      error.status === 503 && error.code === "provider_unavailable" && /expired/i.test(error.message ?? "")
    ),
  )
  assert.equal(listFixtureExternalRefs().includes("lendr_attempt-expired"), false)

  const acceptedJob = job({ attemptKey: "attempt-replay" })
  bindLendrApplication("attempt-replay", application())
  const first = await lendrAdapter.submit(acceptedJob)
  const replay = await runWithAdapterRuntime(runtime({ apiKey: EXPIRED_CREDENTIAL_TOKEN }, "corr-replay"), () => lendrAdapter.submit(acceptedJob))
  assert.equal(first.ok, true)
  assert.equal(replay.ok, true)
  assert.equal(replay.externalRef, first.externalRef)
  assert.equal(replay.correlationId, "corr-replay")
  assert.deepEqual(new Set(listFixtureExternalRefs()), new Set(["lendr_attempt-timeout", "lendr_attempt-replay"]))
  assertNoSecrets(replay)

  setLendrFixture("lendr:expired-credential")
  const destinationExpired = await lendrAdapter.submit(job({ attemptKey: "attempt-expired-destination" }))
  assert.equal(destinationExpired.ok, false)
  assert.equal(destinationExpired.externalRef, undefined)
})

test("MIC-142: maps submitted/pending/approved/declined/funded and preserves unsupported outcomes", async () => {
  assert.equal(mapProviderStatus("Submitted").normalized, "submitted")
  assert.equal(mapProviderStatus("Received").normalized, "submitted")
  assert.equal(mapProviderStatus("Sent").normalized, "submitted")
  assert.equal(mapProviderStatus("New Submission").normalized, "submitted")
  assert.equal(mapProviderStatus("In Review").normalized, "pending")
  assert.equal(mapProviderStatus("Pending").normalized, "pending")
  assert.equal(mapProviderStatus("In Progress").normalized, "pending")
  assert.equal(mapProviderStatus("Approved").normalized, "approved")
  assert.equal(mapProviderStatus("Declined").normalized, "declined")
  assert.equal(mapProviderStatus("Decline").normalized, "declined")
  assert.equal(mapProviderStatus("Rejected").normalized, "declined")
  assert.equal(mapProviderStatus("Funded").normalized, "funded")
  assert.equal(Object.keys(PROVIDER_STATUS_MAP).length, 13)
  assert.deepEqual(mapProviderStatus("Offer"), { rawStatus: "Offer", normalized: "unknown", unknown: true })
  assert.deepEqual(mapProviderStatus("Hold"), { rawStatus: "Hold", normalized: "unknown", unknown: true })
  assert.equal(mapProviderStatus("CREDIT_COMMITTEE_HOLD").unknown, true)

  const pendingJob = job({
    attemptKey: "attempt-pending",
    route: {
      id: "route-lendr-pending",
      kind: "api",
      label: "API",
      destination: "lendr:pending",
      documentExceptions: [],
      active: true,
    },
  })
  const pendingSubmit = await lendrAdapter.submit(pendingJob)
  assert.equal(pendingSubmit.ok, true)
  assert.equal(pendingSubmit.rawStatus, "In Review")
  const pending = await lendrAdapter.getStatus!(pendingJob)
  assert.equal(pending.normalized, "pending")
  assert.equal(pending.terms, undefined)

  const approvedJob = job({
    attemptKey: "attempt-approved",
    route: {
      id: "route-lendr-approved",
      kind: "api",
      label: "API",
      destination: "lendr:approved",
      documentExceptions: [],
      active: true,
    },
  })
  const approvedSubmit = await lendrAdapter.submit(approvedJob)
  assert.equal(approvedSubmit.ok, true)
  assert.equal(approvedSubmit.rawStatus, "Approved")
  const approved = await lendrAdapter.getStatus!(approvedJob)
  assert.equal(approved.normalized, "approved")
  assert.equal(approved.unknown, false)
  assert.equal(approved.terms, undefined)

  const declinedJob = job({
    attemptKey: "attempt-declined",
    route: {
      id: "route-lendr-declined",
      kind: "api",
      label: "API",
      destination: "lendr:declined",
      documentExceptions: [],
      active: true,
    },
  })
  await lendrAdapter.submit(declinedJob)
  const declined = await lendrAdapter.getStatus!(declinedJob)
  assert.equal(declined.rawStatus, "Declined")
  assert.equal(declined.normalized, "declined")
  assert.equal(declined.terms, undefined)

  const fundedJob = job({
    attemptKey: "attempt-funded",
    route: {
      id: "route-lendr-funded",
      kind: "api",
      label: "API",
      destination: "lendr:funded",
      documentExceptions: [],
      active: true,
    },
  })
  await lendrAdapter.submit(fundedJob)
  const funded = await lendrAdapter.getStatus!(fundedJob)
  assert.equal(funded.normalized, "funded")
  assert.equal(funded.terms, undefined)

  const holdJob = job({
    attemptKey: "attempt-hold",
    route: {
      id: "route-lendr-hold",
      kind: "api",
      label: "API",
      destination: "lendr:hold",
      documentExceptions: [],
      active: true,
    },
  })
  const holdSubmit = await lendrAdapter.submit(holdJob)
  assert.equal(holdSubmit.ok, true)
  assert.equal(holdSubmit.rawStatus, "Hold")
  const hold = await lendrAdapter.getStatus!(holdJob)
  assert.equal(hold.rawStatus, "Hold")
  assert.equal(hold.normalized, "unknown")
  assert.equal(hold.unknown, true)
  assert.equal(hold.terms, undefined)
})
