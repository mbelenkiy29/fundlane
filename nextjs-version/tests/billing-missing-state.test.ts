import test,{before,after} from "node:test"
import assert from "node:assert/strict"
import {randomUUID} from "node:crypto"
import {createPostgresTestDatabase} from "./helpers/postgres-test-db.mjs"
import {createWorkspaceWithAdmin} from "../src/lib/mca/workspaces"
import {getDatabase,nowIso,closeDatabaseForTests} from "../src/lib/mca/db"
import {getCompanyAccess,initializeCompanyTrial} from "../src/lib/mca/company-access"
import {setPlatformCompanyAccess} from "../src/lib/mca/billing-operations"
import {listBillingStateExceptions,platformCompanies,resolveMissingBillingState} from "../src/lib/mca/platform-console"

let database:Awaited<ReturnType<typeof createPostgresTestDatabase>>
before(async()=>{database=await createPostgresTestDatabase("billing_missing_state");process.env.DATABASE_URL=database.databaseUrl})
after(async()=>{delete process.env.MCA_BILLING_MISSING_STATE_FAIL_CLOSED;await closeDatabaseForTests();await database?.close()})

async function missingWorkspace() {
  const id=randomUUID(),now=nowIso()
  await getDatabase().prepare("INSERT INTO workspaces(id,name,timezone,seat_limit,feature_flags,page_visibility,action_visibility,created_at,updated_at) VALUES (?,?,'UTC',5,'{}','{}','{}',?,?)").run(id,`Missing ${id}`,now,now)
  return id
}

test("admin workspace creation writes an explicit non-customer state",async()=>{
  const created=await createWorkspaceWithAdmin({workspaceName:"Demo",adminName:"Admin",adminEmail:`${randomUUID()}@example.test`,password:"Test password 123!"})
  const state=await getDatabase().prepare<{state_kind:string;legacy_exempt:number}>("SELECT state_kind,legacy_exempt FROM company_subscription_state WHERE workspace_id=?").get(created.workspaceId)
  assert.deepEqual(state,{state_kind:"internal_demo",legacy_exempt:1})
  assert.equal((await getDatabase().prepare<{count:number}>("SELECT count(*)::int count FROM workspaces w LEFT JOIN company_subscription_state s ON s.workspace_id=w.id WHERE s.workspace_id IS NULL").get())?.count,0)
  await assert.rejects(initializeCompanyTrial(created.workspaceId,5),{code:"internal_workspace"})
  assert.equal((await listBillingStateExceptions()).some(row=>row.id===created.workspaceId),true)
})

test("missing state retains access by default and fails closed only with exact true flag",async()=>{
  const id=await missingWorkspace()
  delete process.env.MCA_BILLING_MISSING_STATE_FAIL_CLOSED
  assert.equal((await getCompanyAccess(id)).allowed,true)
  process.env.MCA_BILLING_MISSING_STATE_FAIL_CLOSED="TRUE"
  assert.equal((await getCompanyAccess(id)).allowed,true)
  process.env.MCA_BILLING_MISSING_STATE_FAIL_CLOSED="true"
  assert.deepEqual({allowed:(await getCompanyAccess(id)).allowed,reason:(await getCompanyAccess(id)).reason,status:(await getCompanyAccess(id)).status},{allowed:false,reason:"subscription_required",status:"missing_state"})
  assert.equal((await listBillingStateExceptions()).some(row=>row.id===id),true)
  delete process.env.MCA_BILLING_MISSING_STATE_FAIL_CLOSED
})

test("Companies filters retain the legacy missing-row result by default",async()=>{
  const id=await missingWorkspace(),q=id
  const previousFlag=process.env.MCA_BILLING_MISSING_STATE_FAIL_CLOSED
  try {
    delete process.env.MCA_BILLING_MISSING_STATE_FAIL_CLOSED
    assert.equal((await platformCompanies({q,status:"legacy_exempt",offset:0}))[0]?.id,id)
    assert.equal((await platformCompanies({q,status:"access:legacy_exempt",offset:0}))[0]?.id,id)
    assert.equal((await platformCompanies({q,status:"missing_state",offset:0}))[0]?.billingState,"missing_state")
    process.env.MCA_BILLING_MISSING_STATE_FAIL_CLOSED="true"
    assert.equal((await platformCompanies({q,status:"legacy_exempt",offset:0})).length,0)
    assert.equal((await platformCompanies({q,status:"missing_state",offset:0}))[0]?.id,id)
  } finally {
    if(previousFlag===undefined) delete process.env.MCA_BILLING_MISSING_STATE_FAIL_CLOSED
    else process.env.MCA_BILLING_MISSING_STATE_FAIL_CLOSED=previousFlag
  }
})

test("operator resolution inserts once, audits once and never overwrites",async()=>{
  const id=await missingWorkspace(),actor=randomUUID()
  assert.deepEqual(await resolveMissingBillingState(id,actor,"start_trial_required","Michael approved setup"),{inserted:true})
  assert.equal((await getCompanyAccess(id)).allowed,false)
  const before=await getDatabase().prepare<{state_kind:string;legacy_exempt:number;trial_started_at:string|null}>("SELECT state_kind,legacy_exempt,trial_started_at FROM company_subscription_state WHERE workspace_id=?").get(id)
  assert.deepEqual(before,{state_kind:"customer",legacy_exempt:0,trial_started_at:null})
  assert.deepEqual(await resolveMissingBillingState(id,actor,"legacy_exempt","Retry with different choice"),{inserted:false})
  assert.deepEqual(await getDatabase().prepare("SELECT state_kind,legacy_exempt,trial_started_at FROM company_subscription_state WHERE workspace_id=?").get(id),before)
  assert.equal((await getDatabase().prepare<{n:number}>("SELECT count(*)::int n FROM audit_events WHERE workspace_id=? AND action='billing.missing_state_resolved'").get(id))?.n,1)
  assert.equal((await listBillingStateExceptions()).some(row=>row.id===id),false)
})

test("ordinary platform access edits keep legacy insertion when the flag is unset",async()=>{
  const id=await missingWorkspace()
  delete process.env.MCA_BILLING_MISSING_STATE_FAIL_CLOSED
  const access=await setPlatformCompanyAccess(id,randomUUID(),{manualPaused:true,reason:"Review"})
  assert.equal(access.allowed,false)
  assert.deepEqual(await getDatabase().prepare("SELECT legacy_exempt,selected_seats,manual_paused FROM company_subscription_state WHERE workspace_id=?").get(id),{legacy_exempt:1,selected_seats:5,manual_paused:1})
})

test("flagged platform access edits require operator resolution",async()=>{
  const id=await missingWorkspace()
  process.env.MCA_BILLING_MISSING_STATE_FAIL_CLOSED="true"
  try {
    await assert.rejects(setPlatformCompanyAccess(id,randomUUID(),{manualPaused:true,reason:"Review"}),{code:"billing_state_missing"})
    assert.equal(await getDatabase().prepare("SELECT workspace_id FROM company_subscription_state WHERE workspace_id=?").get(id),undefined)
  } finally {delete process.env.MCA_BILLING_MISSING_STATE_FAIL_CLOSED}
})

test("explicit exemption remains flagged and retry cannot overwrite it",async()=>{
  const id=await missingWorkspace(),actor=randomUUID()
  assert.deepEqual(await resolveMissingBillingState(id,actor,"legacy_exempt","Historical company approved"),{inserted:true})
  const row=(await listBillingStateExceptions()).find(item=>item.id===id)
  assert.equal(row?.legacyExempt,1)
  assert.equal(row?.stateKind,"legacy_exempt")
  assert.deepEqual(await resolveMissingBillingState(id,actor,"start_trial_required","Retry"),{inserted:false})
  process.env.MCA_BILLING_MISSING_STATE_FAIL_CLOSED="true"
  assert.equal((await getCompanyAccess(id)).allowed,true)
  delete process.env.MCA_BILLING_MISSING_STATE_FAIL_CLOSED
  const internal=await missingWorkspace()
  assert.deepEqual(await resolveMissingBillingState(internal,actor,"mark_internal","Synthetic verification company"),{inserted:true})
  assert.equal((await listBillingStateExceptions()).find(item=>item.id===internal)?.stateKind,"internal_demo")
})
