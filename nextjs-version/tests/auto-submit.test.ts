import assert from "node:assert/strict"
import { test } from "node:test"
import { autoSubmitDecision, autoSubmitEnabled, enqueueAutoSubmitIfEnabled, getAutoSubmitSettings, processAutoSubmit, setAutoSubmitSettings, validateAutoSubmitSettings } from "../src/lib/mca/underwriting/auto-submit"
import { closeDatabaseForTests, getDatabase } from "../src/lib/mca/db"
import { createDeal, updateDealRecord } from "../src/lib/mca/deals/service"
import { storeDocument } from "../src/lib/mca/documents/service"
import { setDocumentStorageForTests } from "../src/lib/mca/documents/storage"
import { setDocumentScannerForTests } from "../src/lib/mca/documents/scanner"
import { queueSubmissions, setSubmissionCompletenessForTests } from "../src/lib/mca/submissions/queue"
import { findJobById, insertAttempt, insertJob, persistNewDestination, updateJobRecord, type JobInsert } from "../src/lib/mca/submissions/repository"
import { processJobDelivery } from "../src/lib/mca/submissions/outbox"
import { deliverSubmission } from "../src/lib/mca/submissions/deliver"
import { upsertAdapterCredential } from "../src/lib/mca/submissions/adapters/credentials"
import { setSandboxFunderEnabled } from "../src/lib/mca/sandbox/service"
import { createPostgresTestDatabase } from "./helpers/postgres-test-db.mjs"

test("auto-submit kill switch is strictly off by default", () => {
  const previous = process.env.MCA_AUTO_SUBMIT_ENABLED
  try {
    delete process.env.MCA_AUTO_SUBMIT_ENABLED
    assert.equal(autoSubmitEnabled(), false)
    process.env.MCA_AUTO_SUBMIT_ENABLED = "TRUE"
    assert.equal(autoSubmitEnabled(), false)
    process.env.MCA_AUTO_SUBMIT_ENABLED = "true"
    assert.equal(autoSubmitEnabled(), true)
  } finally {
    if (previous === undefined) delete process.env.MCA_AUTO_SUBMIT_ENABLED
    else process.env.MCA_AUTO_SUBMIT_ENABLED = previous
  }
})

test("settings validation rejects unsafe limits and deduplicates funders", () => {
  assert.throws(() => validateAutoSubmitSettings({ mode: "auto_submit", minMatchScore: -1, maxFundersPerDeal: 3, eligibleFunderIds: [] }))
  assert.throws(() => validateAutoSubmitSettings({ mode: "auto_submit", minMatchScore: 80, maxFundersPerDeal: 0, eligibleFunderIds: [] }))
  assert.deepEqual(validateAutoSubmitSettings({ mode: "score_only", minMatchScore: 80, maxFundersPerDeal: 3, eligibleFunderIds: ["a", "a"] }).eligibleFunderIds, ["a"])
})

test("score only never submits; auto-submit needs every guardrail", () => {
  const ready = { score: 90, eligible: true, allowedFunder: true, adapterReady: true, complete: true, capacity: true, minScore: 80 }
  assert.deepEqual(autoSubmitDecision({ ...ready, mode: "score_only" }), { outcome: "scored", reason: "score_only" })
  assert.deepEqual(autoSubmitDecision({ ...ready, mode: "auto_submit" }), { outcome: "submit", reason: "matched_and_ready" })
  assert.equal(autoSubmitDecision({ ...ready, mode: "auto_submit", score: 79 }).reason, "below_min_score")
  assert.equal(autoSubmitDecision({ ...ready, mode: "auto_submit", adapterReady: false }).reason, "adapter_not_ready")
  assert.equal(autoSubmitDecision({ ...ready, mode: "auto_submit", capacity: false }).reason, "max_funders_reached")
  assert.equal(autoSubmitDecision({ ...ready, mode: "auto_submit", complete: false }).reason, "deal_incomplete")
})

test("disabled flag and non-admin access reject settings writes before any external work", async () => {
  const previous = process.env.MCA_AUTO_SUBMIT_ENABLED
  const actor = { workspaceId: "workspace", userId: "user", membershipId: "member", role: "rep", managedMembershipIds: [], activeMembershipIds: [], source: "user", correlationId: "test" } as const
  const settings = { mode: "auto_submit", minMatchScore: 80, maxFundersPerDeal: 3, eligibleFunderIds: [] }
  try {
    delete process.env.MCA_AUTO_SUBMIT_ENABLED
    await assert.rejects(setAutoSubmitSettings(actor, settings), { code: "feature_unavailable" })
    process.env.MCA_AUTO_SUBMIT_ENABLED = "true"
    await assert.rejects(setAutoSubmitSettings(actor, settings), { code: "permission_denied" })
  } finally {
    if (previous === undefined) delete process.env.MCA_AUTO_SUBMIT_ENABLED
    else process.env.MCA_AUTO_SUBMIT_ENABLED = previous
  }
})

test("workspace off does not enqueue a score or submission job", async () => {
  const database = await createPostgresTestDatabase("auto_submit_off")
  const previous = { databaseUrl: process.env.DATABASE_URL, flag: process.env.MCA_AUTO_SUBMIT_ENABLED }
  try {
    process.env.DATABASE_URL = database.databaseUrl
    process.env.MCA_AUTO_SUBMIT_ENABLED = "true"
    const now = new Date().toISOString()
    await getDatabase().prepare(`INSERT INTO workspaces (id,name,timezone,seat_limit,feature_flags,page_visibility,action_visibility,created_at,updated_at)
      VALUES (?,?,'America/New_York',5,'{}','{}','{"createDeal":true}',?,?)`).run("auto-off-workspace", "Auto off", now, now)
    const settings = await getAutoSubmitSettings("auto-off-workspace")
    assert.equal(settings.mode, "off")
    await enqueueAutoSubmitIfEnabled({ workspaceId: "auto-off-workspace", userId: null, membershipId: null, role: "admin", managedMembershipIds: [], activeMembershipIds: [], source: "system", correlationId: "test" }, "deal", 0, 1)
    const jobs = await getDatabase().prepare<{ n: number }>("SELECT count(*)::integer AS n FROM mca_background_jobs WHERE workspace_id=?").get("auto-off-workspace")
    assert.equal(jobs?.n, 0)

    const actor = { workspaceId: "auto-off-workspace", userId: null, membershipId: null, role: "admin", managedMembershipIds: [], activeMembershipIds: [], source: "system", correlationId: "test" } as const
    await getDatabase().prepare(`INSERT INTO mca_funders (id,workspace_id,idempotency_key,legal_name,domains,products,active,contacts,routes,criteria_version,profile_version,created_at,updated_at)
      VALUES (?,?,'auto-funder','Auto Funder','[]','[]',1,'[]','[]',1,1,?,?)`).run("auto-funder", actor.workspaceId, now, now)
    await setAutoSubmitSettings(actor, { mode: "score_only", minMatchScore: 80, maxFundersPerDeal: 3, eligibleFunderIds: ["auto-funder"] })
    const deal = await createDeal(actor, { idempotencyKey: "auto-deal", legalName: "Auto Merchant LLC", entityType: "llc", address: { line1: "1 Main St", city: "New York", state: "NY", postalCode: "10001" }, startDate: "2020-01-01", industry: "restaurants", naicsCode: "722511", monthlyRevenue: 20_000, ficoScore: 680, requestedAmount: 50_000, requestedTermMonths: 12, fundingPurpose: "working capital" })
    await processAutoSubmit(actor, deal.deal.id, 0, "score_only", deal.deal.version)
    await processAutoSubmit(actor, deal.deal.id, 0, "score_only", deal.deal.version)
    const decisions = await getDatabase().prepare<{ outcome: string; n: number }>("SELECT outcome,count(*)::integer AS n FROM mca_auto_submit_decisions WHERE workspace_id=? AND deal_id=? GROUP BY outcome").all(actor.workspaceId, deal.deal.id)
    assert.deepEqual(decisions, [{ outcome: "scored", n: 1 }])
    const submissions = await getDatabase().prepare<{ n: number }>("SELECT count(*)::integer AS n FROM mca_submission_jobs WHERE workspace_id=? AND deal_id=?").get(actor.workspaceId, deal.deal.id)
    assert.equal(submissions?.n, 0)
  } finally {
    await closeDatabaseForTests()
    await database.close()
    if (previous.databaseUrl === undefined) delete process.env.DATABASE_URL
    else process.env.DATABASE_URL = previous.databaseUrl
    if (previous.flag === undefined) delete process.env.MCA_AUTO_SUBMIT_ENABLED
    else process.env.MCA_AUTO_SUBMIT_ENABLED = previous.flag
  }
})

test("sandbox automatic submission cannot dispatch without a broker-approved package", async () => {
  const database = await createPostgresTestDatabase("auto_submit_retry")
  const previous = { databaseUrl: process.env.DATABASE_URL, flag: process.env.MCA_AUTO_SUBMIT_ENABLED, backgroundJobs: process.env.MCA_BACKGROUND_JOBS, vercel: process.env.VERCEL }
  const actor = { workspaceId: "auto-retry-workspace", userId: null, membershipId: null, role: "admin", managedMembershipIds: [], activeMembershipIds: [], source: "system", correlationId: "test" } as const
  const bytes = new Uint8Array(Buffer.from("%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\n%%EOF\n"))
  const files = new Map<string, Uint8Array>()
  try {
    process.env.DATABASE_URL = database.databaseUrl
    process.env.MCA_AUTO_SUBMIT_ENABLED = "true"
    delete process.env.MCA_BACKGROUND_JOBS
    delete process.env.VERCEL
    setSubmissionCompletenessForTests(true)
    setDocumentStorageForTests({ name: "auto-test", async putImmutable(key, value) { files.set(key, value) }, async get(key) { return files.get(key)! } })
    setDocumentScannerForTests({ name: "auto-test", async scan() { return { status: "clean", provider: "auto-test", evidence: { engineVerified: true } } } })
    const now = new Date().toISOString()
    await getDatabase().prepare(`INSERT INTO workspaces (id,name,timezone,seat_limit,feature_flags,page_visibility,action_visibility,created_at,updated_at)
      VALUES (?,?,'America/New_York',5,'{}','{}','{"createDeal":true}',?,?)`).run(actor.workspaceId, "Auto retry", now, now)
    const sandbox = await setSandboxFunderEnabled(actor, true)
    const funderId = sandbox.funder!.id
    // Route the synthetic funder through the registered sandbox API adapter.
    await getDatabase().prepare("UPDATE mca_funders SET routes=? WHERE workspace_id=? AND id=?")
      .run(JSON.stringify(sandbox.funder!.routes.map(route => ({ ...route, destination: "sandbox" }))), actor.workspaceId, funderId)
    await upsertAdapterCredential(actor, { funderId, adapterSlug: "sandbox", environment: "development", secrets: {} })
    await setAutoSubmitSettings(actor, { mode: "auto_submit", minMatchScore: 0, maxFundersPerDeal: 1, eligibleFunderIds: [funderId] })
    const deal = (await createDeal(actor, { idempotencyKey: "auto-retry-deal", legalName: "Auto Retry Merchant LLC", entityType: "llc", address: { line1: "1 Main St", city: "New York", state: "NY", postalCode: "10001" }, startDate: "2020-01-01", industry: "restaurants", naicsCode: "722511", monthlyRevenue: 20_000, ficoScore: 680, requestedAmount: 50_000, requestedTermMonths: 12, fundingPurpose: "working capital", contactPhone: "2125550100", owners: [{ firstName: "Ada", lastName: "Cole", ownershipPercent: 100, isPrimary: true }] })).deal
    await getDatabase().prepare(`INSERT INTO mca_completeness_results
      (id,workspace_id,deal_id,ready,version,rule_snapshot,findings_json,findings_fingerprint,checked_at)
      VALUES (?,?,?,1,1,'{}','[]','ready',?)`).run("auto-retry-complete", actor.workspaceId, deal.id, now)

    await processAutoSubmit(actor, deal.id, 1, "auto_submit", deal.version)
    const before = await getDatabase().prepare<{ id: string; outcome: string; retry_count: number }>("SELECT id,outcome,retry_count FROM mca_auto_submit_decisions WHERE deal_id=? AND funder_id=?").get(deal.id, funderId)
    assert.ok(before)
    assert.equal(before.outcome, "failed")
    assert.equal(before.retry_count, 1)

    await storeDocument(actor, { dealId: deal.id, idempotencyKey: "auto-retry-doc", filename: "statement.pdf", mimeType: "application/pdf", bytes, category: "statement", source: "test" })
    const approvedRoute = { ...sandbox.funder!.routes[0], destination: "sandbox" }
    for (const [kind, destination] of [["email", "changed@example.test"], ["manual_portal", "https://example.test/portal"], ["custom_webhook", "https://example.test/hook"], ["api", "unavailable"]] as const) {
      const changedRoute = { ...approvedRoute, kind, destination }
      await getDatabase().prepare("UPDATE mca_funders SET routes=? WHERE workspace_id=? AND id=?")
        .run(JSON.stringify([changedRoute]), actor.workspaceId, funderId)
      const result = await queueSubmissions({ actor, dealId: deal.id, funderIds: [funderId], confirmationKey: `route-changed:${kind}`, expectedDealVersion: deal.version, expectedAutoApiRoute: approvedRoute })
      assert.equal(result.jobs[0].state, "preflight_failed")
      assert.equal((await getDatabase().prepare<{ n: number }>("SELECT count(*)::integer AS n FROM mca_submission_jobs WHERE confirmation_key=?").get(`route-changed:${kind}`))?.n, 0)
      // This is the second check, after queueDestination has already loaded a funder.
      await assert.rejects(persistNewDestination({ workspaceId: actor.workspaceId, dealId: deal.id, funderId,
        displayFunderName: "Sandbox", routeKind: "api", route: approvedRoute, state: "queued",
        confirmationKey: `route-race:${kind}`, attemptKey: `route-race:${kind}`, dealVersion: deal.version,
        expectedDealVersion: deal.version, expectedAutoApiRoute: approvedRoute, documentVersions: [], packageDocumentIds: [],
        preflightErrors: [], merchantIdentityKey: "route-race", packageFingerprint: "route-race", createdByUserId: null,
      }), { code: "auto_submit_route_changed" })
    }
    await getDatabase().prepare("UPDATE mca_funders SET routes=? WHERE workspace_id=? AND id=?")
      .run(JSON.stringify([approvedRoute]), actor.workspaceId, funderId)
    await getDatabase().prepare("UPDATE audit_events SET metadata=? WHERE workspace_id=? AND action='submission.duplicate_claim' AND resource_id=?")
      .run(JSON.stringify({ claimedAt: "2020-01-01T00:00:00.000Z", funderId, dealId: deal.id }), actor.workspaceId, deal.id)
    await getDatabase().prepare("UPDATE mca_submission_jobs SET created_at=? WHERE workspace_id=? AND deal_id=? AND funder_id=?")
      .run("2020-01-01T00:00:00.000Z", actor.workspaceId, deal.id, funderId)
    await processAutoSubmit(actor, deal.id, 1, "auto_submit", deal.version)
    const sent = await getDatabase().prepare<{ id: string; outcome: string; reason: string; retry_count: number; submission_job_id: string }>("SELECT id,outcome,reason,retry_count,submission_job_id FROM mca_auto_submit_decisions WHERE deal_id=? AND funder_id=?").get(deal.id, funderId)
    assert.ok(sent)
    assert.equal(sent.id, before.id)
    assert.equal(sent.outcome,"skipped")
    assert.equal(sent.reason,"manual_retry_required")
    const states=await getDatabase().prepare<{state:string}>("SELECT state FROM mca_submission_jobs WHERE workspace_id=? AND deal_id=?").all(actor.workspaceId,deal.id)
    assert.ok(states.length)
    assert.ok(states.every(job=>!["sent","declined","funded"].includes(job.state)))
    assert.equal((await getDatabase().prepare<{n:number}>("SELECT count(*)::int n FROM intake_submission_previews WHERE workspace_id=?").get(actor.workspaceId))?.n,0)
  } finally {
    setSubmissionCompletenessForTests()
    setDocumentStorageForTests()
    setDocumentScannerForTests()
    await closeDatabaseForTests()
    await database.close()
    if (previous.databaseUrl === undefined) delete process.env.DATABASE_URL
    else process.env.DATABASE_URL = previous.databaseUrl
    if (previous.flag === undefined) delete process.env.MCA_AUTO_SUBMIT_ENABLED
    else process.env.MCA_AUTO_SUBMIT_ENABLED = previous.flag
    if (previous.backgroundJobs === undefined) delete process.env.MCA_BACKGROUND_JOBS
    else process.env.MCA_BACKGROUND_JOBS = previous.backgroundJobs
    if (previous.vercel === undefined) delete process.env.VERCEL
    else process.env.VERCEL = previous.vercel
  }
})
