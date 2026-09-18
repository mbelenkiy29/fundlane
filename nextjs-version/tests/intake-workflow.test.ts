import { storeDocument } from "../src/lib/mca/documents/service"
import { updateDocumentScan } from "../src/lib/mca/documents/repository"
import "./helpers/business-auth"
import test, { after, before } from "node:test"
import assert from "node:assert/strict"
import { generateKeyPairSync, sign } from "node:crypto"
import { closeDatabaseForTests, getDatabase, newId } from "../src/lib/mca/db"
import { createPostgresTestDatabase } from "./helpers/postgres-test-db.mjs"
import type { MembershipContext } from "../src/lib/mca/types"
import type { DealActor } from "../src/lib/mca/deals/schema"
import { getDeal } from "../src/lib/mca/deals/service"
import { setDocumentStorageForTests, type DocumentStorage } from "../src/lib/mca/documents/storage"
import { setDocumentScannerForTests } from "../src/lib/mca/documents/scanner"
import { configureIntegration } from "../src/lib/mca/intake/configuration"
import { ingestProviderDelivery } from "../src/lib/mca/intake/ingress"
import { findIntake, listAttachmentJobs } from "../src/lib/mca/intake/repository"
import { ingestApplication, listIntakeSummaries } from "../src/lib/mca/intake/service"
import { intakeProgress, processIntakeJob, retryIntakeProcessing, scheduleIntakeProcessing } from "../src/lib/mca/intake/processing"
import { claimBackgroundJob, completeBackgroundJob, failBackgroundJob, getBackgroundJob } from "../src/lib/mca/jobs/queue"
import { setStatementExtractionProviderForTests, listStatementMonths } from "../src/lib/mca/underwriting/statements"
import { correctStatementMonth } from "../src/lib/mca/underwriting/corrections"
import { updateAnalysisSettings, analysisQueueCallsForTests } from "../src/lib/mca/underwriting/analysis"
import { getCompleteness } from "../src/lib/mca/underwriting/completeness"
import type { EligibilityRule } from "../src/lib/mca/funders/contracts"
let testDatabase: Awaited<ReturnType<typeof createPostgresTestDatabase>>


const ids = {
  workspace: "10000000-0000-4000-8000-000000000001",
  adminUser: "10000000-0000-4000-8000-000000000002",
  adminMember: "10000000-0000-4000-8000-000000000003",
  repAUser: "10000000-0000-4000-8000-000000000004",
  repAMember: "10000000-0000-4000-8000-000000000005",
  repBUser: "10000000-0000-4000-8000-000000000006",
  repBMember: "10000000-0000-4000-8000-000000000007",
}

const adminContext: MembershipContext = { authType: "session", userId: ids.adminUser, membershipId: ids.adminMember, workspaceId: ids.workspace, role: "admin", scopes: [], sessionId: "fixture-session" }
const adminActor: DealActor = { workspaceId: ids.workspace, userId: ids.adminUser, membershipId: ids.adminMember, role: "admin", managedMembershipIds: [], activeMembershipIds: [ids.adminMember, ids.repAMember, ids.repBMember], source: "user", correlationId: "intake-admin" }
const repActor = (membershipId: string, userId: string): DealActor => ({ workspaceId: ids.workspace, userId, membershipId, role: "rep", managedMembershipIds: [], activeMembershipIds: [ids.adminMember, ids.repAMember, ids.repBMember], source: "user", correlationId: `intake-${membershipId}` })

const memory = new Map<string, Uint8Array>()
const storage: DocumentStorage = {
  name: "intake-memory",
  async putImmutable(key, bytes) { if (!memory.has(key)) memory.set(key, new Uint8Array(bytes)) },
  async get(key) { const value = memory.get(key); if (!value) throw new Error("missing test document"); return new Uint8Array(value) },
}

async function seed() {
  const database = getDatabase(); const now = new Date().toISOString()
  await database.prepare(`INSERT INTO workspaces (id,name,timezone,seat_limit,feature_flags,page_visibility,action_visibility,created_at,updated_at)
    VALUES (?, 'Intake Test', 'America/New_York', 10, ?, ?, ?, ?, ?)`).run(ids.workspace, JSON.stringify({ reports: true, payments: true, integrations: true }), JSON.stringify({ dashboard: true, deals: true, users: true, reports: true, payments: true, workspace: true, integrations: true }), JSON.stringify({ createDeal: true, exportDeals: true, inviteUsers: true, manageApiKeys: true, viewPaymentTable: true, viewCompanyFinancials: true }), now, now)
  for (const [userId, memberId, email, role] of [
    [ids.adminUser, ids.adminMember, "admin@example.test", "admin"],
    [ids.repAUser, ids.repAMember, "rep-a@example.test", "rep"],
    [ids.repBUser, ids.repBMember, "rep-b@example.test", "rep"],
  ]) {
    await database.prepare(`INSERT INTO users (id,email,password_hash,name,phone,application_identifier,created_at,updated_at)
      VALUES (?, ?, NULL, ?, NULL, ?, ?, ?)`).run(userId, email, email, `APP-${String(userId).slice(-6)}`, now, now)
    await database.prepare(`INSERT INTO memberships (id,workspace_id,user_id,role,manager_membership_id,status,sender_association,created_at,updated_at)
      VALUES (?, ?, ?, ?, NULL, 'active', NULL, ?, ?)`).run(memberId, ids.workspace, userId, role, now, now)
  }
}

before(async () => {
  testDatabase = await createPostgresTestDatabase("intake_workflow")
  Object.assign(process.env, testDatabase.env())
  delete process.env.MCA_BACKGROUND_JOBS
  delete process.env.VERCEL
  await seed()
  setDocumentStorageForTests(storage)
  setDocumentScannerForTests({ name: "intake-clean-fixture", async scan() { return { status: "clean", provider: "intake-clean-fixture", evidence: { fixture: true } } } })
})
after(async () => { setStatementExtractionProviderForTests(); setDocumentStorageForTests(); setDocumentScannerForTests(); await closeDatabaseForTests(); await testDatabase.close() })

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

async function exec(sql: string, ...values: unknown[]) { return getDatabase().prepare(sql).run(...values) }
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

const periods = Array.from({ length: 3 }, (_, index) => {
  const now = new Date(); return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - index, 1)).toISOString().slice(0, 7)
})
let extractionCalls = 0
function extraction() {
  setStatementExtractionProviderForTests({ name: "intake-fixture", async extractStatement(_actor, input) {
    extractionCalls++
    const period = Buffer.from(input.bytes).toString().match(/PERIOD:(\d{4}-\d{2})/)?.[1] ?? periods[0]
    const metric = (value: number) => ({ value, unknown: false, confidence: 0.99 })
    return { provider: "intake-fixture", period, accountKind: "checking", accountSuffix: "0123", deposits: metric(142000), depositCount: metric(50), averageDailyBalance: metric(30000), nsfCount: metric(0), negativeDays: metric(0), endingBalance: metric(35000), positions: [], warnings: [] }
  } })
}
const attachmentOptions = {
  lookupImpl: async () => [{ address: "203.0.113.26", family: 4 }],
  fetchImpl: async (input: string | URL | Request) => {
    const text = String(input)
    const period = periods.find(p => text.includes(p)) ?? periods[0]
    return new Response(Buffer.from(`%PDF-1.4\nPERIOD:${period}\n${text}\n%%EOF\n`), { headers: { "content-type": "application/pdf" } })
  },
}
async function drain() {
  let count = 0
  for (;;) {
    const job = await claimBackgroundJob()
    if (!job) return count
    assert.equal(job.kind, "intake_process")
    try { const result = await processIntakeJob(job, attachmentOptions); await completeBackgroundJob(job,result) }
    catch(error) { await failBackgroundJob(job,error); throw error }
    count++
    assert.ok(count < 30, "no endless processing loop")
  }
}
async function connection(provider: "jotform" | "custom" | "highlevel" | "zoho", binding = newId()) {
  return configureIntegration(adminContext, { provider, displayName: `${provider} intake`, ...(provider === "highlevel" ? { locationId: binding } : { formId: binding }),
    automaticProcessing: true, assignmentPool: [ids.repAMember], initialStatus: "new_application", credential: "fixture-read-token",
    credentialExpiresAt: new Date(Date.now()+3600000).toISOString(), allowedHosts: ["www.jotform.com"], mapping: provider === "zoho" ? { legalName:"legalName", requestedAmount:"requestedAmount", startDate:"startDate", ficoScore:"ficoScore", industry:"industry", naicsCode:"naicsCode", entityType:"entityType", "address.state":"address.state" } : {},
  })
}
async function deliver(c: Awaited<ReturnType<typeof connection>>, eventId: string, includeFiles = true) {
  const provider = c.status.provider
  const application = { legalName: "Bayside Diner", requestedAmount: 75000, monthlyRevenue: 142000, startDate: "2020-01-01", ficoScore: 720, industry: "restaurants", naicsCode: "722511", entityType: "llc", address: { state: "NY" } }
  const attachments = includeFiles ? [{ id: "application", filename: "application.pdf", url: "https://www.jotform.com/files/application.pdf", category: "application" }, ...periods.map(period => ({ id: period, filename: `statement-${period}.pdf`, url: `https://www.jotform.com/files/${period}.pdf`, category: "statement" }))] : []
  const binding = c.status.binding
  const body = provider === "jotform" ? { formID: binding, submissionID: eventId, rawRequest: JSON.stringify(application), attachments }
    : provider === "highlevel" ? { locationId: binding, webhookId: eventId, ...application, attachments }
    : provider === "zoho" ? { formId: binding, entryId: eventId, ...application, ...(includeFiles ? { applicationFile:"https://drive.google.com/file/d/application_0123456789/view", statementFile: periods.map(p => `https://drive.google.com/file/d/bank_${p}_0123456789/view`) } : {}) }
    : { formId: binding, eventId, application, attachments }
  const rawBody = JSON.stringify(body)
  const headers: Record<string,string> = { authorization:`Bearer ${c.admissionSecret}` }
  if (provider === "highlevel") {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519")
    process.env.MCA_HIGHLEVEL_WEBHOOK_PUBLIC_KEY = publicKey.export({type:"spki",format:"pem"}).toString()
    headers["x-ghl-signature"] = sign(null,Buffer.from(rawBody),privateKey).toString("base64")
  }
  return ingestProviderDelivery({ provider, integrationId:c.status.id, rawBody, request:new Request("https://mca.example.test/hook",{method:"POST",headers,body:rawBody}) })
}

test("all four providers run durable intake through ready statements and review-only funder selection", async () => {
  extraction()
  await seedFunder(ids.workspace,"ready-funder",fitRules())
  await updateAnalysisSettings(adminActor,{ mode:"automatic_send", automaticSendEnabled:true, reviewNotificationChannel:"both" })
  for (const provider of ["jotform","highlevel","zoho","custom"] as const) {
    const c = await connection(provider)
    const result = await deliver(c, "same-provider-event")
    assert.equal((await getDeal(adminActor,result.dealId!)).assignments[0].membershipId,ids.repAMember)
    assert.equal(await scheduleIntakeProcessing(100),1)
    assert.equal(await drain(),1)
    const progress = await intakeProgress(ids.workspace,result.intakeId)
    assert.equal(progress?.state,"ready_for_review",JSON.stringify(progress))
    assert.equal(progress?.matchedCount,1)
    const analysis = await getDatabase().prepare<{ mode:string; review_notification_channel:string; queued:number }>("SELECT mode,review_notification_channel,queued FROM mca_analysis_runs WHERE id=?").get(progress!.analysisRunId!)
    assert.equal(analysis?.mode,"review_first"); assert.equal(analysis?.review_notification_channel,"select_only"); assert.equal(Boolean(analysis?.queued),false)
    assert.equal((await listAttachmentJobs(ids.workspace,result.intakeId)).filter(a=>a.state==="stored").length,4)
    assert.equal(await scheduleIntakeProcessing(100),0)
  }
  assert.equal(analysisQueueCallsForTests().length,0)
  const mail = await getDatabase().prepare<{ count:number }>("SELECT COUNT(*)::int AS count FROM audit_events WHERE action='review.email_sent'").get()
  assert.equal(mail?.count,0)
})

test("parallel delivery deduplicates within a connection and isolates equal event IDs across forms", async () => {
  const a=await connection("custom"), b=await connection("custom")
  const [first,retry]=await Promise.all([deliver(a,"concurrent"),deliver(a,"concurrent")])
  assert.equal(first.dealId,retry.dealId)
  const distinct=await deliver(b,"concurrent")
  assert.notEqual(first.dealId,distinct.dealId)
  await Promise.all([scheduleIntakeProcessing(100),scheduleIntakeProcessing(100)])
  assert.equal(await drain(),2)
})

test("late files resume the same deal and financial corrections refresh matches without replacing reviewed values", async () => {
  const c=await connection("custom"), first=await deliver(c,"late",false)
  await scheduleIntakeProcessing(100); await drain()
  assert.equal((await intakeProgress(ids.workspace,first.intakeId))?.state,"needs_attention")
  const later=await deliver(c,"late",true)
  assert.equal(first.dealId,later.dealId)
  await scheduleIntakeProcessing(100); await drain()
  const original=await intakeProgress(ids.workspace,first.intakeId)
  const completeness=await getCompleteness(adminActor,first.dealId!)
  const month=(await listStatementMonths(adminActor,first.dealId!))[0]
  const calls=extractionCalls
  await correctStatementMonth(adminActor,{dealId:first.dealId!,monthId:month.id,reason:"Verified deposits against bank statement",deposits:150000})
  assert.equal(await scheduleIntakeProcessing(100),1); await drain()
  assert.notEqual((await intakeProgress(ids.workspace,first.intakeId))?.analysisRunId,original?.analysisRunId)
  assert.equal((await getCompleteness(adminActor,first.dealId!))?.version,completeness?.version)
  assert.equal((await listStatementMonths(adminActor,first.dealId!)).find(m=>m.id===month.id)?.deposits.value,150000)
  assert.equal(extractionCalls,calls)
  assert.equal(await scheduleIntakeProcessing(100),0)
})

test("visibility, explicit retries, inactive reps, and paused integration authority are enforced", async () => {
  const c=await connection("custom"), result=await deliver(c,"access",false)
  const repB=repActor(ids.repBMember,ids.repBUser)
  assert.equal((await listIntakeSummaries(repB)).some(i=>i.intakeId===result.intakeId),false)
  await assert.rejects(()=>retryIntakeProcessing(repB,result.intakeId))
  await assert.rejects(()=>retryIntakeProcessing({...adminActor,workspaceId:"foreign"},result.intakeId))
  await retryIntakeProcessing(repActor(ids.repAMember,ids.repAUser),result.intakeId)
  const job=await claimBackgroundJob(); assert.ok(job)
  await assert.rejects(()=>getBackgroundJob(repActor(ids.repAMember,ids.repAUser),job.id))
  await exec("UPDATE intake_integrations SET enabled=0 WHERE id=?",c.status.id)
  await assert.rejects(()=>processIntakeJob(job,attachmentOptions),(error:{code:string})=>error.code==="intake_automation_paused")
  await failBackgroundJob(job,Object.assign(new Error("paused"),{status:409}))
  await exec("UPDATE mca_background_jobs SET state='failed' WHERE id=?",job.id)
  assert.equal((await intakeProgress(ids.workspace,result.intakeId))?.state,"paused")
  await exec("UPDATE memberships SET status='deactivated' WHERE id=?",ids.repAMember)
  const d=await configureIntegration(adminContext,{ provider:"custom",displayName:"Legacy unassigned",formId:newId() })
  const unassigned=await deliver(d,"no-rep",false)
  assert.equal((await getDeal(adminActor,unassigned.dealId!)).assignments.length,0)
  assert.ok((await findIntake(ids.workspace,unassigned.intakeId))?.warnings.some(w=>w.startsWith("Assignment needed:")))
  await exec("UPDATE memberships SET status='active' WHERE id=?",ids.repAMember)
})

test("expired worker leases recover without extracting statements twice", async () => {
  const c=await connection("custom"), result=await deliver(c,"worker-restart")
  await scheduleIntakeProcessing(100)
  const job=await claimBackgroundJob(); assert.ok(job)
  await processIntakeJob(job,attachmentOptions)
  const progress=await intakeProgress(ids.workspace,result.intakeId), calls=extractionCalls
  await exec("UPDATE mca_background_jobs SET lease_expires_at='2000-01-01' WHERE id=?",job.id)
  assert.equal(await drain(),1)
  assert.equal(extractionCalls,calls)
  assert.equal((await intakeProgress(ids.workspace,result.intakeId))?.analysisRunId,progress?.analysisRunId)
})

test("expired private credentials and quarantined files never produce ready matches", async () => {
  const c=await connection("custom"), result=await deliver(c,"expired-read")
  await exec("UPDATE intake_integrations SET credential_expires_at='2000-01-01' WHERE id=?",c.status.id)
  await scheduleIntakeProcessing(100); await drain()
  assert.equal((await intakeProgress(ids.workspace,result.intakeId))?.state,"needs_attention")
  await exec("UPDATE intake_integrations SET credential_expires_at=NULL WHERE id=?",c.status.id)
  await retryIntakeProcessing(adminActor,result.intakeId)
  // Existing quarantine must still block intake even after a later clean scanner is configured.
  const blocked = await storeDocument(adminActor, { dealId: result.dealId!, idempotencyKey: "legacy-quarantine", filename: "blocked.pdf", mimeType: "application/pdf", bytes: new Uint8Array(Buffer.from("%PDF-1.4\n%%EOF\n")), category: "statement", source: "test" })
  await updateDocumentScan(ids.workspace, blocked.id, "quarantined", "legacy-scanner", { signatureDetected: true }, new Date().toISOString())
  await drain()
  assert.equal((await intakeProgress(ids.workspace,result.intakeId))?.stages.documents.state,"blocked")
  setDocumentScannerForTests({name:"clean-fixture",async scan(){return {status:"clean",provider:"clean-fixture",evidence:{fixture:true}}}})
})

test("existing connections keep manual defaults; new automation requires a fallback and preserves historical deals", async () => {
  await assert.rejects(()=>configureIntegration(adminContext,{provider:"custom",displayName:"No fallback",formId:newId(),automaticProcessing:true}),(error:{code:string})=>error.code==="assignment_required")
  const c=await configureIntegration(adminContext,{provider:"custom",displayName:"Existing form",formId:newId()})
  assert.equal(c.status.automaticProcessing,false)
  const old=await deliver(c,"historical")
  await configureIntegration(adminContext,{id:c.status.id,provider:"custom",displayName:c.status.displayName,formId:c.status.binding!,automaticProcessing:true,assignmentPool:[ids.repAMember]})
  await scheduleIntakeProcessing(100)
  assert.equal(await intakeProgress(ids.workspace,old.intakeId),undefined)
  const generic=await ingestApplication(adminActor,{schemaVersion:1,provider:"custom",eventId:"generic-retry",application:{legalName:"Generic"}})
  assert.equal((await ingestApplication(adminActor,{schemaVersion:1,provider:"custom",eventId:"generic-retry",application:{legalName:"Generic"}})).dealId,generic.dealId)
})
