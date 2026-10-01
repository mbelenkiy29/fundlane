import test,{before,beforeEach,after} from "node:test"
import assert from "node:assert/strict"
import { createHmac } from "node:crypto"
import { createPostgresTestDatabase } from "./helpers/postgres-test-db.mjs"
import { getDatabase,closeDatabaseForTests,nowIso } from "../src/lib/mca/db"
import { createWorkspaceWithAdmin } from "../src/lib/mca/workspaces"
import { actorForDeals,createDeal } from "../src/lib/mca/deals/service"
import { encryptSensitive } from "../src/lib/mca/crypto"
import { saveProvider } from "../src/lib/mca/sms/onboarding"
import { configureVoice,issueToken,setPresence,createDialIntent,cancelDialIntent,handleOutbound,handleInbound,handleOutcome,listVoiceHistory } from "../src/lib/mca/voice/service"
import type { DealActor } from "../src/lib/mca/deals/schema"
let fixture:Awaited<ReturnType<typeof createPostgresTestDatabase>>,actor:DealActor,foreign:DealActor,dealId:string,initialPages:string
const env={...process.env},accountSid=`AC${"a".repeat(32)}`,numberId="voice-number",phone="+15555550101",appSid=`AP${"c".repeat(32)}`
const sid=(v:string)=>`CA${v.repeat(32)}`
before(async()=>{
 fixture=await createPostgresTestDatabase("voice");Object.assign(process.env,fixture.env({MCA_DATA_ENCRYPTION_KEY:Buffer.alloc(32,9).toString("base64url"),MCA_APP_ORIGIN:"https://example.test"}))
 for(const [name,email] of [["Voice company","voice@example.test"],["Foreign company","foreign@example.test"]]){
 const owner=await createWorkspaceWithAdmin({workspaceName:name,adminName:name,adminEmail:email,password:"synthetic-password-123",role:"admin"});const a=await actorForDeals({authType:"session",...owner,role:"admin",scopes:[],sessionId:"fixture"});if(!actor)actor=a;else foreign=a
 }
 const db=getDatabase();await db.prepare("INSERT INTO sms_companies(workspace_id,owner_user_id,created_at,updated_at) VALUES (?,?,?,?)").run(actor.workspaceId,actor.userId,nowIso(),nowIso())
 await saveProvider(actor.workspaceId,{accountSid,authToken:"synthetic-auth",apiKeySid:`SK${"b".repeat(32)}`,apiKeySecret:"synthetic-key"})
 await db.prepare("INSERT INTO mca_sms_accounts(id,workspace_id,provider,label,sender_kind,sender_identity_cipher,credential_ref,state,is_default,created_at,updated_at) VALUES (?,?, 'twilio','Voice fixture','phone_number',?,'MANAGED','active',0,?,?)").run("voice-account",actor.workspaceId,encryptSensitive(phone,actor.workspaceId),nowIso(),nowIso())
 await db.prepare("INSERT INTO sms_numbers(id,workspace_id,account_id,provider_sid,phone,membership_id,state,monthly_cents,created_at,updated_at) VALUES (?,?,?,?,?,?,'registering',0,?,?)").run(numberId,actor.workspaceId,"voice-account",`PN${"d".repeat(32)}`,phone,actor.membershipId,nowIso(),nowIso())
 dealId=(await createDeal(actor,{idempotencyKey:"voice-deal",legalName:"Voice merchant",contactPhone:"+15555550102"})).deal.id
 initialPages=(await db.prepare<{page_visibility:string}>("SELECT page_visibility FROM workspaces WHERE id=?").get(actor.workspaceId))!.page_visibility
 await configureVoice(actor,{numberId,applicationSid:appSid,callbacksConfirmed:true})
})
beforeEach(async()=>{const db=getDatabase();await db.prepare("UPDATE workspaces SET page_visibility=? WHERE id=?").run(initialPages,actor.workspaceId);await db.prepare("UPDATE company_subscription_state SET manual_paused=0 WHERE workspace_id=?").run(actor.workspaceId);await db.prepare("UPDATE voice_config SET callbacks_confirmed=1 WHERE workspace_id=?").run(actor.workspaceId);await db.prepare("UPDATE sms_numbers SET state='registering' WHERE id=?").run(numberId);await db.prepare("UPDATE memberships SET status='active' WHERE id=?").run(actor.membershipId)})
after(async()=>{await closeDatabaseForTests();await fixture?.close();process.env=env})
function hook(kind:string,params:Record<string,string>){const url=`https://example.test/api/mca/voice/webhooks/${actor.workspaceId}/${kind}`;const form=new URLSearchParams({AccountSid:accountSid,...params});let payload=url;for(const key of [...form.keys()].sort())payload+=key+form.get(key);return new Request(url,{method:"POST",headers:{"content-type":"application/x-www-form-urlencoded","x-twilio-signature":createHmac("sha1","synthetic-auth").update(payload).digest("base64")},body:form})}
test("token/config/intent enforce role and tenant",async()=>{
 assert.equal((await issueToken(actor)).recording,"off");await assert.rejects(configureVoice({...actor,role:"rep"},{numberId,applicationSid:appSid,callbacksConfirmed:true}));await assert.rejects(configureVoice(foreign,{numberId,applicationSid:appSid,callbacksConfirmed:true}));await assert.rejects(createDialIntent(foreign,dealId));await assert.rejects(issueToken({...actor,source:"api_key"}));await assert.rejects(issueToken({...actor,membershipId:foreign.membershipId}));
})
test("outbound requires scoped one-use intent and cannot override destination",async()=>{
 const intent=await createDialIntent(actor,dealId);const token=await issueToken(actor);const p={CallSid:sid("1"),From:`client:${token.identity}`,IntentId:intent.intentId,To:"+19999999999"};const xml=await handleOutbound(hook("outbound",p),actor.workspaceId);assert.match(xml,/<Number>\+15555550102<\/Number>/);assert.match(xml,/do-not-record/);assert.match(await handleOutbound(hook("outbound",p),actor.workspaceId),/<Number>/);await assert.rejects(handleOutbound(hook("outbound",{...p,CallSid:sid("2")}),actor.workspaceId));
 const canceled=await createDialIntent(actor,dealId);await cancelDialIntent(actor,canceled.intentId);await assert.rejects(handleOutbound(hook("outbound",{...p,IntentId:canceled.intentId,CallSid:sid("3")}),actor.workspaceId));
 const expired=await createDialIntent(actor,dealId);await getDatabase().prepare("UPDATE voice_dial_intents SET expires_at=? WHERE id=?").run("2000-01-01T00:00:00.000Z",expired.intentId);await assert.rejects(handleOutbound(hook("outbound",{...p,IntentId:expired.intentId,CallSid:sid("4")}),actor.workspaceId))
})
test("inbound presence lease, signed terminal callback, history and missed replay",async()=>{
 await setPresence(actor,true);const p={CallSid:sid("5"),To:phone,From:"+15555550103"};assert.match(await handleInbound(hook("inbound",p),actor.workspaceId),/<Client>/);await assert.rejects(handleOutcome(hook("outcome",{...p,From:"+15555559999",DialCallStatus:"no-answer"}),actor.workspaceId));await handleOutcome(hook("outcome",{...p,DialCallStatus:"no-answer"}),actor.workspaceId);await handleOutcome(hook("outcome",{...p,DialCallStatus:"no-answer"}),actor.workspaceId);await handleOutcome(hook("outcome",{...p,DialCallStatus:"completed"}),actor.workspaceId);const history=await listVoiceHistory(actor);assert.equal(history.find(c=>c.id===sid("5"))?.state,"missed");assert.equal((await getDatabase().prepare<{n:number}>("SELECT count(*)::int n FROM mca_notifications WHERE workspace_id=? AND event_key=?").get(actor.workspaceId,`voice-missed:${sid("5")}`))?.n,1);assert.equal((await listVoiceHistory(foreign)).length,0);
 await assert.rejects(handleInbound(hook("inbound",{...p,To:"+15555559999",CallSid:sid("6")}),actor.workspaceId));await setPresence(actor,false);assert.match(await handleInbound(hook("inbound",{...p,CallSid:sid("7")}),actor.workspaceId),/<Reject/)
})
test("membership and number revocation between intent and dispatch fails closed",async()=>{
 const intent=await createDialIntent(actor,dealId),token=await issueToken(actor);await getDatabase().prepare("UPDATE sms_numbers SET state='released' WHERE id=?").run(numberId);await assert.rejects(handleOutbound(hook("outbound",{CallSid:sid("8"),From:`client:${token.identity}`,IntentId:intent.intentId}),actor.workspaceId));await getDatabase().prepare("UPDATE sms_numbers SET state='registering' WHERE id=?").run(numberId)
 await getDatabase().prepare("UPDATE memberships SET status='deactivated' WHERE id=?").run(actor.membershipId);await assert.rejects(issueToken(actor));await assert.rejects(handleOutbound(hook("outbound",{CallSid:sid("8"),From:`client:${token.identity}`,IntentId:intent.intentId}),actor.workspaceId));await getDatabase().prepare("UPDATE memberships SET status='active' WHERE id=?").run(actor.membershipId)
})
test("new inbound/outbound dispatch rechecks company and deal page access",async()=>{
 await setPresence(actor,true);const intent=await createDialIntent(actor,dealId),token=await issueToken(actor)
 const db=getDatabase(),original=(await db.prepare<{page_visibility:string}>("SELECT page_visibility FROM workspaces WHERE id=?").get(actor.workspaceId))!.page_visibility
 await db.prepare("UPDATE workspaces SET page_visibility=? WHERE id=?").run(JSON.stringify({...JSON.parse(original),deals:false}),actor.workspaceId)
 await assert.rejects(handleInbound(hook("inbound",{CallSid:sid("9"),To:phone,From:"+15555550103"}),actor.workspaceId))
 await assert.rejects(handleOutbound(hook("outbound",{CallSid:sid("a"),From:`client:${token.identity}`,IntentId:intent.intentId}),actor.workspaceId))
 await db.prepare("UPDATE workspaces SET page_visibility=? WHERE id=?").run(original,actor.workspaceId)
 await db.prepare("UPDATE company_subscription_state SET manual_paused=1 WHERE workspace_id=?").run(actor.workspaceId)
 await assert.rejects(handleInbound(hook("inbound",{CallSid:sid("9"),To:phone,From:"+15555550103"}),actor.workspaceId))
 await db.prepare("UPDATE company_subscription_state SET manual_paused=0 WHERE workspace_id=?").run(actor.workspaceId)
})
test("signed terminal callback survives released number and disabled setup",async()=>{
 await setPresence(actor,true);const p={CallSid:sid("b"),To:phone,From:"+15555550104"};await handleInbound(hook("inbound",p),actor.workspaceId)
 await getDatabase().prepare("UPDATE sms_numbers SET state='released' WHERE id=?").run(numberId)
 await getDatabase().prepare("UPDATE voice_config SET callbacks_confirmed=0 WHERE workspace_id=?").run(actor.workspaceId)
 await handleOutcome(hook("outcome",{...p,DialCallStatus:"completed"}),actor.workspaceId)
 assert.equal((await listVoiceHistory(actor)).find(c=>c.id===sid("b"))?.state,"completed")
 await getDatabase().prepare("UPDATE sms_numbers SET state='registering' WHERE id=?").run(numberId)
 await getDatabase().prepare("UPDATE voice_config SET callbacks_confirmed=1 WHERE workspace_id=?").run(actor.workspaceId)
})
test("inbound replay with expired recipients records one terminal missed call",async()=>{
 await setPresence(actor,true);const p={CallSid:sid("c"),To:phone,From:"+15555550105"};await handleInbound(hook("inbound",p),actor.workspaceId);await getDatabase().prepare("UPDATE voice_presence SET expires_at=? WHERE workspace_id=?").run("2000-01-01T00:00:00.000Z",actor.workspaceId)
 assert.match(await handleInbound(hook("inbound",p),actor.workspaceId),/<Reject/)
 assert.equal((await listVoiceHistory(actor)).find(c=>c.id===sid("c"))?.state,"missed")
 const row=await getDatabase().prepare<{terminal_at:string|null}>("SELECT terminal_at FROM voice_calls WHERE workspace_id=? AND provider_call_sid=?").get(actor.workspaceId,sid("c"));assert.ok(row?.terminal_at)
 assert.match(await handleInbound(hook("inbound",p),actor.workspaceId),/<Hangup/)
})
