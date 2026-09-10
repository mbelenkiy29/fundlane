import "./helpers/business-auth";
import test, { after, before, beforeEach } from "node:test"
import assert from "node:assert/strict"
import { closeDatabaseForTests, getDatabase } from "../src/lib/mca/db"
import { createPostgresTestDatabase } from "./helpers/postgres-test-db.mjs"
import { decryptSensitive, hashOpaqueToken } from "../src/lib/mca/crypto"
import { createDeal, getDealForDocument } from "../src/lib/mca/deals/service"
import type { DealActor } from "../src/lib/mca/deals/schema"
import type { Role } from "../src/lib/mca/types"
import type { DataMerchCheck, DataMerchConfig } from "../src/lib/mca/datamerch/contracts"
import {
  getDataMerchConfig,
  getDealDataMerch,
  requireDataMerchActor,
  runDataMerchCheck,
  saveDataMerchConfig,
  setDataMerchFetchForTests,
} from "../src/lib/mca/datamerch/service"
import { GET as getConfig, POST as postConfig } from "../src/app/api/mca/datamerch/route"
import { GET as getDealChecks, POST as postDealCheck } from "../src/app/api/mca/datamerch/[dealId]/route"
import { claimCheck, completeClaimedCheck, insertCheck } from "../src/lib/mca/datamerch/repository"

let testDatabase: Awaited<ReturnType<typeof createPostgresTestDatabase>>

const ids = {
  workspace: "workspace-datamerch",
  otherWorkspace: "workspace-other",
  adminUser: "dm-admin-user",
  adminMember: "dm-admin-member",
  repUser: "dm-rep-user",
  repMember: "dm-rep-member",
  otherUser: "dm-other-user",
  otherMember: "dm-other-member",
}

const SECRET = "dm-live-secret-token-never-leak"
const FRESH_SECRET = "dm-rotated-secret-token-never-leak"

const actor = (workspaceId = ids.workspace, role: Role | null = "admin"): DealActor => ({
  workspaceId,
  userId: workspaceId === ids.otherWorkspace ? ids.otherUser : role === "rep" ? ids.repUser : ids.adminUser,
  membershipId: null,
  role,
  managedMembershipIds: [],
  activeMembershipIds: [],
  source: role ? "user" : "api_key",
  correlationId: `corr-${workspaceId}-${role ?? "key"}`,
})

type CapturedRequest = { url: string; authorization: string | null; method: string }
let captured: CapturedRequest[] = []
let fixtureMode: "records" | "empty" | "unauthorized" | "network" = "records"

function merchantsPayload() {
  return {
    merchants: [
      {
        id: "m-harbor",
        name: "Harbor Coffee LLC",
        ein: "12-3456789",
        risk_level: "high",
        records: [
          { category: "Default", notes: "Merchant defaulted on an advance.", funder: "Xpress Capital", created_at: "2025-12-14" },
          { category: "Slow pay", notes: "ACH returned twice.", funder: "North Funder", created_at: "2025-11-01" },
        ],
      },
    ],
  }
}

function fixtureFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = String(input)
  const headers = new Headers(init?.headers)
  captured.push({ url, authorization: headers.get("authorization"), method: init?.method ?? "GET" })
  if (fixtureMode === "network") return Promise.reject(new Error("connect ECONNREFUSED"))
  if (fixtureMode === "unauthorized") return Promise.resolve(new Response(JSON.stringify({ error: "invalid_token" }), { status: 401, headers: { "content-type": "application/json" } }))
  if (fixtureMode === "empty") return Promise.resolve(Response.json({ merchants: [] }))
  return Promise.resolve(Response.json(merchantsPayload()))
}

async function seed() {
  const database = getDatabase()
  const now = new Date().toISOString()
  const visibility = JSON.stringify({ dashboard: true, deals: true, users: true, reports: true, payments: true, workspace: true, integrations: true })
  const actions = JSON.stringify({ createDeal: true, exportDeals: true, inviteUsers: true, manageApiKeys: true, viewPaymentTable: true, viewCompanyFinancials: true })
  const flags = JSON.stringify({ reports: true, payments: true, integrations: true })
  for (const [id, name] of [[ids.workspace, "Data Merch Test"], [ids.otherWorkspace, "Other Workspace"]] as const) {
    await database.prepare(`INSERT INTO workspaces (id,name,timezone,seat_limit,feature_flags,page_visibility,action_visibility,created_at,updated_at)
      VALUES (?, ?, 'America/New_York', 5, ?, ?, ?, ?, ?)`).run(id, name, flags, visibility, actions, now, now)
  }
  for (const [userId, memberId, email, workspaceId, role] of [
    [ids.adminUser, ids.adminMember, "datamerch-admin@example.test", ids.workspace, "admin"],
    [ids.repUser, ids.repMember, "datamerch-rep@example.test", ids.workspace, "rep"],
    [ids.otherUser, ids.otherMember, "datamerch-other@example.test", ids.otherWorkspace, "admin"],
  ] as const) {
    await database.prepare(`INSERT INTO users (id,email,password_hash,name,phone,application_identifier,created_at,updated_at)
      VALUES (?, ?, NULL, ?, NULL, ?, ?, ?)`).run(userId, email, email, `APP-${userId.slice(-6)}`, now, now)
    await database.prepare(`INSERT INTO memberships (id,workspace_id,user_id,role,manager_membership_id,status,sender_association,created_at,updated_at)
      VALUES (?, ?, ?, ?, NULL, 'active', NULL, ?, ?)`).run(memberId, workspaceId, userId, role, now, now)
  }
  await database.prepare(`INSERT INTO sessions (id,user_id,membership_id,token_hash,expires_at,created_at,last_seen_at)
    VALUES (?, ?, ?, ?, '2099-01-01T00:00:00.000Z', ?, ?)`).run("dm-admin-session", ids.adminUser, ids.adminMember, hashOpaqueToken("admin-session-token"), now, now)
  await database.prepare(`INSERT INTO sessions (id,user_id,membership_id,token_hash,expires_at,created_at,last_seen_at)
    VALUES (?, ?, ?, ?, '2099-01-01T00:00:00.000Z', ?, ?)`).run("dm-rep-session", ids.repUser, ids.repMember, hashOpaqueToken("rep-session-token"), now, now)
  await database.prepare(`INSERT INTO sessions (id,user_id,membership_id,token_hash,expires_at,created_at,last_seen_at)
    VALUES (?, ?, ?, ?, '2099-01-01T00:00:00.000Z', ?, ?)`).run("dm-other-session", ids.otherUser, ids.otherMember, hashOpaqueToken("other-session-token"), now, now)
  const addKey = async (id: string, secret: string, scopes: string[], workspaceId: string) => {
    await database.prepare(`INSERT INTO api_keys
      (id,workspace_id,name,prefix,secret_hash,scopes,expires_at,last_used_at,revoked_at,rate_limit_per_minute,created_by,created_at)
      VALUES (?, ?, ?, 'mca_test', ?, ?, NULL, NULL, NULL, 60, ?, ?)`).run(id, workspaceId, id, hashOpaqueToken(`mca_${secret}`), JSON.stringify(scopes), ids.adminUser, now)
  }
  await addKey("intake-key", "intake-secret", ["intake:write"], ids.workspace)
  await addKey("read-key", "read-secret", ["deals:read"], ids.workspace)
  await addKey("write-key", "write-secret", ["deals:write"], ids.workspace)
}

function cookieRequest(path: string, token: string, init: RequestInit = {}) {
  return new Request(`http://localhost${path}`, {
    ...init,
    headers: {
      cookie: `mca_session=${token}`,
      origin: "http://localhost",
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...init.headers,
    },
  })
}

function bearerRequest(path: string, secret: string, init: RequestInit = {}) {
  return new Request(`http://localhost${path}`, {
    ...init,
    headers: {
      authorization: `Bearer mca_${secret}`,
      origin: "http://localhost",
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...init.headers,
    },
  })
}

function params(dealId: string) {
  return { params: Promise.resolve({ dealId }) }
}

async function enable(workspaceId = ids.workspace, credential = SECRET, extra: { credentialExpiresAt?: string; enabled?: boolean } = {}) {
  return saveDataMerchConfig(actor(workspaceId), {
    enabled: extra.enabled ?? true,
    credential,
    credentialExpiresAt: extra.credentialExpiresAt,
  })
}

function assertNoSecret(value: unknown) {
  const text = typeof value === "string" ? value : JSON.stringify(value)
  assert.equal(text.includes(SECRET), false)
  assert.equal(text.includes(FRESH_SECRET), false)
  assert.equal(/Bearer\s+dm-/i.test(text), false)
}

before(async () => {
  testDatabase = await createPostgresTestDatabase("datamerch")
  Object.assign(process.env, testDatabase.env())
  await seed()
  setDataMerchFetchForTests(fixtureFetch)
  await getDataMerchConfig(actor())
})

beforeEach(async () => {
  captured = []
  fixtureMode = "records"
  await getDatabase().execute("DELETE FROM mca_datamerch_checks")
  await getDatabase().execute("DELETE FROM mca_datamerch_config")
})

after(async () => {
  setDataMerchFetchForTests()
  await closeDatabaseForTests()
  await testDatabase.close()
})

test("MIC-180: credential is encrypted workspace-bound and never returned", async () => {
  const config = await enable()
  assert.equal(config.enabled, true)
  assert.equal(config.hasCredential, true)
  assert.equal("credential" in config, false)
  assertNoSecret(config)
  assertNoSecret(await getDataMerchConfig(actor()))

  const row = await getDatabase().prepare<{ credential_cipher: string }>("SELECT credential_cipher FROM mca_datamerch_config WHERE workspace_id = ?").get(ids.workspace)
  assert.ok(row)
  assert.equal(row.credential_cipher.includes(SECRET), false)
  assert.equal(decryptSensitive(row.credential_cipher, ids.workspace), SECRET)
  assert.throws(() => decryptSensitive(row.credential_cipher, ids.otherWorkspace))
})

test("MIC-180: disabled config hides run and API returns 409 datamerch_disabled", async () => {
  const deal = (await createDeal(actor(), { idempotencyKey: "disabled-deal", legalName: "Harbor Coffee LLC", ein: "12-3456789" })).deal
  await saveDataMerchConfig(actor(), { enabled: false, credential: SECRET })

  const view = await getDealDataMerch(actor(), deal.id)
  assert.equal(view.config.enabled, false)
  assert.equal(view.canRun, false)

  await assert.rejects(
    () => runDataMerchCheck(actor(), deal.id),
    (error: { code?: string; status?: number }) => error.code === "datamerch_disabled" && error.status === 409,
  )
  assert.equal(captured.length, 0)

  const response = await postDealCheck(
    bearerRequest(`/api/mca/datamerch/${deal.id}`, "write-secret", { method: "POST", body: "{}" }),
    params(deal.id),
  )
  assert.equal(response.status, 409)
  const body = await response.json() as { error: { code: string } }
  assert.equal(body.error.code, "datamerch_disabled")
  assertNoSecret(body)
})

test("MIC-180: run queries EIN when present and legal name otherwise", async () => {
  await enable()
  const withEin = (await createDeal(actor(), { idempotencyKey: "ein-deal", legalName: "Harbor Coffee LLC", ein: "12-3456789" })).deal
  const unmasked = await getDealForDocument(actor(), withEin.id)
  assert.equal(unmasked.ein, "12-3456789")
  assert.equal(withEin.ein?.includes("12-3456789"), false)

  const einCheck = await runDataMerchCheck(actor(), withEin.id)
  assert.equal(einCheck.status, "records")
  assert.equal(einCheck.recordCount, 2)
  assert.equal(einCheck.dealVersion, unmasked.version)
  assert.match(captured[0].url, /^https:\/\/api\.datamerch\.com\/v2\/merchants\?/)
  assert.equal(new URL(captured[0].url).searchParams.get("q"), "12-3456789")
  assert.equal(captured[0].authorization, `Bearer ${SECRET}`)

  const named = (await createDeal(actor(), { idempotencyKey: "name-deal", legalName: "Named Merchant LLC" })).deal
  captured = []
  const nameCheck = await runDataMerchCheck(actor(), named.id)
  assert.equal(nameCheck.status, "records")
  assert.equal(new URL(captured[0].url).searchParams.get("q"), "Named Merchant LLC")
})

test("MIC-180: no_result versus failed persist with deal version", async () => {
  await enable()
  const deal = (await createDeal(actor(), { idempotencyKey: "status-deal", legalName: "Status Merchant LLC", ein: "98-7654321" })).deal
  const version = (await getDealForDocument(actor(), deal.id)).version

  fixtureMode = "empty"
  const empty = await runDataMerchCheck(actor(), deal.id)
  assert.equal(empty.status, "no_result")
  assert.equal(empty.recordCount, 0)
  assert.equal(empty.dealVersion, version)

  fixtureMode = "network"
  const failed = await runDataMerchCheck({ ...actor(), correlationId: "corr-network" }, deal.id)
  assert.equal(failed.status, "failed")
  assert.equal(failed.dealVersion, version)
  assertNoSecret(failed)

  const listed = await getDealDataMerch(actor(), deal.id)
  assert.equal(listed.checks.length, 2)
  assert.equal(listed.latest?.id, failed.id)
})

test("MIC-180: expired credential is recoverable and secrets stay out of the body", async () => {
  await enable(ids.workspace, SECRET, { credentialExpiresAt: "2020-01-01T00:00:00.000Z" })
  const deal = (await createDeal(actor(), { idempotencyKey: "expired-deal", legalName: "Expired Merchant LLC", ein: "12-3456789" })).deal

  const expired = await runDataMerchCheck(actor(), deal.id)
  assert.equal(expired.status, "failed")
  assert.match(expired.resultSummary ?? "", /expir/i)
  assert.equal(captured.length, 0)
  assertNoSecret(expired)
  const afterExpiry = await getDataMerchConfig(actor())
  assert.equal(afterExpiry.hasCredential, true)
  assert.match(afterExpiry.lastDiagnostic ?? "", /expir/i)
  assertNoSecret(afterExpiry)

  await saveDataMerchConfig(actor(), { enabled: true, credential: FRESH_SECRET, credentialExpiresAt: "2099-01-01T00:00:00.000Z" })
  const recovered = await runDataMerchCheck({ ...actor(), correlationId: "corr-recovered" }, deal.id)
  assert.equal(recovered.status, "records")
  assert.equal(captured.length, 1)
  assert.equal(captured[0].authorization, `Bearer ${FRESH_SECRET}`)
  assertNoSecret(recovered)

  fixtureMode = "unauthorized"
  const unauthorized = await runDataMerchCheck({ ...actor(), correlationId: "corr-401" }, deal.id)
  assert.equal(unauthorized.status, "failed")
  assertNoSecret(unauthorized)
  assert.match((await getDataMerchConfig(actor())).lastDiagnostic ?? "", /expir|unauthor/i)
})

test("MIC-180: missing EIN and legal name is a validation error", async () => {
  await enable()
  const deal = (await createDeal(actor(), { idempotencyKey: "blank-deal" })).deal
  await assert.rejects(
    () => runDataMerchCheck(actor(), deal.id),
    (error: { code?: string; status?: number }) => error.code === "validation_failed" && error.status === 422,
  )
  assert.equal(captured.length, 0)
})

test("MIC-180: cross-workspace access is 404 and retries keep the same check id", async () => {
  await enable()
  const deal = (await createDeal(actor(), { idempotencyKey: "tenant-deal", legalName: "Tenant Merchant LLC", ein: "12-3456789" })).deal
  await assert.rejects(
    () => runDataMerchCheck(actor(ids.otherWorkspace), deal.id),
    (error: { code?: string; status?: number }) => error.code === "deal_not_found" && error.status === 404,
  )
  await assert.rejects(getDealDataMerch(actor(ids.otherWorkspace), deal.id), (error: { code?: string }) => error.code === "deal_not_found")

  const first = await runDataMerchCheck({ ...actor(), correlationId: "corr-retry" }, deal.id)
  const replay = await runDataMerchCheck({ ...actor(), correlationId: "corr-retry" }, deal.id)
  assert.equal(replay.id, first.id)
  assert.equal(captured.length, 1)
})

test("MIC-180: concurrent retries claim one provider lookup and one completion audit", async () => {
  await enable()
  const deal = (await createDeal(actor(), { idempotencyKey: "concurrent-deal", legalName: "Concurrent Merchant LLC", ein: "12-3456789" })).deal
  const concurrentActor = { ...actor(), correlationId: "corr-concurrent" }
  let releaseLookup!: () => void
  let markLookupStarted!: () => void
  const lookupStarted = new Promise<void>((resolve) => { markLookupStarted = resolve })
  const lookupRelease = new Promise<void>((resolve) => { releaseLookup = resolve })
  let providerCalls = 0
  setDataMerchFetchForTests(async () => {
    providerCalls += 1
    markLookupStarted()
    await lookupRelease
    return Response.json(merchantsPayload())
  })

  try {
    const claimedRun = runDataMerchCheck(concurrentActor, deal.id)
    await lookupStarted
    const concurrentReplay = await runDataMerchCheck(concurrentActor, deal.id)
    assert.equal(concurrentReplay.status, "queued")
    assert.equal(providerCalls, 1)

    releaseLookup()
    const completed = await claimedRun
    assert.equal(completed.id, concurrentReplay.id)
    assert.equal(completed.status, "records")
    assert.equal(providerCalls, 1)

    const row = await getDatabase().prepare<{ lease_token: string | null; lease_expires_at: string | null }>(
      "SELECT lease_token, lease_expires_at FROM mca_datamerch_checks WHERE id = ?",
    ).get(completed.id)
    assert.deepEqual(row, { lease_token: null, lease_expires_at: null })
    const audit = await getDatabase().prepare<{ count: number }>(
      "SELECT COUNT(*)::integer AS count FROM audit_events WHERE workspace_id = ? AND action = 'datamerch.check_run' AND correlation_id = ?",
    ).get(ids.workspace, concurrentActor.correlationId)
    assert.equal(audit?.count, 1)
  } finally {
    releaseLookup()
    setDataMerchFetchForTests(fixtureFetch)
  }
})

test("MIC-180: an expired claim can be recovered and its stale completion is fenced", async () => {
  const deal = (await createDeal(actor(), { idempotencyKey: "claim-fence-deal", legalName: "Claim Fence LLC" })).deal
  const queued = await insertCheck({
    id: "datamerch-claim-fence",
    workspaceId: ids.workspace,
    dealId: deal.id,
    dealVersion: deal.version,
    status: "queued",
    correlationId: "corr-claim-fence",
    recordCount: 0,
    queryKind: "legal_name",
    createdAt: new Date().toISOString(),
  })
  const first = await claimCheck({
    id: queued.id,
    workspaceId: ids.workspace,
    leaseToken: "first-claim",
    claimedAt: "1999-01-01T00:00:00.000Z",
    leaseExpiresAt: "2000-01-01T00:00:00.000Z",
  })
  assert.equal(first.acquired, true)
  const recovered = await claimCheck({
    id: queued.id,
    workspaceId: ids.workspace,
    leaseToken: "recovered-claim",
    claimedAt: new Date().toISOString(),
    leaseExpiresAt: "2099-01-01T00:00:00.000Z",
  })
  assert.equal(recovered.acquired, true)

  const stale = await completeClaimedCheck({
    id: queued.id,
    workspaceId: ids.workspace,
    leaseToken: "first-claim",
    status: "failed",
    resultSummary: "stale result",
    recordCount: 0,
  })
  assert.equal(stale, undefined)
  const completed = await completeClaimedCheck({
    id: queued.id,
    workspaceId: ids.workspace,
    leaseToken: "recovered-claim",
    status: "no_result",
    resultSummary: "No Data Merch records were found.",
    recordCount: 0,
  })
  assert.equal(completed?.status, "no_result")
  assert.equal(completed?.resultSummary, "No Data Merch records were found.")
})

test("MIC-180: admin configures, deals:write runs, deals:read views, intake:write is 403", async () => {
  const deal = (await createDeal(actor(), { idempotencyKey: "scope-deal", legalName: "Scope Merchant LLC", ein: "12-3456789" })).deal

  const intakeGet = await getConfig(bearerRequest("/api/mca/datamerch", "intake-secret"))
  assert.equal(intakeGet.status, 403)

  const repConfig = await postConfig(cookieRequest("/api/mca/datamerch", "rep-session-token", {
    method: "POST",
    body: JSON.stringify({ enabled: true, credential: SECRET }),
  }))
  assert.equal(repConfig.status, 403)

  const saved = await postConfig(cookieRequest("/api/mca/datamerch", "admin-session-token", {
    method: "POST",
    body: JSON.stringify({ enabled: true, credential: SECRET, testConnection: true }),
  }))
  assert.equal(saved.status, 200)
  const savedBody = await saved.json() as DataMerchConfig
  assert.equal(savedBody.enabled, true)
  assert.equal(savedBody.hasCredential, true)
  assertNoSecret(savedBody)

  await assert.rejects(requireDataMerchActor(bearerRequest(`/api/mca/datamerch/${deal.id}`, "intake-secret"), "read"), (error: { code?: string }) => error.code === "scope_required")
  await assert.rejects(requireDataMerchActor(bearerRequest(`/api/mca/datamerch/${deal.id}`, "intake-secret"), "write"), (error: { code?: string }) => error.code === "scope_required")
  assert.equal((await requireDataMerchActor(bearerRequest(`/api/mca/datamerch/${deal.id}`, "read-secret"), "read")).workspaceId, ids.workspace)

  const view = await getDealChecks(bearerRequest(`/api/mca/datamerch/${deal.id}`, "read-secret"), params(deal.id))
  assert.equal(view.status, 200)
  const viewBody = await view.json() as { canRun: boolean; checks: DataMerchCheck[] }
  assert.equal(viewBody.canRun, true)
  assert.equal(viewBody.checks.length, 0)

  const deniedRun = await postDealCheck(bearerRequest(`/api/mca/datamerch/${deal.id}`, "read-secret", { method: "POST", body: "{}" }), params(deal.id))
  assert.equal(deniedRun.status, 403)

  const ran = await postDealCheck(bearerRequest(`/api/mca/datamerch/${deal.id}`, "write-secret", { method: "POST", body: "{}" }), params(deal.id))
  assert.equal(ran.status, 200)
  const ranBody = await ran.json() as DataMerchCheck
  assert.equal(ranBody.status, "records")
  assert.equal(ranBody.recordCount, 2)
  assertNoSecret(ranBody)
})
