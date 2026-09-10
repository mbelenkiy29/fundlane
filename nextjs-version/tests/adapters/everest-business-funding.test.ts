import test, { beforeEach } from "node:test"
import assert from "node:assert/strict"
import type { AdapterRuntime } from "../../src/lib/mca/submissions/adapters/contracts"
import { runWithAdapterRuntime } from "../../src/lib/mca/submissions/adapters/credentials"
import type { SubmissionJob } from "../../src/lib/mca/submissions/contracts"
import {
  bindEverestBusinessFundingApplication,
  CREDENTIAL_COMPONENT_FIELDS,
  EVEREST_BUSINESS_FUNDING_SLUG,
  everestBusinessFundingAdapter,
  everestBusinessFundingDealId,
  EXPIRED_CREDENTIAL_TOKEN,
  fixtureSubmitCallCount,
  listFixtureExternalRefs,
  mapCredentialComponents,
  mapProviderStatus,
  peekFixture,
  PROVIDER_STATUS_MAP,
  resetEverestBusinessFundingFixtures,
  setEverestBusinessFundingFixture,
  SYNTHETIC_OFFER_TERMS,
} from "../../src/lib/mca/submissions/adapters/everest-business-funding"

const CLIENT_ID = "ebf-development-client-id"
const CLIENT_SECRET = "ebf-development-secret-never-leak"

function documents() {
  return [
    { documentId: "doc-app", category: "api_application", checksum: "checksum-app" },
    { documentId: "doc-bank", category: "statement", checksum: "checksum-bank" },
  ]
}

function application(overrides: Record<string, unknown> = {}) {
  return {
    legalName: "Harbor Coffee LLC",
    ein: "12-3456789",
    dbaName: "Harbor Coffee",
    documents: documents(),
    ...overrides,
  }
}

function job(overrides: Partial<SubmissionJob> = {}): SubmissionJob {
  return {
    id: overrides.id ?? "job-ebf-1",
    workspaceId: overrides.workspaceId ?? "workspace-ebf",
    dealId: overrides.dealId ?? "deal-ebf-1",
    funderId: overrides.funderId ?? "funder-ebf-1",
    displayFunderName: overrides.displayFunderName ?? "Everest Business Funding",
    routeKind: "api",
    route: overrides.route ?? {
      id: "route-ebf",
      kind: "api",
      label: "API",
      destination: EVEREST_BUSINESS_FUNDING_SLUG,
      documentExceptions: [],
      active: true,
    },
    state: overrides.state ?? "sending",
    confirmationKey: overrides.confirmationKey ?? "conf-ebf-1",
    attemptKey: overrides.attemptKey ?? "attempt-ebf-1",
    dealVersion: overrides.dealVersion ?? 1,
    documentVersions: overrides.documentVersions ?? [],
    packageDocumentIds: overrides.packageDocumentIds ?? [],
    preflightErrors: overrides.preflightErrors ?? [],
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

function runtime(secrets: AdapterRuntime["secrets"], correlationId = "corr-ebf-1"): AdapterRuntime {
  return {
    credentialId: "cred-ebf-1",
    workspaceId: "workspace-ebf",
    funderId: "funder-ebf-1",
    adapterSlug: EVEREST_BUSINESS_FUNDING_SLUG,
    environment: "development",
    capabilities: everestBusinessFundingAdapter.capabilities,
    secrets,
    correlationId,
  }
}

function developmentSecrets(): AdapterRuntime["secrets"] {
  return { clientId: CLIENT_ID, clientSecret: CLIENT_SECRET }
}

function assertNoSecrets(value: unknown) {
  const text = typeof value === "string" ? value : JSON.stringify(value)
  assert.equal(text.includes(CLIENT_SECRET), false)
  assert.equal(text.includes(CLIENT_ID), false)
  assert.equal(text.includes(EXPIRED_CREDENTIAL_TOKEN), false)
}

beforeEach(() => {
  resetEverestBusinessFundingFixtures()
})

test("MIC-143: required-field rejection", () => {
  const empty = everestBusinessFundingAdapter.validate({})
  assert.equal(empty.ok, false)
  if (empty.ok) throw new Error("expected field errors")
  assert.equal(empty.fields.legalName, "Business name is required.")
  assert.equal(empty.fields.ein, "EIN / Tax ID is required.")
  assert.equal(empty.fields["documents.application"], "An API application file is required.")
  assert.equal(empty.fields["documents.bankStatements"], "Bank statement files are required.")
  assert.equal(empty.fields.owners, undefined)
  assert.equal(empty.fields.phone, undefined)

  const invalidEin = everestBusinessFundingAdapter.validate(application({ ein: "12-345" }))
  assert.equal(invalidEin.ok, false)
  if (invalidEin.ok) throw new Error("expected EIN error")
  assert.equal(invalidEin.fields.ein, "EIN must contain 9 digits.")

  const missingStatements = everestBusinessFundingAdapter.validate(application({
    documents: [{ documentId: "doc-app", category: "api_application", checksum: "checksum-app" }],
  }))
  assert.equal(missingStatements.ok, false)
  if (missingStatements.ok) throw new Error("expected statement file error")
  assert.equal(missingStatements.fields["documents.bankStatements"], "Bank statement files are required.")

  const sameFile = everestBusinessFundingAdapter.validate(application({
    documents: [
      { documentId: "doc-shared", category: "api_application", checksum: "checksum-shared" },
      { documentId: "doc-shared", category: "statement", checksum: "checksum-shared" },
    ],
  }))
  assert.equal(sameFile.ok, false)
  if (sameFile.ok) throw new Error("expected distinct file error")
  assert.equal(sameFile.fields["documents.distinct"], "Application and bank-statement files must be distinct.")

  assert.equal(everestBusinessFundingAdapter.validate(application()).ok, true)
})

test("MIC-143: accepted submission maps structured credentials and offer-capable status poll", async () => {
  assert.equal(everestBusinessFundingAdapter.slug, "everest-business-funding")
  assert.deepEqual(everestBusinessFundingAdapter.capabilities, {
    submit: true,
    statusPoll: true,
    webhooks: false,
    offers: true,
  })
  assert.equal(typeof everestBusinessFundingAdapter.getStatus, "function")
  assert.equal(everestBusinessFundingAdapter.parseWebhook, undefined)
  assert.deepEqual(CREDENTIAL_COMPONENT_FIELDS, {
    clientId: "clientId",
    clientSecret: "clientSecret",
  })
  const components = mapCredentialComponents(developmentSecrets())
  assert.deepEqual(components, { clientId: CLIENT_ID, clientSecret: CLIENT_SECRET })
  assert.equal(components.clientId.includes(","), false)
  assert.equal(mapCredentialComponents({ apiKey: `${CLIENT_ID},${CLIENT_SECRET}` }).clientId, "")

  bindEverestBusinessFundingApplication("attempt-ebf-1", application())
  const submitted = await runWithAdapterRuntime(runtime(developmentSecrets()), () => (
    everestBusinessFundingAdapter.submit(documentsJob())
  ))
  assert.equal(submitted.ok, true)
  assert.equal(submitted.correlationId, "corr-ebf-1")
  assert.equal(submitted.externalRef, everestBusinessFundingDealId("attempt-ebf-1"))
  assert.equal(submitted.rawStatus, "Submitted")
  assert.equal(submitted.fields?.dealId, "ebf_attempt-ebf-1")
  assert.equal(mapProviderStatus(submitted.rawStatus ?? "").normalized, "submitted")
  assertNoSecrets(submitted)

  const stored = peekFixture("attempt-ebf-1")
  assert.ok(stored)
  assert.equal(stored.mapped?.legalName, "Harbor Coffee LLC")
  assert.equal(stored.mapped?.ein, "123456789")
  assert.deepEqual(stored.mapped?.credentialFields, ["clientId", "clientSecret"])
  assert.equal(stored.mapped?.applicationDocumentId, "doc-app")
  assert.deepEqual(stored.mapped?.statementDocumentIds, ["doc-bank"])

  const status = await runWithAdapterRuntime(
    runtime(developmentSecrets(), "corr-status-1"),
    () => everestBusinessFundingAdapter.getStatus!(job()),
  )
  assert.equal(status.normalized, "submitted")
  assert.equal(status.rawStatus, "Submitted")
  assert.equal(status.unknown, false)
  assert.equal(status.terms, undefined)
  assert.equal(status.correlationId, "corr-status-1")
  assert.equal(status.eventId, "ebf-event-attempt-ebf-1")
  assertNoSecrets(status)
})

test("MIC-143: document receipt is stable on replay", async () => {
  const attempt = documentsJob({ attemptKey: "attempt-docs" })
  bindEverestBusinessFundingApplication("attempt-docs", application())
  const first = await everestBusinessFundingAdapter.submit(attempt)
  assert.equal(first.ok, true)
  assert.equal(first.fields?.dealId, "ebf_attempt-docs")
  assert.equal(first.fields?.["documents.0.documentId"], "doc-app")
  assert.equal(first.fields?.["documents.0.category"], "application")
  assert.equal(first.fields?.["documents.0.receiptId"], "ebf_doc_attempt-docs_doc-app")
  assert.equal(first.fields?.["documents.1.documentId"], "doc-bank")
  assert.equal(first.fields?.["documents.1.category"], "bank_statements")
  assert.equal(first.fields?.["documents.1.receiptId"], "ebf_doc_attempt-docs_doc-bank")
  assertNoSecrets(first)

  const replay = await everestBusinessFundingAdapter.submit(attempt)
  assert.equal(replay.ok, true)
  assert.equal(replay.externalRef, first.externalRef)
  assert.deepEqual(replay.fields, first.fields)
  assert.deepEqual(listFixtureExternalRefs(), ["ebf_attempt-docs"])
  assert.equal(peekFixture("attempt-docs")?.submitCalls, 2)
  assert.equal(fixtureSubmitCallCount(), 2)
})

test("MIC-143: timeout, expired credential, and replay do not duplicate submissions", async () => {
  const missingDocs = await everestBusinessFundingAdapter.submit(job({ attemptKey: "attempt-missing-docs" }))
  assert.equal(missingDocs.ok, false)
  assert.equal(missingDocs.errorCode, "validation_failed")
  assert.equal(missingDocs.fields?.["documents.application"], "An API application file is required.")
  assert.equal(missingDocs.fields?.["documents.bankStatements"], "Bank statement files are required.")
  assert.equal(missingDocs.externalRef, undefined)
  assert.equal(listFixtureExternalRefs().includes("ebf_attempt-missing-docs"), false)

  const timeoutJob = job({
    attemptKey: "attempt-timeout",
    route: {
      id: "route-ebf-timeout",
      kind: "api",
      label: "API",
      destination: "everest-business-funding:timeout",
      documentExceptions: [],
      active: true,
    },
  })
  const timedOut = await everestBusinessFundingAdapter.submit(timeoutJob)
  assert.equal(timedOut.ok, false)
  assert.equal(timedOut.errorCode, "provider_unavailable")
  assert.match(timedOut.errorMessage ?? "", /timed out/i)
  assert.equal(timedOut.externalRef, "ebf_attempt-timeout")

  const recovered = await everestBusinessFundingAdapter.submit(timeoutJob)
  assert.equal(recovered.ok, true)
  assert.equal(recovered.externalRef, timedOut.externalRef)
  assert.equal(recovered.fields?.dealId, "ebf_attempt-timeout")
  assert.deepEqual(listFixtureExternalRefs(), ["ebf_attempt-timeout"])

  const expiredJob = job({ attemptKey: "attempt-expired" })
  const expired = await runWithAdapterRuntime(
    runtime({ clientId: CLIENT_ID, clientSecret: EXPIRED_CREDENTIAL_TOKEN }, "corr-expired"),
    () => everestBusinessFundingAdapter.submit(expiredJob),
  )
  assert.equal(expired.ok, false)
  assert.equal(expired.errorCode, "provider_unavailable")
  assert.match(expired.errorMessage ?? "", /expired/i)
  assert.equal(expired.externalRef, undefined)
  assert.equal(expired.correlationId, "corr-expired")
  assertNoSecrets(expired)
  await assert.rejects(
    () => runWithAdapterRuntime(
      runtime({ clientId: CLIENT_ID, clientSecret: EXPIRED_CREDENTIAL_TOKEN }),
      () => everestBusinessFundingAdapter.getStatus!(expiredJob),
    ),
    (error: { status?: number; code?: string; message?: string }) => (
      error.status === 503 && error.code === "provider_unavailable" && /expired/i.test(error.message ?? "")
    ),
  )
  assert.equal(listFixtureExternalRefs().includes("ebf_attempt-expired"), false)

  const acceptedJob = documentsJob({ attemptKey: "attempt-replay" })
  bindEverestBusinessFundingApplication("attempt-replay", application())
  const first = await everestBusinessFundingAdapter.submit(acceptedJob)
  const replay = await runWithAdapterRuntime(
    runtime({ clientId: CLIENT_ID, clientSecret: EXPIRED_CREDENTIAL_TOKEN }, "corr-replay"),
    () => everestBusinessFundingAdapter.submit(acceptedJob),
  )
  assert.equal(first.ok, true)
  assert.equal(replay.ok, true)
  assert.equal(replay.externalRef, first.externalRef)
  assert.equal(replay.correlationId, "corr-replay")
  assert.deepEqual(new Set(listFixtureExternalRefs()), new Set(["ebf_attempt-timeout", "ebf_attempt-replay"]))
  assertNoSecrets(replay)

  setEverestBusinessFundingFixture("everest-business-funding:expired-credential")
  const destinationExpired = await everestBusinessFundingAdapter.submit(job({ attemptKey: "attempt-expired-destination" }))
  assert.equal(destinationExpired.ok, false)
  assert.equal(destinationExpired.externalRef, undefined)
})

test("MIC-143: maps submitted/offer/declined and preserves unsupported outcomes", async () => {
  assert.equal(mapProviderStatus("Submitted").normalized, "submitted")
  assert.equal(mapProviderStatus("Received").normalized, "submitted")
  assert.equal(mapProviderStatus("Sent").normalized, "submitted")
  assert.equal(mapProviderStatus("New Submission").normalized, "submitted")
  assert.equal(mapProviderStatus("Offer").normalized, "approved")
  assert.equal(mapProviderStatus("Offered").normalized, "approved")
  assert.equal(mapProviderStatus("Approved").normalized, "approved")
  assert.equal(mapProviderStatus("Declined").normalized, "declined")
  assert.equal(mapProviderStatus("Decline").normalized, "declined")
  assert.equal(mapProviderStatus("Rejected").normalized, "declined")
  assert.equal(Object.keys(PROVIDER_STATUS_MAP).length, 11)
  assert.deepEqual(mapProviderStatus("Hold"), { rawStatus: "Hold", normalized: "unknown", unknown: true })
  assert.equal(mapProviderStatus("CREDIT_COMMITTEE_HOLD").unknown, true)
  assert.equal(mapProviderStatus("Funded").unknown, true)

  const offerJob = documentsJob({
    attemptKey: "attempt-offer",
    route: {
      id: "route-ebf-offer",
      kind: "api",
      label: "API",
      destination: "everest-business-funding:offer",
      documentExceptions: [],
      active: true,
    },
  })
  const offerSubmit = await everestBusinessFundingAdapter.submit(offerJob)
  assert.equal(offerSubmit.ok, true)
  assert.equal(offerSubmit.rawStatus, "Offer")
  const offer = await everestBusinessFundingAdapter.getStatus!(offerJob)
  assert.equal(offer.normalized, "approved")
  assert.equal(offer.unknown, false)
  assert.deepEqual(offer.terms, SYNTHETIC_OFFER_TERMS)

  const declinedJob = documentsJob({
    attemptKey: "attempt-declined",
    route: {
      id: "route-ebf-declined",
      kind: "api",
      label: "API",
      destination: "everest-business-funding:declined",
      documentExceptions: [],
      active: true,
    },
  })
  const declinedSubmit = await everestBusinessFundingAdapter.submit(declinedJob)
  assert.equal(declinedSubmit.ok, true)
  assert.equal(declinedSubmit.rawStatus, "Declined")
  const declined = await everestBusinessFundingAdapter.getStatus!(declinedJob)
  assert.equal(declined.normalized, "declined")
  assert.equal(declined.unknown, false)
  assert.equal(declined.terms, undefined)

  const holdJob = documentsJob({
    attemptKey: "attempt-hold",
    route: {
      id: "route-ebf-hold",
      kind: "api",
      label: "API",
      destination: "everest-business-funding:hold",
      documentExceptions: [],
      active: true,
    },
  })
  const holdSubmit = await everestBusinessFundingAdapter.submit(holdJob)
  assert.equal(holdSubmit.ok, true)
  assert.equal(holdSubmit.rawStatus, "Hold")
  const hold = await everestBusinessFundingAdapter.getStatus!(holdJob)
  assert.equal(hold.normalized, "unknown")
  assert.equal(hold.unknown, true)
  assert.equal(hold.rawStatus, "Hold")
  assert.equal(hold.terms, undefined)
})
