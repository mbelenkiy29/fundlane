import test, { beforeEach } from "node:test"
import assert from "node:assert/strict"
import { AppError } from "../../src/lib/mca/errors"
import type { AdapterRuntime } from "../../src/lib/mca/submissions/adapters/contracts"
import { runWithAdapterRuntime } from "../../src/lib/mca/submissions/adapters/credentials"
import { assertStatusPollAllowed } from "../../src/lib/mca/submissions/adapters/framework"
import {
  CHANNEL_PARTNERS_CAPITAL_CAPABILITIES,
  CHANNEL_PARTNERS_CAPITAL_EXPIRED_API_KEY,
  CHANNEL_PARTNERS_CAPITAL_SLUG,
  channelPartnersCapitalAdapter,
  lastChannelPartnersCapitalSubmission,
  mapChannelPartnersCapitalRequest,
  resetChannelPartnersCapitalAdapterForTests,
  setChannelPartnersCapitalFixtureForTests,
  validateChannelPartnersApplication,
} from "../../src/lib/mca/submissions/adapters/channel-partners-capital"
import {
  CHANNEL_PARTNERS_CAPITAL_ACCEPTED_APPLICATION,
  CHANNEL_PARTNERS_CAPITAL_MISSING_FIELDS_APPLICATION,
  accountIdForAttempt,
} from "../../src/lib/mca/submissions/adapters/channel-partners-capital/fixtures"
import type { SubmissionJob } from "../../src/lib/mca/submissions/contracts"

const SECRET = "cpc-dev-secret-never-leak"
const FULL_SSN = "123-45-6789"

function job(overrides: Partial<SubmissionJob> & { destination?: string } = {}): SubmissionJob {
  const { destination, route, ...rest } = overrides
  return {
    id: rest.id ?? "job-cpc-1",
    workspaceId: rest.workspaceId ?? "workspace-cpc",
    dealId: rest.dealId ?? "deal-cpc-1",
    funderId: rest.funderId ?? "funder-cpc-1",
    displayFunderName: rest.displayFunderName ?? "Channel Partners Capital",
    routeKind: "api",
    route: route ?? {
      id: "route-cpc",
      kind: "api",
      label: "Channel Partners Capital API",
      destination: destination ?? CHANNEL_PARTNERS_CAPITAL_SLUG,
      documentExceptions: [],
      active: true,
    },
    state: rest.state ?? "sending",
    confirmationKey: rest.confirmationKey ?? "conf-cpc-1",
    attemptKey: rest.attemptKey ?? "attempt-cpc-1",
    dealVersion: rest.dealVersion ?? 1,
    documentVersions: rest.documentVersions ?? [],
    packageDocumentIds: rest.packageDocumentIds ?? [],
    preflightErrors: rest.preflightErrors ?? [],
    createdAt: rest.createdAt ?? "2026-09-08T00:00:00.000Z",
    updatedAt: rest.updatedAt ?? "2026-09-08T00:00:00.000Z",
    ...rest,
  }
}

function runtime(secrets: AdapterRuntime["secrets"] = { apiKey: SECRET }): AdapterRuntime {
  return {
    credentialId: "cred-cpc-1",
    workspaceId: "workspace-cpc",
    funderId: "funder-cpc-1",
    adapterSlug: CHANNEL_PARTNERS_CAPITAL_SLUG,
    environment: "development",
    capabilities: CHANNEL_PARTNERS_CAPITAL_CAPABILITIES,
    secrets,
    correlationId: "corr-cpc-1",
  }
}

beforeEach(() => {
  resetChannelPartnersCapitalAdapterForTests()
})

test("channel partners capital rejects missing primary owner, state of incorporation, and NAICS", () => {
  const empty = channelPartnersCapitalAdapter.validate({})
  assert.equal(empty.ok, false)
  if (empty.ok) throw new Error("expected field errors")
  assert.equal(empty.fields.primaryOwner, "Add a primary owner with first name, last name, and ownership percentage.")
  assert.equal(empty.fields.stateOfIncorporation, "Enter the two-letter state of incorporation.")
  assert.equal(empty.fields.naicsCode, "Enter a 6-digit NAICS code.")

  const missing = channelPartnersCapitalAdapter.validate(CHANNEL_PARTNERS_CAPITAL_MISSING_FIELDS_APPLICATION)
  assert.equal(missing.ok, false)
  if (missing.ok) throw new Error("expected field errors")
  assert.deepEqual(Object.keys(missing.fields).sort(), ["naicsCode", "primaryOwner", "stateOfIncorporation"])
})

test("channel partners capital accepts a complete application and returns a durable Account ID", async () => {
  const accepted = channelPartnersCapitalAdapter.validate(CHANNEL_PARTNERS_CAPITAL_ACCEPTED_APPLICATION)
  assert.equal(accepted.ok, true)

  const highest = validateChannelPartnersApplication({
    ...CHANNEL_PARTNERS_CAPITAL_ACCEPTED_APPLICATION,
    owners: CHANNEL_PARTNERS_CAPITAL_ACCEPTED_APPLICATION.owners.map((owner) => ({ ...owner, isPrimary: false })),
  })
  assert.equal(highest.ok, true)
  if (!highest.ok) throw new Error("expected valid application")
  assert.equal(highest.value.primaryOwner.firstName, "Ava")
  assert.equal(highest.value.primaryOwner.ownershipPercent, 60)

  const result = await runWithAdapterRuntime(runtime(), () => channelPartnersCapitalAdapter.submit(job()))
  assert.equal(result.ok, true)
  assert.equal(result.externalRef, accountIdForAttempt("attempt-cpc-1"))
  assert.equal(result.rawStatus, "Sent")
  assert.equal(result.correlationId, "corr-cpc-1")
  assert.equal(result.fields?.documentReceipt, "none")

  const recorded = lastChannelPartnersCapitalSubmission()
  assert.ok(recorded)
  assert.equal(recorded.request.owner.firstName, "Ava")
  assert.equal(recorded.request.business.stateOfIncorporation, "DE")
  assert.equal(recorded.request.business.naics, "722511")
  assert.equal(recorded.request.workspaceId, "workspace-cpc")
  assert.equal(JSON.stringify(result).includes(SECRET), false)
})

test("channel partners capital acknowledges application and bank statement documents", async () => {
  const documentsJob = job({
    destination: `${CHANNEL_PARTNERS_CAPITAL_SLUG}:documents`,
    attemptKey: "attempt-cpc-docs",
    packageDocumentIds: ["doc-app", "doc-bank"],
    documentVersions: [
      { documentId: "doc-app", checksum: "sha-app", category: "application" },
      { documentId: "doc-bank", checksum: "sha-bank", category: "statement" },
      { documentId: "doc-excluded", checksum: "sha-other", category: "other_stip" },
    ],
  })
  const result = await channelPartnersCapitalAdapter.submit(documentsJob)
  assert.equal(result.ok, true)
  assert.equal(result.externalRef, accountIdForAttempt("attempt-cpc-docs"))
  assert.equal(result.rawStatus, "Sent")
  assert.equal(result.fields?.documentReceipt, "accepted")
  assert.equal(result.fields?.documentsReceived, "2")
  assert.equal(result.fields?.documentReceipts, "doc-app:application;doc-bank:statement")

  const recorded = lastChannelPartnersCapitalSubmission()
  assert.ok(recorded)
  assert.deepEqual(recorded.response.documents, [
    { documentId: "doc-app", category: "application", checksum: "sha-app", received: true },
    { documentId: "doc-bank", category: "statement", checksum: "sha-bank", received: true },
  ])
  assert.equal(JSON.stringify(recorded).includes("full document"), false)
})

test("channel partners capital timeouts, expired credentials, and attemptKey replay do not duplicate Account IDs", async () => {
  const timeout = await channelPartnersCapitalAdapter.submit(job({
    destination: `${CHANNEL_PARTNERS_CAPITAL_SLUG}:timeout`,
    attemptKey: "attempt-cpc-timeout",
  }))
  assert.equal(timeout.ok, false)
  assert.equal(timeout.errorCode, "provider_unavailable")
  assert.match(timeout.errorMessage ?? "", /timed out/i)
  assert.equal(timeout.externalRef, undefined)
  assert.equal(lastChannelPartnersCapitalSubmission(), undefined)

  const expiredFixture = await channelPartnersCapitalAdapter.submit(job({
    destination: `${CHANNEL_PARTNERS_CAPITAL_SLUG}:expired`,
    attemptKey: "attempt-cpc-expired",
  }))
  assert.equal(expiredFixture.ok, false)
  assert.equal(expiredFixture.errorCode, "expired_credential")
  assert.equal(expiredFixture.externalRef, undefined)

  const expiredRuntime = await runWithAdapterRuntime(
    runtime({ apiKey: CHANNEL_PARTNERS_CAPITAL_EXPIRED_API_KEY }),
    () => channelPartnersCapitalAdapter.submit(job({ attemptKey: "attempt-cpc-expired-runtime" })),
  )
  assert.equal(expiredRuntime.ok, false)
  assert.equal(expiredRuntime.errorCode, "expired_credential")
  assert.equal(JSON.stringify(expiredRuntime).includes(CHANNEL_PARTNERS_CAPITAL_EXPIRED_API_KEY), false)

  const missing = await channelPartnersCapitalAdapter.submit(job({
    destination: `${CHANNEL_PARTNERS_CAPITAL_SLUG}:missing-fields`,
    attemptKey: "attempt-cpc-missing",
  }))
  assert.equal(missing.ok, false)
  assert.equal(missing.errorCode, "validation_failed")
  assert.deepEqual(Object.keys(missing.fields ?? {}).sort(), ["naicsCode", "primaryOwner", "stateOfIncorporation"])
  assert.equal(missing.externalRef, undefined)

  const first = await runWithAdapterRuntime(runtime(), () => channelPartnersCapitalAdapter.submit(job({ attemptKey: "attempt-cpc-replay" })))
  setChannelPartnersCapitalFixtureForTests("timeout")
  const replay = await runWithAdapterRuntime(runtime({ apiKey: SECRET, clientSecret: "other-secret" }), () => (
    channelPartnersCapitalAdapter.submit(job({ attemptKey: "attempt-cpc-replay", id: "job-cpc-retry" }))
  ))
  assert.equal(first.ok, true)
  assert.equal(replay.ok, true)
  assert.equal(replay.externalRef, first.externalRef)
  assert.equal(replay.correlationId, first.correlationId)
  assert.equal(replay.rawStatus, "Sent")
  assert.equal(accountIdForAttempt("attempt-cpc-replay"), first.externalRef)

  setChannelPartnersCapitalFixtureForTests()
  const recovered = await channelPartnersCapitalAdapter.submit(job({
    destination: CHANNEL_PARTNERS_CAPITAL_SLUG,
    attemptKey: "attempt-cpc-timeout",
  }))
  assert.equal(recovered.ok, true)
  assert.equal(recovered.externalRef, accountIdForAttempt("attempt-cpc-timeout"))
})

test("channel partners capital is submit-only and keeps Sent pending email or manual outcomes", async () => {
  assert.equal(channelPartnersCapitalAdapter.slug, CHANNEL_PARTNERS_CAPITAL_SLUG)
  assert.deepEqual(channelPartnersCapitalAdapter.capabilities, {
    submit: true,
    statusPoll: false,
    webhooks: false,
    offers: false,
  })
  assert.equal(typeof channelPartnersCapitalAdapter.getStatus, "undefined")
  assert.equal(typeof channelPartnersCapitalAdapter.parseWebhook, "undefined")
  assert.throws(
    () => assertStatusPollAllowed(channelPartnersCapitalAdapter.capabilities, channelPartnersCapitalAdapter),
    (error: unknown) => error instanceof AppError && error.status === 409 && error.code === "capability_unsupported",
  )

  const mapped = mapChannelPartnersCapitalRequest(
    (() => {
      const validated = validateChannelPartnersApplication({
        ...CHANNEL_PARTNERS_CAPITAL_ACCEPTED_APPLICATION,
        owners: [{
          ...CHANNEL_PARTNERS_CAPITAL_ACCEPTED_APPLICATION.owners[0],
          ssn: FULL_SSN,
          identityLast4: undefined,
        }],
      })
      assert.equal(validated.ok, true)
      if (!validated.ok) throw new Error("expected mapped application")
      return validated.value
    })(),
    job(),
  )
  const serialized = JSON.stringify(mapped)
  assert.equal(serialized.includes(FULL_SSN), false)
  assert.equal(mapped.owner.ssnLast4, "6789")
  assert.equal(serialized.includes(SECRET), false)
})
