/** Isolated end-to-end verification. OPENAI_API_KEY stays in process memory. */
import { createPostgresTestDatabase } from "../../tests/helpers/postgres-test-db.mjs"
import { createSupabaseHttpFixture } from "../../tests/helpers/supabase-http.mjs"
import { spawn } from "node:child_process"
import { randomBytes } from "node:crypto"
import { readFileSync, writeFileSync, rmSync } from "node:fs"
import { parseEnv } from "node:util"
import { once } from "node:events"
import assert from "node:assert/strict"

const live = process.argv.includes("--live")
const hold = process.argv.includes("--hold")
const base = "http://localhost:4387"
let database, fixture, web, python
const local = parseEnv(readFileSync(".env.local", "utf8"))
const key = process.env.OPENAI_API_KEY || local.OPENAI_API_KEY
const model = process.env.MCA_ASSISTANT_MODEL || local.MCA_ASSISTANT_MODEL
if (!key || !model) throw new Error("Configure OPENAI_API_KEY and MCA_ASSISTANT_MODEL before verification.")
const signing = randomBytes(32).toString("base64url")
async function ready(url) {
  for (let attempt=0;attempt<90;attempt++) {
    try { if((await fetch(url,{signal:AbortSignal.timeout(2000)})).status<500) return } catch {}
    await new Promise(resolve=>setTimeout(resolve,500))
  }
  throw new Error("Verification server did not become ready.")
}
async function stop(child) {
  if(child && child.exitCode===null) { child.kill("SIGTERM"); await once(child,"exit") }
}
try {
  database = await createPostgresTestDatabase("chatkit_e2e")
  fixture = await createSupabaseHttpFixture(database)
  const owner = await fixture.login("chatkit-owner@example.test","Synthetic password 99!")
  const headers = await fixture.headers(owner.cookie)
  const env = database.env({ ...fixture.env, MCA_ASSISTANT_ENABLED:"true", MCA_ASSISTANT_DOMAIN_KEY:"domain_pk_localhost_dev",
    MCA_ASSISTANT_SIGNING_SECRET:signing, MCA_ASSISTANT_SERVICE_URL:"http://127.0.0.1:8387", MCA_APP_ORIGIN:base,
    NEXT_DIST_DIR:".next-test-chatkit", MCA_ASSISTANT_MODEL:model, MCA_STRIPE_BILLING_ENABLED:"false" })
  web = spawn(process.execPath,["node_modules/next/dist/bin/next","dev","--hostname","localhost","--port","4387"],{env,stdio:["ignore","ignore","ignore"]})
  python = spawn(process.env.CHATKIT_PYTHON || "python3",["-m","uvicorn","app:app","--host","127.0.0.1","--port","8387","--no-access-log",...(hold ? ["--reload"] : [])],{
    cwd:"../chatkit-service",env:{...process.env,OPENAI_API_KEY:key,MCA_ASSISTANT_MODEL:model,MCA_ASSISTANT_SIGNING_SECRET:signing,MCA_ASSISTANT_CALLBACK_URL:`${base}/api/mca/chatkit/internal`},stdio:["ignore","ignore","ignore"],
  })
  await ready(`${base}/api/auth/session`); await ready("http://127.0.0.1:8387/health")
  const request = (path,body) => fetch(`${base}${path}`,{method:"POST",headers:{...headers,origin:base,"content-type":"application/json"},body:JSON.stringify(body)})
  const created = await request("/api/mca/deals",{idempotencyKey:"chatkit-synthetic-one",legalName:"Synthetic Cedar Bakery",requestedAmount:25000,monthlyRevenue:50000})
  assert.equal(created.status,201)
  const deal = await created.json()
  const noAuth = await fetch(`${base}/api/mca/chatkit`,{method:"POST",headers:{origin:base,"content-type":"application/json"},body:JSON.stringify({type:"threads.list",params:{}})})
  assert.equal(noAuth.status,401)
  const history = await request("/api/mca/chatkit",{type:"threads.list",params:{}})
  assert.equal(history.status,200)
  console.log("Authenticated gateway and Python storage round-trip passed.")
  if(live) {
    const response = await request("/api/mca/chatkit",{type:"threads.create",params:{input:{content:[{type:"input_text",text:"Use summarize_pipeline to count my deals. Give the total and a link. This is a synthetic verification."}],attachments:[],inference_options:{}}}})
    assert.equal(response.status,200)
    const stream=await response.text()
    const events=stream.split("\n").filter(line=>line.startsWith("data: ")).map(line=>JSON.parse(line.slice(6)))
    const errors=events.filter(event=>event.type==="error")
    assert.equal(errors.length,0,"Live response returned a sanitized error event")
    const tid=events.find(event=>event.type==="thread.created")?.thread.id
    assert.ok(tid)
    const restored=await request("/api/mca/chatkit",{type:"threads.get_by_id",params:{thread_id:tid}})
    assert.equal(restored.status,200)
    const text=await restored.text()
    assert.ok(text.includes("assistant_message"),"Expected a persisted assistant response")
    const refs=await database.query("SELECT deal_id FROM mca_chatkit_references WHERE thread_id=$1",[tid])
    assert.ok(refs.rows.some(row=>row.deal_id===deal.id),"Expected the model to execute the pipeline tool")
    const deleted=await request("/api/mca/chatkit",{type:"threads.delete",params:{thread_id:tid}})
    assert.equal(deleted.status,200)
    console.log("Live synthetic model/tool/stream/history/delete round-trip passed.")
  }
  if(hold) {
    const refresh = async () => writeFileSync("/tmp/mca-chatkit-browser-fixture.json",JSON.stringify({base,headers:await fixture.headers(owner.cookie),dealId:deal.id}),{mode:0o600})
    await refresh()
    const refreshTimer = setInterval(() => { void refresh() },30000)
    console.log("Synthetic browser fixture ready at http://localhost:4387/dashboard (10-minute window).")
    await new Promise(resolve=>{const timer=setTimeout(resolve,600000);process.once("SIGTERM",()=>{clearTimeout(timer);resolve()})})
    clearInterval(refreshTimer)
  }
} finally {
  if(hold) rmSync("/tmp/mca-chatkit-browser-fixture.json",{force:true})
  await stop(web); await stop(python)
  if(fixture) await fixture.close()
  if(database) await database.close()
}
