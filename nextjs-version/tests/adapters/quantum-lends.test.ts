import test, { beforeEach } from "node:test"
import assert from "node:assert/strict"
import { AppError } from "../../src/lib/mca/errors"
import type { SubmissionJob } from "../../src/lib/mca/submissions/contracts"
import {
  mapApplication,
  quantumLendsAdapter,
  resetQuantumLendsAdapterForTests,
  setQuantumLendsFixtureForTests,
} from "../../src/lib/mca/submissions/adapters/quantum-lends"

const SECRET = "ql-api-key-never-leak"
const FULL_SSN = "123-45-6789"

const completeApplication = {
  legalName: "Harbor Coffee LLC",
  dbaName: "Harbor Coffee",
  ein: "12-3456789",
  entityType: "llc",
  address: { line1: "100 Main St", city: "Austin", state: "TX", postalCode: "78701" },
  contactPhone: "5125550100",
  startDate: "2019-04-01",
  industry: "Restaurants",
  monthlyRevenue: 45_000,
  requestedAmount: 75_000,
  owners: [
    { firstName: "Ava", lastName: "Stone", ownershipPercent: 30, identityLast4: "1111" },
    { firstName: "Miles", lastName: "Stone", ownershipPercent: 70, ssn: FULL_SSN, isPrimary: false },
  ],
}

function job(overrides: Partial<SubmissionJob> & { destination?: string } = {}): SubmissionJob {
  const { destination, route, ...rest } = overrides
  return {
    id: rest.id ?? "job-ql-1",
    workspaceId: rest.workspaceId ?? "workspace-ql",
    dealId: rest.dealId ?? "deal-ql-1",
    funderId: rest.funderId ?? "funder-ql",
    displayFunderName: rest.displayFunderName ?? "Quantum Lends",
    routeKind: "api",
    route: route ?? {
      id: "route-ql",
      kind: "api",
      label: "API",
      destination: destination ?? "quantum-lends",
      documentExceptions: [],
      active: true,
    },
    state: rest.state ?? "sending",
    confirmationKey: rest.confirmationKey ?? "conf-ql-1",
    attemptKey: rest.attemptKey ?? "attempt-ql-1",
    dealVersion: rest.dealVersion ?? 1,
    documentVersions: rest.documentVersions ?? [],
    packageDocumentIds: rest.packageDocumentIds ?? [],
    preflightErrors: rest.preflightErrors ?? [],
    merchantIdentityKey: rest.merchantIdentityKey ?? `deal:${rest.dealId ?? "deal-fixture"}`,
    packageFingerprint: rest.packageFingerprint ?? "",
    createdAt: rest.createdAt ?? "2026-01-01T00:00:00.000Z",
    updatedAt: rest.updatedAt ?? "2026-01-01T00:00:00.000Z",
    ...rest,
  }
}

function assertNoSecrets(value: unknown) {
  const text = typeof value === "string" ? value : JSON.stringify(value)
  assert.equal(text.includes(SECRET), false)
  assert.equal(text.includes(FULL_SSN), false)
  assert.equal(text.includes("123456789"), false)
  assert.equal(text.includes("pdf-bytes"), false)
}

beforeEach(() => {
  resetQuantumLendsAdapterForTests()
})

test("MIC-129: capability flags match submit and status poll only", () => {
  assert.equal(quantumLendsAdapter.slug, "quantum-lends")
  assert.deepEqual(quantumLendsAdapter.capabilities, {
    submit: true,
    statusPoll: true,
    webhooks: false,
    offers: false,
  })
  assert.equal(typeof quantumLendsAdapter.getStatus, "function")
  assert.equal(quantumLendsAdapter.parseWebhook, undefined)
})

test("MIC-129: empty and required-field rejection", () => {
  const empty = quantumLendsAdapter.validate({})
  assert.equal(empty.ok, false)
  if (empty.ok) throw new Error("expected field errors")
  assert.ok(empty.fields.legalName)
  assert.ok(empty.fields.requestedAmount)
  assert.ok(empty.fields.annualRevenue)
  assert.ok(empty.fields.ein)
  assert.ok(empty.fields.owners)
  assert.ok(empty.fields.industry)
  assert.ok(empty.fields.entityType)
  assert.ok(empty.fields.contactPhone)
  assert.ok(empty.fields.startDate)

  const missingMoney = quantumLendsAdapter.validate({
    ...completeApplication,
    requestedAmount: undefined,
    monthlyRevenue: undefined,
    annualRevenue: undefined,
  })
  assert.equal(missingMoney.ok, false)
  if (missingMoney.ok) throw new Error("expected money field errors")
  assert.equal(missingMoney.fields.requestedAmount, "Enter the requested funding amount.")
  assert.match(missingMoney.fields.annualRevenue ?? "", /annual revenue/i)
})

test("MIC-129: sole-proprietor EIN exception, primary applicant, and NAICS mapping", () => {
  const llcMissingEin = quantumLendsAdapter.validate({ ...completeApplication, ein: undefined })
  assert.equal(llcMissingEin.ok, false)
  if (llcMissingEin.ok) throw new Error("expected EIN error")
  assert.equal(llcMissingEin.fields.ein, "An EIN is required for this entity type.")

  const soleProp = mapApplication({
    ...completeApplication,
    legalName: "Miles Stone",
    entityType: "sole_proprietor",
    ein: undefined,
    industry: "Trucking",
  })
  assert.equal(soleProp.ok, true)
  if (!soleProp.ok) throw new Error("expected sole proprietor to validate")
  assert.equal(soleProp.request.merchant.ein, undefined)
  assert.equal(soleProp.request.merchant.entityType, "Sole Proprietorship")
  assert.equal(soleProp.request.merchant.naics, "484121")
  assert.equal(soleProp.request.funding.annualRevenue, 540_000)
  assert.equal(soleProp.request.owners.filter((owner) => owner.isPrimary).length, 1)
  const primary = soleProp.request.owners.find((owner) => owner.isPrimary)
  assert.equal(primary?.firstName, "Miles")
  assert.equal(primary?.ssnLast4, "6789")
  assert.equal(JSON.stringify(soleProp.request).includes(FULL_SSN), false)

  const unmapped = quantumLendsAdapter.validate({ ...completeApplication, industry: "Unlisted Niche Vertical", naicsCode: undefined })
  assert.equal(unmapped.ok, false)
  if (unmapped.ok) throw new Error("expected industry error")
  assert.match(unmapped.fields.industry ?? "", /NAICS/i)
})

test("MIC-129: accepted submission and document receipt", async () => {
  const validated = quantumLendsAdapter.validate(completeApplication)
  assert.equal(validated.ok, true)

  const submitted = await quantumLendsAdapter.submit(job({
    documentVersions: [
      { documentId: "doc-statement-jan", checksum: "aaa", category: "statement" },
      { documentId: "doc-statement-feb", checksum: "bbb", category: "statement" },
      { documentId: "doc-application", checksum: "ccc", category: "application" },
    ],
    packageDocumentIds: ["doc-statement-jan", "doc-statement-feb", "doc-application"],
  }))
  assert.equal(submitted.ok, true)
  assert.equal(submitted.externalRef, "ql-attempt-ql-1")
  assert.equal(submitted.rawStatus, "Sent")
  assert.equal(submitted.fields?.documentReceipt, "accepted")
  assert.equal(submitted.fields?.documentsReceived, "2")
  assert.equal(submitted.fields?.documentIds, "doc-statement-jan,doc-statement-feb")
  assertNoSecrets(submitted)
  assert.equal(JSON.stringify(submitted).includes("aaa"), false)

  const withoutStatements = await quantumLendsAdapter.submit(job({ attemptKey: "attempt-ql-no-docs" }))
  assert.equal(withoutStatements.ok, true)
  assert.equal(withoutStatements.fields?.documentReceipt, "none")
})

test("MIC-129: timeout, expired credentials, and attemptKey replay preserve identity", async () => {
  const timeoutJob = job({ destination: "quantum-lends:timeout", attemptKey: "attempt-timeout" })
  const timeout = await quantumLendsAdapter.submit(timeoutJob)
  assert.equal(timeout.ok, false)
  assert.equal(timeout.errorCode, "timeout")
  assert.equal(timeout.externalRef, undefined)
  assert.match(timeout.errorMessage ?? "", /timed out/i)
  assert.ok(timeout.correlationId)

  const timeoutAgain = await quantumLendsAdapter.submit(timeoutJob)
  assert.equal(timeoutAgain.ok, false)
  assert.equal(timeoutAgain.externalRef, undefined)

  const recovered = await quantumLendsAdapter.submit(job({ destination: "quantum-lends", attemptKey: "attempt-timeout" }))
  assert.equal(recovered.ok, true)
  assert.equal(recovered.externalRef, "ql-attempt-timeout")

  setQuantumLendsFixtureForTests("expired")
  const expired = await quantumLendsAdapter.submit(job({ attemptKey: "attempt-expired" }))
  assert.equal(expired.ok, false)
  assert.equal(expired.errorCode, "expired_credentials")
  assert.equal(expired.externalRef, undefined)
  assert.match(expired.errorMessage ?? "", /expired/i)
  assertNoSecrets(expired)

  setQuantumLendsFixtureForTests()
  const first = await quantumLendsAdapter.submit(job({ attemptKey: "attempt-replay" }))
  setQuantumLendsFixtureForTests("timeout")
  const replay = await quantumLendsAdapter.submit(job({ attemptKey: "attempt-replay" }))
  assert.equal(first.ok, true)
  assert.equal(replay.ok, true)
  assert.equal(replay.externalRef, first.externalRef)
  assert.equal(replay.correlationId, first.correlationId)
})

test("MIC-129: status poll maps sent, approved, funded, declined and keeps unknown raw", async () => {
  const submitted = await quantumLendsAdapter.submit(job())
  assert.equal(submitted.rawStatus, "Sent")
  const sent = await quantumLendsAdapter.getStatus!(job())
  assert.equal(sent.rawStatus, "Sent")
  assert.equal(sent.normalized, "submitted")
  assert.equal(sent.unknown, false)
  assert.equal(sent.terms, undefined)

  const approved = await quantumLendsAdapter.getStatus!(job({ destination: "quantum-lends:approved" }))
  assert.equal(approved.rawStatus, "Approved")
  assert.equal(approved.normalized, "approved")
  assert.equal(approved.unknown, false)
  assert.equal(approved.terms, undefined)

  const funded = await quantumLendsAdapter.getStatus!(job({ destination: "quantum-lends:funded" }))
  assert.equal(funded.rawStatus, "Funded")
  assert.equal(funded.normalized, "funded")

  const declined = await quantumLendsAdapter.getStatus!(job({ destination: "quantum-lends:declined" }))
  assert.equal(declined.rawStatus, "Declined")
  assert.equal(declined.normalized, "declined")

  const unknown = await quantumLendsAdapter.getStatus!(job({ destination: "quantum-lends:unknown" }))
  assert.equal(unknown.rawStatus, "OnHold")
  assert.equal(unknown.normalized, "unknown")
  assert.equal(unknown.unknown, true)
  assert.equal(unknown.terms, undefined)

  await assert.rejects(
    () => quantumLendsAdapter.getStatus!(job({ destination: "timeout" })),
    (error: unknown) => error instanceof AppError && error.code === "timeout" && error.status === 503,
  )
  await assert.rejects(
    () => quantumLendsAdapter.getStatus!(job({ destination: "expired" })),
    (error: unknown) => error instanceof AppError && error.code === "expired_credentials",
  )
})
