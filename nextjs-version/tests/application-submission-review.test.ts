import test, { before, after } from "node:test"
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { PDFDocument } from "pdf-lib"
import { downloadApprovedPortalDocument, listPortalBoard } from "../src/lib/mca/submissions/portal"
import { updateStampSettings } from "../src/lib/mca/submissions/stamps"
import { createPostgresTestDatabase } from "./helpers/postgres-test-db.mjs"
import { closeDatabaseForTests, getDatabase, newId } from "../src/lib/mca/db"
import type { DealActor } from "../src/lib/mca/deals/schema"
import { createDeal } from "../src/lib/mca/deals/service"
import { reserveIntake, updateIntake, saveIntegration } from "../src/lib/mca/intake/repository"
import { prepareApplicationSubmission, sendApplicationSubmission } from "../src/lib/mca/intake/submission-review"
import { setDocumentScannerForTests } from "../src/lib/mca/documents/scanner"
import { setDocumentStorageForTests } from "../src/lib/mca/documents/storage"
import { storeDocument } from "../src/lib/mca/documents/service"
import { createFunder } from "../src/lib/mca/funders/directory"
import { createSender, testSend } from "../src/lib/mca/senders/service"
import { setSenderDeliveryFetchForTests } from "../src/lib/mca/senders/delivery"
import { setEmailDeliveryFetchForTests, upsertSubmissionEmailTemplate } from "../src/lib/mca/submissions/email-templates"
import { processJobDelivery, reconcileUncertainDelivery } from "../src/lib/mca/submissions/outbox"
import { listJobsForDeal, persistNewDestination, insertAttempt, updateJobRecord } from "../src/lib/mca/submissions/repository"
import { checkCompleteness } from "../src/lib/mca/underwriting/completeness"
import { runAnalysis } from "../src/lib/mca/underwriting/analysis"

let database: Awaited<ReturnType<typeof createPostgresTestDatabase>>
const actor: DealActor = { workspaceId: newId(), userId: "t2-application-broker", membershipId: null, role: "admin", managedMembershipIds: [], activeMembershipIds: [], source: "user", correlationId: newId() }
const memory = new Map<string, Uint8Array>()
const integrationId = newId()
let portalFunderId: string
let funderId: string
const sent: Array<{subject:string;body:string;to:string[];attachments:unknown[]}> = []
before(async () => {
  database = await createPostgresTestDatabase("application_submission_review")
  Object.assign(process.env, database.env())
  delete process.env.MCA_BACKGROUND_JOBS
  delete process.env.VERCEL
  process.env.MCA_EMAIL_WEBHOOK_URL = "https://email.example.test/send"
  setDocumentStorageForTests({ name: "memory", async putImmutable(key, bytes) { memory.set(key,new Uint8Array(bytes)) }, async get(key) { const bytes=memory.get(key); if(!bytes) throw Error("missing");return bytes } })
  setDocumentScannerForTests({ name: "clean", async scan() { return {status:"clean",provider:"clean",evidence:{engineVerified:true}} } })
  setSenderDeliveryFetchForTests(async()=>new Response("ok"))
  setEmailDeliveryFetchForTests(async(_url,init)=>{ sent.push(JSON.parse(String(init?.body)));return new Response("ok") })
  const now = new Date().toISOString()
  await getDatabase().prepare(`INSERT INTO workspaces(id,name,timezone,seat_limit,feature_flags,page_visibility,action_visibility,created_at,updated_at) VALUES (?,'Review','UTC',10,'{}','{"deals":true}','{"createDeal":true}',?,?)`).run(actor.workspaceId,now,now)
  await getDatabase().prepare("INSERT INTO users(id,email,password_hash,name,application_identifier,created_at,updated_at) VALUES (?,'t2-review@example.test',NULL,'Fixture Broker','APP-T2REVIEW',?,?)").run(actor.userId,now,now)
  await saveIntegration({ id: integrationId, workspaceId: actor.workspaceId, provider: "custom", displayName: "Application", enabled: true, approvalState: "approved", mapping: {}, allowedHosts: [], senderRules: [], assignmentPool: [], initialStatus: "new_application" })
  await getDatabase().prepare("UPDATE intake_integrations SET automatic_processing=1 WHERE id=?").run(integrationId)
  const sender = await createSender(actor,{provider:"smtp",purpose:"submission",fromName:"Desk",fromAddress:"desk@example.test",isDefault:true,smtp:{host:"smtp.example.test",port:587,username:"desk",password:"secret"}})
  await testSend(actor,sender.id,{to:"ops@example.test"})
  portalFunderId=(await createFunder(actor,{idempotencyKey:newId(),legalName:"Portal Capital",routes:[{kind:"manual_portal",label:"Portal",destination:"https://portal.example.test/submit",documentExceptions:[],active:true}]})).funder.id
  funderId=(await createFunder(actor,{idempotencyKey:newId(),legalName:"Review Capital",routes:[{kind:"email",label:"Email",destination:"lender@example.test",documentExceptions:[],active:true}]})).funder.id
})
after(async()=>{setDocumentStorageForTests();setDocumentScannerForTests();setEmailDeliveryFetchForTests();setSenderDeliveryFetchForTests();await closeDatabaseForTests();await database?.close()})
async function readyApplication() {
  const deal=(await createDeal(actor,{idempotencyKey:newId(),legalName:"Bakery",monthlyRevenue:100000,requestedAmount:25000})).deal
  const intake=(await reserveIntake(actor.workspaceId,{schemaVersion:1,provider:"custom",eventId:newId(),application:{legalName:"Bakery"}},newId(),integrationId)).record
  await updateIntake({workspaceId:actor.workspaceId,intakeId:intake.intakeId,state:"created",dealId:deal.id})
  const jobsMode = process.env.MCA_BACKGROUND_JOBS
  delete process.env.MCA_BACKGROUND_JOBS
  const pdf = await PDFDocument.create()
  pdf.addPage().drawText("Application package")
  await storeDocument(actor,{dealId:deal.id,idempotencyKey:newId(),filename:"application.pdf",mimeType:"application/pdf",bytes:await pdf.save(),category:"application",source:"test"})
  if (jobsMode) process.env.MCA_BACKGROUND_JOBS = jobsMode
  await checkCompleteness(actor,deal.id)
  // Fixture isolates approval flow; completeness evaluation has its own integration tests.
  await getDatabase().prepare("UPDATE mca_completeness_results SET ready=1 WHERE workspace_id=? AND deal_id=?").run(actor.workspaceId,deal.id)
  const timestamp = new Date().toISOString()
  await getDatabase().prepare("INSERT INTO intake_processing(intake_id,workspace_id,progress_json,checked_at,updated_at) VALUES (?,?,?,?,?)").run(intake.intakeId,actor.workspaceId,JSON.stringify({state:"ready_for_review",stages:{}}),timestamp,timestamp)
  const scores=await runAnalysis(actor,deal.id,{mode:"review_first",reviewNotificationChannel:"select_only"})
  assert.equal(scores.snapshot.scores.find(s=>s.funderId===funderId)?.eligible,true)
  await getDatabase().prepare("UPDATE mca_score_snapshots SET scores_json=? WHERE id=?").run(JSON.stringify(scores.snapshot.scores.map(score=>({...score,grade:"A",score:90}))),scores.snapshot.id)
  await getDatabase().prepare("UPDATE mca_analysis_runs SET state='review_pending' WHERE id=?").run(scores.run.id)
  return {intakeId:intake.intakeId,dealId:deal.id}
}
test("prepare has no delivery jobs; rejects stale templates; explicit concurrent send is once",async()=>{
  const item=await readyApplication()
  const before=sent.length
  const preview=await prepareApplicationSubmission(actor,item.intakeId,[funderId])
  assert.equal(preview.destinations[0].email?.to[0],"lender@example.test")
  assert.equal((await listJobsForDeal(actor.workspaceId,item.dealId)).length,0)
  assert.equal(sent.length,before)
  await upsertSubmissionEmailTemplate(actor,{subjectTemplate:"Approved bakery",bodyTemplate:"Approved package"})
  await assert.rejects(()=>sendApplicationSubmission(actor,item.intakeId,preview.id),{code:"submission_preview_stale"})
  assert.equal((await listJobsForDeal(actor.workspaceId,item.dealId)).length,0)
  const refreshed=await prepareApplicationSubmission(actor,item.intakeId,[funderId])
  const [first,second]=await Promise.all([sendApplicationSubmission(actor,item.intakeId,refreshed.id),sendApplicationSubmission(actor,item.intakeId,refreshed.id)])
  assert.equal(first.jobs[0].jobId,second.jobs[0].jobId)
  assert.equal(sent.length,before+1)
  await sendApplicationSubmission(actor,item.intakeId,refreshed.id)
  assert.equal(sent.length,before+1)
  const row=await getDatabase().prepare<{approved_package_cipher:string}>("SELECT approved_package_cipher FROM mca_submission_jobs WHERE id=?").get(first.jobs[0].jobId)
  assert.ok(row?.approved_package_cipher)
  assert.ok(!row.approved_package_cipher.includes("Approved bakery"))
})
test("queued job delivers the frozen email after template changes; byte changes fail closed",async()=>{
  process.env.MCA_BACKGROUND_JOBS="enabled"
  const item=await readyApplication()
  const preview=await prepareApplicationSubmission(actor,item.intakeId,[funderId])
  const count=sent.length
  await sendApplicationSubmission(actor,item.intakeId,preview.id)
  await upsertSubmissionEmailTemplate(actor,{subjectTemplate:"Changed after approval",bodyTemplate:"Changed"})
  const [job]=await listJobsForDeal(actor.workspaceId,item.dealId)
  await Promise.all([processJobDelivery(job),processJobDelivery(job)])
  assert.equal(sent.length,count+1)
  assert.equal(sent.at(-1)?.subject,preview.destinations[0].email?.subject)
  assert.equal(sent.at(-1)?.body,preview.destinations[0].email?.body)
  const second=await readyApplication()
  const other=await prepareApplicationSubmission(actor,second.intakeId,[funderId])
  await sendApplicationSubmission(actor,second.intakeId,other.id)
  const [tampered]=await listJobsForDeal(actor.workspaceId,second.dealId)
  const key=await getDatabase().prepare<{storage_key:string}>("SELECT storage_key FROM mca_documents WHERE id=?").get(tampered.documentVersions[0].documentId)
  memory.set(key!.storage_key,new Uint8Array(Buffer.from("changed")))
  assert.equal((await processJobDelivery(tampered)).state,"failed")
  assert.equal(sent.length,count+1)
  delete process.env.MCA_BACKGROUND_JOBS
})
test("invalid selection, other workspace, expired approval and stale analysis fail without jobs",async()=>{
  const item=await readyApplication()
  await assert.rejects(()=>prepareApplicationSubmission(actor,item.intakeId,[]),{code:"validation_failed"})
  await assert.rejects(()=>prepareApplicationSubmission(actor,item.intakeId,["unknown"]),{code:"funder_not_eligible"})
  await assert.rejects(()=>prepareApplicationSubmission({...actor,workspaceId:newId()},item.intakeId,[funderId]),{code:"intake_not_found"})
  const preview=await prepareApplicationSubmission(actor,item.intakeId,[funderId])
  await getDatabase().prepare("UPDATE intake_submission_previews SET expires_at='2000-01-01T00:00:00.000Z' WHERE id=?").run(preview.id)
  await assert.rejects(()=>sendApplicationSubmission(actor,item.intakeId,preview.id),{code:"submission_preview_stale"})
  await getDatabase().prepare("UPDATE deals SET version=version+1 WHERE id=?").run(item.dealId)
  await assert.rejects(()=>prepareApplicationSubmission(actor,item.intakeId,[funderId]),{code:"submission_preview_stale"})
  assert.equal((await listJobsForDeal(actor.workspaceId,item.dealId)).length,0)
})

test("independent destinations retain duplicate failure and continue the other lender",async()=>{
  const item=await readyApplication()
  const first=await prepareApplicationSubmission(actor,item.intakeId,[funderId])
  await sendApplicationSubmission(actor,item.intakeId,first.id)
  const next=await prepareApplicationSubmission(actor,item.intakeId,[funderId,portalFunderId])
  const sent=await sendApplicationSubmission(actor,item.intakeId,next.id)
  assert.equal(sent.jobs.find(job=>job.funderId===funderId)?.state,"blocked_duplicate")
  assert.equal(sent.jobs.find(job=>job.funderId===portalFunderId)?.state,"pending_portal")
  assert.deepEqual((await sendApplicationSubmission(actor,item.intakeId,next.id)).jobs,sent.jobs)
})
test("generic preview confirmation reports an unknown funder on first approval and replay", async () => {
  const item = await readyApplication()
  const unknownFunderId = newId()
  const { prepareDealSubmission, confirmDealSubmission } = await import("../src/lib/mca/submissions/broker-preview")
  const preview = await prepareDealSubmission(actor, item.dealId, [unknownFunderId])
  assert.match(preview.destinations[0]?.errors[0] ?? "", /not found/i)

  const first = await confirmDealSubmission(actor, item.dealId, { previewId: preview.id })
  const replay = await confirmDealSubmission(actor, item.dealId, { previewId: preview.id })

  assert.equal(first.jobs.length, 1)
  assert.equal(first.jobs[0]?.funderId, unknownFunderId)
  assert.equal(first.jobs[0]?.state, "preflight_failed")
  assert.match(first.jobs[0]?.reason ?? "", /not found/i)
  assert.deepEqual(replay.jobs, first.jobs)
  assert.equal((await listJobsForDeal(actor.workspaceId, item.dealId)).length, 0)
})
test("disabled connection and changed completeness block Send",async()=>{
  const item=await readyApplication()
  const preview=await prepareApplicationSubmission(actor,item.intakeId,[funderId])
  await getDatabase().prepare("UPDATE intake_integrations SET enabled=0 WHERE id=?").run(integrationId)
  await assert.rejects(()=>sendApplicationSubmission(actor,item.intakeId,preview.id),{code:"integration_disabled"})
  await getDatabase().prepare("UPDATE intake_integrations SET enabled=1 WHERE id=?").run(integrationId)
  await getDatabase().prepare("UPDATE mca_completeness_results SET ready=0 WHERE deal_id=?").run(item.dealId)
  await assert.rejects(()=>sendApplicationSubmission(actor,item.intakeId,preview.id),{code:"completeness_not_ready"})
  assert.equal((await listJobsForDeal(actor.workspaceId,item.dealId)).length,0)
})
test("interrupted approved attempt becomes explicit uncertain failure without resending",async()=>{
  process.env.MCA_BACKGROUND_JOBS="enabled"
  const item=await readyApplication()
  const preview=await prepareApplicationSubmission(actor,item.intakeId,[funderId])
  await sendApplicationSubmission(actor,item.intakeId,preview.id)
  const [job]=await listJobsForDeal(actor.workspaceId,item.dealId)
  await getDatabase().prepare(`INSERT INTO mca_submission_attempts(id,workspace_id,job_id,attempt_key,transport,state,correlation_id,created_at) VALUES (?,?,?,?,'email','sending',?,'2000-01-01T00:00:00.000Z')`).run(newId(),actor.workspaceId,job.id,job.attemptKey,newId())
  const count=sent.length
  const failed=await processJobDelivery(job)
  assert.equal(failed.state,"failed")
  assert.match(failed.reason!,/uncertain/)
  assert.equal(sent.length,count)
  delete process.env.MCA_BACKGROUND_JOBS
})

test("approved portal derivatives download with job/deal authorization and exact checksum",async()=>{
  const item=await readyApplication()
  await updateStampSettings(actor,{enabled:true})
  const preview=await prepareApplicationSubmission(actor,item.intakeId,[portalFunderId])
  await sendApplicationSubmission(actor,item.intakeId,preview.id)
  const [job]=await listJobsForDeal(actor.workspaceId,item.dealId)
  const document=job.approvedPackage!.documents[0]
  assert.equal(document.stage,"stamp")
  assert.notEqual(document.documentId,document.originalDocumentId)
  assert.equal(await getDatabase().prepare("SELECT id FROM mca_documents WHERE id=?").get(document.documentId),undefined)
  const board=await listPortalBoard(actor,item.dealId)
  assert.ok(board.portals[0].packageDocuments[0].downloadUrl?.includes(job.id))
  const downloaded=await downloadApprovedPortalDocument(actor,item.dealId,job.id,document.documentId)
  assert.equal(downloaded.filename,"application.pdf")
  assert.equal(createHash("sha256").update(downloaded.bytes).digest("hex"),document.checksum)
  await assert.rejects(()=>downloadApprovedPortalDocument({...actor,workspaceId:newId()},item.dealId,job.id,document.documentId),{code:"portal_document_not_found"})
  await assert.rejects(()=>downloadApprovedPortalDocument(actor,newId(),job.id,document.documentId),{code:"portal_document_not_found"})
  await assert.rejects(()=>downloadApprovedPortalDocument(actor,item.dealId,job.id,document.originalDocumentId),{code:"portal_document_not_found"})
  await assert.rejects(()=>downloadApprovedPortalDocument({...actor,source:"user",role:"rep",membershipId:newId(),userId:newId()},item.dealId,job.id,document.documentId),{code:"deal_not_found"})
  memory.set(`${actor.workspaceId}/derivatives/stamp/${document.documentId}`,new Uint8Array(Buffer.from("changed")))
  await assert.rejects(()=>downloadApprovedPortalDocument(actor,item.dealId,job.id,document.documentId),{code:"immutable_storage_conflict"})
  await updateStampSettings(actor,{enabled:false})
})

test("generic deal preview sends only exact reviewed package, survives replay and rejects stale settings", async () => {
  const item = await readyApplication()
  const { prepareDealSubmission, confirmDealSubmission } = await import("../src/lib/mca/submissions/broker-preview")
  const preview = await prepareDealSubmission(actor, item.dealId, [funderId])
  assert.equal(preview.destinations[0]?.email?.to[0], "lender@example.test")
  assert.equal((await listJobsForDeal(actor.workspaceId, item.dealId)).length, 0)
  await assert.rejects(() => confirmDealSubmission({ ...actor, source: "api_key" }, item.dealId, { previewId: preview.id }), { code: "broker_review_required" })
  await assert.rejects(() => confirmDealSubmission({ ...actor, workspaceId: "another" }, item.dealId, { previewId: preview.id }), { status: 404 })
  await upsertSubmissionEmailTemplate(actor, { subjectTemplate: "Changed generic preview", bodyTemplate: "Changed" })
  await assert.rejects(() => confirmDealSubmission(actor, item.dealId, { previewId: preview.id }), { code: "submission_preview_stale" })
  const fresh = await prepareDealSubmission(actor, item.dealId, [funderId])
  const count = sent.length
  const [first, replay] = await Promise.all([confirmDealSubmission(actor, item.dealId, { previewId: fresh.id }), confirmDealSubmission(actor, item.dealId, { previewId: fresh.id })])
  assert.equal(first.jobs[0]?.state, "sent")
  assert.equal(replay.jobs[0]?.jobId, first.jobs[0]?.jobId)
  assert.equal(sent.length, count + 1)
})


test("uncertain API and webhook deliveries require broker reconciliation and fresh approval", async () => {
  const item = await readyApplication()
  for (const kind of ["api", "custom_webhook"] as const) {
    const funder = (await createFunder(actor, { idempotencyKey: newId(), legalName: `Uncertain ${kind} fixture`, routes: [{ kind, label: "Fixture", destination: kind === "api" ? "fixture-no-network" : "https://fixture.example.test", documentExceptions: [], active: true }] })).funder
    const confirmationKey = newId()
    const job = (await persistNewDestination({ workspaceId: actor.workspaceId, dealId: item.dealId, funderId: funder.id, displayFunderName: funder.legalName, routeKind: kind, route: funder.routes[0], state: "failed", confirmationKey, attemptKey: confirmationKey, dealVersion: 1, documentVersions: [], packageDocumentIds: [], preflightErrors: [], merchantIdentityKey: "fixture", packageFingerprint: "fixture", actor, createdByUserId: actor.userId })).job
    await insertAttempt({ workspaceId: actor.workspaceId, jobId: job.id, attemptKey: job.attemptKey, transport: kind, state: "failed", correlationId: "fixture-receipt", errorCode: "delivery_uncertain" })
    await assert.rejects(() => reconcileUncertainDelivery({ ...actor, source: "api_key" }, job.id, { outcome: "accepted", evidence: "fixture" }), { code: "broker_review_required" })
    await assert.rejects(() => reconcileUncertainDelivery({ ...actor, role: "rep" }, job.id, { outcome: "accepted", evidence: "fixture" }), { code: "broker_review_required" })
    await assert.rejects(() => reconcileUncertainDelivery({ ...actor, workspaceId: newId() }, job.id, { outcome: "accepted", evidence: "fixture" }), { code: "resource_not_found" })
    const reconciled = await reconcileUncertainDelivery(actor, job.id, { outcome: "not_sent", evidence: "Fixture receiver confirms no acceptance" })
    assert.equal(reconciled.state, "failed")
    await assert.rejects(() => reconcileUncertainDelivery(actor, job.id, { outcome: "accepted", evidence: "fixture" }), { code: "delivery_not_uncertain" })

    for (const lenderState of ["funded", "declined"] as const) {
      const lateKey = newId()
      const late = (await persistNewDestination({ workspaceId: actor.workspaceId, dealId: item.dealId, funderId: funder.id, displayFunderName: funder.legalName, routeKind: kind, route: funder.routes[0], state: "failed", confirmationKey: lateKey, attemptKey: lateKey, dealVersion: 1, documentVersions: [], packageDocumentIds: [], preflightErrors: [], merchantIdentityKey: "fixture", packageFingerprint: "fixture", actor, createdByUserId: actor.userId })).job
      await insertAttempt({ workspaceId: actor.workspaceId, jobId: late.id, attemptKey: late.attemptKey, transport: kind, state: "failed", correlationId: "late-receipt", errorCode: "delivery_uncertain" })
      await updateJobRecord(actor.workspaceId, late.id, { state: lenderState })
      await getDatabase().prepare("UPDATE deal_submissions SET status = ? WHERE job_id = ?").run(lenderState, late.id)
      await assert.rejects(() => reconcileUncertainDelivery(actor, late.id, { outcome: "not_sent", evidence: "fixture" }), { code: "lender_evidence_exists" })
      const acceptedLate = await reconcileUncertainDelivery(actor, late.id, { outcome: "accepted", evidence: "late receipt" })
      assert.equal(acceptedLate.state, lenderState)
      assert.equal((await getDatabase().prepare<{ status: string }>("SELECT status FROM deal_submissions WHERE job_id = ?").get(late.id))?.status, lenderState)
    }
  }
})

test("webhook preview exposes the exact routing query and removes credential parameters", async () => {
  const item = await readyApplication()
  const funder = (await createFunder(actor, { idempotencyKey: newId(), legalName: "Webhook route fixture", routes: [{ kind: "custom_webhook", label: "Fixture", destination: "https://fixture.example.test/submit?team=north&token=fixture-secret", documentExceptions: [], active: true }] })).funder
  const { prepareDealSubmission } = await import("../src/lib/mca/submissions/broker-preview")
  const preview = await prepareDealSubmission(actor, item.dealId, [funder.id])
  assert.equal(preview.destinations[0].destination, "https://fixture.example.test/submit?team=north")
  assert.equal(JSON.stringify(preview).includes("fixture-secret"), false)
})


test("post-provider audit failure preserves accepted and uncertain outcomes without resend", async () => {
  const { prepareDealSubmission, confirmDealSubmission } = await import("../src/lib/mca/submissions/broker-preview")
  const { findAttempt } = await import("../src/lib/mca/submissions/repository")
  for (const uncertain of [false, true]) {
    const item = await readyApplication()
    const preview = await prepareDealSubmission(actor, item.dealId, [funderId])
    process.env.MCA_BACKGROUND_JOBS = "enabled"
    let queued
    try { queued = await confirmDealSubmission(actor, item.dealId, { previewId: preview.id }) }
    finally { delete process.env.MCA_BACKGROUND_JOBS }
    const job = (await listJobsForDeal(actor.workspaceId, item.dealId)).find(row => row.id === queued.jobs[0].jobId)!
    let sends = 0
    setEmailDeliveryFetchForTests(async () => { sends++; return new Response("fixture", { status: uncertain ? 500 : 202 }) })
    await getDatabase().prepare(`CREATE FUNCTION t2_audit_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='submission.delivery_recorded' THEN RAISE EXCEPTION 'synthetic audit outage'; END IF; RETURN NEW; END $$`).run()
    await getDatabase().prepare(`CREATE TRIGGER t2_audit_failure BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION t2_audit_failure()`).run()
    try { await assert.rejects(() => processJobDelivery(job), /synthetic audit outage/) }
    finally {
      await getDatabase().prepare("DROP TRIGGER t2_audit_failure ON audit_events").run()
      await getDatabase().prepare("DROP FUNCTION t2_audit_failure()").run()
    }
    const receipt = await findAttempt(job.id, job.attemptKey)
    assert.equal(receipt?.state, uncertain ? "failed" : "sent")
    assert.equal(receipt?.errorCode, uncertain ? "delivery_uncertain" : undefined)
    const reloaded = (await listJobsForDeal(actor.workspaceId, item.dealId)).find(row => row.id === job.id)!
    assert.equal((await processJobDelivery(reloaded)).state, uncertain ? "failed" : "sent")
    assert.equal((await getDatabase().prepare<{ count: number }>("SELECT count(*)::int AS count FROM audit_events WHERE resource_id=? AND action='submission.delivery_recovered'").get(job.id))?.count, 1)
    assert.equal(sends, 1)
  }
  setEmailDeliveryFetchForTests(async (_url, init) => { sent.push(JSON.parse(String(init?.body))); return new Response("ok") })
})
