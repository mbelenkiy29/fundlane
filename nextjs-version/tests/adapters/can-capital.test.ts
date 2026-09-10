import test, { beforeEach } from "node:test"
import assert from "node:assert/strict"
import type { AdapterRuntime } from "../../src/lib/mca/submissions/adapters/contracts"
import { runWithAdapterRuntime } from "../../src/lib/mca/submissions/adapters/credentials"
import type { SubmissionJob } from "../../src/lib/mca/submissions/contracts"
import {
  applicationNameForAttempt,
  bindCanCapitalApplication,
  canCapitalAdapter,
  CAN_CAPITAL_SLUG,
  CREDENTIAL_COMPONENT_FIELDS,
  EXPIRED_CREDENTIAL_TOKEN,
  fixtureSubmitCallCount,
  FORMATION_REQUIRED_ENTITY_TYPES,
  listFixtureExternalRefs,
  mapCredentialComponents,
  mapEntityType,
  mapProviderStatus,
  MINIMUM_OWNER_AGE,
  peekFixture,
  PROVIDER_STATUS_MAP,
  requiresStateOfFormation,
  resetCanCapitalFixtures,
  selectPrimaryOwner,
  setCanCapitalFixture,
} from "../../src/lib/mca/submissions/adapters/can-capital"

const SSN = "123456789"
const API_KEY = "can-development-partner-key-never-leak"
const CLIENT_SECRET = "can-development-client-secret-never-leak"
const GENERAL_PASSWORD = "can-development-password-never-leak"
const SALES_REP_EMAIL = "alex.kim@iso.example"

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
    entityType: "llc",
    industry: "Food Services",
    startDate: "2019-06-01",
    contactPhone: "2125550199",
    address: { line1: "100 Front Street", city: "New York", state: "NY", postalCode: "10004" },
    requestedAmount: 75000,
    stateOfFormation: "DE",
    salesRepEmail: SALES_REP_EMAIL,
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
    id: overrides.id ?? "job-can-1",
    workspaceId: overrides.workspaceId ?? "workspace-can",
    dealId: overrides.dealId ?? "deal-can-1",
    funderId: overrides.funderId ?? "funder-can-1",
    displayFunderName: overrides.displayFunderName ?? "CAN Capital",
    routeKind: "api",
    route: overrides.route ?? {
      id: "route-can",
      kind: "api",
      label: "API",
      destination: CAN_CAPITAL_SLUG,
      documentExceptions: [],
      active: true,
    },
    state: overrides.state ?? "sending",
    confirmationKey: overrides.confirmationKey ?? "conf-can-1",
    attemptKey: overrides.attemptKey ?? "attempt-can-1",
    dealVersion: overrides.dealVersion ?? 1,
    documentVersions: overrides.documentVersions ?? [],
    packageDocumentIds: overrides.packageDocumentIds ?? [],
    preflightErrors: overrides.preflightErrors ?? [],
    createdAt: overrides.createdAt ?? "2026-01-01T00:00:00.000Z",
    updatedAt: overrides.updatedAt ?? "2026-01-01T00:00:00.000Z",
    ...overrides,
  }
}

function runtime(secrets: AdapterRuntime["secrets"], correlationId = "corr-can-1"): AdapterRuntime {
  return {
    credentialId: "cred-can-1",
    workspaceId: "workspace-can",
    funderId: "funder-can-1",
    adapterSlug: CAN_CAPITAL_SLUG,
    environment: "development",
    capabilities: canCapitalAdapter.capabilities,
    secrets,
    correlationId,
  }
}

function developmentSecrets(overrides: AdapterRuntime["secrets"] = {}): AdapterRuntime["secrets"] {
  return {
    clientId: "can-consumer-key",
    clientSecret: CLIENT_SECRET,
    username: "general@iso.example",
    password: GENERAL_PASSWORD,
    apiKey: API_KEY,
    ...overrides,
  }
}

function assertNoSecrets(value: unknown) {
  const text = typeof value === "string" ? value : JSON.stringify(value)
  assert.equal(text.includes(API_KEY), false)
  assert.equal(text.includes(CLIENT_SECRET), false)
  assert.equal(text.includes(GENERAL_PASSWORD), false)
  assert.equal(text.includes(EXPIRED_CREDENTIAL_TOKEN), false)
  assert.equal(text.includes(SSN), false)
  assert.equal(text.includes("111223333"), false)
  assert.equal(text.includes("987654321"), false)
}

beforeEach(() => {
  resetCanCapitalFixtures()
})

test("MIC-139: required-field rejection", () => {
  const empty = canCapitalAdapter.validate({})
  assert.equal(empty.ok, false)
  if (empty.ok) throw new Error("expected field errors")
  assert.equal(empty.fields.legalName, "Business name is required.")
  assert.equal(empty.fields.dba, "DBA is required.")
  assert.equal(empty.fields.ein, "EIN / Tax ID is required.")
  assert.equal(empty.fields.requestedAmount, "Funding amount is required.")
  assert.equal(empty.fields.owners, "At least one business owner is required.")
  assert.equal(empty.fields.stateOfFormation, undefined)

  const llcMissingFormation = canCapitalAdapter.validate(application({
    stateOfFormation: "",
    owners: [owner()],
  }))
  assert.equal(llcMissingFormation.ok, false)
  if (llcMissingFormation.ok) throw new Error("expected formation field error")
  assert.match(llcMissingFormation.fields.stateOfFormation ?? "", /required for LLC/i)

  const corporationMissingFormation = canCapitalAdapter.validate(application({
    entityType: "s_corporation",
    stateOfFormation: undefined,
    owners: [owner()],
  }))
  assert.equal(corporationMissingFormation.ok, false)
  if (corporationMissingFormation.ok) throw new Error("expected corporation formation error")
  assert.match(corporationMissingFormation.fields.stateOfFormation ?? "", /required for Corporation/i)

  const soleProp = canCapitalAdapter.validate(application({
    entityType: "sole_proprietor",
    stateOfFormation: "",
    owners: [owner()],
  }))
  assert.equal(soleProp.ok, true)

  const underage = canCapitalAdapter.validate(application({
    owners: [owner({ dateOfBirth: "2012-01-01" })],
  }))
  assert.equal(underage.ok, false)
  if (underage.ok) throw new Error("expected underage field error")
  assert.equal(underage.fields["owners.0.dateOfBirth"], "Owner must be 18 years or older.")

  const badPhone = canCapitalAdapter.validate(application({
    contactPhone: "12125550199",
    owners: [owner({ phone: "5550101" })],
  }))
  assert.equal(badPhone.ok, false)
  if (badPhone.ok) throw new Error("expected phone field errors")
  assert.equal(badPhone.fields.phone, "Business phone must be 10 digits.")
  assert.equal(badPhone.fields["owners.0.phone"], "Owner phone must be 10 digits.")

  assert.equal(canCapitalAdapter.validate(application()).ok, true)
  assert.equal(MINIMUM_OWNER_AGE, 18)
  assert.equal(requiresStateOfFormation("LLC"), true)
  assert.equal(requiresStateOfFormation("sole_proprietor"), false)
  assert.deepEqual([...FORMATION_REQUIRED_ENTITY_TYPES], ["LLC", "LLP", "Limited Partnership", "Corporation", "Partnership"])
})

test("MIC-139: accepted submission maps primary owner, credentials, and status-only capabilities", async () => {
  assert.equal(canCapitalAdapter.slug, "can-capital")
  assert.deepEqual(canCapitalAdapter.capabilities, {
    submit: true,
    statusPoll: true,
    webhooks: false,
    offers: false,
  })
  assert.equal(typeof canCapitalAdapter.getStatus, "function")
  assert.equal(canCapitalAdapter.parseWebhook, undefined)
  assert.equal(mapEntityType("s_corporation"), "Corporation")
  assert.equal(mapEntityType("llp"), "LLP")
  assert.equal(mapEntityType("limited partnership"), "Limited Partnership")
  assert.deepEqual(CREDENTIAL_COMPONENT_FIELDS, {
    consumerKey: "clientId",
    clientSecret: "clientSecret",
    generalEmail: "username",
    generalPassword: "password",
    partnerApiKey: "apiKey",
  })
  const components = mapCredentialComponents(developmentSecrets(), SALES_REP_EMAIL)
  assert.deepEqual(components, {
    consumerKey: "can-consumer-key",
    clientSecret: CLIENT_SECRET,
    generalEmail: "general@iso.example",
    generalPassword: GENERAL_PASSWORD,
    partnerApiKey: API_KEY,
    salesRepEmail: SALES_REP_EMAIL,
  })
  assert.equal(components.partnerApiKey.includes(","), false)

  const payload = application()
  bindCanCapitalApplication("attempt-can-1", payload)
  const submitted = await runWithAdapterRuntime(runtime(developmentSecrets()), () => canCapitalAdapter.submit(job()))
  assert.equal(submitted.ok, true)
  assert.equal(submitted.correlationId, "corr-can-1")
  assert.equal(submitted.externalRef, "can_attempt-can-1")
  assert.equal(submitted.fields?.applicationName, "can_attempt-can-1")
  assert.equal(submitted.rawStatus, "Application Received")
  assertNoSecrets(submitted)

  const stored = peekFixture("attempt-can-1")
  assert.ok(stored)
  assert.equal(stored.mapped?.entityType, "LLC")
  assert.equal(stored.mapped?.stateOfFormation, "DE")
  assert.equal(stored.mapped?.ownerFirstName, "Alex")
  assert.equal(stored.mapped?.ownerLastName, "Rivera")
  assert.equal(stored.mapped?.ownershipPercent, 55)
  assert.equal(stored.mapped?.requestedAmount, 75000)
  assert.equal(stored.mapped?.salesRepEmail, SALES_REP_EMAIL)
  assert.ok((stored.mapped?.ownerAge ?? 0) >= MINIMUM_OWNER_AGE)
  assert.deepEqual(selectPrimaryOwner(payload.owners as Array<{ ownershipPercent: number; isPrimary: boolean }>), payload.owners[1])

  const status = await runWithAdapterRuntime(runtime(developmentSecrets(), "corr-status-1"), () => canCapitalAdapter.getStatus!(job()))
  assert.equal(status.normalized, "submitted")
  assert.equal(status.rawStatus, "Application Received")
  assert.equal(status.unknown, false)
  assert.equal(status.terms, undefined)
  assert.equal(status.correlationId, "corr-status-1")
  assert.equal(status.eventId, "can-event-attempt-can-1")
  assertNoSecrets(status)
})

test("MIC-139: document receipt is stable on replay", async () => {
  const attempt = job({
    attemptKey: "attempt-docs",
    packageDocumentIds: ["doc-app", "doc-bank"],
    documentVersions: [
      { documentId: "doc-app", checksum: "checksum-app", category: "api_application" },
      { documentId: "doc-bank", checksum: "checksum-bank", category: "statement" },
    ],
  })
  bindCanCapitalApplication("attempt-docs", application({ owners: [owner()] }))
  const first = await canCapitalAdapter.submit(attempt)
  assert.equal(first.ok, true)
  assert.equal(first.fields?.["documents.0.documentId"], "doc-app")
  assert.equal(first.fields?.["documents.0.category"], "application")
  assert.equal(first.fields?.["documents.0.receiptId"], "can_doc_attempt-docs_doc-app")
  assert.equal(first.fields?.["documents.1.documentId"], "doc-bank")
  assert.equal(first.fields?.["documents.1.category"], "bank_statements")
  assert.equal(first.fields?.["documents.1.receiptId"], "can_doc_attempt-docs_doc-bank")
  assert.equal(first.fields?.applicationName, applicationNameForAttempt("attempt-docs"))
  assertNoSecrets(first)

  const replay = await canCapitalAdapter.submit(attempt)
  assert.equal(replay.ok, true)
  assert.equal(replay.externalRef, first.externalRef)
  assert.deepEqual(replay.fields, first.fields)
  assert.deepEqual(listFixtureExternalRefs(), ["can_attempt-docs"])
  assert.equal(peekFixture("attempt-docs")?.submitCalls, 2)
  assert.equal(fixtureSubmitCallCount(), 2)
})

test("MIC-139: timeout, expired credential, and replay do not duplicate submissions", async () => {
  const timeoutJob = job({
    attemptKey: "attempt-timeout",
    route: {
      id: "route-can-timeout",
      kind: "api",
      label: "API",
      destination: "can-capital:timeout",
      documentExceptions: [],
      active: true,
    },
  })
  const timedOut = await canCapitalAdapter.submit(timeoutJob)
  assert.equal(timedOut.ok, false)
  assert.equal(timedOut.errorCode, "provider_unavailable")
  assert.match(timedOut.errorMessage ?? "", /timed out/i)
  assert.equal(timedOut.externalRef, "can_attempt-timeout")

  const recovered = await canCapitalAdapter.submit(timeoutJob)
  assert.equal(recovered.ok, true)
  assert.equal(recovered.externalRef, timedOut.externalRef)
  assert.equal(recovered.rawStatus, "Application Received")
  assert.deepEqual(listFixtureExternalRefs(), ["can_attempt-timeout"])

  const expiredJob = job({ attemptKey: "attempt-expired" })
  const expired = await runWithAdapterRuntime(
    runtime({ ...developmentSecrets(), clientSecret: EXPIRED_CREDENTIAL_TOKEN }, "corr-expired"),
    () => canCapitalAdapter.submit(expiredJob),
  )
  assert.equal(expired.ok, false)
  assert.equal(expired.errorCode, "provider_unavailable")
  assert.match(expired.errorMessage ?? "", /expired/i)
  assert.equal(expired.externalRef, undefined)
  assert.equal(expired.correlationId, "corr-expired")
  assertNoSecrets(expired)
  await assert.rejects(
    () => runWithAdapterRuntime(
      runtime({ ...developmentSecrets(), password: EXPIRED_CREDENTIAL_TOKEN }),
      () => canCapitalAdapter.getStatus!(expiredJob),
    ),
    (error: { status?: number; code?: string; message?: string }) => (
      error.status === 503 && error.code === "provider_unavailable" && /expired/i.test(error.message ?? "")
    ),
  )
  assert.equal(listFixtureExternalRefs().includes("can_attempt-expired"), false)

  const acceptedJob = job({ attemptKey: "attempt-replay" })
  bindCanCapitalApplication("attempt-replay", application({ owners: [owner()] }))
  const first = await canCapitalAdapter.submit(acceptedJob)
  const replay = await runWithAdapterRuntime(
    runtime({ ...developmentSecrets(), apiKey: EXPIRED_CREDENTIAL_TOKEN }, "corr-replay"),
    () => canCapitalAdapter.submit(acceptedJob),
  )
  assert.equal(first.ok, true)
  assert.equal(replay.ok, true)
  assert.equal(replay.externalRef, first.externalRef)
  assert.equal(replay.correlationId, "corr-replay")
  assert.deepEqual(new Set(listFixtureExternalRefs()), new Set(["can_attempt-timeout", "can_attempt-replay"]))
  assertNoSecrets(replay)

  setCanCapitalFixture("can-capital:expired-credential")
  const destinationExpired = await canCapitalAdapter.submit(job({ attemptKey: "attempt-expired-destination" }))
  assert.equal(destinationExpired.ok, false)
  assert.equal(destinationExpired.externalRef, undefined)
})

test("MIC-139: outstanding documents and unknown outcomes stay status-only", async () => {
  assert.deepEqual(mapProviderStatus("Application Received"), { rawStatus: "Application Received", normalized: "submitted", unknown: false })
  assert.deepEqual(mapProviderStatus("Approved"), { rawStatus: "Approved", normalized: "approved", unknown: false })
  assert.deepEqual(mapProviderStatus("Funded"), { rawStatus: "Funded", normalized: "funded", unknown: false })
  assert.deepEqual(mapProviderStatus("Declined"), { rawStatus: "Declined", normalized: "declined", unknown: false })
  assert.equal(mapProviderStatus("CREDIT_COMMITTEE_HOLD").unknown, true)
  assert.equal(mapProviderStatus("CREDIT_COMMITTEE_HOLD").normalized, "unknown")
  assert.equal(Object.keys(PROVIDER_STATUS_MAP).length, 10)

  const pending = mapProviderStatus("Missing Information", ["application", "bank statements"])
  assert.equal(pending.normalized, "pending")
  assert.equal(pending.unknown, false)
  assert.match(pending.rawStatus, /application/)
  assert.match(pending.rawStatus, /bank statements/)

  const missingJob = job({
    attemptKey: "attempt-missing-info",
    route: {
      id: "route-can-missing",
      kind: "api",
      label: "API",
      destination: "can-capital:outstanding-documents",
      documentExceptions: [],
      active: true,
    },
  })
  const submitted = await canCapitalAdapter.submit(missingJob)
  assert.equal(submitted.ok, true)
  assert.equal(submitted.rawStatus, "Missing Information")
  const status = await canCapitalAdapter.getStatus!(missingJob)
  assert.equal(status.normalized, "pending")
  assert.equal(status.unknown, false)
  assert.equal(status.terms, undefined)
  assert.match(status.rawStatus, /outstanding document requests/)
  assert.match(status.rawStatus, /bank statements/)

  const declinedJob = job({
    attemptKey: "attempt-declined",
    route: {
      id: "route-can-declined",
      kind: "api",
      label: "API",
      destination: "can-capital:declined",
      documentExceptions: [],
      active: true,
    },
  })
  const declined = await canCapitalAdapter.submit(declinedJob)
  assert.equal(declined.ok, true)
  const declinedStatus = await canCapitalAdapter.getStatus!(declinedJob)
  assert.equal(declinedStatus.normalized, "declined")
  assert.equal(declinedStatus.terms, undefined)
  assert.equal(declinedStatus.unknown, false)

  const unknownJob = job({
    attemptKey: "attempt-unknown",
    route: {
      id: "route-can-unknown",
      kind: "api",
      label: "API",
      destination: "can-capital:unknown",
      documentExceptions: [],
      active: true,
    },
  })
  const unknownSubmit = await canCapitalAdapter.submit(unknownJob)
  assert.equal(unknownSubmit.ok, true)
  const unknownStatus = await canCapitalAdapter.getStatus!(unknownJob)
  assert.equal(unknownStatus.unknown, true)
  assert.equal(unknownStatus.normalized, "unknown")
  assert.equal(unknownStatus.rawStatus, "CREDIT_COMMITTEE_HOLD")
  assert.equal(unknownStatus.terms, undefined)
})
