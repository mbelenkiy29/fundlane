import test, { after, before } from "node:test"
import assert from "node:assert/strict"
import { closeDatabaseForTests, getDatabase, newId } from "../src/lib/mca/db"
import { createPostgresTestDatabase } from "./helpers/postgres-test-db.mjs"
import { createDeal, getDealForDocument, updateDealRecord } from "../src/lib/mca/deals/service"
import type { DealActor, DealRecord } from "../src/lib/mca/deals/schema"
import { hashOpaqueToken } from "../src/lib/mca/crypto"
import type { EligibilityRule } from "../src/lib/mca/funders/contracts"
import {
  POLICY_VERSION,
  SCORE_FIT_DISCLAIMER,
  autoSelectableFunderIds,
  buildScoringInputs,
  evaluateFunderScore,
  getDealScores,
  naicsPrefixMatch,
  rankScores,
  requireScoreActor,
  resolveDefaultFlag,
  scoreDeal,
} from "../src/lib/mca/underwriting/scoring"
import { GET as getFit } from "../src/app/api/mca/underwriting/lender-fit/[dealId]/route"
import { getLenderFit } from "../src/lib/mca/underwriting/lender-fit"
import type { ScoringInputs } from "../src/lib/mca/underwriting/scoring"
import type { ExistingPositionCandidate, FunderScore, UnderwritingAggregate } from "../src/lib/mca/underwriting/contracts"
import { AUTO_SELECT_GRADES } from "../src/lib/mca/underwriting/policy"
import { insertCheck } from "../src/lib/mca/datamerch/repository"
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
    { id: "r-term", funderId: "", field: "term", operator: "max", unit: "months", value: 12, unspecified: false },
    { id: "r-adb", funderId: "", field: "average_daily_balance", operator: "min", unit: "usd", value: 5_000, unspecified: false },
    { id: "r-dep", funderId: "", field: "deposit_count", operator: "min", unit: "count", value: 6, unspecified: false },
    { id: "r-nsf", funderId: "", field: "nsf", operator: "max", unit: "count", value: 4, unspecified: false },
    { id: "r-neg", funderId: "", field: "negative_days", operator: "max", unit: "days", value: 4, unspecified: false },
    { id: "r-def", funderId: "", field: "default_status", operator: "eq", unit: "boolean", value: false, unspecified: false },
    { id: "r-ent", funderId: "", field: "entity", operator: "in", unit: "entity", value: ["llc", "corp"], unspecified: false },
    { id: "r-st", funderId: "", field: "state", operator: "not_in", unit: "state", value: ["NV", "SD"], unspecified: false },
    { id: "r-ind", funderId: "", field: "industry", operator: "not_in", unit: "naics", value: ["7132"], unspecified: false },
  ].map((rule) => ({ ...rule, sourceText: "Synthetic scoring fixture", sourceAsOf: "2026-01-01" })) as EligibilityRule[]
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
  termMonths: 12,
  monthlyRevenue: 20_000,
  revenueUnknown: false,
  averageDailyBalance: 8_000,
  adbUnknown: false,
  nsfCount: 1,
  nsfUnknown: false,
  negativeDays: 0,
  negativeUnknown: false,
  depositCount: 12,
  depositUnknown: false,
  worstMonthNsf: 1,
  positionCount: 0,
  proposedPositionCount: 0,
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
      `INSERT INTO mca_funder_criteria (id, workspace_id, funder_id, field, operator, unit, value_json, source_text, source_as_of, valid_until, unspecified, position, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      newId(), workspaceId, id, rule.field, rule.operator, rule.unit,
      rule.unspecified ? null : JSON.stringify(rule.value), rule.sourceText ?? null, rule.sourceAsOf ?? null, rule.validUntil ?? null, rule.unspecified ? 1 : 0, index, now, now,
    )
  }
  return id
}

async function seedReadyCompleteness(workspaceId: string, dealId: string, version = 1) {
  const now = new Date().toISOString()
  await exec(
    `INSERT INTO mca_completeness_results
      (id, workspace_id, deal_id, ready, version, rule_snapshot, findings_json, findings_fingerprint, checked_at)
     VALUES (?, ?, ?, 1, ?, '{"requiredStatementMonths":3}', '[]', ?, ?)`,
    newId(), workspaceId, dealId, version, `ready-${version}`, now,
  )
}

async function seedAggregate(workspaceId: string, dealId: string, extra: { stale?: boolean; version?: number; revenue?: number } = {}) {
  const metric = (value: number) => JSON.stringify({ value, unknown: false, confidence: 0.95, text: String(value) })
  await exec(
    `INSERT INTO mca_underwriting_aggregates
      (workspace_id, deal_id, version, monthly_revenue, average_daily_balance, nsf_count, negative_days, deposit_count, worst_month_nsf, position_count, stale, source_fingerprint, computed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, 'fixture', ?)
     ON CONFLICT (workspace_id, deal_id) DO UPDATE SET
      version = excluded.version, monthly_revenue = excluded.monthly_revenue, deposit_count = excluded.deposit_count, worst_month_nsf = excluded.worst_month_nsf, stale = excluded.stale, computed_at = excluded.computed_at`,
    workspaceId, dealId, extra.version ?? 1, metric(extra.revenue ?? 20_000), metric(8_000), metric(1), metric(0), metric(12), metric(1), extra.stale ? 1 : 0, extra.stale ? new Date().toISOString() : "2026-09-08T00:00:00.000Z",
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
    requestedTermMonths: 12,
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

test("auto-select is C+ only: D and F grades are not auto-selected", () => {
  assert.deepEqual(AUTO_SELECT_GRADES, ["A", "B", "C"])
  const scored: FunderScore[] = [
    { funderId: "grade-a", rank: 1, score: 90, grade: "A", eligible: true, fitStatus: "matched", reasons: [] },
    { funderId: "grade-b", rank: 2, score: 80, grade: "B", eligible: true, fitStatus: "matched", reasons: [] },
    { funderId: "grade-c", rank: 3, score: 70, grade: "C", eligible: true, fitStatus: "matched", reasons: [] },
    { funderId: "grade-d", rank: 4, score: 65, grade: "D", eligible: true, fitStatus: "matched", reasons: [] },
    { funderId: "grade-f", rank: 5, score: 40, grade: "F", eligible: true, fitStatus: "matched", reasons: [] },
    { funderId: "grade-dq", rank: 6, score: 0, grade: "DQ", eligible: false, reasons: [] },
  ]
  assert.deepEqual(autoSelectableFunderIds(scored), ["grade-a", "grade-b", "grade-c"])
})

test("scoreDeal autoSelectableFunderIds requires send-gate ok", async () => {
  const workspaceId = `ws-score-gate-${newId().slice(0, 8)}`
  await addWorkspace(workspaceId)
  const deal = await merchantDeal(workspaceId, "gate-empty")
  await seedFunder(workspaceId, "gate-fit", fitRules())
  const scored = await scoreDeal(actor(workspaceId), deal.id)
  assert.equal(scored.snapshot.scores.some((row) => row.eligible && row.grade === "A"), true)
  assert.deepEqual(scored.autoSelectableFunderIds, [])
  assert.deepEqual((await getDealScores(actor(workspaceId), deal.id)).autoSelectableFunderIds, [])
})

test("MIC-163 same inputs and policyVersion 3 produce identical scores and retry identity", async () => {
  const workspaceId = `ws-score-repro-${newId().slice(0, 8)}`
  await addWorkspace(workspaceId)
  const deal = await merchantDeal(workspaceId, "repro")
  await seedFunder(workspaceId, "repro-fit", fitRules())
  const first = await scoreDeal(actor(workspaceId), deal.id)
  const second = await scoreDeal(actor(workspaceId), deal.id)
  assert.equal(first.snapshot.policyVersion, POLICY_VERSION)
  assert.equal(first.snapshot.policyVersion, POLICY_VERSION)
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

test("MIC-163 missing inputs are unknown, never a fake pass; unspecified rules require broker review", async () => {
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
  assert.equal(open.eligible, false)
  assert.equal(open.fitStatus, "needs_review")
})

function assertHardDq(score: { eligible: boolean; grade: string; score: number; reasons: Array<{ ruleId: string; result: string }> }, ruleId: string, result: "fail" | "unknown" = "fail") {
  assert.equal(score.eligible, false)
  assert.equal(score.grade, "DQ")
  assert.equal(score.score, 0)
  assert.equal(score.reasons.some((reason) => reason.ruleId === ruleId && reason.result === result), true)
  assert.equal(score.reasons.some((reason) => reason.ruleId.startsWith("soft.")), false)
}

test("hard DQ ADB, requested amount, term, and deposit count; unknown cannot pass", async () => {
  const workspaceId = "workspace-score-hard-extras"
  const rules = fitRules()
  const funder = (id: string, name: string) => funderRecord(id, workspaceId, name)

  const adbDq = await evaluateFunderScore(actor(workspaceId), { ...harborInputs, averageDailyBalance: 1_000 }, funder("adb-dq", "Thin ADB"), rules)
  assertHardDq(adbDq, "hard.average_daily_balance")

  const amountDq = await evaluateFunderScore(actor(workspaceId), { ...harborInputs, requestedAmount: 300_000 }, funder("amt-dq", "Thin Amount"), rules)
  assertHardDq(amountDq, "hard.requested_amount")

  const termDq = await evaluateFunderScore(actor(workspaceId), { ...harborInputs, termMonths: 18 }, funder("term-dq", "Thin Term"), rules)
  assertHardDq(termDq, "hard.term")

  const depositDq = await evaluateFunderScore(actor(workspaceId), { ...harborInputs, depositCount: 2 }, funder("dep-dq", "Thin Deposits"), rules)
  assertHardDq(depositDq, "hard.deposit_count")

  const unknownAdb = await evaluateFunderScore(actor(workspaceId), { ...harborInputs, averageDailyBalance: undefined, adbUnknown: true }, funder("adb-unk", "Unknown ADB"), rules)
  assertHardDq(unknownAdb, "hard.average_daily_balance", "unknown")

  const unknownAmount = await evaluateFunderScore(actor(workspaceId), { ...harborInputs, requestedAmount: undefined }, funder("amt-unk", "Unknown Amount"), rules)
  assertHardDq(unknownAmount, "hard.requested_amount", "unknown")

  const unknownTerm = await evaluateFunderScore(actor(workspaceId), { ...harborInputs, termMonths: undefined }, funder("term-unk", "Unknown Term"), rules)
  assertHardDq(unknownTerm, "hard.term", "unknown")

  const unknownDeposit = await evaluateFunderScore(actor(workspaceId), { ...harborInputs, depositCount: undefined, depositUnknown: true }, funder("dep-unk", "Unknown Deposits"), rules)
  assertHardDq(unknownDeposit, "hard.deposit_count", "unknown")
})

test("industry not_in 7132 fails NAICS prefix 713210", async () => {
  assert.equal(naicsPrefixMatch("7132", "713210"), true)
  assert.equal(naicsPrefixMatch("713210", "7132"), true)
  assert.equal(naicsPrefixMatch("7132", "722511"), false)
  const workspaceId = "workspace-score-naics-prefix"
  const restricted = await evaluateFunderScore(
    actor(workspaceId),
    { ...harborInputs, industry: "casinos", naics: "713210" },
    funderRecord("naics-block", workspaceId, "No Gambling"),
    fitRules(),
  )
  assertHardDq(restricted, "hard.industry")

  const allowed = await evaluateFunderScore(
    actor(workspaceId),
    harborInputs,
    funderRecord("naics-ok", workspaceId, "Restaurants Ok"),
    fitRules(),
  )
  assert.equal(allowed.eligible, true)
  assert.equal(allowed.grade, "A")
  assert.equal(allowed.reasons.some((reason) => reason.ruleId === "hard.industry" && reason.result === "pass"), true)
})

test("soft NSF uses worst-month; hard NSF uses window unique days", async () => {
  const workspaceId = "workspace-score-nsf-split"
  const windowDq = await evaluateFunderScore(
    actor(workspaceId),
    { ...harborInputs, nsfCount: 5, nsfUnknown: false, worstMonthNsf: 1 },
    funderRecord("nsf-window", workspaceId, "Window NSF"),
    fitRules(),
  )
  assertHardDq(windowDq, "hard.nsf")

  const worstMonthSoft = await evaluateFunderScore(
    actor(workspaceId),
    { ...harborInputs, nsfCount: 1, nsfUnknown: false, worstMonthNsf: 4 },
    funderRecord("nsf-worst", workspaceId, "Worst Month NSF"),
    fitRules(),
  )
  assert.equal(worstMonthSoft.eligible, true)
  const nsfSoft = worstMonthSoft.reasons.find((reason) => reason.ruleId === "soft.nsf")
  assert.equal(nsfSoft?.result, "pass")
  assert.match(nsfSoft?.detail ?? "", /Worst-month NSF 4 scores 0 against maximum 4/)

  const unknownWorst = await evaluateFunderScore(
    actor(workspaceId),
    { ...harborInputs, nsfCount: 1, nsfUnknown: false, worstMonthNsf: undefined },
    funderRecord("nsf-unk", workspaceId, "Unknown Worst Month"),
    fitRules(),
  )
  assert.equal(unknownWorst.eligible, true)
  assert.equal(unknownWorst.reasons.find((reason) => reason.ruleId === "soft.nsf")?.result, "unknown")
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
  await seedReadyCompleteness(workspaceId, deal.id)
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
  await addKey(`score-other-${otherId}`, "score-other", ["deals:read", "deals:write"], otherId)

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
  assert.equal(postedBody.snapshot.policyVersion, POLICY_VERSION)
  assert.equal(postedBody.snapshot.scores.length > 0, true)
  assert.equal(postedBody.autoSelectableFunderIds.length, 1)

  const countBefore = await getDatabase().prepare<{ count: string }>("SELECT count(*) AS count FROM mca_score_snapshots WHERE workspace_id = ? AND deal_id = ?").get(workspaceId, deal.id)
  const fitResponse = await getFit(request("score-read"), params)
  assert.equal(fitResponse.status, 200)
  assert.equal(fitResponse.headers.get("cache-control"), "no-store")
  const fitBody = await fitResponse.json() as { contractVersion: number; brokerSelectionRequired: boolean; lenders: Array<{status:string}> }
  assert.equal(fitBody.contractVersion, 1)
  assert.equal(fitBody.brokerSelectionRequired, true)
  assert.equal(fitBody.lenders[0].status, "matched")
  const countAfter = await getDatabase().prepare<{ count: string }>("SELECT count(*) AS count FROM mca_score_snapshots WHERE workspace_id = ? AND deal_id = ?").get(workspaceId, deal.id)
  assert.deepEqual(countAfter,countBefore)
  assert.equal((await getFit(request("score-intake"),params)).status,403)
  assert.equal((await getFit(request("score-write"),params)).status,403)
  assert.equal((await getFit(request("score-other"),params)).status,404)
  const repActor = { ...actor(workspaceId), role: "rep" as const, membershipId: "unassigned-rep", userId: "unassigned-user" }
  await assert.rejects(() => getLenderFit(repActor,deal.id),(error:{status?:number}) => error.status === 404 || error.status === 403)
  const other = await postScores(request("score-other", "POST", "{}"), params)
  assert.equal(other.status, 404)
  await assert.rejects(
    () => getDealScores(actor(otherId), deal.id),
    (error: { status?: number; code?: string }) => error.status === 404 && error.code === "deal_not_found",
  )
})

test("requestedTermMonths persists and scoring inputs expose term, deposits, worst-month NSF, proposed positions", async () => {
  const workspaceId = `ws-term-${newId().slice(0, 8)}`
  await addWorkspace(workspaceId)
  const created = await createDeal(actor(workspaceId), {
    idempotencyKey: `term-${workspaceId}`,
    legalName: "Term Merchant LLC",
    entityType: "llc",
    address: { line1: "1 Harbor St", city: "Brooklyn", state: "NY", postalCode: "11201" },
    startDate: "2020-01-01",
    industry: "restaurants",
    naicsCode: "722511",
    monthlyRevenue: 20_000,
    ficoScore: 680,
    requestedAmount: 50_000,
    requestedTermMonths: 18,
    fundingPurpose: "working capital",
  })
  assert.equal(created.deal.requestedTermMonths, 18)
  const loaded = await getDealForDocument(actor(workspaceId), created.deal.id)
  assert.equal(loaded.requestedTermMonths, 18)

  const updated = await updateDealRecord(actor(workspaceId), created.deal.id, {
    expectedVersion: created.deal.version,
    requestedTermMonths: 24,
  })
  assert.equal(updated.requestedTermMonths, 24)

  const aggregate: UnderwritingAggregate = {
    dealId: created.deal.id,
    version: 1,
    monthlyRevenue: { value: 20_000, unknown: false, confidence: 1 },
    averageDailyBalance: { value: 8_000, unknown: false, confidence: 1 },
    nsfCount: { value: 3, unknown: false, confidence: 1 },
    negativeDays: { value: 0, unknown: false, confidence: 1 },
    depositCount: { value: 9, unknown: false, confidence: 1 },
    worstMonthNsf: { value: 2, unknown: false, confidence: 1 },
    warnings: [],
    positionCount: 1,
    stale: false,
    computedAt: "2026-09-08T00:00:00.000Z",
  }
  const positions: ExistingPositionCandidate[] = [
    {
      id: "pos-proposed",
      dealId: created.deal.id,
      label: "MCA ACH",
      status: "proposed",
      estimatedPayment: 500,
      evidence: "fixture",
    },
    {
      id: "pos-confirmed",
      dealId: created.deal.id,
      label: "Confirmed advance",
      status: "confirmed",
      estimatedPayment: 400,
      evidence: "fixture",
    },
    {
      id: "pos-dismissed",
      dealId: created.deal.id,
      label: "Noise",
      status: "dismissed",
      estimatedPayment: 100,
      evidence: "fixture",
    },
  ]
  const deal: DealRecord = { ...loaded, requestedTermMonths: 24, version: updated.version }
  const inputs = buildScoringInputs(deal, aggregate, [], positions)
  assert.equal(inputs.termMonths, 24)
  assert.equal(inputs.depositCount, 9)
  assert.equal(inputs.depositUnknown, false)
  assert.equal(inputs.worstMonthNsf, 2)
  assert.equal(inputs.proposedPositionCount, 1)
  assert.equal(inputs.positionCount, 1)
})

function position(
  dealId: string,
  label: string,
  status: ExistingPositionCandidate["status"],
  id = newId(),
): ExistingPositionCandidate {
  return { id, dealId, label, status, evidence: "fixture", estimatedPayment: 100 }
}

test("resolveDefaultFlag: confirmed defaultish labels and DataMerch Default/Slow pay only", () => {
  assert.equal(resolveDefaultFlag([], null), false)
  assert.equal(resolveDefaultFlag([], undefined), false)

  assert.equal(resolveDefaultFlag([position("d", "Default - Xpress", "confirmed")]), true)
  assert.equal(resolveDefaultFlag([position("d", "merchant defaulted", "confirmed")]), true)
  assert.equal(resolveDefaultFlag([position("d", "defaults on ACH", "confirmed")]), true)
  assert.equal(resolveDefaultFlag([position("d", "Slow pay funder", "confirmed")]), true)
  assert.equal(resolveDefaultFlag([position("d", "slow-pay", "confirmed")]), true)
  assert.equal(resolveDefaultFlag([position("d", "slow_pay account", "confirmed")]), true)

  assert.equal(resolveDefaultFlag([position("d", "OCR default position", "proposed")]), false)
  assert.equal(resolveDefaultFlag([position("d", "Default - dismissed", "dismissed")]), false)
  assert.equal(resolveDefaultFlag([position("d", "active MCA", "confirmed")]), false)

  assert.equal(resolveDefaultFlag([], { status: "records", merchants: [{ records: [{ category: "Default" }] }] }), true)
  assert.equal(resolveDefaultFlag([], { status: "records", merchants: [{ records: [{ category: "Slow pay" }] }] }), true)
  assert.equal(resolveDefaultFlag([], { status: "records", merchants: [{ records: [{ category: "Inquiry" }] }] }), false)
  assert.equal(resolveDefaultFlag([], { status: "no_result", merchants: [{ records: [{ category: "Default" }] }] }), false)
  assert.equal(resolveDefaultFlag([], { status: "failed", merchants: [{ records: [{ category: "Default" }] }] }), false)
  assert.equal(resolveDefaultFlag([], { status: "queued" }), false)
})

test("buildScoringInputs defaultFlag ignores deal.status; proposed OCR default does not count", async () => {
  const workspaceId = `ws-default-flag-${newId().slice(0, 8)}`
  await addWorkspace(workspaceId)
  const created = await createDeal(actor(workspaceId), {
    idempotencyKey: `default-flag-${workspaceId}`,
    legalName: "Default Flag Merchant LLC",
    entityType: "llc",
    address: { line1: "1 Harbor St", city: "Brooklyn", state: "NY", postalCode: "11201" },
    startDate: "2020-01-01",
    industry: "restaurants",
    naicsCode: "722511",
    monthlyRevenue: 20_000,
    ficoScore: 680,
    requestedAmount: 50_000,
    fundingPurpose: "working capital",
  })
  const deal: DealRecord = { ...created.deal, status: "default" }

  assert.equal(buildScoringInputs(deal, null, [], []).defaultFlag, false)
  assert.equal(
    buildScoringInputs(deal, null, [], [position(deal.id, "OCR default from statement", "proposed")]).defaultFlag,
    false,
  )
  assert.equal(
    buildScoringInputs(deal, null, [], [position(deal.id, "Confirmed default position", "confirmed")]).defaultFlag,
    true,
  )
  assert.equal(
    buildScoringInputs(
      deal,
      null,
      [],
      [],
      { status: "records", merchants: [{ records: [{ category: "Default" }] }] },
    ).defaultFlag,
    true,
  )
  assert.equal(
    buildScoringInputs(deal, null, [], [], null).defaultFlag,
    false,
  )
})

test("scoreDeal loads latest DataMerch records for defaultFlag hard DQ", async () => {
  const workspaceId = `ws-dm-default-${newId().slice(0, 8)}`
  await addWorkspace(workspaceId)
  const deal = await merchantDeal(workspaceId, "dm-default")
  await seedFunder(workspaceId, "dm-default-fit", fitRules())

  const without = await scoreDeal(actor(workspaceId), deal.id)
  const withoutScore = without.snapshot.scores[0]
  assert.ok(withoutScore)
  assert.equal(withoutScore.eligible, true)
  assert.equal(withoutScore.reasons.some((reason) => reason.ruleId === "hard.default_status" && reason.result === "pass"), true)

  await insertCheck({
    id: newId(),
    workspaceId,
    dealId: deal.id,
    dealVersion: deal.version,
    status: "records",
    correlationId: `corr-dm-default-${workspaceId}`,
    resultSummary: "1 record",
    recordCount: 1,
    queryKind: "legal_name",
    merchants: [{ name: deal.legalName, records: [{ category: "Slow pay", notes: "ACH returned", funder: "North" }] }],
    createdAt: new Date().toISOString(),
  })

  const withDefault = await scoreDeal(actor(workspaceId), deal.id)
  const blocked = withDefault.snapshot.scores[0]
  assert.ok(blocked)
  assert.equal(blocked.eligible, false)
  assert.equal(blocked.grade, "DQ")
  assert.equal(blocked.reasons.some((reason) => reason.ruleId === "hard.default_status" && reason.result === "fail"), true)
})

test("empty and unspecified criteria cannot be a configured match", async () => {
  const lender=funderRecord("empty-fit", "w", "Synthetic")
  const empty=await evaluateFunderScore({workspaceId:"w"} as DealActor,harborInputs,lender,[],"2026-10-01T00:00:00Z")
  assert.equal(empty.fitStatus,"needs_review")
  assert.equal(empty.eligible,false)
  const unspecified=await evaluateFunderScore({workspaceId:"w"} as DealActor,harborInputs,lender,[{id:"u",funderId:lender.id,field:"fico",operator:"min",unit:"fico",value:null,unspecified:true}],"2026-10-01T00:00:00Z")
  assert.equal(unspecified.fitStatus,"needs_review")
  assert.equal(unspecified.eligible,false)
})

test("provenance, expiry and inactivity control suggested fits deterministically", async () => {
  const lender=funderRecord("dated-fit", "w", "Synthetic")
  const rule:EligibilityRule={id:"dated",funderId:lender.id,field:"fico",operator:"min",unit:"fico",value:600,unspecified:false,sourceText:"Synthetic policy",sourceAsOf:"2026-09-01",validUntil:"2026-10-01"}
  const a={workspaceId:"w"} as DealActor
  const matched=await evaluateFunderScore(a,harborInputs,lender,[rule],"2026-10-01T00:00:00Z")
  assert.equal(matched.fitStatus,"matched")
  assert.deepEqual(await evaluateFunderScore(a,harborInputs,lender,[rule],"2026-10-01T00:00:00Z"),matched)
  assert.equal((await evaluateFunderScore(a,harborInputs,lender,[rule],"2026-10-02T00:00:00Z")).fitStatus,"stale_criteria")
  assert.equal((await evaluateFunderScore(a,harborInputs,{...lender,active:false},[rule],"2026-10-01T00:00:00Z")).fitStatus,"inactive")
  const unknown=await evaluateFunderScore(a,harborInputs,lender,[{...rule,sourceAsOf:undefined}],"2026-10-01T00:00:00Z")
  assert.equal(unknown.fitStatus,"needs_review")
  assert.deepEqual(autoSelectableFunderIds([{...unknown,rank:1,grade:"A"}]),[])
})

test("active changes invalidate snapshots and inactive lenders remain explained", async () => {
  const ws=`ws-score-active-${newId().slice(0,8)}`
  await addWorkspace(ws)
  const deal=await merchantDeal(ws,"active-drift")
  const id=await seedFunder(ws,"active-lender",fitRules())
  await scoreDeal(actor(ws),deal.id)
  await exec("UPDATE mca_funders SET active=0 WHERE workspace_id=? AND id=?",ws,id)
  assert.equal((await getDealScores(actor(ws),deal.id)).stale,true)
  assert.equal((await getLenderFit(actor(ws),deal.id)).lenders[0].status,"inactive")
  const inactive=await scoreDeal(actor(ws),deal.id)
  assert.equal(inactive.snapshot.scores[0].fitStatus,"inactive")
  await exec("UPDATE mca_funders SET active=1 WHERE workspace_id=? AND id=?",ws,id)
  assert.equal((await getDealScores(actor(ws),deal.id)).stale,true)
  assert.equal((await getLenderFit(actor(ws),deal.id)).lenders[0].score,null)
})

test("configured expiry invalidates actionable snapshot reads without inserting another snapshot", async () => {
  const ws=`ws-score-expiry-${newId().slice(0,8)}`
  await addWorkspace(ws)
  const deal=await merchantDeal(ws,"expiry-drift")
  const id=await seedFunder(ws,"expiry-lender",fitRules())
  const scored=await scoreDeal(actor(ws),deal.id)
  // Model a date boundary passing after scoring; preserve criterion version as time alone would.
  await exec("UPDATE mca_funder_criteria SET valid_until='2026-01-02' WHERE workspace_id=? AND funder_id=?",ws,id)
  const read=await getLenderFit(actor(ws),deal.id)
  assert.equal(read.snapshotId,scored.snapshot.id)
  assert.equal(read.stale,true)
  assert.equal(read.lenders[0].status,"stale_criteria")
  assert.equal(read.lenders[0].score,null)
  assert.deepEqual((await getDealScores(actor(ws),deal.id)).autoSelectableFunderIds,[])
})
