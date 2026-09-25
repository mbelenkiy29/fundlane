import "./helpers/business-auth";
import test, { after, before, beforeEach } from "node:test"
import assert from "node:assert/strict"
import { closeDatabaseForTests, getDatabase } from "../src/lib/mca/db"
import { createPostgresTestDatabase } from "./helpers/postgres-test-db.mjs"
import { decryptSensitive, hashOpaqueToken } from "../src/lib/mca/crypto"
import type { DealActor } from "../src/lib/mca/deals/schema"
import type { Role } from "../src/lib/mca/types"
import { createFunder } from "../src/lib/mca/funders/directory"
import { AppError } from "../src/lib/mca/errors"
import type { FunderAdapter, SubmissionJob } from "../src/lib/mca/submissions/contracts"
import { registerAdapter } from "../src/lib/mca/submissions/adapters/registry"
import {
  decryptAdapterCredential,
  requireAdapterRuntime,
  resolveAdapterSecrets,
  setAdapterEnvironmentForTests,
  upsertAdapterCredential,
} from "../src/lib/mca/submissions/adapters/credentials"
import {
  getStatusViaAdapter,
  submitViaAdapter,
} from "../src/lib/mca/submissions/adapters/framework"
import { GET as listGet, POST as listPost } from "../src/app/api/mca/adapters/route"
import { GET as credentialGet, PATCH as credentialPatch } from "../src/app/api/mca/adapters/[id]/route"
import { POST as statusPost } from "../src/app/api/mca/adapters/[id]/status/route"
import { POST as retryPost } from "../src/app/api/mca/adapters/[id]/retry/route"

let testDatabase: Awaited<ReturnType<typeof createPostgresTestDatabase>>

const DEV_SECRET = "dev-adapter-secret-never-leak"
const PROD_SECRET = "prod-adapter-secret-never-leak"
const OTHER_SECRET = "other-tenant-adapter-secret-never-leak"
const RATE_SECRET = "rate-limit-adapter-secret-never-leak"

const ids = {
  workspace: "workspace-adapters",
  otherWorkspace: "workspace-adapters-other",
  adminUser: "adapter-admin-user",
  adminMember: "adapter-admin-member",
  repUser: "adapter-rep-user",
  repMember: "adapter-rep-member",
  otherUser: "adapter-other-user",
  otherMember: "adapter-other-member",
}

const actor = (workspaceId = ids.workspace, role: Role | null = "admin"): DealActor => ({
  workspaceId,
  userId: workspaceId === ids.otherWorkspace ? ids.otherUser : role === "rep" ? ids.repUser : ids.adminUser,
  membershipId: workspaceId === ids.otherWorkspace ? ids.otherMember : role === "rep" ? ids.repMember : ids.adminMember,
  role,
  managedMembershipIds: [],
  activeMembershipIds: [],
  source: role ? "user" : "api_key",
  correlationId: `corr-${workspaceId}-${role ?? "key"}`,
})

let submitFunderId = ""
let statusFunderId = ""
let otherFunderId = ""
let sandboxFunderId = ""
const seenSecrets: string[] = []
const submitCounts = new Map<string, number>()

const submitOnly: FunderAdapter = {
  slug: "fixture-submit-only",
  readiness: "live",
  capabilities: { submit: true, statusPoll: false, webhooks: false, offers: false },
  validate: () => ({ ok: true }),
  submit: async (job) => {
    const runtime = requireAdapterRuntime()
    seenSecrets.push(runtime.secrets.apiKey ?? "")
    return {
      ok: true,
      correlationId: runtime.correlationId,
      externalRef: `ext-${job.attemptKey}`,
      rawStatus: "accepted",
    }
  },
}

const statusAdapter: FunderAdapter = {
  slug: "fixture-status",
  readiness: "live",
  capabilities: { submit: true, statusPoll: true, webhooks: true, offers: true },
  validate: () => ({ ok: true }),
  submit: async (job) => {
    const runtime = requireAdapterRuntime()
    seenSecrets.push(runtime.secrets.apiKey ?? "")
    const key = `${runtime.credentialId}:${job.attemptKey}`
    const count = (submitCounts.get(key) ?? 0) + 1
    submitCounts.set(key, count)
    if (runtime.secrets.apiKey === RATE_SECRET && count === 1) {
      throw new AppError(429, "rate_limited", "The funder API rate-limited this request.", {
        retryAfterSeconds: ["30"],
        retryAt: ["2099-01-01T00:00:30.000Z"],
        externalRef: [`ext-${job.attemptKey}`],
      })
    }
    return {
      ok: true,
      correlationId: runtime.correlationId,
      externalRef: `ext-${job.attemptKey}`,
      rawStatus: "accepted",
    }
  },
  getStatus: async (job) => {
    const runtime = requireAdapterRuntime()
    seenSecrets.push(runtime.secrets.apiKey ?? "")
    if (runtime.secrets.apiKey === RATE_SECRET) {
      throw new AppError(429, "rate_limited", "The funder API rate-limited this request.", {
        retryAfterSeconds: ["30"],
        retryAt: ["2099-01-01T00:00:30.000Z"],
        externalRef: [runtime.externalRef ?? `ext-${job.attemptKey}`],
      })
    }
    return {
      rawStatus: "pending",
      normalized: "pending",
      correlationId: runtime.correlationId,
      unknown: false,
    }
  },
  parseWebhook: async () => ({
    rawStatus: "pending",
    normalized: "pending",
    correlationId: "webhook",
    eventId: "evt-1",
    unknown: false,
  }),
}

function jobFor(funderId: string, destination: string, extra: Partial<SubmissionJob> = {}): SubmissionJob {
  return {
    id: extra.id ?? "job-adapter-1",
    workspaceId: extra.workspaceId ?? ids.workspace,
    dealId: extra.dealId ?? "deal-adapter-1",
    funderId,
    displayFunderName: extra.displayFunderName ?? "Fixture Funder",
    routeKind: "api",
    route: extra.route ?? {
      id: "route-api",
      kind: "api",
      label: "API",
      destination,
      documentExceptions: [],
      active: true,
    },
    state: extra.state ?? "sending",
    confirmationKey: extra.confirmationKey ?? "conf-adapter-1",
    attemptKey: extra.attemptKey ?? "attempt-adapter-1",
    dealVersion: extra.dealVersion ?? 1,
    documentVersions: extra.documentVersions ?? [],
    packageDocumentIds: extra.packageDocumentIds ?? [],
    preflightErrors: extra.preflightErrors ?? [],
    merchantIdentityKey: extra.merchantIdentityKey ?? `deal:${extra.dealId ?? "deal-adapter-1"}`,
    packageFingerprint: extra.packageFingerprint ?? "",
    createdAt: extra.createdAt ?? "2026-01-01T00:00:00.000Z",
    updatedAt: extra.updatedAt ?? "2026-01-01T00:00:00.000Z",
    ...extra,
  }
}

async function seed() {
  const database = getDatabase()
  const now = new Date().toISOString()
  const visibility = JSON.stringify({ dashboard: true, deals: true, users: true, reports: true, payments: true, workspace: true, integrations: true })
  const actions = JSON.stringify({ createDeal: true, exportDeals: true, inviteUsers: true, manageApiKeys: true, viewPaymentTable: true, viewCompanyFinancials: true })
  const flags = JSON.stringify({ reports: true, payments: true, integrations: true })
  for (const [id, name] of [[ids.workspace, "Adapters Test"], [ids.otherWorkspace, "Other Workspace"]] as const) {
    await database.prepare(`INSERT INTO workspaces (id,name,timezone,seat_limit,feature_flags,page_visibility,action_visibility,created_at,updated_at)
      VALUES (?, ?, 'America/New_York', 5, ?, ?, ?, ?, ?)`).run(id, name, flags, visibility, actions, now, now)
  }
  for (const [userId, memberId, email, workspaceId, role] of [
    [ids.adminUser, ids.adminMember, "adapters-admin@example.test", ids.workspace, "admin"],
    [ids.repUser, ids.repMember, "adapters-rep@example.test", ids.workspace, "rep"],
    [ids.otherUser, ids.otherMember, "adapters-other@example.test", ids.otherWorkspace, "admin"],
  ] as const) {
    await database.prepare(`INSERT INTO users (id,email,password_hash,name,phone,application_identifier,created_at,updated_at)
      VALUES (?, ?, NULL, ?, NULL, ?, ?, ?)`).run(userId, email, email, `APP-${userId.slice(-6)}`, now, now)
    await database.prepare(`INSERT INTO memberships (id,workspace_id,user_id,role,manager_membership_id,status,sender_association,created_at,updated_at)
      VALUES (?, ?, ?, ?, NULL, 'active', NULL, ?, ?)`).run(memberId, workspaceId, userId, role, now, now)
  }
  await database.prepare(`INSERT INTO sessions (id,user_id,membership_id,token_hash,expires_at,created_at,last_seen_at)
    VALUES (?, ?, ?, ?, '2099-01-01T00:00:00.000Z', ?, ?)`).run("adapter-admin-session", ids.adminUser, ids.adminMember, hashOpaqueToken("admin-session-token"), now, now)
  await database.prepare(`INSERT INTO sessions (id,user_id,membership_id,token_hash,expires_at,created_at,last_seen_at)
    VALUES (?, ?, ?, ?, '2099-01-01T00:00:00.000Z', ?, ?)`).run("adapter-rep-session", ids.repUser, ids.repMember, hashOpaqueToken("rep-session-token"), now, now)
  await database.prepare(`INSERT INTO sessions (id,user_id,membership_id,token_hash,expires_at,created_at,last_seen_at)
    VALUES (?, ?, ?, ?, '2099-01-01T00:00:00.000Z', ?, ?)`).run("adapter-other-session", ids.otherUser, ids.otherMember, hashOpaqueToken("other-session-token"), now, now)
  const addKey = async (id: string, secret: string, scopes: string[], workspaceId: string) => {
    await database.prepare(`INSERT INTO api_keys
      (id,workspace_id,name,prefix,secret_hash,scopes,expires_at,last_used_at,revoked_at,rate_limit_per_minute,created_by,created_at)
      VALUES (?, ?, ?, 'mca_test', ?, ?, NULL, NULL, NULL, 60, ?, ?)`).run(id, workspaceId, id, hashOpaqueToken(`mca_${secret}`), JSON.stringify(scopes), ids.adminUser, now)
  }
  await addKey("intake-key", "intake-secret", ["intake:write"], ids.workspace)
  await addKey("read-key", "read-secret", ["deals:read"], ids.workspace)
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

function params(id: string) {
  return { params: Promise.resolve({ id }) }
}

function assertNoSecret(value: unknown) {
  const text = typeof value === "string" ? value : JSON.stringify(value)
  assert.equal(text.includes(DEV_SECRET), false)
  assert.equal(text.includes(PROD_SECRET), false)
  assert.equal(text.includes(OTHER_SECRET), false)
  assert.equal(text.includes(RATE_SECRET), false)
  assert.equal(text.includes("credentialCipher"), false)
  assert.equal(text.includes("credential_cipher"), false)
}

before(async () => {
  testDatabase = await createPostgresTestDatabase("adapters_framework")
  Object.assign(process.env, testDatabase.env())
  registerAdapter(submitOnly)
  registerAdapter(statusAdapter)
  await seed()
  submitFunderId = (await createFunder(actor(), {
    idempotencyKey: "submit-only-funder",
    legalName: "Submit Only Capital LLC",
    nickname: "Submit Only",
    routes: [{ kind: "api", label: "API", destination: "fixture-submit-only", documentExceptions: [], active: true }],
  })).funder.id
  statusFunderId = (await createFunder(actor(), {
    idempotencyKey: "status-funder",
    legalName: "Status Capital LLC",
    nickname: "Status Cap",
    routes: [{ kind: "api", label: "API", destination: "fixture-status", documentExceptions: [], active: true }],
  })).funder.id
  otherFunderId = (await createFunder(actor(ids.otherWorkspace), {
    idempotencyKey: "other-funder",
    legalName: "Other Tenant Capital LLC",
    routes: [{ kind: "api", label: "API", destination: "fixture-submit-only", documentExceptions: [], active: true }],
  })).funder.id
  sandboxFunderId = (await createFunder(actor(), {
    idempotencyKey: "sandbox-funder",
    legalName: "Local Sandbox Funder LLC",
    routes: [{ kind: "api", label: "Sandbox", destination: "sandbox", documentExceptions: [], active: true }],
  })).funder.id
})

beforeEach(async () => {
  await getDatabase().execute("DELETE FROM mca_adapter_credentials")
  seenSecrets.length = 0
  submitCounts.clear()
  setAdapterEnvironmentForTests()
})

after(async () => {
  setAdapterEnvironmentForTests()
  await closeDatabaseForTests()
  await testDatabase.close()
})

test("sandbox adapter submits and polls with workspace config and no network credentials", async () => {
  const saved = await upsertAdapterCredential(actor(), {
    funderId: sandboxFunderId,
    adapterSlug: "sandbox",
    environment: "development",
    secrets: {},
  })
  assert.equal(saved.readiness, "sandbox")
  assert.equal(saved.hasCredential, true)
  assert.deepEqual((await resolveAdapterSecrets({ workspaceId: ids.workspace, funderId: sandboxFunderId, environment: "development", adapterSlug: "sandbox" }))?.secrets, {})
  assert.equal(await resolveAdapterSecrets({ workspaceId: ids.otherWorkspace, funderId: sandboxFunderId, environment: "development" }), undefined)
  const job = jobFor(sandboxFunderId, "sandbox", { attemptKey: "sandbox-attempt" })
  const result = await submitViaAdapter(job, { environment: "development" })
  assert.equal(result.ok, true)
  assert.match(result.externalRef ?? "", /^sandbox-/)
  const status = await getStatusViaAdapter(job, { environment: "development" })
  assert.equal(status.normalized, "submitted")
  assert.equal(status.rawStatus, "accepted")
  const blocked = await submitViaAdapter(job, { environment: "production" })
  assert.equal(blocked.ok, false)
  assert.match(blocked.errorMessage ?? "", /not verified for live delivery/)
})

test("MIC-124: submit-only adapter cannot status-check", async () => {
  const created = await listPost(cookieRequest("/api/mca/adapters", "admin-session-token", {
    method: "POST",
    body: JSON.stringify({
      funderId: submitFunderId,
      adapterSlug: "fixture-submit-only",
      environment: "development",
      secrets: { apiKey: DEV_SECRET, baseUrl: "https://sandbox.fixture-adapter.test" },
    }),
  }))
  assert.equal(created.status, 201)
  const credential = await created.json() as { id: string; capabilities: { statusPoll: boolean } }
  assert.equal(credential.capabilities.statusPoll, false)
  assertNoSecret(credential)

  const listed = await listGet(cookieRequest("/api/mca/adapters", "admin-session-token"))
  const listBody = await listed.json() as { credentials: Array<{ id: string; capabilities: { statusPoll: boolean } }>; adapters: Array<{ slug: string; capabilities: { statusPoll: boolean } }> }
  assert.equal(listBody.credentials[0]?.capabilities.statusPoll, false)
  assert.equal(listBody.adapters.find((item) => item.slug === "fixture-submit-only")?.capabilities.statusPoll, false)
  assertNoSecret(listBody)

  const status = await statusPost(cookieRequest(`/api/mca/adapters/${credential.id}/status`, "admin-session-token", {
    method: "POST",
    body: "{}",
  }), params(credential.id))
  assert.equal(status.status, 409)
  const statusBody = await status.json() as { error: { code: string; message: string } }
  assert.equal(statusBody.error.code, "capability_unsupported")
  assert.match(statusBody.error.message, /cannot check status/i)
  assertNoSecret(statusBody)

  await assert.rejects(
    () => getStatusViaAdapter(jobFor(submitFunderId, "fixture-submit-only"), { environment: "development" }),
    (error: { status?: number; code?: string }) => error.status === 409 && error.code === "capability_unsupported",
  )

  const submitted = await submitViaAdapter(jobFor(submitFunderId, "fixture-submit-only"), { environment: "development" })
  assert.equal(submitted.ok, true)
  assert.equal(submitted.externalRef, "ext-attempt-adapter-1")
  assert.deepEqual(seenSecrets, [DEV_SECRET])
})

test("MIC-124: production environment does not read the development cipher", async () => {
  const development = await upsertAdapterCredential(actor(), {
    funderId: submitFunderId,
    adapterSlug: "fixture-submit-only",
    environment: "development",
    secrets: { apiKey: DEV_SECRET, baseUrl: "https://sandbox.fixture-adapter.test" },
  })
  assert.equal(development.environment, "development")
  assert.equal(development.hasCredential, true)
  assertNoSecret(development)

  setAdapterEnvironmentForTests("production")
  const missingProduction = await submitViaAdapter(jobFor(submitFunderId, "fixture-submit-only"))
  assert.equal(missingProduction.ok, false)
  assert.equal(missingProduction.errorCode, "provider_unavailable")
  assert.match(missingProduction.errorMessage ?? "", /production credentials/i)
  assert.deepEqual(seenSecrets, [])
  assertNoSecret(missingProduction)

  const resolvedProduction = await resolveAdapterSecrets({
    workspaceId: ids.workspace,
    funderId: submitFunderId,
    environment: "production",
    adapterSlug: "fixture-submit-only",
  })
  assert.equal(resolvedProduction, undefined)

  const devRow = await getDatabase().prepare<{ id: string; credential_cipher: string; environment: string }>(
    "SELECT id, credential_cipher, environment FROM mca_adapter_credentials WHERE id = ?",
  ).get(development.id)
  assert.ok(devRow)
  assert.equal(devRow.environment, "development")
  assert.equal(devRow.credential_cipher.includes(DEV_SECRET), false)
  const payload = decryptAdapterCredential(ids.workspace, devRow.credential_cipher)
  assert.equal(payload?.environment, "development")
  assert.equal(payload?.secrets.apiKey, DEV_SECRET)
  assert.equal(decryptAdapterCredential(ids.otherWorkspace, devRow.credential_cipher), undefined)
  assert.throws(() => decryptSensitive(devRow.credential_cipher, ids.otherWorkspace))

  await getDatabase().prepare(`INSERT INTO mca_adapter_credentials
    (id, workspace_id, funder_id, adapter_slug, environment, credential_cipher, capabilities_json, active, updated_by_user_id, updated_at)
    VALUES (?, ?, ?, ?, 'production', ?, '{"submit":true,"statusPoll":false,"webhooks":false,"offers":false}', 1, ?, ?)`).run(
    "copied-dev-cipher",
    ids.workspace,
    submitFunderId,
    "fixture-submit-only",
    devRow.credential_cipher,
    ids.adminUser,
    new Date().toISOString(),
  )
  const copied = await resolveAdapterSecrets({
    workspaceId: ids.workspace,
    funderId: submitFunderId,
    environment: "production",
    adapterSlug: "fixture-submit-only",
  })
  assert.equal(copied, undefined)
  const copiedSubmit = await submitViaAdapter(jobFor(submitFunderId, "fixture-submit-only"), { environment: "production" })
  assert.equal(copiedSubmit.ok, false)
  assert.equal(copiedSubmit.errorCode, "provider_unavailable")
  assert.deepEqual(seenSecrets, [])

  const production = await upsertAdapterCredential(actor(), {
    funderId: submitFunderId,
    adapterSlug: "fixture-submit-only",
    environment: "production",
    secrets: { apiKey: PROD_SECRET, baseUrl: "https://api.fixture-adapter.test" },
  })
  assert.equal(production.id, "copied-dev-cipher")
  const produced = await submitViaAdapter(jobFor(submitFunderId, "fixture-submit-only"), { environment: "production" })
  assert.equal(produced.ok, true)
  assert.deepEqual(seenSecrets, [PROD_SECRET])
  const developed = await submitViaAdapter(jobFor(submitFunderId, "fixture-submit-only"), { environment: "development" })
  assert.equal(developed.ok, true)
  assert.deepEqual(seenSecrets, [PROD_SECRET, DEV_SECRET])

  const other = await upsertAdapterCredential(actor(ids.otherWorkspace), {
    funderId: otherFunderId,
    adapterSlug: "fixture-submit-only",
    environment: "production",
    secrets: { apiKey: OTHER_SECRET, baseUrl: "https://api.other-tenant.test" },
  })
  const otherSubmit = await submitViaAdapter(jobFor(otherFunderId, "fixture-submit-only", { workspaceId: ids.otherWorkspace }), { environment: "production" })
  assert.equal(otherSubmit.ok, true)
  assert.equal(seenSecrets.at(-1), OTHER_SECRET)
  const cross = await resolveAdapterSecrets({
    workspaceId: ids.workspace,
    funderId: otherFunderId,
    environment: "production",
    adapterSlug: "fixture-submit-only",
  })
  assert.equal(cross, undefined)
  const stolen = await credentialGet(cookieRequest(`/api/mca/adapters/${other.id}`, "admin-session-token"), params(other.id))
  assert.equal(stolen.status, 403)
  assertNoSecret(await stolen.json())
})

test("MIC-124: missing credential returns provider_unavailable", async () => {
  const result = await submitViaAdapter(jobFor(statusFunderId, "fixture-status"), { environment: "production" })
  assert.equal(result.ok, false)
  assert.equal(result.errorCode, "provider_unavailable")
  assert.match(result.errorMessage ?? "", /production credentials/i)
  assert.ok(result.correlationId)
  assert.deepEqual(seenSecrets, [])
  assertNoSecret(result)

  await upsertAdapterCredential(actor(), {
    funderId: statusFunderId,
    adapterSlug: "fixture-status",
    environment: "development",
    secrets: { apiKey: DEV_SECRET },
  })
  const stillMissing = await submitViaAdapter(jobFor(statusFunderId, "fixture-status"), { environment: "production" })
  assert.equal(stillMissing.ok, false)
  assert.equal(stillMissing.errorCode, "provider_unavailable")
  assert.deepEqual(seenSecrets, [])

  await assert.rejects(
    () => getStatusViaAdapter(jobFor(statusFunderId, "fixture-status"), { environment: "production" }),
    (error: { status?: number; code?: string }) => error.status === 503 && error.code === "provider_unavailable",
  )
})

test("MIC-124: admin-only credential writes", async () => {
  const repCreate = await listPost(cookieRequest("/api/mca/adapters", "rep-session-token", {
    method: "POST",
    body: JSON.stringify({
      funderId: submitFunderId,
      adapterSlug: "fixture-submit-only",
      environment: "development",
      secrets: { apiKey: DEV_SECRET },
    }),
  }))
  assert.equal(repCreate.status, 403)
  assert.equal((await repCreate.json() as { error: { code: string } }).error.code, "permission_denied")

  const intakeCreate = await listPost(bearerRequest("/api/mca/adapters", "intake-secret", {
    method: "POST",
    body: JSON.stringify({
      funderId: submitFunderId,
      adapterSlug: "fixture-submit-only",
      environment: "development",
      secrets: { apiKey: DEV_SECRET },
    }),
  }))
  assert.equal(intakeCreate.status, 403)

  const invalid = await listPost(cookieRequest("/api/mca/adapters", "admin-session-token", {
    method: "POST",
    body: JSON.stringify({
      funderId: submitFunderId,
      adapterSlug: "fixture-submit-only",
      environment: "development",
      secrets: {},
    }),
  }))
  assert.equal(invalid.status, 422)

  const created = await listPost(cookieRequest("/api/mca/adapters", "admin-session-token", {
    method: "POST",
    body: JSON.stringify({
      funderId: submitFunderId,
      adapterSlug: "fixture-submit-only",
      environment: "development",
      secrets: { apiKey: DEV_SECRET, baseUrl: "https://sandbox.fixture-adapter.test" },
    }),
  }))
  assert.equal(created.status, 201)
  const credential = await created.json() as { id: string; hasCredential: boolean }
  assert.equal(credential.hasCredential, true)
  assertNoSecret(credential)

  const updated = await credentialPatch(cookieRequest(`/api/mca/adapters/${credential.id}`, "admin-session-token", {
    method: "PATCH",
    body: JSON.stringify({ secrets: { apiKey: DEV_SECRET } }),
  }), params(credential.id))
  assert.equal(updated.status, 200)
  const same = await updated.json() as { id: string }
  assert.equal(same.id, credential.id)
  assertNoSecret(same)

  const listed = await listGet(bearerRequest("/api/mca/adapters", "read-secret"))
  assert.equal(listed.status, 200)
  const listBody = await listed.json() as { credentials: Array<{ id: string; hasCredential: boolean }>; canManage: boolean }
  assert.equal(listBody.credentials.some((item) => item.id === credential.id && item.hasCredential), true)
  assert.equal(listBody.canManage, false)
  assertNoSecret(listBody)

  const forged = await credentialPatch(cookieRequest(`/api/mca/adapters/${credential.id}`, "rep-session-token", {
    method: "PATCH",
    body: JSON.stringify({ secrets: { apiKey: "stolen" } }),
  }), params(credential.id))
  assert.equal(forged.status, 403)
  assertNoSecret(await forged.json())

  const audits = await getDatabase().prepare<{ metadata: string }>(
    "SELECT metadata FROM audit_events WHERE resource_type = 'adapter_credential'",
  ).all()
  for (const row of audits) assertNoSecret(row.metadata)
})

test("MIC-124: rate-limit retry preserves identity and redacts secrets", async () => {
  const created = await listPost(cookieRequest("/api/mca/adapters", "admin-session-token", {
    method: "POST",
    body: JSON.stringify({
      funderId: statusFunderId,
      adapterSlug: "fixture-status",
      environment: "development",
      secrets: { apiKey: RATE_SECRET, baseUrl: "https://sandbox.fixture-adapter.test" },
    }),
  }))
  const credential = await created.json() as { id: string; capabilities: { statusPoll: boolean } }
  assert.equal(credential.capabilities.statusPoll, true)

  const limited = await submitViaAdapter(jobFor(statusFunderId, "fixture-status", { attemptKey: "attempt-retry" }), {
    environment: "development",
    correlationId: "corr-retry-1",
  })
  assert.equal(limited.ok, false)
  assert.equal(limited.errorCode, "rate_limited")
  assert.equal(limited.externalRef, "ext-attempt-retry")
  assert.equal(limited.correlationId, "corr-retry-1")
  assertNoSecret(limited)

  const retried = await retryPost(cookieRequest(`/api/mca/adapters/${credential.id}/retry`, "admin-session-token", {
    method: "POST",
    body: JSON.stringify({
      action: "submit",
      correlationId: "corr-retry-1",
      externalRef: "ext-attempt-retry",
      job: { attemptKey: "attempt-retry", dealId: "deal-adapter-1" },
    }),
  }), params(credential.id))
  assert.equal(retried.status, 200)
  const retryBody = await retried.json() as { ok: boolean; credentialId: string; correlationId: string; externalRef?: string }
  assert.equal(retryBody.ok, true)
  assert.equal(retryBody.credentialId, credential.id)
  assert.equal(retryBody.correlationId, "corr-retry-1")
  assert.equal(retryBody.externalRef, "ext-attempt-retry")
  assertNoSecret(retryBody)

  const statusOk = await statusPost(cookieRequest(`/api/mca/adapters/${credential.id}/status`, "admin-session-token", {
    method: "POST",
    body: JSON.stringify({ correlationId: "corr-status-1" }),
  }), params(credential.id))
  assert.equal(statusOk.status, 429)
  const statusBody = await statusOk.json() as { error: { code: string; fieldErrors?: Record<string, string[]> } }
  assert.equal(statusBody.error.code, "rate_limited")
  assert.ok(statusBody.error.fieldErrors?.externalRef?.[0])
  assertNoSecret(statusBody)
})
