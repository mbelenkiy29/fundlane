import test, { beforeEach } from "node:test"
import assert from "node:assert/strict"
import type { AdapterRuntime } from "../../src/lib/mca/submissions/adapters/contracts"
import { runWithAdapterRuntime } from "../../src/lib/mca/submissions/adapters/credentials"
import type { SubmissionJob } from "../../src/lib/mca/submissions/contracts"
import {
  bindExpansionCapitalGroupApplication,
  EXPIRED_CREDENTIAL_TOKEN,
  expansionCapitalGroupAdapter,
  EXPANSION_CAPITAL_GROUP_SLUG,
  fixtureSubmitCallCount,
  listFixtureExternalRefs,
  mapEntityType,
  mapProviderStatus,
  peekFixture,
  PROVIDER_STATUS_MAP,
  REGISTERED_PARTNERS,
  resetExpansionCapitalGroupFixtures,
  setExpansionCapitalGroupFixture,
} from "../../src/lib/mca/submissions/adapters/expansion-capital-group"

const SSN = "123456789"
const API_KEY = "ecg-development-token-never-leak"

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
    industry: "Food Services",
    startDate: "2019-06-01",
    contactPhone: "2125550199",
    address: { line1: "100 Front Street", city: "New York", state: "NY", postalCode: "10004" },
    partnerEmail: REGISTERED_PARTNERS[0].email,
    partnerRepName: REGISTERED_PARTNERS[0].name,
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
    id: overrides.id ?? "job-ecg-1",
    workspaceId: overrides.workspaceId ?? "workspace-ecg",
    dealId: overrides.dealId ?? "deal-ecg-1",
    funderId: overrides.funderId ?? "funder-ecg-1",
    displayFunderName: overrides.displayFunderName ?? "Expansion Capital Group",
    routeKind: "api",
    route: overrides.route ?? {
      id: "route-ecg",
      kind: "api",
      label: "API",
      destination: EXPANSION_CAPITAL_GROUP_SLUG,
      documentExceptions: [],
      active: true,
    },
    state: overrides.state ?? "sending",
    confirmationKey: overrides.confirmationKey ?? "conf-ecg-1",
    attemptKey: overrides.attemptKey ?? "attempt-ecg-1",
    dealVersion: overrides.dealVersion ?? 1,
    documentVersions: overrides.documentVersions ?? [],
    packageDocumentIds: overrides.packageDocumentIds ?? [],
    preflightErrors: overrides.preflightErrors ?? [],
    merchantIdentityKey: overrides.merchantIdentityKey ?? `deal:${overrides.dealId ?? "deal-fixture"}`,
    packageFingerprint: overrides.packageFingerprint ?? "",
    createdAt: overrides.createdAt ?? "2026-01-01T00:00:00.000Z",
    updatedAt: overrides.updatedAt ?? "2026-01-01T00:00:00.000Z",
    ...overrides,
  }
}

function runtime(secrets: AdapterRuntime["secrets"], correlationId = "corr-ecg-1"): AdapterRuntime {
  return {
    credentialId: "cred-ecg-1",
    workspaceId: "workspace-ecg",
    funderId: "funder-ecg-1",
    adapterSlug: EXPANSION_CAPITAL_GROUP_SLUG,
    environment: "development",
    capabilities: expansionCapitalGroupAdapter.capabilities,
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
  resetExpansionCapitalGroupFixtures()
})

test("MIC-123: required-field rejection", () => {
  const empty = expansionCapitalGroupAdapter.validate({})
  assert.equal(empty.ok, false)
  if (empty.ok) throw new Error("expected field errors")
  assert.equal(empty.fields.legalName, "Business name is required.")
  assert.equal(empty.fields.dba, "DBA is required.")
  assert.equal(empty.fields.ein, "EIN / Tax ID is required.")
  assert.equal(empty.fields.owners, "At least one business owner is required.")
  assert.equal(empty.fields.partnerEmail, "Registered partner email is required.")
  assert.equal(empty.fields.partnerRepName, "Registered partner representative name is required.")

  const unregistered = expansionCapitalGroupAdapter.validate(application({
    partnerEmail: "unknown.rep@iso.example",
    owners: [owner()],
  }))
  assert.equal(unregistered.ok, false)
  if (unregistered.ok) throw new Error("expected unregistered partner error")
  assert.match(unregistered.fields.partnerEmail ?? "", /registered/i)

  const invalid = expansionCapitalGroupAdapter.validate(application({
    ein: "12-345",
    owners: [owner({ ssn: "1234", firstName: "", ownershipPercent: undefined })],
  }))
  assert.equal(invalid.ok, false)
  if (invalid.ok) throw new Error("expected invalid field errors")
  assert.equal(invalid.fields.ein, "EIN must contain 9 digits.")
  assert.equal(invalid.fields["owners.0.firstName"], "Owner first name is required.")
  assert.equal(invalid.fields["owners.0.ssn"], "Owner SSN must contain 9 digits.")
  assert.equal(invalid.fields["owners.0.ownershipPercent"], "Owner ownership percentage is required.")
  assert.equal(expansionCapitalGroupAdapter.validate(application()).ok, true)
})

test("MIC-123: accepted submission maps owners, partner, and status-only capabilities", async () => {
  assert.equal(expansionCapitalGroupAdapter.slug, "expansion-capital-group")
  assert.deepEqual(expansionCapitalGroupAdapter.capabilities, {
    submit: true,
    statusPoll: true,
    webhooks: false,
    offers: false,
  })
  assert.equal(typeof expansionCapitalGroupAdapter.getStatus, "function")
  assert.equal(expansionCapitalGroupAdapter.parseWebhook, undefined)
  assert.equal(mapEntityType("s_corporation"), "Corporation")
  assert.equal(mapEntityType("nonprofit"), "Other")

  const payload = application()
  bindExpansionCapitalGroupApplication("attempt-ecg-1", payload)
  const submitted = await runWithAdapterRuntime(runtime({ apiKey: API_KEY }), () => expansionCapitalGroupAdapter.submit(job()))
  assert.equal(submitted.ok, true)
  assert.equal(submitted.correlationId, "corr-ecg-1")
  assert.equal(submitted.externalRef, "ecg_attempt-ecg-1")
  assert.equal(submitted.rawStatus, "New Submission")
  assertNoSecrets(submitted)

  const stored = peekFixture("attempt-ecg-1")
  assert.ok(stored)
  assert.equal(stored.mapped?.entityType, "Corporation")
  assert.equal(stored.mapped?.partnerEmail, REGISTERED_PARTNERS[0].email)
  assert.deepEqual(stored.mapped?.owners, [
    { firstName: "Alex", lastName: "Rivera", ownershipPercent: 55 },
    { firstName: "Jordan", lastName: "Nguyen", ownershipPercent: 30 },
  ])
  assert.equal(stored.mapped?.owners?.length, 2)

  const status = await runWithAdapterRuntime(runtime({ apiKey: API_KEY }, "corr-status-1"), () => expansionCapitalGroupAdapter.getStatus!(job()))
  assert.equal(status.normalized, "submitted")
  assert.equal(status.rawStatus, "New Submission")
  assert.equal(status.unknown, false)
  assert.equal(status.terms, undefined)
  assert.equal(status.correlationId, "corr-status-1")
  assert.equal(status.eventId, "ecg-event-attempt-ecg-1")
  assertNoSecrets(status)
})

test("MIC-123: document receipt is stable on replay", async () => {
  const attempt = job({
    attemptKey: "attempt-docs",
    packageDocumentIds: ["doc-app", "doc-bank"],
    documentVersions: [
      { documentId: "doc-app", checksum: "checksum-app", category: "api_application" },
      { documentId: "doc-bank", checksum: "checksum-bank", category: "statement" },
    ],
  })
  bindExpansionCapitalGroupApplication("attempt-docs", application({ owners: [owner()] }))
  const first = await expansionCapitalGroupAdapter.submit(attempt)
  assert.equal(first.ok, true)
  assert.equal(first.fields?.["documents.0.documentId"], "doc-app")
  assert.equal(first.fields?.["documents.0.category"], "application")
  assert.equal(first.fields?.["documents.0.receiptId"], "ecg_doc_attempt-docs_doc-app")
  assert.equal(first.fields?.["documents.1.documentId"], "doc-bank")
  assert.equal(first.fields?.["documents.1.category"], "bank_statements")
  assert.equal(first.fields?.["documents.1.receiptId"], "ecg_doc_attempt-docs_doc-bank")
  assertNoSecrets(first)

  const replay = await expansionCapitalGroupAdapter.submit(attempt)
  assert.equal(replay.ok, true)
  assert.equal(replay.externalRef, first.externalRef)
  assert.deepEqual(replay.fields, first.fields)
  assert.deepEqual(listFixtureExternalRefs(), ["ecg_attempt-docs"])
  assert.equal(peekFixture("attempt-docs")?.submitCalls, 2)
  assert.equal(fixtureSubmitCallCount(), 2)
})

test("MIC-123: timeout, expired credential, and replay do not duplicate submissions", async () => {
  const timeoutJob = job({
    attemptKey: "attempt-timeout",
    route: {
      id: "route-ecg-timeout",
      kind: "api",
      label: "API",
      destination: "expansion-capital-group:timeout",
      documentExceptions: [],
      active: true,
    },
  })
  const timedOut = await expansionCapitalGroupAdapter.submit(timeoutJob)
  assert.equal(timedOut.ok, false)
  assert.equal(timedOut.errorCode, "provider_unavailable")
  assert.match(timedOut.errorMessage ?? "", /timed out/i)
  assert.equal(timedOut.externalRef, "ecg_attempt-timeout")

  const recovered = await expansionCapitalGroupAdapter.submit(timeoutJob)
  assert.equal(recovered.ok, true)
  assert.equal(recovered.externalRef, timedOut.externalRef)
  assert.deepEqual(listFixtureExternalRefs(), ["ecg_attempt-timeout"])

  const expiredJob = job({ attemptKey: "attempt-expired" })
  const expired = await runWithAdapterRuntime(runtime({ apiKey: EXPIRED_CREDENTIAL_TOKEN }, "corr-expired"), () => expansionCapitalGroupAdapter.submit(expiredJob))
  assert.equal(expired.ok, false)
  assert.equal(expired.errorCode, "provider_unavailable")
  assert.match(expired.errorMessage ?? "", /expired/i)
  assert.equal(expired.externalRef, undefined)
  assert.equal(expired.correlationId, "corr-expired")
  assertNoSecrets(expired)
  await assert.rejects(
    () => runWithAdapterRuntime(runtime({ apiKey: EXPIRED_CREDENTIAL_TOKEN }), () => expansionCapitalGroupAdapter.getStatus!(expiredJob)),
    (error: { status?: number; code?: string; message?: string }) => (
      error.status === 503 && error.code === "provider_unavailable" && /expired/i.test(error.message ?? "")
    ),
  )
  assert.equal(listFixtureExternalRefs().includes("ecg_attempt-expired"), false)

  const acceptedJob = job({ attemptKey: "attempt-replay" })
  bindExpansionCapitalGroupApplication("attempt-replay", application({ owners: [owner()] }))
  const first = await expansionCapitalGroupAdapter.submit(acceptedJob)
  const replay = await runWithAdapterRuntime(runtime({ apiKey: EXPIRED_CREDENTIAL_TOKEN }, "corr-replay"), () => expansionCapitalGroupAdapter.submit(acceptedJob))
  assert.equal(first.ok, true)
  assert.equal(replay.ok, true)
  assert.equal(replay.externalRef, first.externalRef)
  assert.equal(replay.correlationId, "corr-replay")
  assert.deepEqual(new Set(listFixtureExternalRefs()), new Set(["ecg_attempt-timeout", "ecg_attempt-replay"]))
  assertNoSecrets(replay)

  setExpansionCapitalGroupFixture("expansion-capital-group:expired-credential")
  const destinationExpired = await expansionCapitalGroupAdapter.submit(job({ attemptKey: "attempt-expired-destination" }))
  assert.equal(destinationExpired.ok, false)
  assert.equal(destinationExpired.externalRef, undefined)
})

test("MIC-123: outstanding document requests map to pending", async () => {
  assert.deepEqual(mapProviderStatus("New Submission"), { rawStatus: "New Submission", normalized: "submitted", unknown: false })
  assert.deepEqual(mapProviderStatus("Soft Approval"), { rawStatus: "Soft Approval", normalized: "approved", unknown: false })
  assert.deepEqual(mapProviderStatus("Funded"), { rawStatus: "Funded", normalized: "funded", unknown: false })
  assert.deepEqual(mapProviderStatus("Outside Funded"), { rawStatus: "Outside Funded", normalized: "declined", unknown: false })
  assert.equal(mapProviderStatus("CREDIT_COMMITTEE_HOLD").unknown, true)
  assert.equal(Object.keys(PROVIDER_STATUS_MAP).length, 13)

  const pending = mapProviderStatus("UW Prep", ["bank statements", "voided check"])
  assert.equal(pending.normalized, "pending")
  assert.equal(pending.unknown, false)
  assert.match(pending.rawStatus, /bank statements/)
  assert.match(pending.rawStatus, /voided check/)

  const missingJob = job({
    attemptKey: "attempt-missing-info",
    route: {
      id: "route-ecg-missing",
      kind: "api",
      label: "API",
      destination: "expansion-capital-group:outstanding-documents",
      documentExceptions: [],
      active: true,
    },
  })
  const submitted = await expansionCapitalGroupAdapter.submit(missingJob)
  assert.equal(submitted.ok, true)
  assert.equal(submitted.rawStatus, "UW Prep")
  const status = await expansionCapitalGroupAdapter.getStatus!(missingJob)
  assert.equal(status.normalized, "pending")
  assert.equal(status.unknown, false)
  assert.equal(status.terms, undefined)
  assert.match(status.rawStatus, /outstanding document requests/)
  assert.match(status.rawStatus, /bank statements/)
})
