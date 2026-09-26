import assert from "node:assert/strict"
import { after, before, beforeEach, mock, test } from "node:test"
import { randomUUID } from "node:crypto"
import { createPostgresTestDatabase } from "./helpers/postgres-test-db.mjs"
import { closeDatabaseForTests, getDatabase } from "../src/lib/mca/db"
import { createWorkspaceWithAdmin } from "../src/lib/mca/workspaces"
import { signDelegation, bodyHash } from "../src/lib/mca/assistant/security"
import { decodeSse, type NativeChatRequest } from "../src/lib/mca/assistant/native-contract"
import { storeOperation, storeRequest } from "../src/lib/mca/assistant/store"
import type { MembershipContext } from "../src/lib/mca/types"

let actual: typeof import("../src/lib/mca/assistant/chatkit-context")
let nativeAssistant: typeof import("../src/lib/mca/assistant/native-runtime")["nativeAssistant"]
let sessionActive = true
let fixture: Awaited<ReturnType<typeof createPostgresTestDatabase>>, first: MembershipContext, second: MembershipContext
const originalFetch = globalThis.fetch
const saved = { signing: process.env.MCA_ASSISTANT_SIGNING_SECRET, key: process.env.OPENAI_API_KEY, model: process.env.MCA_ASSISTANT_MODEL }
let calls = 0
const events = (items: unknown[]) => new Response(items.map(item => `data: ${JSON.stringify(item)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } })
before(async () => {
actual = await import("../src/lib/mca/assistant/chatkit-context")
mock.module(new URL("../src/lib/mca/assistant/chatkit-context.ts", import.meta.url).href, {
  namedExports: { ...actual, delegatedContext: (claims: Parameters<typeof actual.delegatedContext>[0]) => actual.delegatedContext(claims, async () => {
    if (!sessionActive) throw new Error("Synthetic session revoked")
  }) },
})
nativeAssistant = (await import("../src/lib/mca/assistant/native-runtime")).nativeAssistant

  fixture = await createPostgresTestDatabase("native_assistant")
  process.env.DATABASE_URL = fixture.databaseUrl
  process.env.MCA_ASSISTANT_SIGNING_SECRET = "synthetic-native-assistant-signing-secret"
  process.env.OPENAI_API_KEY = "synthetic-model-key"
  process.env.MCA_ASSISTANT_MODEL = "synthetic-model"
  for (const name of ["first", "second"]) {
    const data = await createWorkspaceWithAdmin({ workspaceName: name, adminName: "Test", adminEmail: `${randomUUID()}@example.test`, password: "Synthetic password 2026!", role: "admin" })
    const context: MembershipContext = { ...data, authType: "session", role: "admin", sessionId: randomUUID(), scopes: [] }
    await getDatabase().prepare("UPDATE users SET supabase_user_id=? WHERE id=?").run(randomUUID(), data.userId)
    if (name === "first") first = context; else second = context
  }
})
beforeEach(() => {
  sessionActive = true; calls = 0
  globalThis.fetch = async (url) => {
    assert.equal(String(url), "https://api.openai.com/v1/responses"); calls++
    return events([{ type: "response.output_text.delta", delta: "Synthetic reply" }, { type: "response.completed", response: { output: [] } }])
  }
})
after(async () => {
  globalThis.fetch = originalFetch
  for (const [key,value] of [["MCA_ASSISTANT_SIGNING_SECRET",saved.signing],["OPENAI_API_KEY",saved.key],["MCA_ASSISTANT_MODEL",saved.model]]) { if (value === undefined) delete process.env[key!]; else process.env[key!] = value }
  await closeDatabaseForTests(); await fixture?.close()
})

async function request(command: NativeChatRequest, context = first) {
  const raw = JSON.stringify(command), now = Math.floor(Date.now()/1000), requestId = randomUUID()
  await getDatabase().prepare("INSERT INTO mca_chatkit_requests(id,workspace_id,user_id,expires_at) VALUES(?,?,?,?)")
    .run(requestId,context.workspaceId,context.userId,new Date((now+120)*1000).toISOString())
  const token = signDelegation({ aud:"mca-chatkit",requestId,userId:context.userId,workspaceId:context.workspaceId,membershipId:context.membershipId,sessionId:context.sessionId!,bodyHash:bodyHash(raw),iat:now,exp:now+120 })
  return new Request("https://example.test/functions/v1/mca-assistant", { method:"POST",body:raw,headers:{authorization:`Bearer ${token}`} })
}
async function turn(command: NativeChatRequest) {
  const response = await nativeAssistant(await request(command))
  assert.equal(response.status,200)
  const result: Record<string,unknown>[] = []
  for await (const event of decodeSse(response.body!)) result.push(event as Record<string,unknown>)
  return result
}

test("native turns stream and retries replay a persisted reply without another model call", async () => {
  const messageId = randomUUID(), command: NativeChatRequest = {version:1,type:"threads.create",params:{message_id:messageId,text:"My pipeline?"}}
  const result = await turn(command), threadId = String(result[0].threadId)
  assert.equal(result.at(-1)?.type,"complete"); assert.equal(calls,1)
  const retried = await turn({version:1,type:"threads.retry_after_item",params:{thread_id:threadId,message_id:messageId,text:"My pipeline?"}})
  assert.equal(retried.at(-1)?.type,"complete"); assert.equal(calls,1)
  const rows = await getDatabase().prepare<{count:string}>("SELECT count(*) count FROM mca_chatkit_items WHERE thread_id=?").get(threadId)
  assert.equal(Number(rows?.count),2)
  const conflict = await nativeAssistant(await request({version:1,type:"threads.add_user_message",params:{thread_id:threadId,message_id:messageId,text:"Changed question"}}))
  assert.equal(conflict.status,409)
})
test("legacy history remains readable and another company cannot read or delete it", async () => {
  const context = await actual.assistantContext(first), id = `legacy_${randomUUID()}`
  await storeOperation(context,storeRequest.parse({op:"save_thread",payload:{id,title:"Legacy",created_at:new Date().toISOString()}}))
  await storeOperation(context,storeRequest.parse({op:"save_item",threadId:id,payload:{id:"legacy_message",thread_id:id,type:"assistant_message",content:[{type:"output_text",text:"Historical response"}]}}))
  const response = await nativeAssistant(await request({version:1,type:"items.list",params:{thread_id:id}}))
  assert.equal(response.status,200); assert.match(JSON.stringify(await response.json()),/Historical response/)
  for (const type of ["threads.get_by_id","threads.delete"] as const) {
    const denied = await nativeAssistant(await request({version:1,type,params:{thread_id:id}},second)); assert.equal(denied.status,404)
  }
})
test("malformed operations and forged or revoked delegations fail before model access", async () => {
  const command: NativeChatRequest = {version:1,type:"threads.list",params:{}}
  const valid = await request(command)
  const forged = new Request(valid.url,{method:"POST",headers:valid.headers,body:JSON.stringify({...command,type:"send_email"})})
  assert.equal((await nativeAssistant(forged)).status,401)
  sessionActive = false
  assert.notEqual((await nativeAssistant(await request(command))).status,200)
  assert.equal(calls,0)
})
test("Vercel Node gateway streams without a service URL and rechecks membership", async () => {
  const { chatkitGateway } = await import("../src/lib/mca/assistant/gateway")
  const savedRuntime = process.env.MCA_ASSISTANT_RUNTIME, savedEnabled = process.env.MCA_ASSISTANT_ENABLED
  const savedUrl = process.env.MCA_ASSISTANT_SERVICE_URL
  process.env.MCA_ASSISTANT_RUNTIME = "vercel_node"
  process.env.MCA_ASSISTANT_ENABLED = "true"
  delete process.env.MCA_ASSISTANT_SERVICE_URL
  const command = { version: 1, type: "threads.create", params: { message_id: randomUUID(), text: "My pipeline?" } }
  const gatewayRequest = () => new Request("https://example.test/api/mca/chatkit", {
    method: "POST", headers: { origin: "https://example.test", "content-type": "application/json" }, body: JSON.stringify(command),
  })
  try {
    const response = await chatkitGateway(gatewayRequest(), async () => first)
    assert.equal(response.status, 200)
    const events: Record<string, unknown>[] = []
    for await (const event of decodeSse(response.body!)) events.push(event as Record<string, unknown>)
    assert.equal(events.at(-1)?.type, "complete")
    assert.equal(calls, 1)
    await getDatabase().prepare("UPDATE memberships SET status='deactivated' WHERE id=?").run(first.membershipId)
    const denied = await chatkitGateway(gatewayRequest(), async () => first)
    assert.notEqual(denied.status, 200)
    assert.equal(calls, 1)
  } finally {
    await getDatabase().prepare("UPDATE memberships SET status='active' WHERE id=?").run(first.membershipId)
    for (const [key, value] of [["MCA_ASSISTANT_RUNTIME", savedRuntime], ["MCA_ASSISTANT_ENABLED", savedEnabled], ["MCA_ASSISTANT_SERVICE_URL", savedUrl]] as const)
      if (value === undefined) delete process.env[key]; else process.env[key] = value
  }
})
test("truncated provider streams emit an error and never persist a completed answer", async () => {
  globalThis.fetch = async () => events([{type:"response.output_text.delta",delta:"partial"}])
  const result = await turn({version:1,type:"threads.create",params:{message_id:randomUUID(),text:"My pipeline?"}})
  assert.equal(result.at(-1)?.type,"error")
  assert.equal(result.some(event=>event.type==="complete"),false)
  const count = await getDatabase().prepare<{count:string}>("SELECT count(*) count FROM mca_chatkit_items WHERE thread_id=?").get(result[0].threadId)
  assert.equal(Number(count?.count),1)
})
