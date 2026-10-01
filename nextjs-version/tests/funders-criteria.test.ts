import "./helpers/business-auth";
import test, { after, before } from "node:test"
import assert from "node:assert/strict"
import { closeDatabaseForTests, getDatabase } from "../src/lib/mca/db"
import { createPostgresTestDatabase } from "./helpers/postgres-test-db.mjs"
import { hashOpaqueToken } from "../src/lib/mca/crypto"
import type { DealActor } from "../src/lib/mca/deals/schema"
import type { Role } from "../src/lib/mca/types"
import { createFunder, getFunder } from "../src/lib/mca/funders/directory"
import {
  convertRevenueThreshold,
  deleteIndustryAlias,
  listFunderCriteria,
  listIndustryAliases,
  publishFunderCriteria,
  resolveIndustry,
  upsertIndustryAlias,
} from "../src/lib/mca/funders/criteria"
import { GET as criteriaGet, PUT as criteriaPut } from "../src/app/api/mca/funders/criteria/[funderId]/route"
import { GET as aliasesGet, POST as aliasesPost } from "../src/app/api/mca/funders/criteria/aliases/route"
import { DELETE as aliasDelete, PATCH as aliasPatch } from "../src/app/api/mca/funders/criteria/aliases/[id]/route"

let testDatabase: Awaited<ReturnType<typeof createPostgresTestDatabase>>

const ids = {
  workspace: "workspace-criteria",
  otherWorkspace: "workspace-criteria-other",
  adminUser: "criteria-admin-user",
  adminMember: "criteria-admin-member",
  repUser: "criteria-rep-user",
  repMember: "criteria-rep-member",
  otherUser: "criteria-other-user",
  otherMember: "criteria-other-member",
}

const actor = (workspaceId = ids.workspace, role: Role | null = "admin"): DealActor => ({
  workspaceId,
  userId: workspaceId === ids.otherWorkspace ? ids.otherUser : role === "rep" ? ids.repUser : ids.adminUser,
  membershipId: workspaceId === ids.otherWorkspace ? ids.otherMember : role === "rep" ? ids.repMember : ids.adminMember,
  role,
  managedMembershipIds: [],
  activeMembershipIds: [],
  source: role ? "user" : "api_key",
  correlationId: `corr-criteria-${workspaceId}-${role ?? "key"}`,
})

async function seed() {
  const database = getDatabase()
  const now = new Date().toISOString()
  const visibility = JSON.stringify({ dashboard: true, deals: true, users: true, reports: true, payments: true, workspace: true, integrations: true })
  const actions = JSON.stringify({ createDeal: true, exportDeals: true, inviteUsers: true, manageApiKeys: true, viewPaymentTable: true, viewCompanyFinancials: true })
  const flags = JSON.stringify({ reports: true, payments: true, integrations: true })
  for (const [id, name] of [[ids.workspace, "Criteria Test"], [ids.otherWorkspace, "Other Criteria"]] as const) {
    await database.prepare(`INSERT INTO workspaces (id,name,timezone,seat_limit,feature_flags,page_visibility,action_visibility,created_at,updated_at)
      VALUES (?, ?, 'America/New_York', 5, ?, ?, ?, ?, ?)`).run(id, name, flags, visibility, actions, now, now)
  }
  for (const [userId, memberId, email, workspaceId, role] of [
    [ids.adminUser, ids.adminMember, "criteria-admin@example.test", ids.workspace, "admin"],
    [ids.repUser, ids.repMember, "criteria-rep@example.test", ids.workspace, "rep"],
    [ids.otherUser, ids.otherMember, "criteria-other@example.test", ids.otherWorkspace, "admin"],
  ] as const) {
    await database.prepare(`INSERT INTO users (id,email,password_hash,name,phone,application_identifier,created_at,updated_at)
      VALUES (?, ?, NULL, ?, NULL, ?, ?, ?)`).run(userId, email, email, `APP-${userId.slice(-6)}`, now, now)
    await database.prepare(`INSERT INTO memberships (id,workspace_id,user_id,role,manager_membership_id,status,sender_association,created_at,updated_at)
      VALUES (?, ?, ?, ?, NULL, 'active', NULL, ?, ?)`).run(memberId, workspaceId, userId, role, now, now)
  }
  await database.prepare(`INSERT INTO sessions (id,user_id,membership_id,token_hash,expires_at,created_at,last_seen_at)
    VALUES (?, ?, ?, ?, '2099-01-01T00:00:00.000Z', ?, ?)`).run("criteria-admin-session", ids.adminUser, ids.adminMember, hashOpaqueToken("admin-session-token"), now, now)
  await database.prepare(`INSERT INTO sessions (id,user_id,membership_id,token_hash,expires_at,created_at,last_seen_at)
    VALUES (?, ?, ?, ?, '2099-01-01T00:00:00.000Z', ?, ?)`).run("criteria-rep-session", ids.repUser, ids.repMember, hashOpaqueToken("rep-session-token"), now, now)
  await database.prepare(`INSERT INTO sessions (id,user_id,membership_id,token_hash,expires_at,created_at,last_seen_at)
    VALUES (?, ?, ?, ?, '2099-01-01T00:00:00.000Z', ?, ?)`).run("criteria-other-session", ids.otherUser, ids.otherMember, hashOpaqueToken("other-session-token"), now, now)
  const addKey = async (id: string, secret: string, scopes: string[], workspaceId: string, createdBy: string) => {
    await database.prepare(`INSERT INTO api_keys
      (id,workspace_id,name,prefix,secret_hash,scopes,expires_at,last_used_at,revoked_at,rate_limit_per_minute,created_by,created_at)
      VALUES (?, ?, ?, 'mca_test', ?, ?, NULL, NULL, NULL, 60, ?, ?)`).run(id, workspaceId, id, hashOpaqueToken(`mca_${secret}`), JSON.stringify(scopes), createdBy, now)
  }
  await addKey("criteria-intake-key", "intake-secret", ["intake:write"], ids.workspace, ids.adminUser)
  await addKey("criteria-read-key", "read-secret", ["deals:read"], ids.workspace, ids.adminUser)
}

before(async () => {
  testDatabase = await createPostgresTestDatabase("funders_criteria")
  Object.assign(process.env, testDatabase.env())
  await seed()
})
after(async () => {
  await closeDatabaseForTests()
  await testDatabase.close()
})

function cookieRequest(path: string, token: string, init: RequestInit = {}) {
  return new Request(`http://localhost${path}`, {
    ...init,
    headers: {
      cookie: `mca_session=${token}`,
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
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...init.headers,
    },
  })
}

function params(id: string) {
  return { params: Promise.resolve({ funderId: id, id }) }
}

async function funder(key: string, workspaceId = ids.workspace) {
  return (await createFunder(actor(workspaceId), { idempotencyKey: key, legalName: `${key} Capital LLC` })).funder
}

test("MIC-170 convertRevenueThreshold yearly 120000 equals monthly 10000", () => {
  assert.equal(convertRevenueThreshold({ value: 120000, from: "usd_annual", to: "usd_monthly" }), 10000)
  assert.equal(convertRevenueThreshold({ value: 120000, from: "yearly", to: "monthly" }), 10000)
  assert.equal(convertRevenueThreshold({ value: 10000, from: "usd_monthly", to: "usd_annual" }), 120000)
  assert.equal(convertRevenueThreshold({ value: 10000, from: "monthly", to: "yearly" }), 120000)
  assert.equal(convertRevenueThreshold({ value: 120000, from: "usd_annual", to: "usd_annual" }), 120000)
})

test("MIC-170 publishing yearly min revenue 120000 is equivalent to monthly min 10000", async () => {
  const created = await funder("yearly-revenue")
  const published = await publishFunderCriteria(actor(), created.id, [{
    field: "revenue",
    operator: "min",
    unit: "usd_annual",
    value: 120000,
    sourceText: "Minimum $120,000 annual revenue",
    unspecified: false,
  }])
  assert.equal(published.rules.length, 1)
  const rule = published.rules[0]
  assert.equal(rule.field, "revenue")
  assert.equal(rule.operator, "min")
  assert.equal(rule.unit, "usd_annual")
  assert.equal(rule.value, 120000)
  assert.equal(rule.unspecified, false)
  assert.equal(convertRevenueThreshold({ value: Number(rule.value), from: rule.unit === "usd_annual" ? "usd_annual" : "usd_monthly", to: "usd_monthly" }), 10000)
})

test("MIC-170 conflicting min/max on the same field+unit cannot publish", async () => {
  const created = await funder("conflict-same-unit")
  await assert.rejects(
    publishFunderCriteria(actor(), created.id, [
      { field: "nsf", operator: "min", unit: "count", value: 4, unspecified: false },
      { field: "nsf", operator: "max", unit: "count", value: 2, unspecified: false },
    ]),
    (error: { status?: number; code?: string }) => error.status === 422 && error.code === "criteria_conflict",
  )
  assert.equal((await listFunderCriteria(actor(), created.id)).rules.length, 0)
  assert.equal((await getFunder(actor(), created.id)).criteriaVersion, 1)
})

test("MIC-170 yearly vs monthly revenue min/max conflict uses convertRevenueThreshold", async () => {
  const created = await funder("conflict-converted")
  await assert.rejects(
    publishFunderCriteria(actor(), created.id, [
      { field: "revenue", operator: "min", unit: "usd_annual", value: 120000, unspecified: false },
      { field: "revenue", operator: "max", unit: "usd_monthly", value: 9000, unspecified: false },
    ]),
    (error: { status?: number; code?: string }) => error.status === 422 && error.code === "criteria_conflict",
  )
  const compatible = await publishFunderCriteria(actor(), created.id, [
    { field: "revenue", operator: "min", unit: "usd_annual", value: 120000, unspecified: false },
    { field: "revenue", operator: "max", unit: "usd_monthly", value: 20000, unspecified: false },
  ])
  assert.equal(compatible.rules.length, 2)
  assert.equal(compatible.criteriaVersion, 2)
})

test("MIC-170 unspecified:true stores null and never a sentinel number", async () => {
  const created = await funder("unspecified-fico")
  const published = await publishFunderCriteria(actor(), created.id, [{
    field: "fico",
    operator: "min",
    unit: "fico",
    value: 0,
    unspecified: true,
    sourceText: "FICO not stated",
  }])
  assert.equal(published.rules.length, 1)
  assert.equal(published.rules[0].unspecified, true)
  assert.equal(published.rules[0].value, null)
  assert.notEqual(published.rules[0].value, 0)
  assert.notEqual(published.rules[0].value, -1)
  const row = await getDatabase().prepare<{ value_json: string | null; unspecified: number }>("SELECT value_json, unspecified FROM mca_funder_criteria WHERE funder_id = ?").get(created.id)
  assert.equal(row?.value_json, null)
  assert.equal(row?.unspecified, 1)
  assert.equal(JSON.stringify(row?.value_json), "null")
})

test("MIC-170 covers remaining eligibility fields and versions the funder", async () => {
  const created = await funder("full-book")
  const published = await publishFunderCriteria(actor(), created.id, [
    { field: "revenue", operator: "min", unit: "usd_monthly", value: 10000, unspecified: false, sourceText: "$10k monthly deposits" },
    { field: "fico", operator: "min", unit: "fico", value: 600, unspecified: false },
    { field: "time_in_business", operator: "min", unit: "months", value: 12, unspecified: false },
    { field: "positions", operator: "max", unit: "count", value: 3, unspecified: false },
    { field: "requested_amount", operator: "max", unit: "usd", value: 250000, unspecified: false },
    { field: "term", operator: "max", unit: "months", value: 12, unspecified: false },
    { field: "average_daily_balance", operator: "min", unit: "usd", value: 5000, unspecified: false },
    { field: "deposit_count", operator: "min", unit: "count", value: 8, unspecified: false },
    { field: "nsf", operator: "max", unit: "count", value: 3, unspecified: false },
    { field: "negative_days", operator: "max", unit: "days", value: 4, unspecified: false },
    { field: "default_status", operator: "eq", unit: "boolean", value: false, unspecified: false },
    { field: "entity", operator: "in", unit: "entity", value: ["llc", "corp"], unspecified: false },
    { field: "state", operator: "not_in", unit: "state", value: ["NV", "SD"], unspecified: false },
    { field: "industry", operator: "not_in", unit: "naics", value: ["7132"], unspecified: false },
  ])
  assert.equal(published.rules.length, 14)
  assert.equal(published.criteriaVersion, 2)
  assert.equal((await getFunder(actor(), created.id)).criteriaVersion, 2)
  const replay = await publishFunderCriteria(actor(), created.id, published.rules)
  assert.equal(replay.criteriaVersion, 2)
  assert.deepEqual(replay.rules.map((rule) => rule.id), published.rules.map((rule) => rule.id))
  const updated = await publishFunderCriteria(actor(), created.id, [
    ...published.rules.filter((rule) => rule.field !== "positions"),
    { id: published.rules.find((rule) => rule.field === "positions")?.id, field: "positions", operator: "max", unit: "count", value: 2, unspecified: false },
  ])
  assert.equal(updated.criteriaVersion, 3)
  assert.equal(updated.rules.find((rule) => rule.field === "positions")?.value, 2)
})

test("MIC-170 industry aliases normalize and stay workspace-scoped", async () => {
  const restaurants = await upsertIndustryAlias(actor(), { alias: "restaurants", naics: "722511", normalizedIndustry: "Food Services" })
  const replay = await upsertIndustryAlias(actor(), { alias: "Restaurants", naics: "722511", normalizedIndustry: "Food Services" })
  assert.equal(replay.id, restaurants.id)
  assert.equal((await resolveIndustry(actor(), "RESTAURANTS")).normalizedIndustry, "Food Services")
  assert.equal((await resolveIndustry(actor(), "722511")).naics, "722511")
  const remote = await upsertIndustryAlias(actor(ids.otherWorkspace), { alias: "restaurants", naics: "722513", normalizedIndustry: "Limited-Service Restaurants" })
  assert.notEqual(remote.id, restaurants.id)
  assert.equal((await listIndustryAliases(actor())).some((item) => item.id === remote.id), false)
  await assert.rejects(deleteIndustryAlias(actor(), remote.id), (error: { status?: number; code?: string }) => error.status === 404 && error.code === "alias_not_found")
  await deleteIndustryAlias(actor(), restaurants.id)
  assert.equal((await resolveIndustry(actor(), "restaurants")).normalizedIndustry, "restaurants")
})

test("MIC-170 HTTP publish, permissions, and cross-workspace isolation", async () => {
  const local = await funder("http-local")
  const remote = await funder("http-remote", ids.otherWorkspace)
  const path = `/api/mca/funders/criteria/${local.id}`
  const listed = await criteriaGet(cookieRequest(path, "admin-session-token"), params(local.id))
  assert.equal(listed.status, 200)
  assert.equal((await listed.json() as { rules: unknown[] }).rules.length, 0)

  const published = await criteriaPut(cookieRequest(path, "admin-session-token", {
    method: "PUT",
    body: JSON.stringify({
      rules: [
        { field: "fico", operator: "min", unit: "fico", value: 620, unspecified: false, sourceText: "Credit 620+" },
        { field: "revenue", operator: "min", unit: "usd_annual", value: 120000, unspecified: false },
      ],
    }),
  }), params(local.id))
  assert.equal(published.status, 200)
  const body = await published.json() as { criteriaVersion: number; rules: Array<{ field: string; value: number | null }> }
  assert.equal(body.criteriaVersion, 2)
  assert.equal(body.rules.length, 2)

  const conflict = await criteriaPut(cookieRequest(path, "admin-session-token", {
    method: "PUT",
    body: JSON.stringify({
      rules: [
        { field: "fico", operator: "min", unit: "fico", value: 700, unspecified: false },
        { field: "fico", operator: "max", unit: "fico", value: 650, unspecified: false },
      ],
    }),
  }), params(local.id))
  assert.equal(conflict.status, 422)
  assert.equal((await conflict.json() as { error: { code: string } }).error.code, "criteria_conflict")

  const repWrite = await criteriaPut(cookieRequest(path, "rep-session-token", {
    method: "PUT",
    body: JSON.stringify({ rules: [{ field: "fico", operator: "min", unit: "fico", value: 500, unspecified: false }] }),
  }), params(local.id))
  assert.equal(repWrite.status, 403)
  const repRead = await criteriaGet(cookieRequest(path, "rep-session-token"), params(local.id))
  assert.equal(repRead.status, 200)

  const intake = await criteriaGet(bearerRequest(path, "intake-secret"), params(local.id))
  assert.equal(intake.status, 403)
  assert.equal((await intake.json() as { error: { code: string } }).error.code, "scope_required")
  const readable = await criteriaGet(bearerRequest(path, "read-secret"), params(local.id))
  assert.equal(readable.status, 200)

  const stolen = await criteriaGet(cookieRequest(`/api/mca/funders/criteria/${local.id}`, "other-session-token"), params(local.id))
  assert.equal(stolen.status, 404)
  const foreign = await criteriaPut(cookieRequest(`/api/mca/funders/criteria/${remote.id}`, "admin-session-token", {
    method: "PUT",
    body: JSON.stringify({ rules: [{ field: "fico", operator: "min", unit: "fico", value: 600, unspecified: false }] }),
  }), params(remote.id))
  assert.equal(foreign.status, 404)

  const createdAlias = await aliasesPost(cookieRequest("/api/mca/funders/criteria/aliases", "admin-session-token", {
    method: "POST",
    body: JSON.stringify({ alias: "truckers", naics: "484121", normalizedIndustry: "General Freight Trucking" }),
  }))
  assert.equal(createdAlias.status, 201)
  const alias = await createdAlias.json() as { id: string; alias: string }
  const listedAliases = await aliasesGet(cookieRequest("/api/mca/funders/criteria/aliases", "admin-session-token"))
  assert.equal(listedAliases.status, 200)
  assert.equal((await listedAliases.json() as { aliases: Array<{ id: string }> }).aliases.some((item) => item.id === alias.id), true)
  const patched = await aliasPatch(cookieRequest(`/api/mca/funders/criteria/aliases/${alias.id}`, "admin-session-token", {
    method: "PATCH",
    body: JSON.stringify({ normalizedIndustry: "Long-Haul Trucking" }),
  }), params(alias.id))
  assert.equal(patched.status, 200)
  const removed = await aliasDelete(cookieRequest(`/api/mca/funders/criteria/aliases/${alias.id}`, "admin-session-token", { method: "DELETE" }), params(alias.id))
  assert.equal(removed.status, 200)
})

test("source dates are validated, persisted and versioned without inventing dates", async () => {
  const created = (await createFunder(actor(), { idempotencyKey: "dated-criteria", legalName: "Dated Fixture" })).funder
  const draft = { field: "fico", operator: "min", unit: "fico", value: 600, sourceText: "Synthetic policy", sourceAsOf: "2026-09-01", validUntil: "2026-10-01" }
  await assert.rejects(() => publishFunderCriteria(actor(),created.id,[{...draft,sourceAsOf:"2026-02-30"}]),(error: {status?:number}) => error.status === 422)
  await assert.rejects(() => publishFunderCriteria(actor(),created.id,[{...draft,validUntil:"2026-08-01"}]),(error: {status?:number}) => error.status === 422)
  const saved=await publishFunderCriteria(actor(),created.id,[draft])
  assert.equal((await listFunderCriteria(actor(),created.id)).rules[0].sourceAsOf,"2026-09-01")
  assert.equal((await listFunderCriteria(actor(),created.id)).rules[0].validUntil,"2026-10-01")
  assert.equal((await publishFunderCriteria(actor(),created.id,[draft])).criteriaVersion,saved.criteriaVersion)
  assert.equal((await publishFunderCriteria(actor(),created.id,[{...draft,validUntil:"2026-11-01"}])).criteriaVersion,saved.criteriaVersion+1)
})
