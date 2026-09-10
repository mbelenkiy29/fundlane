import test, { beforeEach } from "node:test"
import assert from "node:assert/strict"
import type { SubmissionJob } from "../../src/lib/mca/submissions/contracts"
import { runWithAdapterRuntime } from "../../src/lib/mca/submissions/adapters/credentials"
import {
  FINTEGRA_MAX_OWNERS,
  FINTEGRA_SLUG,
  fintegraAdapter,
  mapFintegraRequest,
  mapFintegraStatus,
  resetFintegraAdapterForTests,
  setFintegraApplicationForTests,
  setFintegraFixtureForTests,
  ssnLast4,
  validateFintegraApplication,
} from "../../src/lib/mca/submissions/adapters/fintegra"
import type { FintegraApplication } from "../../src/lib/mca/submissions/adapters/fintegra/mapping"

const SECRET = "ftg-live-secret-never-leak"
type AdapterNormalized = "submitted" | "pending" | "approved" | "declined" | "funded" | "unknown"

function job(overrides: Partial<SubmissionJob> = {}): SubmissionJob {
  return {
    id: "job-fintegra-1",
    workspaceId: "workspace-fintegra",
    dealId: "deal-fintegra-1",
    funderId: "funder-fintegra",
    displayFunderName: "Fintegra",
    routeKind: "api",
    route: {
      id: "route-fintegra",
      kind: "api",
      label: "API",
      destination: FINTEGRA_SLUG,
      documentExceptions: [],
      active: true,
    },
    state: "sending",
    confirmationKey: "conf-fintegra-1",
    attemptKey: "attempt-fintegra-1",
    dealVersion: 1,
    documentVersions: [
      { documentId: "doc-app", checksum: "sha-app", category: "application" },
      { documentId: "doc-stmt", checksum: "sha-stmt", category: "statement" },
    ],
    packageDocumentIds: ["doc-app", "doc-stmt"],
    preflightErrors: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  }
}

function owner(index: number, extra: NonNullable<FintegraApplication["owners"]>[number] = {}): NonNullable<FintegraApplication["owners"]>[number] {
  return {
    firstName: ["Ari", "Sam", "Lee", "Jordan"][index] ?? `Owner${index}`,
    lastName: ["Ng", "Patel", "Chen", "Brooks"][index] ?? "Owner",
    ssn: ["123-45-6789", "987-65-4321", "111-22-3333", "222-33-4444"][index] ?? "555-66-7777",
    dateOfBirth: ["1984-04-12", "1990-09-01", "1988-01-20", "1979-07-07"][index] ?? "1980-01-01",
    ownershipPercent: [60, 25, 15, 10][index] ?? 10,
    isPrimary: index === 0,
    address: { street: `${20 + index} Oak Ave`, city: "Austin", state: "TX", zip: "78702" },
    ...extra,
  }
}

function application(overrides: FintegraApplication = {}): FintegraApplication {
  return {
    legalName: "Harbor Coffee LLC",
    ein: "12-3456789",
    address: { street: "10 Main St", city: "Austin", state: "TX", zip: "78701" },
    originatorEmail: "originator@broker.test",
    isoName: "Northwind ISO",
    brokerName: "Alex Broker",
    owners: [owner(0), owner(1), owner(2)],
    documents: [
      { documentId: "doc-app", category: "application", checksum: "sha-app" },
      { documentId: "doc-stmt", category: "statement", checksum: "sha-stmt" },
    ],
    ...overrides,
  }
}

function runtime(apiKey?: string) {
  return {
    credentialId: "cred-fintegra",
    workspaceId: "workspace-fintegra",
    funderId: "funder-fintegra",
    adapterSlug: FINTEGRA_SLUG,
    environment: "development" as const,
    capabilities: { submit: true as const, statusPoll: true, webhooks: false, offers: false },
    secrets: apiKey ? { apiKey } : {},
    correlationId: "corr-fintegra-runtime",
  }
}

beforeEach(() => {
  resetFintegraAdapterForTests()
})

test("MIC-127 rejects missing required fields and more than three owners", async () => {
  const empty = fintegraAdapter.validate({})
  assert.equal(empty.ok, false)
  if (empty.ok) throw new Error("expected field errors")
  assert.equal(empty.fields.legalName, "Enter the legal business name.")
  assert.equal(empty.fields.ein, "Enter a 9-digit EIN / tax ID.")
  assert.equal(empty.fields["address.street"], "Enter the street address.")
  assert.equal(empty.fields["address.city"], "Enter the city.")
  assert.equal(empty.fields["address.state"], "Enter a two-letter state code.")
  assert.equal(empty.fields["address.zip"], "Enter a ZIP code.")
  assert.equal(empty.fields.originatorEmail, "Enter the registered originator email.")
  assert.equal(empty.fields.owners, "A primary owner is required.")
  assert.equal(empty.fields.applicationDocument, "Attach a signed application.")
  assert.equal(empty.fields.bankStatements, "Attach bank statements.")

  const fourOwners = fintegraAdapter.validate(application({ owners: [owner(0), owner(1), owner(2), owner(3)] }))
  assert.equal(fourOwners.ok, false)
  if (fourOwners.ok) throw new Error("expected owner cap")
  assert.equal(fourOwners.fields.owners, "Fintegra accepts at most three owners.")
  assert.equal(FINTEGRA_MAX_OWNERS, 3)

  const incompleteOwner = fintegraAdapter.validate(application({
    owners: [{ firstName: "Ari", isPrimary: true, address: { city: "Austin" } }],
    originatorEmail: "not-an-email",
  }))
  assert.equal(incompleteOwner.ok, false)
  if (incompleteOwner.ok) throw new Error("expected owner field errors")
  assert.equal(incompleteOwner.fields.originatorEmail, "Enter a valid originator email.")
  assert.equal(incompleteOwner.fields["owners.0.lastName"], "Enter the owner last name.")
  assert.equal(incompleteOwner.fields["owners.0.ssn"], "Enter a 9-digit Social Security Number.")
  assert.equal(incompleteOwner.fields["owners.0.dateOfBirth"], "Enter the owner date of birth as YYYY-MM-DD.")
  assert.equal(incompleteOwner.fields["owners.0.ownershipPercent"], "Enter the ownership percentage.")
  assert.equal(incompleteOwner.fields["owners.0.address.street"], "Enter the street address.")
  assert.equal(incompleteOwner.fields["owners.0.address.state"], "Enter a two-letter state code.")
  assert.equal(incompleteOwner.fields["owners.0.address.zip"], "Enter a ZIP code.")

  const mapped = validateFintegraApplication(application())
  assert.equal(mapped.ok, true)
  if (!mapped.ok) throw new Error("expected valid application")
  const request = mapFintegraRequest(mapped.application, job())
  assert.equal(request.owners.length, 3)
  assert.equal(request.owners[0]?.isPrimary, true)
  assert.equal(request.owners[0]?.ssnLast4, ssnLast4("123-45-6789"))
  assert.equal(JSON.stringify(request).includes("123-45-6789"), false)
  assert.equal(request.originatorEmail, "originator@broker.test")
  assert.deepEqual(request.business.address, { street: "10 Main St", city: "Austin", state: "TX", zip: "78701" })

  setFintegraFixtureForTests("missing_fields")
  const submitted = await fintegraAdapter.submit(job({ attemptKey: "attempt-missing-fields" }))
  assert.equal(submitted.ok, false)
  assert.equal(submitted.errorCode, "validation_failed")
  assert.equal(submitted.externalRef, undefined)
  assert.equal(submitted.fields?.legalName, "Enter the legal business name.")
  assert.equal(submitted.fields?.originatorEmail, "Enter the registered originator email.")
})

test("MIC-127 accepts a complete submission and records document receipt", async () => {
  setFintegraApplicationForTests(application())
  const result = await fintegraAdapter.submit(job())
  assert.equal(result.ok, true)
  assert.equal(result.externalRef, "ftg-attempt-fintegra-1")
  assert.equal(result.rawStatus, "Received")
  assert.equal(result.fields?.signedApplication, "received")
  assert.equal(result.fields?.bankStatements, "received")
  assert.equal(result.fields?.ownerCount, "3")
  assert.equal(JSON.stringify(result).includes("123-45-6789"), false)
  assert.equal(JSON.stringify(result).includes(SECRET), false)

  setFintegraApplicationForTests()
  const missingDocs = await fintegraAdapter.submit(job({
    attemptKey: "attempt-missing-docs",
    documentVersions: [{ documentId: "doc-other", checksum: "sha-other", category: "voided_check" }],
    packageDocumentIds: ["doc-other"],
  }))
  assert.equal(missingDocs.ok, false)
  assert.equal(missingDocs.errorCode, "validation_failed")
  assert.equal(missingDocs.externalRef, undefined)
  assert.equal(missingDocs.fields?.applicationDocument, "Attach a signed application.")
  assert.equal(missingDocs.fields?.bankStatements, "Attach bank statements.")
})

test("MIC-127 timeouts, expired credentials, and attemptKey replay keep one external ref", async () => {
  setFintegraFixtureForTests("timeout")
  const firstTimeout = await fintegraAdapter.submit(job({ attemptKey: "attempt-timeout" }))
  const replayTimeout = await fintegraAdapter.submit(job({ attemptKey: "attempt-timeout" }))
  assert.equal(firstTimeout.ok, false)
  assert.equal(firstTimeout.errorCode, "provider_unavailable")
  assert.match(firstTimeout.errorMessage ?? "", /timed out/i)
  assert.equal(firstTimeout.externalRef, "ftg-attempt-timeout")
  assert.equal(replayTimeout.externalRef, firstTimeout.externalRef)
  assert.equal(replayTimeout.correlationId, firstTimeout.correlationId)
  assert.equal(replayTimeout.errorCode, "provider_unavailable")

  resetFintegraAdapterForTests()
  const expired = await fintegraAdapter.submit(job({
    attemptKey: "attempt-expired",
    route: { id: "route-expired", kind: "api", label: "API", destination: "fintegra-expired", documentExceptions: [], active: true },
  }))
  const expiredReplay = await fintegraAdapter.submit(job({
    attemptKey: "attempt-expired",
    route: { id: "route-expired", kind: "api", label: "API", destination: "fintegra-expired", documentExceptions: [], active: true },
  }))
  assert.equal(expired.ok, false)
  assert.equal(expired.errorCode, "credential_expired")
  assert.equal(expired.externalRef, undefined)
  assert.equal(expiredReplay.correlationId, expired.correlationId)
  assert.equal(expiredReplay.errorCode, "credential_expired")

  const runtimeExpired = await runWithAdapterRuntime(runtime(), () => fintegraAdapter.submit(job({ attemptKey: "attempt-runtime-expired" })))
  assert.equal(runtimeExpired.ok, false)
  assert.equal(runtimeExpired.errorCode, "credential_expired")
  assert.equal(JSON.stringify(runtimeExpired).includes(SECRET), false)

  resetFintegraAdapterForTests()
  setFintegraApplicationForTests(application())
  const accepted = await runWithAdapterRuntime(runtime(SECRET), () => fintegraAdapter.submit(job({ attemptKey: "attempt-replay-ok" })))
  const acceptedReplay = await runWithAdapterRuntime(runtime(SECRET), () => fintegraAdapter.submit(job({ attemptKey: "attempt-replay-ok" })))
  assert.equal(accepted.ok, true)
  assert.equal(accepted.externalRef, "ftg-attempt-replay-ok")
  assert.equal(acceptedReplay.ok, true)
  assert.equal(acceptedReplay.externalRef, accepted.externalRef)
  assert.equal(acceptedReplay.correlationId, accepted.correlationId)
  assert.equal(acceptedReplay.rawStatus, "Received")
  assert.equal(JSON.stringify(accepted).includes(SECRET), false)
})

test("MIC-127 status poll maps Fintegra outcomes without priced offers", async () => {
  setFintegraApplicationForTests(application())
  await fintegraAdapter.submit(job({ attemptKey: "attempt-status" }))
  const received = await fintegraAdapter.getStatus!(job({ attemptKey: "attempt-status" }))
  assert.equal(received.rawStatus, "Received")
  assert.equal(received.normalized, "submitted")
  assert.equal(received.unknown, false)
  assert.equal(received.terms, undefined)
  assert.equal(received.eventId, "ftg-evt-attempt-status")

  const rows: Array<[string, Exclude<AdapterNormalized, "approved" | "funded">]> = [
    ["New Submission", "submitted"],
    ["Work In Process", "submitted"],
    ["Underwriting", "submitted"],
    ["Clarification Received", "submitted"],
    ["Processed", "submitted"],
    ["Awaiting Clarification", "pending"],
    ["Rejected", "declined"],
    ["Rejected - Credit", "declined"],
    ["Cancelled", "declined"],
    ["Disregarded Email", "declined"],
    ["Credit Committee Hold", "unknown"],
  ]
  for (const [raw, normalized] of rows) {
    const mapped = mapFintegraStatus(raw)
    assert.equal(mapped.rawStatus, raw)
    assert.equal(mapped.normalized, normalized)
    assert.equal(mapped.unknown, normalized === "unknown")
  }

  setFintegraFixtureForTests("awaiting_clarification")
  const pending = await fintegraAdapter.getStatus!(job({ attemptKey: "attempt-awaiting" }))
  assert.equal(pending.rawStatus, "Awaiting Clarification")
  assert.equal(pending.normalized, "pending")
  assert.equal(pending.terms, undefined)

  setFintegraFixtureForTests("unknown_status")
  const unknown = await fintegraAdapter.getStatus!(job({ attemptKey: "attempt-unknown" }))
  assert.equal(unknown.rawStatus, "Credit Committee Hold")
  assert.equal(unknown.normalized, "unknown")
  assert.equal(unknown.unknown, true)
  assert.equal(unknown.terms, undefined)
})

test("MIC-127 capabilities stay honest and disregarded-email is distinct", async () => {
  assert.equal(fintegraAdapter.slug, "fintegra")
  assert.deepEqual(fintegraAdapter.capabilities, { submit: true, statusPoll: true, webhooks: false, offers: false })
  assert.equal(typeof fintegraAdapter.getStatus, "function")
  assert.equal("parseWebhook" in fintegraAdapter, false)

  setFintegraFixtureForTests("disregarded_email")
  const declined = await fintegraAdapter.submit(job({ attemptKey: "attempt-disregarded" }))
  assert.equal(declined.ok, false)
  assert.equal(declined.errorCode, "disregarded_email")
  assert.equal(declined.rawStatus, "Disregarded Email")
  assert.match(declined.errorMessage ?? "", /originator email is not registered/i)
  assert.equal(declined.fields?.originatorEmail, "Register this originator email with Fintegra before resubmitting.")
  assert.equal(declined.externalRef, "ftg-attempt-disregarded")

  const status = await fintegraAdapter.getStatus!(job({ attemptKey: "attempt-disregarded" }))
  assert.equal(status.rawStatus, "Disregarded Email")
  assert.equal(status.normalized, "declined")
  assert.equal(status.unknown, false)
  assert.equal(status.terms, undefined)

  const generic = mapFintegraStatus("Rejected")
  assert.equal(generic.normalized, "declined")
  assert.notEqual(generic.rawStatus, "Disregarded Email")
})
