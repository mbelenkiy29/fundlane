import test, { after, before } from "node:test"
import assert from "node:assert/strict"
import { closeDatabaseForTests, getDatabase, newId } from "../src/lib/mca/db"
import { createPostgresTestDatabase } from "./helpers/postgres-test-db.mjs"
import { createDeal } from "../src/lib/mca/deals/service"
import type { DealActor } from "../src/lib/mca/deals/schema"
import { hashOpaqueToken } from "../src/lib/mca/crypto"
import type { EligibilityRule } from "../src/lib/mca/funders/contracts"
import {
  POLICY_VERSION,
  SCORE_FIT_DISCLAIMER,
  autoSelectableFunderIds,
  evaluateFunderScore,
  getDealScores,
  rankScores,
  requireScoreActor,
  scoreDeal,
} from "../src/lib/mca/underwriting/scoring"
import type { ScoringInputs } from "../src/lib/mca/underwriting/scoring"
import { GET as getScores, POST as postScores } from "../src/app/api/mca/underwriting/scores/[dealId]/route"

let testDatabase: Awaited<ReturnType<typeof createPostgresTestDatabase>>

const actor = (workspaceId: string): DealActor => ({
  workspaceId,
  userId: "user-scoring",
  membershipId: null,
  role: "admin",
  managedMembershipIds: [],
  activeMembershipIds: [],
  source: "system",
  correlationId: `corr-${workspaceId}`,
})

function fitRules(): EligibilityRule[] {
  return [
    { id: "r-rev", funderId: "", field: "revenue", operator: "min", unit: "usd_annual", value: 120_000, unspecified: false },
    { id: "r-fico", funderId: "", field: "fico", operator: "min", unit: "fico", value: 600, unspecified: false },
    { id: "r-tib", funderId: "", field: "time_in_business", operator: "min", unit: "months", value: 12, unspecified: false },
    { id: "r-pos", funderId: "", field: "positions", operator: "max", unit: "count", value: 3, unspecified: false },
    { id: "r-amt", funderId: "", field: "requested_amount", operator: "max", unit: "usd", value: 250_000, unspecified: false },
    { id: "r-adb", funderId: "", field: "average_daily_balance", operator: "min", unit: "usd", value: 5_000, unspecified: false },
    { id: "r-nsf", funderId: "", field: "nsf", operator: "max", unit: "count", value: 4, unspecified: false },
    { id: "r-neg", funderId: "", field: "negative_days", operator: "max", unit: "days", value: 4, unspecified: false },
    { id: "r-def", funderId: "", field: "default_status", operator: "eq", unit: "boolean", value: false, unspecified: false },
    { id: "r-ent", funderId: "", field: "entity", operator: "in", unit: "entity", value: ["llc", "corp"], unspecified: false },
    { id: "r-st", funderId: "", field: "state", operator: "not_in", unit: "state", value: ["NV", "SD"], unspecified: false },
    { id: "r-ind", funderId: "", field: "industry", operator: "not_in", unit: "naics", value: ["713210"], unspecified: false },
  ]
}

const harborInputs: ScoringInputs = {
  dealId: "deal-harbor",
  dealVersion: 1,
  state: "NY",
  entity: "llc",
  industry: "restaurants",
  naics: "722511",
  defaultFlag: false,
  tibMonths: 80,
  fico: 680,
  requestedAmount: 50_000,
  monthlyRevenue: 20_000,
  revenueUnknown: false,
  averageDailyBalance: 8_000,
  adbUnknown: false,
  nsfCount: 1,
  nsfUnknown: false,
  negativeDays: 0,
  negativeUnknown: false,
  positionCount: 0,
  availableMonthlyRevenue: 20_000,
  availableUnknown: false,
  dataAge: "2026-08",
}

function funderRecord(id: string, workspaceId: string, name: string) {
  const now = new Date().toISOString()
  return {
    id, workspaceId, legalName: name, domains: [] as string[], products: [] as string[], active: true,
    contacts: [], routes: [], criteriaVersion: 2, profileVersion: 1, createdAt: now, updatedAt: now,
  }
}

async function exec(sql: string, ...values: unknown[]) {
  return getDatabase().prepare(sql).run(...values)
}

async function addWorkspace(id: string) {
  const now = new Date().toISOString()
  await exec(
    `INSERT INTO workspaces (id,name,timezone,seat_limit,feature_flags,page_visibility,action_visibility,created_at,updated_at)
     VALUES (?, ?, 'America/New_York', 5, ?, ?, ?, ?, ?)
     ON CONFLICT (id) DO NOTHING`,
    id, id,
    JSON.stringify({ reports: true, payments: true, integrations: true }),
    JSON.stringify({ dashboard: true, deals: true, users: true, reports: true, payments: true, workspace: true, integrations: true }),
    JSON.stringify({ createDeal: true, exportDeals: true, inviteUsers: true, manageApiKeys: true, viewPaymentTable: true, viewCompanyFinancials: true }),
    now, now,
  )
}

async function seedFunder(workspaceId: string, key: string, rules: EligibilityRule[]) {
  const now = new Date().toISOString()
  const id = newId()
  await exec(
    `INSERT INTO mca_funders (id, workspace_id, idempotency_key, legal_name, domains, products, active, contacts, routes, criteria_version, profile_version, created_at, updated_at)
     VALUES (?, ?, ?, ?, '[]', '[]', 1, '[]', '[]', 2, 1, ?, ?)`,
    id, workspaceId, key, `${key} Capital LLC`, now, now,
  )
  for (const [index, rule] of rules.entries()) {
    await exec(
      `INSERT INTO mca_funder_criteria (id, workspace_id, funder_id, field, operator, unit, value_json, source_text, unspecified, position, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      newId(), workspaceId, id, rule.field, rule.operator, rule.unit,
      rule.unspecified ? null : JSON.stringify(rule.value), rule.sourceText ?? null, rule.unspecified ? 1 : 0, index, now, now,
    )
  }
  return id
}

async function seedAggregate(workspaceId: string, dealId: string, extra: { stale?: boolean; version?: number; revenue?: number } = {}) {
  const metric = (value: number) => JSON.stringify({ value, unknown: false, confidence: 0.95, text: String(value) })
  await exec(
    `INSERT INTO mca_underwriting_aggregates
      (workspace_id, deal_id, version, monthly_revenue, average_daily_balance, nsf_count, negative_days, position_count, stale, source_fingerprint, computed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, 'fixture', ?)
     ON CONFLICT (workspace_id, deal_id) DO UPDATE SET
      version = excluded.version, monthly_revenue = excluded.monthly_revenue, stale = excluded.stale, computed_at = excluded.computed_at`,
    workspaceId, dealId, extra.version ?? 1, metric(extra.revenue ?? 20_000), metric(8_000), metric(1), metric(0), extra.stale ? 1 : 0, extra.stale ? new Date().toISOString() : "2026-09-08T00:00:00.000Z",
  )
}

async function merchantDeal(workspaceId: string, key: string, extra: { ficoScore?: number | null; state?: string } = {}) {
  const created = await createDeal(actor(workspaceId), {
    idempotencyKey: key,
    legalName: `${key} Merchant LLC`,
    entityType: "llc",
    address: { line1: "1 Harbor St", city: "Brooklyn", state: extra.state ?? "NY", postalCode: "11201" },
    startDate: "2020-01-01",
    industry: "restaurants",
    naicsCode: "722511",
    monthlyRevenue: 20_000,
    ...(extra.ficoScore === null ? {} : { ficoScore: extra.ficoScore ?? 680 }),
    requestedAmount: 50_000,
    fundingPurpose: "working capital",
  })
  await seedAggregate(workspaceId, created.deal.id)
  return created.deal
}

before(async () => {
  testDatabase = await createPostgresTestDatabase("underwriting_scoring")
  Object.assign(process.env, testDatabase.env())
})

after(async () => {
  await closeDatabaseForTests()
  await testDatabase.close()
})

test("MIC-163 hard DQ runs before score and cannot be auto-selected", async () => {
  const workspaceId = "workspace-score-dq"
  const scored = rankScores([
    await evaluateFunderScore(actor(workspaceId), harborInputs, funderRecord("fit-ok", workspaceId, "Fit Capital"), fitRules().map((rule) => ({ ...rule, funderId: "fit-ok" }))),
    await evaluateFunderScore(actor(workspaceId), harborInputs, funderRecord("state-block", workspaceId, "State Block"), [
      ...fitRules().filter((rule) => rule.field !== "state").map((rule) => ({ ...rule, funderId: "state-block" })),
      { id: "r-st-in", funderId: "state-block", field: "state", operator: "in", unit: "state", value: ["CA", "TX"], unspecified: false },
    ]),
  ])
  const fitScore = scored.find((row) => row.funderId === "fit-ok")
  const blockedScore = scored.find((row) => row.funderId === "state-block")
  assert.ok(fitScore)
  assert.ok(blockedScore)
  assert.equal(fitScore.eligible, true)
  assert.notEqual(fitScore.grade, "DQ")
  assert.equal(blockedScore.eligible, false)
  assert.equal(blockedScore.grade, "DQ")
  assert.equal(blockedScore.score, 0)
  assert.equal(blockedScore.reasons.some((reason) => reason.ruleId === "hard.state" && reason.result === "fail"), true)
  assert.equal(blockedScore.reasons.some((reason) => reason.ruleId.startsWith("soft.")), false)
  assert.deepEqual(autoSelectableFunderIds(scored), ["fit-ok"])
  assert.equal(fitScore.rank < blockedScore.rank, true)
})

test("MIC-163 same inputs and policyVersion 2 produce identical scores and retry identity", async () => {
  const workspaceId = `ws-score-repro-${newId().slice(0, 8)}`
  await addWorkspace(workspaceId)
  const deal = await merchantDeal(workspaceId, "repro")
  await seedFunder(workspaceId, "repro-fit", fitRules())
  const first = await scoreDeal(actor(workspaceId), deal.id)
  const second = await scoreDeal(actor(workspaceId), deal.id)
  assert.equal(first.snapshot.policyVersion, POLICY_VERSION)
  assert.equal(first.snapshot.policyVersion, 2)
  assert.equal(second.snapshot.id, first.snapshot.id)
  assert.deepEqual(second.snapshot.scores, first.snapshot.scores)
  const listed = await getDealScores(actor(workspaceId), deal.id)
  assert.equal(listed.snapshot?.id, first.snapshot.id)
  assert.equal(listed.stale, false)
  assert.equal(listed.disclaimer, SCORE_FIT_DISCLAIMER)
})

test("MIC-163 synthetic fit scenario ranks, grades, and describes fit not approval odds", async () => {
  const workspaceId = "workspace-score-fit"
  const fit = await evaluateFunderScore(actor(workspaceId), harborInputs, funderRecord("harbor-fit", workspaceId, "Harbor Fit"), fitRules())
  const ficoDq = await evaluateFunderScore(actor(workspaceId), harborInputs, funderRecord("harbor-fico", workspaceId, "Thin FICO"), [
    ...fitRules().filter((rule) => rule.field !== "fico"),
    { id: "r-fico-hi", funderId: "harbor-fico", field: "fico", operator: "min", unit: "fico", value: 700, unspecified: false },
  ])
  const revDq = await evaluateFunderScore(actor(workspaceId), harborInputs, funderRecord("harbor-rev", workspaceId, "Thin Rev"), [
    ...fitRules().filter((rule) => rule.field !== "revenue"),
    { id: "r-rev-hi", funderId: "harbor-rev", field: "revenue", operator: "min", unit: "usd_monthly", value: 25_000, unspecified: false },
  ])
  const ranked = rankScores([fit, ficoDq, revDq])
  assert.match(SCORE_FIT_DISCLAIMER, /fit, not approval odds/i)
  const fitScore = ranked.find((row) => row.funderId === "harbor-fit")
  const ficoScore = ranked.find((row) => row.funderId === "harbor-fico")
  const revScore = ranked.find((row) => row.funderId === "harbor-rev")
  assert.ok(fitScore && ficoScore && revScore)
  assert.equal(fitScore.grade, "A")
  assert.equal(fitScore.score, 90)
  assert.equal(fitScore.eligible, true)
  assert.equal(fitScore.rank, 1)
  assert.equal(fitScore.reasons.some((reason) => reason.ruleId === "hard.revenue" && reason.result === "pass"), true)
  assert.equal(fitScore.reasons.some((reason) => reason.ruleId === "soft.revenue_fit" && reason.result === "pass"), true)
  assert.equal(fitScore.dataAge, "2026-08")
  assert.equal(ficoScore.grade, "DQ")
  assert.equal(ficoScore.eligible, false)
  assert.equal(ficoScore.reasons.some((reason) => reason.ruleId === "hard.fico" && reason.result === "fail"), true)
  assert.equal(revScore.grade, "DQ")
  assert.equal(revScore.reasons.some((reason) => reason.ruleId === "hard.revenue" && reason.result === "fail"), true)
  assert.deepEqual(autoSelectableFunderIds(ranked), ["harbor-fit"])
})

test("MIC-163 missing inputs are unknown, never a fake pass; unspecified rules are skipped", async () => {
  const workspaceId = "workspace-score-unk"
  const missingFico: ScoringInputs = { ...harborInputs, fico: undefined }
  const required = await evaluateFunderScore(actor(workspaceId), missingFico, funderRecord("need-fico", workspaceId, "Need FICO"), [
    ...fitRules().filter((rule) => rule.field !== "fico"),
    { id: "r-fico-req", funderId: "need-fico", field: "fico", operator: "min", unit: "fico", value: 650, unspecified: false },
  ])
  const open = await evaluateFunderScore(actor(workspaceId), missingFico, funderRecord("open-fico", workspaceId, "Open FICO"), [
    ...fitRules().filter((rule) => rule.field !== "fico"),
    { id: "r-fico-open", funderId: "open-fico", field: "fico", operator: "min", unit: "fico", value: 0, unspecified: true, sourceText: "FICO not stated" },
  ])
  assert.equal(required.eligible, false)
  assert.equal(required.grade, "DQ")
  const unknown = required.reasons.find((reason) => reason.ruleId === "hard.fico")
  assert.equal(unknown?.result, "unknown")
  assert.notEqual(unknown?.result, "pass")
  assert.equal(open.reasons.some((reason) => reason.ruleId === "hard.fico"), false)
  assert.equal(open.eligible, true)
  assert.notEqual(open.grade, "DQ")
})

test("MIC-163 criteria or underwriting version change marks snapshots stale and reanalyze refreshes", async () => {
  const workspaceId = `ws-score-stale-${newId().slice(0, 8)}`
  await addWorkspace(workspaceId)
  const deal = await merchantDeal(workspaceId, "stale")
  const funderId = await seedFunder(workspaceId, "stale-fit", fitRules())
  const first = await scoreDeal(actor(workspaceId), deal.id)
  assert.equal((await getDealScores(actor(workspaceId), deal.id)).stale, false)

  await exec(`UPDATE mca_funders SET criteria_version = criteria_version + 1, updated_at = ? WHERE id = ?`, new Date().toISOString(), funderId)
  const afterCriteria = await getDealScores(actor(workspaceId), deal.id)
  assert.equal(afterCriteria.stale, true)
  assert.equal(afterCriteria.snapshot?.id, first.snapshot.id)
  assert.equal(afterCriteria.autoSelectableFunderIds.length, 0)
  assert.equal(afterCriteria.staleReasons.some((reason) => reason.includes("criteria")), true)

  const refreshed = await scoreDeal(actor(workspaceId), deal.id)
  assert.notEqual(refreshed.snapshot.id, first.snapshot.id)
  assert.equal((await getDealScores(actor(workspaceId), deal.id)).stale, false)

  await seedAggregate(workspaceId, deal.id, { stale: true, version: 1, revenue: 21_000 })
  const afterCorrection = await getDealScores(actor(workspaceId), deal.id)
  assert.equal(afterCorrection.stale, true)
  const again = await scoreDeal(actor(workspaceId), deal.id)
  assert.notEqual(again.snapshot.id, refreshed.snapshot.id)
  assert.equal((await getDealScores(actor(workspaceId), deal.id)).stale, false)
})

test("MIC-163 deals:read lists, deals:write scores, intake:write is 403, foreign workspace is 404", async () => {
  const workspaceId = `ws-score-http-${newId().slice(0, 8)}`
  const otherId = `ws-score-other-${newId().slice(0, 8)}`
  await addWorkspace(workspaceId)
  await addWorkspace(otherId)
  const deal = await merchantDeal(workspaceId, "http-score")
  await seedFunder(workspaceId, "http-fit", fitRules())
  const now = new Date().toISOString()
  const creatorId = `score-user-${workspaceId}`
  try {
    await exec(
      `INSERT INTO users (id,email,password_hash,name,phone,application_identifier,created_at,updated_at)
       VALUES (?, ?, NULL, 'Scoring Fixture', NULL, ?, ?, ?)`,
      creatorId, `${creatorId}@example.test`, `APP-${creatorId.slice(-8)}`, now, now,
    )
  } catch { /* users table or unique email may already exist */ }
  const addKey = async (id: string, secret: string, scopes: string[], ws = workspaceId) => {
    await exec(
      `INSERT INTO api_keys (id,workspace_id,name,prefix,secret_hash,scopes,expires_at,last_used_at,revoked_at,rate_limit_per_minute,created_by,created_at)
       VALUES (?, ?, ?, 'mca_test', ?, ?, NULL, NULL, NULL, 60, ?, ?)`,
      id, ws, id, hashOpaqueToken(`mca_${secret}`), JSON.stringify(scopes), creatorId, now,
    )
  }
  await addKey(`score-read-${workspaceId}`, "score-read", ["deals:read"])
  await addKey(`score-write-${workspaceId}`, "score-write", ["deals:write"])
  await addKey(`score-intake-${workspaceId}`, "score-intake", ["intake:write"])
  await addKey(`score-other-${otherId}`, "score-other", ["deals:write"], otherId)

  const params = { params: Promise.resolve({ dealId: deal.id }) }
  const request = (secret: string, method = "GET", body?: string) => new Request(`http://localhost/api/mca/underwriting/scores/${deal.id}`, {
    method,
    headers: { authorization: `Bearer mca_${secret}` },
    ...(body ? { body } : {}),
  })

  await assert.rejects(() => requireScoreActor(request("score-intake"), "read"), (error: { code?: string }) => error.code === "scope_required")
  assert.equal((await getScores(request("score-intake"), params)).status, 403)
  assert.equal((await postScores(request("score-intake", "POST", "{}"), params)).status, 403)
  assert.equal((await postScores(request("score-read", "POST", "{}"), params)).status, 403)

  const empty = await getScores(request("score-read"), params)
  assert.equal(empty.status, 200)
  const emptyBody = await empty.json() as { snapshot: null; disclaimer: string }
  assert.equal(emptyBody.snapshot, null)
  assert.match(emptyBody.disclaimer, /fit, not approval odds/i)

  const posted = await postScores(request("score-write", "POST", "{}"), params)
  assert.equal(posted.status, 200)
  const postedBody = await posted.json() as { snapshot: { scores: Array<{ grade: string; eligible: boolean }>; policyVersion: number }; autoSelectableFunderIds: string[] }
  assert.equal(postedBody.snapshot.policyVersion, 2)
  assert.equal(postedBody.snapshot.scores.length > 0, true)
  assert.equal(postedBody.autoSelectableFunderIds.length, 1)

  const other = await postScores(request("score-other", "POST", "{}"), params)
  assert.equal(other.status, 404)
  await assert.rejects(
    () => getDealScores(actor(otherId), deal.id),
    (error: { status?: number; code?: string }) => error.status === 404 && error.code === "deal_not_found",
  )
})
