import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { randomUUID } from "node:crypto"
import { createPostgresTestDatabase } from "./helpers/postgres-test-db.mjs"
import { closeDatabaseForTests, getDatabase } from "../src/lib/mca/db"
import { createWorkspaceWithAdmin } from "../src/lib/mca/workspaces"
import { createDeal, actorForDeals } from "../src/lib/mca/deals/service"
import { signDelegation, verifyDelegation, bodyHash, boundedBody } from "../src/lib/mca/assistant/security"
import { storeOperation, storeRequest, rememberDeals } from "../src/lib/mca/assistant/store"
import { runTool, toolRequest } from "../src/lib/mca/assistant/tools"
import type { MembershipContext } from "../src/lib/mca/types"

let db: Awaited<ReturnType<typeof createPostgresTestDatabase>>
let remoteActive = true
const remoteUsers = new Map<string, string>()
const fakeClient: NonNullable<Parameters<typeof delegatedContext>[1]> = async (sessionId, userId) => {
  assert.ok(remoteActive && remoteUsers.get(sessionId) === userId, "Supabase session must remain active and belong to the user")
}
import { assistantContext, delegatedContext } from "../src/lib/mca/assistant/chatkit-context"
let first: MembershipContext, second: MembershipContext
before(async () => {
  process.env.MCA_ASSISTANT_SIGNING_SECRET = "synthetic-signing-secret-for-chatkit-tests-only"
  db = await createPostgresTestDatabase("chatkit")
  process.env.DATABASE_URL = db.databaseUrl
  for (const label of ["first", "second"]) {
    const fixture = await createWorkspaceWithAdmin({ workspaceName: label, adminName: "Test", adminEmail: `${randomUUID()}@example.test`, password: "Synthetic fixture password 99!", role: "admin" })
    const context: MembershipContext = { authType: "session", ...fixture, role: "admin", sessionId: randomUUID(), scopes: [] }
    await getDatabase().prepare("UPDATE users SET supabase_user_id=? WHERE id=?").run(fixture.userId, fixture.userId)
    remoteUsers.set(context.sessionId!, fixture.userId)
    if (label === "first") first = context; else second = context
  }
})
after(async () => { await closeDatabaseForTests(); await db?.close(); delete process.env.MCA_ASSISTANT_SIGNING_SECRET })
async function thread(context = first) {
  const c = await assistantContext(context), id = `thr_${randomUUID()}`
  await storeOperation(c, storeRequest.parse({ op: "save_thread", payload: { id, created_at: new Date().toISOString(), title: "Private merchant discussion" } }))
  return { c, id }
}
async function deal(context = first, amount = 10000) {
  return (await createDeal(await actorForDeals(context), { idempotencyKey: randomUUID(), legalName: "Synthetic merchant", requestedAmount: amount, monthlyRevenue: 30000 })).deal
}
test("delegations reject forgery, expiry, wrong audience and malformed input", () => {
  const now = Math.floor(Date.now()/1000)
  const claims = { aud: "mca-chatkit" as const, requestId: randomUUID(), userId: "u", workspaceId: "w", membershipId: "m", sessionId: "s", iat: now, exp: now+120, bodyHash: bodyHash("body") }
  const token = signDelegation(claims)
  assert.deepEqual(verifyDelegation(token), claims)
  assert.throws(() => verifyDelegation(`${token.split(".")[0]}.AAAA`))
  assert.throws(() => verifyDelegation(token, now+121))
  assert.throws(() => verifyDelegation("junk"))
  assert.throws(() => signDelegation({ ...claims, aud: "other" } as never))
})
test("history is scoped to both company and user, encrypted, paginated and cascade-deleted", async () => {
  const { c, id } = await thread()
  for (let n=0; n<3; n++) await storeOperation(c, storeRequest.parse({ op: "save_item", threadId: id, payload: { id: `item_${n}`, thread_id: id, type: "user_message", content: `Secret message ${n}` } }))
  const raw = await getDatabase().prepare<{ payload_cipher: string }>("SELECT payload_cipher FROM mca_chatkit_items WHERE thread_id=?").get(id)
  assert.ok(raw); assert.ok(!raw.payload_cipher.includes("Secret"))
  const page = await storeOperation(c, storeRequest.parse({ op: "load_items", threadId: id, limit: 2, order: "asc" })) as { data: { id: string }[]; after: string; has_more: boolean }
  assert.deepEqual(page.data.map(item=>item.id), ["item_0", "item_1"]); assert.equal(page.has_more,true)
  const next = await storeOperation(c, storeRequest.parse({ op: "load_items", threadId: id, after: page.after, limit: 2, order: "asc" })) as { data: { id: string }[] }
  assert.deepEqual(next.data.map(item=>item.id), ["item_2"])
  await assert.rejects(storeOperation(await assistantContext(second), storeRequest.parse({ op: "load_thread", threadId: id })))
  await assert.rejects(storeOperation({ ...c, context: { ...first, userId: second.userId } }, storeRequest.parse({ op: "delete_thread", threadId: id })))
  await storeOperation(c, storeRequest.parse({ op: "delete_thread", threadId: id }))
  assert.equal((await getDatabase().prepare("SELECT id FROM mca_chatkit_items WHERE thread_id=?").all(id)).length,0)
})
test("search and pipeline use visible deals and redact restricted financial fields", async () => {
  const { c, id } = await thread()
  const own = await deal(first, 12000); await deal(second, 999999)
  const search = await runTool(c, toolRequest.parse({ name: "search_deals", threadId: id, args: {} })) as { deals: { id: string; requestedAmount: number }[] }
  assert.ok(search.deals.some(row=>row.id===own.id))
  const pipeline = await runTool(c, toolRequest.parse({ name: "summarize_pipeline", threadId: id, args: {} })) as { total: number; requestedAmountTotal: number }
  assert.equal(pipeline.total,1); assert.equal(pipeline.requestedAmountTotal,12000)
  const rep = await assistantContext({ ...first, role: "rep" })
  const repThread = await thread({ ...first, role: "rep" })
  const restricted = await runTool(rep, toolRequest.parse({ name: "get_deal", threadId: repThread.id, args: { dealId: own.id } }))
  assert.ok(!JSON.stringify(restricted).includes("requestedAmount")); assert.ok(!JSON.stringify(restricted).includes("monthlyRevenue"))
  assert.ok(!JSON.stringify(restricted).includes("owners"))
  assert.ok(JSON.stringify(restricted).includes(`/deals?deal=${own.id}`))
  const foreign = await deal(second)
  await assert.rejects(runTool(c, toolRequest.parse({ name: "get_deal", threadId: id, args: { dealId: foreign.id } })))
  assert.throws(()=>toolRequest.parse({ name: "send_email", threadId: id, args: {} }))
})
test("revoked deal access and role changes block replay but allow deletion", async () => {
  const repContext = { ...first, role: "rep" as const }
  const { c, id } = await thread(repContext), own = await deal()
  await rememberDeals(c,id,[own.id])
  await getDatabase().prepare("DELETE FROM deal_assignments WHERE deal_id=?").run(own.id)
  await assert.rejects(storeOperation(c,storeRequest.parse({op:"load_thread",threadId:id})), /Access has changed/)
  const list = await storeOperation(c,storeRequest.parse({op:"load_threads"}))
  assert.ok(JSON.stringify(list).includes("Conversation unavailable"))
  await storeOperation(c,storeRequest.parse({op:"delete_thread",threadId:id}))
  const original = await thread()
  await assert.rejects(storeOperation(await assistantContext(repContext),storeRequest.parse({op:"load_thread",threadId:original.id})), /Access has changed/)
})
test("existing underwriting is read without creating score snapshots", async () => {
  const { c,id } = await thread(), own = await deal()
  const result = await runTool(c,toolRequest.parse({ name:"get_underwriting",threadId:id,args:{dealId:own.id} })) as {status:string}
  assert.equal(result.status,"not_analyzed")
})
test("delegated callbacks recheck active request, Supabase session and current membership role", async () => {
  const now = Math.floor(Date.now()/1000)
  const claims = { aud:"mca-chatkit" as const,requestId:randomUUID(),userId:first.userId,workspaceId:first.workspaceId,membershipId:first.membershipId,sessionId:first.sessionId!,iat:now,exp:now+120,bodyHash:bodyHash("test") }
  await assert.rejects(delegatedContext(claims, fakeClient))
  await getDatabase().prepare("INSERT INTO mca_chatkit_requests(id,workspace_id,user_id,expires_at) VALUES(?,?,?,?)").run(claims.requestId,first.workspaceId,first.userId,new Date(Date.now()+120000).toISOString())
  assert.equal((await delegatedContext(claims, fakeClient)).context.role,"admin")
  remoteActive=false; await assert.rejects(delegatedContext(claims, fakeClient)); remoteActive=true
  await getDatabase().prepare("UPDATE memberships SET role='rep' WHERE id=?").run(first.membershipId)
  assert.equal((await delegatedContext(claims, fakeClient)).financials,false)
  await getDatabase().prepare("UPDATE memberships SET role='admin' WHERE id=?").run(first.membershipId)
})
test("request body limit also applies without Content-Length", async () => {
  const request = new Request("https://example.test",{method:"POST",body:"12345"})
  await assert.rejects(boundedBody(request,4))
})


test("gateway preserves streaming, cleans cancellation, and gates disabled or invalid requests", async () => {
  const { chatkitGateway } = await import("../src/lib/mca/assistant/gateway")
  const previousFetch = globalThis.fetch
  const enabled = process.env.MCA_ASSISTANT_ENABLED
  const url = process.env.MCA_ASSISTANT_SERVICE_URL
  process.env.MCA_ASSISTANT_ENABLED = "true"
  process.env.MCA_ASSISTANT_SERVICE_URL = "chatkit.test"
  let canceled = false
  try {
    globalThis.fetch = async (_input, init) => {
      assert.equal(String(_input), "http://chatkit.test:8000/chatkit")
      const token = new Headers(init?.headers).get("authorization")!.slice(7)
      const claims = verifyDelegation(token)
      assert.equal(claims.bodyHash,bodyHash(String(init?.body)))
      assert.equal(claims.userId,first.userId)
      return new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('data: {"type":"thread.created"}\n\n')) }, cancel() { canceled=true } }),{headers:{"content-type":"text/event-stream"}})
    }
    const request = () => new Request("https://mca.test/api/mca/chatkit",{method:"POST",headers:{origin:"https://mca.test"},body:JSON.stringify({type:"threads.create",params:{}})})
    const result = await chatkitGateway(request(),async()=>first)
    assert.equal(result.status,200)
    const reader = result.body!.getReader()
    assert.match(new TextDecoder().decode((await reader.read()).value),/thread.created/)
    const overlapping = await chatkitGateway(request(),async()=>first)
    assert.equal(overlapping.status,409)
    await reader.cancel()
    assert.equal(canceled,true)
    assert.equal((await getDatabase().prepare("SELECT id FROM mca_chatkit_requests WHERE user_id=? AND is_turn=1").all(first.userId)).length,0)
    process.env.MCA_ASSISTANT_ENABLED = "false"
    assert.equal((await chatkitGateway(request(),async()=>first)).status,404)
    process.env.MCA_ASSISTANT_ENABLED = "true"
    const bad = new Request("https://mca.test/api/mca/chatkit",{method:"POST",headers:{origin:"https://evil.test"},body:"{}"})
    assert.equal((await chatkitGateway(bad,async()=>first)).status,403)
    globalThis.fetch = async () => new Response("Sensitive provider failure",{status:500})
    const failure = await chatkitGateway(request(),async()=>first)
    assert.equal(failure.status,502); assert.ok(!(await failure.text()).includes("Sensitive"))
  } finally {
    globalThis.fetch=previousFetch
    if(enabled===undefined) delete process.env.MCA_ASSISTANT_ENABLED; else process.env.MCA_ASSISTANT_ENABLED=enabled
    if(url===undefined) delete process.env.MCA_ASSISTANT_SERVICE_URL; else process.env.MCA_ASSISTANT_SERVICE_URL=url
  }
})

test("stale underwriting is labeled and never recomputed; restricted reasons omit financial detail", async () => {
  const { insertScoreSnapshot, listScoreSnapshotRecords } = await import("../src/lib/mca/underwriting/snapshot-repository")
  const own = await deal(), { c,id } = await thread()
  await insertScoreSnapshot({ id:randomUUID(),workspaceId:first.workspaceId,dealId:own.id,dealVersion:0,policyVersion:0,underwritingVersion:0,completenessVersion:0,
    criteriaVersions:{},stale:true,aggregateComputedAt:"",mode:"analyze_only",topN:1,createdAt:new Date().toISOString(),
    scores:[{funderId:"synthetic-funder",rank:1,score:50,grade:"C",eligible:true,reasons:[{ruleId:"monthly_revenue",result:"pass",detail:"Sensitive financial comparison 30000"}]}] })
  const result = await runTool(c,toolRequest.parse({name:"get_underwriting",threadId:id,args:{dealId:own.id}})) as {status:string;staleReasons:string[]}
  assert.equal(result.status,"stale");assert.ok(result.staleReasons.length)
  assert.equal((await listScoreSnapshotRecords(first.workspaceId,own.id)).length,1)
  const rep = await thread({...first,role:"rep"})
  const restricted=await runTool(rep.c,toolRequest.parse({name:"get_underwriting",threadId:rep.id,args:{dealId:own.id}}))
  assert.ok(!JSON.stringify(restricted).includes("Sensitive financial"))
})

test("production verification scope fails closed and never enables other users or companies", async () => {
  const { assistantEnabled, requireAssistant } = await import("../src/lib/mca/assistant/security")
  const enabled = process.env.MCA_ASSISTANT_ENABLED
  process.env.MCA_ASSISTANT_ENABLED = "false"
  try {
    process.env.MCA_ASSISTANT_VERIFICATION_SCOPE = JSON.stringify({ userId: first.userId, workspaceId: first.workspaceId, expiresAt: new Date(Date.now()+600_000).toISOString() })
    assert.equal(assistantEnabled(), false)
    assert.equal(assistantEnabled(first), true)
    assert.equal(assistantEnabled(second), false)
    assert.equal(assistantEnabled({ ...first, workspaceId: second.workspaceId }), false)
    assert.equal(assistantEnabled({ ...first, userId: second.userId }), false)
    assert.throws(() => requireAssistant(second))
    for (const value of ["invalid", "{}", JSON.stringify({ userId: first.userId, workspaceId: first.workspaceId, expiresAt: new Date(Date.now()-1000).toISOString() }), JSON.stringify({ userId: first.userId, workspaceId: first.workspaceId, expiresAt: new Date(Date.now()+7_200_000).toISOString() })]) {
      process.env.MCA_ASSISTANT_VERIFICATION_SCOPE = value
      assert.equal(assistantEnabled(first), false)
    }
  } finally {
    delete process.env.MCA_ASSISTANT_VERIFICATION_SCOPE
    if (enabled === undefined) delete process.env.MCA_ASSISTANT_ENABLED
    else process.env.MCA_ASSISTANT_ENABLED = enabled
  }
})
