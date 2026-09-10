import test, { beforeEach } from "node:test"
import assert from "node:assert/strict"
import type { SubmissionJob } from "../../src/lib/mca/submissions/contracts"
import { AppError } from "../../src/lib/mca/errors"
import {
  getKapitusAttempt,
  kapitusAcceptedApplication,
  kapitusAdapter,
  kapitusResultContainsSecret,
  KAPITUS_FIXTURE_TRANSPORT,
  mapKapitusApplication,
  mapKapitusStatus,
  resetKapitusAdapterState,
  setKapitusFixtureOverride,
} from "../../src/lib/mca/submissions/adapters/kapitus"

const OWNER_SSN = "000000001"

function jobFor(extra: Partial<SubmissionJob> = {}): SubmissionJob {
  return {
    id: "job-kapitus-1",
    workspaceId: "workspace-kapitus",
    dealId: "deal-kapitus-1",
    funderId: "funder-kapitus",
    displayFunderName: "Kapitus",
    routeKind: "api",
    route: {
      id: "route-kapitus",
      kind: "api",
      label: "Kapitus API",
      destination: "kapitus",
      documentExceptions: [],
      active: true,
    },
    state: "sending",
    confirmationKey: "conf-kapitus-1",
    attemptKey: "attempt-kapitus-1",
    dealVersion: 1,
    documentVersions: [
      { documentId: "doc-app-1", checksum: "checksum-app", category: "application" },
      { documentId: "doc-stmt-1", checksum: "checksum-stmt", category: "statement" },
    ],
    packageDocumentIds: ["doc-app-1", "doc-stmt-1"],
    preflightErrors: [],
    createdAt: "2026-09-08T00:00:00.000Z",
    updatedAt: "2026-09-08T00:00:00.000Z",
    ...extra,
  }
}

beforeEach(() => {
  resetKapitusAdapterState()
})

test("MIC-126 rejects missing primary owner, annual revenue, amount, and signed documents", () => {
  const empty = kapitusAdapter.validate({})
  assert.equal(empty.ok, false)
  if (empty.ok) throw new Error("expected field errors")
  assert.equal(typeof empty.fields["owners.primary"], "string")
  assert.equal(typeof empty.fields.annualRevenue, "string")
  assert.equal(typeof empty.fields.requestedAmount, "string")
  assert.equal(typeof empty.fields["documents.signedApplication"], "string")
  assert.equal(typeof empty.fields["documents.bankStatements"], "string")

  const noOwner = structuredClone(kapitusAcceptedApplication)
  noOwner.owners = []
  const ownerResult = kapitusAdapter.validate(noOwner)
  assert.equal(ownerResult.ok, false)
  if (ownerResult.ok) throw new Error("expected owner errors")
  assert.equal(ownerResult.fields["owners.primary"], "Add the primary owner (highest ownership percentage).")

  const noRevenue = structuredClone(kapitusAcceptedApplication)
  delete noRevenue.annualRevenue
  const revenueResult = kapitusAdapter.validate(noRevenue)
  assert.equal(revenueResult.ok, false)
  if (revenueResult.ok) throw new Error("expected revenue errors")
  assert.equal(revenueResult.fields.annualRevenue, "Enter gross annual revenue.")

  const noAmount = structuredClone(kapitusAcceptedApplication)
  delete noAmount.requestedAmount
  const amountResult = kapitusAdapter.validate(noAmount)
  assert.equal(amountResult.ok, false)
  if (amountResult.ok) throw new Error("expected amount errors")
  assert.equal(amountResult.fields.requestedAmount, "Enter the requested funding amount.")

  const unsigned = structuredClone(kapitusAcceptedApplication)
  unsigned.documents = [
    { documentId: "doc-app-1", kind: "application", category: "application", signed: false, checksum: "checksum-app" },
    { documentId: "doc-stmt-1", kind: "bank_statement", category: "statement", checksum: "checksum-stmt" },
  ]
  const unsignedResult = kapitusAdapter.validate(unsigned)
  assert.equal(unsignedResult.ok, false)
  if (unsignedResult.ok) throw new Error("expected signed document errors")
  assert.equal(unsignedResult.fields["documents.signedApplication"], "Upload a signed application.")
  assert.equal("documents.bankStatements" in unsignedResult.fields, false)

  assert.deepEqual(kapitusAdapter.validate(kapitusAcceptedApplication), { ok: true })
})

test("MIC-126 accepts a submission, records document receipt, and does not treat acknowledgement as approval", async () => {
  const mapped = mapKapitusApplication(kapitusAcceptedApplication)
  assert.equal(mapped.owner.firstName, "Mira")
  assert.equal(mapped.owner.ownershipPercent, 80)
  assert.equal(mapped.documents.some((document) => document.kind === "signed_application"), true)
  assert.equal(mapped.documents.some((document) => document.kind === "bank_statement"), true)
  assert.equal(JSON.stringify(mapped).includes("Jonah"), false)

  const submitted = await kapitusAdapter.submit(jobFor())
  assert.equal(submitted.ok, true)
  assert.equal(submitted.externalRef, "kapitus-app-attempt-kapitus-1")
  assert.equal(submitted.rawStatus, "Application Received")
  assert.equal(mapKapitusStatus(submitted.rawStatus ?? "").normalized, "submitted")
  assert.notEqual(mapKapitusStatus(submitted.rawStatus ?? "").normalized, "approved")
  assert.equal(submitted.fields?.signedApplication, "received")
  assert.equal(submitted.fields?.bankStatements, "received")
  assert.equal(submitted.fields?.signedApplicationChecksum, "checksum-app")
  assert.equal(submitted.fields?.bankStatementChecksum, "checksum-stmt")
  assert.equal(kapitusResultContainsSecret(submitted, OWNER_SSN), false)

  const receipts = getKapitusAttempt("attempt-kapitus-1")?.documentReceipts ?? []
  assert.equal(receipts.length, 2)
  assert.deepEqual(receipts.map((item) => item.kind).sort(), ["bank_statement", "signed_application"])
  assert.equal(receipts.every((item) => item.received), true)

  const status = await kapitusAdapter.getStatus!(jobFor())
  assert.equal(status.rawStatus, "Application Received")
  assert.equal(status.normalized, "submitted")
  assert.equal(status.unknown, false)
  assert.equal(status.terms, undefined)
  assert.equal(kapitusResultContainsSecret(status, OWNER_SSN), false)
  assert.equal(KAPITUS_FIXTURE_TRANSPORT.startsWith("fixture://"), true)

  const missingDocs = await kapitusAdapter.submit(jobFor({
    attemptKey: "attempt-missing-docs",
    documentVersions: [{ documentId: "doc-other", checksum: "checksum-other", category: "voided_check" }],
  }))
  assert.equal(missingDocs.ok, false)
  assert.equal(missingDocs.errorCode, "validation_failed")
  assert.equal(missingDocs.externalRef, undefined)
  assert.equal(missingDocs.fields?.["documents.signedApplication"], "Upload a signed application.")
  assert.equal(missingDocs.fields?.["documents.bankStatements"], "Upload bank statements.")

  const corrected = await kapitusAdapter.submit(jobFor({ attemptKey: "attempt-missing-docs" }))
  assert.equal(corrected.ok, true)
  assert.equal(corrected.externalRef, "kapitus-app-attempt-missing-docs")
  assert.equal(corrected.rawStatus, "Application Received")
})

test("MIC-126 maps delayed underwriting, closing, funded, declined, and unknown statuses without inventing offers", async () => {
  assert.equal(mapKapitusStatus("Application Received").normalized, "submitted")
  assert.equal(mapKapitusStatus("Not Delivered").normalized, "submitted")
  assert.equal(mapKapitusStatus("Credit Review").normalized, "pending")
  assert.equal(mapKapitusStatus("Update Requested").normalized, "pending")
  assert.equal(mapKapitusStatus("Incomplete").normalized, "pending")
  assert.equal(mapKapitusStatus("Approved").normalized, "approved")
  assert.equal(mapKapitusStatus("Contract Sent").normalized, "approved")
  assert.equal(mapKapitusStatus("Contract Received").normalized, "approved")
  assert.equal(mapKapitusStatus("Closing").normalized, "approved")
  assert.equal(mapKapitusStatus("Closing Documents Missing").normalized, "approved")
  assert.equal(mapKapitusStatus("Funded").normalized, "funded")
  assert.equal(mapKapitusStatus("Declined").normalized, "declined")
  assert.equal(mapKapitusStatus("Expired").normalized, "declined")
  assert.deepEqual(mapKapitusStatus("CREDIT_COMMITTEE_HOLD"), {
    rawStatus: "CREDIT_COMMITTEE_HOLD",
    normalized: "unknown",
    unknown: true,
  })

  await kapitusAdapter.submit(jobFor({ attemptKey: "attempt-status" }))

  setKapitusFixtureOverride("credit-review")
  const pending = await kapitusAdapter.getStatus!(jobFor({ attemptKey: "attempt-status" }))
  assert.equal(pending.rawStatus, "Credit Review")
  assert.equal(pending.normalized, "pending")
  assert.equal(pending.terms, undefined)

  setKapitusFixtureOverride("closing")
  const closing = await kapitusAdapter.getStatus!(jobFor({ attemptKey: "attempt-status" }))
  assert.equal(closing.rawStatus, "Closing")
  assert.equal(closing.normalized, "approved")
  assert.equal(closing.unknown, false)
  assert.equal(closing.terms, undefined)

  setKapitusFixtureOverride("approved")
  const approved = await kapitusAdapter.getStatus!(jobFor({ attemptKey: "attempt-status" }))
  assert.equal(approved.rawStatus, "Approved")
  assert.equal(approved.normalized, "approved")
  assert.equal(approved.terms?.amount, 75000)
  assert.equal(approved.terms?.rate, 1.35)
  assert.equal(approved.terms?.term, 10)
  assert.equal(approved.terms?.offerLink, "https://offers.example.test/kapitus/synthetic-offer")

  setKapitusFixtureOverride("funded")
  const funded = await kapitusAdapter.getStatus!(jobFor({ attemptKey: "attempt-status" }))
  assert.equal(funded.rawStatus, "Funded")
  assert.equal(funded.normalized, "funded")
  assert.equal(funded.terms?.amount, 75000)

  setKapitusFixtureOverride("declined")
  const declined = await kapitusAdapter.getStatus!(jobFor({ attemptKey: "attempt-status" }))
  assert.equal(declined.rawStatus, "Declined")
  assert.equal(declined.normalized, "declined")
  assert.equal(declined.terms, undefined)

  setKapitusFixtureOverride("unknown")
  const unknown = await kapitusAdapter.getStatus!(jobFor({ attemptKey: "attempt-status" }))
  assert.equal(unknown.rawStatus, "CREDIT_COMMITTEE_HOLD")
  assert.equal(unknown.normalized, "unknown")
  assert.equal(unknown.unknown, true)
  assert.equal(unknown.terms, undefined)

  setKapitusFixtureOverride("approved")
  const acknowledged = await kapitusAdapter.submit(jobFor({ attemptKey: "attempt-ack-not-approval" }))
  assert.equal(acknowledged.ok, true)
  assert.equal(acknowledged.rawStatus, "Application Received")
  assert.notEqual(mapKapitusStatus(acknowledged.rawStatus ?? "").normalized, "approved")
})

test("MIC-126 timeouts, expired credentials, and attemptKey replay keep a single external identity", async () => {
  setKapitusFixtureOverride("timeout")
  const timeoutJob = jobFor({ attemptKey: "attempt-timeout" })
  const timeout = await kapitusAdapter.submit(timeoutJob)
  assert.equal(timeout.ok, false)
  assert.equal(timeout.errorCode, "timeout")
  assert.equal(timeout.externalRef, "kapitus-app-attempt-timeout")
  assert.equal(timeout.fields?.timeout?.includes("same attempt key"), true)

  const timeoutReplay = await kapitusAdapter.submit(timeoutJob)
  assert.equal(timeoutReplay.ok, false)
  assert.equal(timeoutReplay.externalRef, timeout.externalRef)
  assert.equal(timeoutReplay.correlationId, timeout.correlationId)
  assert.equal(getKapitusAttempt("attempt-timeout")?.providerSubmissions, 1)

  await assert.rejects(
    () => kapitusAdapter.getStatus!(timeoutJob),
    (error: unknown) => error instanceof AppError && error.code === "timeout" && error.message.includes("timed out"),
  )

  setKapitusFixtureOverride("expired-credential")
  const expiredJob = jobFor({ attemptKey: "attempt-expired" })
  const expired = await kapitusAdapter.submit(expiredJob)
  assert.equal(expired.ok, false)
  assert.equal(expired.errorCode, "expired_credential")
  assert.equal(expired.externalRef, undefined)
  assert.equal(expired.fields?.credentials?.includes("expired"), true)
  assert.equal(kapitusResultContainsSecret(expired, OWNER_SSN), false)

  const expiredReplay = await kapitusAdapter.submit(expiredJob)
  assert.equal(expiredReplay.externalRef, undefined)
  assert.equal(getKapitusAttempt("attempt-expired")?.providerSubmissions, 0)

  await assert.rejects(
    () => kapitusAdapter.getStatus!(expiredJob),
    (error: unknown) => error instanceof AppError && error.code === "expired_credential",
  )

  setKapitusFixtureOverride("accepted")
  const acceptedJob = jobFor({ attemptKey: "attempt-replay" })
  const first = await kapitusAdapter.submit(acceptedJob)
  const second = await kapitusAdapter.submit(acceptedJob)
  assert.equal(first.ok, true)
  assert.equal(second.ok, true)
  assert.equal(second.externalRef, first.externalRef)
  assert.equal(second.correlationId, first.correlationId)
  assert.equal(second.rawStatus, "Application Received")
  assert.equal(getKapitusAttempt("attempt-replay")?.providerSubmissions, 1)
  assert.equal(getKapitusAttempt("attempt-replay")?.documentReceipts.length, 2)
})

test("MIC-126 advertises submit, status poll, and offers without webhooks", () => {
  assert.equal(kapitusAdapter.slug, "kapitus")
  assert.deepEqual(kapitusAdapter.capabilities, {
    submit: true,
    statusPoll: true,
    webhooks: false,
    offers: true,
  })
  assert.equal(typeof kapitusAdapter.getStatus, "function")
  assert.equal(kapitusAdapter.parseWebhook, undefined)
})
