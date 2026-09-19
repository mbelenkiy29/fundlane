import test, { beforeEach } from "node:test"
import assert from "node:assert/strict"
import { AppError } from "../../src/lib/mca/errors"
import type { AdapterRuntime } from "../../src/lib/mca/submissions/adapters/contracts"
import { runWithAdapterRuntime } from "../../src/lib/mca/submissions/adapters/credentials"
import { assertStatusPollAllowed } from "../../src/lib/mca/submissions/adapters/framework"
import type { SubmissionJob } from "../../src/lib/mca/submissions/contracts"
import {
  bindFundomateApplication,
  EXPIRED_CREDENTIAL_TOKEN,
  fixtureSubmitCallCount,
  FUNDOMATE_CAPABILITIES,
  FUNDOMATE_RECEIVED_STATUS,
  FUNDOMATE_SLUG,
  fundomateAdapter,
  listFixtureExternalRefs,
  mapApplication,
  mapIndustry,
  mapOwnershipType,
  peekFixture,
  resetFundomateFixtures,
  setFundomateFixture,
  validateApplication,
} from "../../src/lib/mca/submissions/adapters/fundomate"

const SSN = "987654321"
const CLIENT_ID = "fundomate-dev-client-id"
const CLIENT_SECRET = "fundomate-development-secret-never-leak"

function owner(overrides: Record<string, unknown> = {}) {
  return {
    firstName: "Alex",
    lastName: "Rivera",
    ssn: SSN,
    address: { line1: "10 Owner Way", city: "New York", state: "NY", postalCode: "10001" },
    ...overrides,
  }
}

function documents() {
  return [
    { documentId: "doc-app", category: "application", checksum: "checksum-app" },
    { documentId: "doc-bank", category: "statement", checksum: "checksum-bank" },
  ]
}

function application(overrides: Record<string, unknown> = {}) {
  return {
    legalName: "Harbor Coffee LLC",
    businessEmail: "ops@harborcoffee.example",
    ein: "12-3456789",
    entityType: "s_corporation",
    industry: "restaurant",
    startDate: "2019-06-01",
    address: { line1: "100 Front Street", city: "New York", state: "NY", postalCode: "10004" },
    owners: [owner()],
    documents: documents(),
    ...overrides,
  }
}

function job(overrides: Partial<SubmissionJob> = {}): SubmissionJob {
  return {
    id: overrides.id ?? "job-fm-1",
    workspaceId: overrides.workspaceId ?? "workspace-fm",
    dealId: overrides.dealId ?? "deal-fm-1",
    funderId: overrides.funderId ?? "funder-fm-1",
    displayFunderName: overrides.displayFunderName ?? "Fundomate",
    routeKind: "api",
    route: overrides.route ?? {
      id: "route-fm",
      kind: "api",
      label: "API",
      destination: FUNDOMATE_SLUG,
      documentExceptions: [],
      active: true,
    },
    state: overrides.state ?? "sending",
    confirmationKey: overrides.confirmationKey ?? "conf-fm-1",
    attemptKey: overrides.attemptKey ?? "attempt-fm-1",
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

function documentsJob(overrides: Partial<SubmissionJob> = {}): SubmissionJob {
  return job({
    packageDocumentIds: ["doc-app", "doc-bank"],
    documentVersions: [
      { documentId: "doc-app", checksum: "checksum-app", category: "api_application" },
      { documentId: "doc-bank", checksum: "checksum-bank", category: "statement" },
    ],
    ...overrides,
  })
}

function runtime(secrets: AdapterRuntime["secrets"], correlationId = "corr-fm-1"): AdapterRuntime {
  return {
    credentialId: "cred-fm-1",
    workspaceId: "workspace-fm",
    funderId: "funder-fm-1",
    adapterSlug: FUNDOMATE_SLUG,
    environment: "development",
    capabilities: FUNDOMATE_CAPABILITIES,
    secrets,
    correlationId,
  }
}

function assertNoSecrets(value: unknown) {
  const text = typeof value === "string" ? value : JSON.stringify(value)
  assert.equal(text.includes(CLIENT_SECRET), false)
  assert.equal(text.includes(CLIENT_ID), false)
  assert.equal(text.includes(EXPIRED_CREDENTIAL_TOKEN), false)
  assert.equal(text.includes(SSN), false)
}

beforeEach(() => {
  resetFundomateFixtures()
})

test("MIC-132: required-field rejection", () => {
  const empty = fundomateAdapter.validate({})
  assert.equal(empty.ok, false)
  if (empty.ok) throw new Error("expected field errors")
  assert.equal(empty.fields.legalName, "Business name is required.")
  assert.equal(empty.fields.businessEmail, "Business email is required.")
  assert.equal(empty.fields.ein, "EIN / Tax ID is required.")
  assert.equal(empty.fields.industry, "Industry is required.")
  assert.equal(empty.fields.ownershipType, "Ownership type is required.")
  assert.equal(empty.fields.startDate, "Enter the business start month and year as YYYY-MM or YYYY-MM-DD.")
  assert.equal(empty.fields.owners, "At least one business owner is required.")
  assert.equal(empty.fields.signedApplication, "A signed merchant application is required.")
  assert.equal(empty.fields.bankStatements, "Bank statements are required.")

  const texas = fundomateAdapter.validate(application({
    address: { line1: "400 Congress Avenue", city: "Austin", state: "TX", postalCode: "78701" },
    requestedAmount: undefined,
  }))
  assert.equal(texas.ok, false)
  if (texas.ok) throw new Error("expected Texas amount error")
  assert.equal(texas.fields.requestedAmount, "Requested funding amount is required for Texas businesses.")

  const invalid = fundomateAdapter.validate(application({
    ein: "12-345",
    owners: [owner({ ssn: "1234", firstName: "" })],
  }))
  assert.equal(invalid.ok, false)
  if (invalid.ok) throw new Error("expected invalid field errors")
  assert.equal(invalid.fields.ein, "EIN must contain 9 digits.")
  assert.equal(invalid.fields["owners.0.firstName"], "Owner first name is required.")
  assert.equal(invalid.fields["owners.0.ssn"], "Owner SSN must contain 9 digits.")

  const recommendedOnly = fundomateAdapter.validate(application({
    owners: [owner({ email: undefined, phone: undefined, dateOfBirth: undefined })],
  }))
  assert.equal(recommendedOnly.ok, true)

  const nonTexas = fundomateAdapter.validate(application({ requestedAmount: undefined }))
  assert.equal(nonTexas.ok, true)

  const texasOk = fundomateAdapter.validate(application({
    address: { line1: "400 Congress Avenue", city: "Austin", state: "TX", postalCode: "78701" },
    requestedAmount: 25000,
  }))
  assert.equal(texasOk.ok, true)
})

test("MIC-132: accepted submission maps EIN, ownership type, and submit-only acknowledgement", async () => {
  assert.equal(fundomateAdapter.slug, "fundomate")
  assert.deepEqual(fundomateAdapter.capabilities, {
    submit: true,
    statusPoll: false,
    webhooks: false,
    offers: false,
  })
  assert.equal(fundomateAdapter.getStatus, undefined)
  assert.equal(fundomateAdapter.parseWebhook, undefined)
  assert.equal(mapOwnershipType("s_corporation"), "S-Corporation")
  assert.equal(mapOwnershipType("nonprofit"), "Other")
  assert.equal(mapIndustry("restaurant"), "Food Services")
  assert.equal(mapIndustry("unknown niche"), "Other")

  const payload = application({
    address: { line1: "400 Congress Avenue", city: "Austin", state: "TX", postalCode: "78701" },
    requestedAmount: 25000,
    startDate: "2019-06",
  })
  bindFundomateApplication("attempt-fm-1", payload)
  const submitted = await runWithAdapterRuntime(
    runtime({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET }),
    () => fundomateAdapter.submit(documentsJob()),
  )
  assert.equal(submitted.ok, true)
  assert.equal(submitted.correlationId, "corr-fm-1")
  assert.equal(submitted.externalRef, "fm_attempt-fm-1")
  assert.equal(submitted.rawStatus, FUNDOMATE_RECEIVED_STATUS)
  assertNoSecrets(submitted)

  const stored = peekFixture("attempt-fm-1")
  assert.ok(stored)
  assert.equal(stored.mapped?.ein, "123456789")
  assert.equal(stored.mapped?.ownershipType, "S-Corporation")
  assert.equal(stored.mapped?.industry, "Food Services")
  assert.equal(stored.mapped?.startMonthYear, "2019-06")
  assert.equal(stored.mapped?.state, "TX")
  assert.equal(stored.mapped?.requestedAmount, 25000)
  assert.equal(stored.mapped?.ownerCount, 1)
  assert.equal(JSON.stringify(stored.mapped).includes(SSN), false)
})

test("MIC-132: document receipt is stable on replay", async () => {
  const attempt = documentsJob({ attemptKey: "attempt-docs" })
  bindFundomateApplication("attempt-docs", application({ owners: [owner()] }))
  const first = await fundomateAdapter.submit(attempt)
  assert.equal(first.ok, true)
  assert.equal(first.fields?.["documents.0.documentId"], "doc-app")
  assert.equal(first.fields?.["documents.0.category"], "signed_application")
  assert.equal(first.fields?.["documents.0.receiptId"], "fm_doc_attempt-docs_doc-app")
  assert.equal(first.fields?.["documents.1.documentId"], "doc-bank")
  assert.equal(first.fields?.["documents.1.category"], "bank_statements")
  assert.equal(first.fields?.["documents.1.receiptId"], "fm_doc_attempt-docs_doc-bank")
  assertNoSecrets(first)

  const replay = await fundomateAdapter.submit(attempt)
  assert.equal(replay.ok, true)
  assert.equal(replay.externalRef, first.externalRef)
  assert.deepEqual(replay.fields, first.fields)
  assert.deepEqual(listFixtureExternalRefs(), ["fm_attempt-docs"])
  assert.equal(peekFixture("attempt-docs")?.submitCalls, 2)
  assert.equal(fixtureSubmitCallCount(), 2)
})

test("MIC-132: timeout, expired credential, and replay do not duplicate submissions", async () => {
  const missingDocs = await fundomateAdapter.submit(job({ attemptKey: "attempt-missing-docs" }))
  assert.equal(missingDocs.ok, false)
  assert.equal(missingDocs.errorCode, "validation_failed")
  assert.equal(missingDocs.fields?.signedApplication, "A signed merchant application is required.")
  assert.equal(missingDocs.fields?.bankStatements, "Bank statements are required.")
  assert.equal(missingDocs.externalRef, undefined)
  assert.equal(listFixtureExternalRefs().includes("fm_attempt-missing-docs"), false)

  const timeoutJob = job({
    attemptKey: "attempt-timeout",
    route: {
      id: "route-fm-timeout",
      kind: "api",
      label: "API",
      destination: "fundomate:timeout",
      documentExceptions: [],
      active: true,
    },
  })
  const timedOut = await fundomateAdapter.submit(timeoutJob)
  assert.equal(timedOut.ok, false)
  assert.equal(timedOut.errorCode, "provider_unavailable")
  assert.match(timedOut.errorMessage ?? "", /timed out/i)
  assert.equal(timedOut.externalRef, "fm_attempt-timeout")

  const recovered = await fundomateAdapter.submit(timeoutJob)
  assert.equal(recovered.ok, true)
  assert.equal(recovered.externalRef, timedOut.externalRef)
  assert.equal(recovered.rawStatus, FUNDOMATE_RECEIVED_STATUS)
  assert.deepEqual(listFixtureExternalRefs(), ["fm_attempt-timeout"])

  const expiredJob = job({ attemptKey: "attempt-expired" })
  const expired = await runWithAdapterRuntime(
    runtime({ clientId: CLIENT_ID, clientSecret: EXPIRED_CREDENTIAL_TOKEN }, "corr-expired"),
    () => fundomateAdapter.submit(expiredJob),
  )
  assert.equal(expired.ok, false)
  assert.equal(expired.errorCode, "provider_unavailable")
  assert.match(expired.errorMessage ?? "", /expired/i)
  assert.equal(expired.externalRef, undefined)
  assert.equal(expired.correlationId, "corr-expired")
  assertNoSecrets(expired)
  assert.equal(listFixtureExternalRefs().includes("fm_attempt-expired"), false)

  const acceptedJob = documentsJob({ attemptKey: "attempt-replay" })
  bindFundomateApplication("attempt-replay", application({ owners: [owner()] }))
  const first = await fundomateAdapter.submit(acceptedJob)
  const replay = await runWithAdapterRuntime(
    runtime({ clientId: CLIENT_ID, clientSecret: EXPIRED_CREDENTIAL_TOKEN }, "corr-replay"),
    () => fundomateAdapter.submit(acceptedJob),
  )
  assert.equal(first.ok, true)
  assert.equal(replay.ok, true)
  assert.equal(replay.externalRef, first.externalRef)
  assert.equal(replay.correlationId, "corr-replay")
  assert.deepEqual(new Set(listFixtureExternalRefs()), new Set(["fm_attempt-timeout", "fm_attempt-replay"]))
  assertNoSecrets(replay)

  setFundomateFixture("fundomate:expired-credential")
  const destinationExpired = await fundomateAdapter.submit(job({ attemptKey: "attempt-expired-destination" }))
  assert.equal(destinationExpired.ok, false)
  assert.equal(destinationExpired.externalRef, undefined)
})

test("MIC-132: capability flags match submit-only implementation", () => {
  assert.deepEqual(fundomateAdapter.capabilities, FUNDOMATE_CAPABILITIES)
  assert.equal(typeof fundomateAdapter.getStatus, "undefined")
  assert.equal(typeof fundomateAdapter.parseWebhook, "undefined")
  assert.throws(
    () => assertStatusPollAllowed(fundomateAdapter.capabilities, fundomateAdapter),
    (error: unknown) => error instanceof AppError && error.status === 409 && error.code === "capability_unsupported",
  )

  const mapped = validateApplication(application({
    owners: [owner({ ssn: "987-65-4321", email: "alex.rivera@merchant.example" })],
  }))
  assert.equal(mapped.ok, true)
  if (!mapped.ok) throw new Error("expected valid application")
  const request = mapApplication(mapped.value)
  const serialized = JSON.stringify(request)
  assert.equal(mapped.value.ein, "123456789")
  assert.equal(request.business.ein, "123456789")
  assert.equal(request.owners[0].ssnLast4, "4321")
  assert.equal(serialized.includes("987654321"), false)
  assert.equal(serialized.includes(CLIENT_SECRET), false)
})
