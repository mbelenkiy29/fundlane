import assert from "node:assert/strict"
import fs from "node:fs/promises"
import http from "node:http"
import { createRequire } from "node:module"
const require = createRequire(import.meta.url)
const { chromium } = require("/Users/mbele/.npm-global/lib/node_modules/openclaw/node_modules/playwright-core")
const directory = "/tmp/task6-public-entry-browser"
const server = http.createServer(async (request, response) => {
  const pathname = new URL(request.url, "http://localhost").pathname
  const file = pathname === "/app.js" ? "app.js" : pathname === "/app.css" ? "app.css" : "index.html"
  response.setHeader("content-type", file.endsWith(".js") ? "text/javascript" : file.endsWith(".css") ? "text/css" : "text/html")
  response.end(await fs.readFile(`${directory}/${file}`))
})
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve))
const origin = `http://127.0.0.1:${server.address().port}`
const browser = await chromium.launch({ headless: true, executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", args: ["--no-sandbox"] })
const results = [], browserErrors = []
const id = "11111111-1111-4111-8111-111111111111"
const canonical = `/enrollment?enrollment=${id}&destination=business&generation=3`
const readiness = { dismissed: false, dismissedAt: null, completedCount: 0, totalCount: 0, allComplete: false, nextStep: null, steps: [], readiness: [{ id:"business_details",title:"Business details",phase:"needs_setup",detail:"Optional legal name and EIN. Keep using the CRM.",action:"Open business details",href:"/settings/business",helpHref:"/help/set-up-your-company" }] }

async function fixture(screen, scenario = "ready", viewport = { width: 1440, height: 900 }) {
  const context = await browser.newContext({ viewport })
  if (scenario === "unsupported") await context.addInitScript(() => { Object.defineProperty(navigator, "locks", { configurable: true, value: undefined }) })
  const calls = [], navigations = []
  const state = { scenario, statusCalls: 0, claimCalls: 0, sessionCalls: 0, startCalls: 0, holdStart: null, releaseStart: null, holdClaim: null, releaseClaim: null }
  await context.route("**/*", async route => {
    const request = route.request(), url = new URL(request.url())
    if (url.origin !== origin) { navigations.push(url.toString()); return route.fulfill({ status: 200, contentType: "text/html", body: "Synthetic external destination. No provider request." }) }
    if (["/dashboard", "/settings/business", "/account-security"].includes(url.pathname)) { navigations.push(url.pathname + url.search); return route.fulfill({status:200,contentType:"text/html",body:"Synthetic protected destination"}) }
    if (!url.pathname.startsWith("/api/")) return route.continue()
    const body = request.postData() ? JSON.parse(request.postData()) : null
    calls.push({ path:url.pathname, search:url.search, method:request.method(), body, cookie:request.headers().cookie??"" })
    const respond = (body, status = 200, headers) => route.fulfill({status,contentType:"application/json",body:JSON.stringify(body),headers})
    const error = (code,status=403) => respond({error:{code,message:"RAW synthetic provider detail must not render"}},status)
    if (url.pathname === "/api/enrollment/session") { state.sessionCalls++; return respond({success:true},200,{"set-cookie":"mca_enrollment_binding=synthetic-browser-binding; HttpOnly; SameSite=Lax; Path=/"}) }
    if (url.pathname === "/api/enrollment/start") { state.startCalls++; if(state.holdStart)await state.holdStart; if(state.scenario==="start-failed"){state.scenario="ready";return error("enrollment_busy",409)} return respond({enrollmentId:id,checkoutUrl:"https://checkout.stripe.test/synthetic"}) }
    if (url.pathname === "/api/enrollment/status") {
      state.statusCalls++
      if(state.scenario==="stale")return error("enrollment_link_superseded",409)
      if(state.scenario==="outage")return error("enrollment_disabled",503)
      const stateName = ["auth","unknown","expired"].includes(state.scenario) ? "unavailable" : state.scenario === "pending" ? "pending" : state.scenario === "recover" ? "recovery_required" : state.scenario === "claimed" ? "claimed" : "ready"
      return respond({state:stateName,nextAction:stateName==="unavailable"?"authenticate":stateName==="pending"?"wait":stateName==="recovery_required"?"recover":stateName==="claimed"?"continue":"claim",...(stateName==="unavailable"?{}:{trialEndsAt:"2026-10-15T18:30:00Z",destination:"/settings/business"})})
    }
    if(url.pathname==="/api/enrollment/claim") { state.claimCalls++; if(state.holdClaim)await state.holdClaim; if(state.scenario==="mfa")return error("totp_required");if(state.scenario==="mfa-enroll")return error("totp_enrollment_required");if(state.scenario==="wrong")return error("enrollment_identity_mismatch");if(state.scenario==="unauth")return error("authentication_required",401);state.scenario="claimed";return respond({workspaceId:id,destination:"/settings/business"}) }
    if(url.pathname==="/api/enrollment/billing")return respond({url:"https://billing.stripe.test/synthetic"})
    if(url.pathname==="/api/enrollment/auth")return respond({success:true,challengeId:"22222222-2222-4222-8222-222222222222"})
    if(url.pathname==="/api/enrollment/verify") {if(state.scenario==="expired")return error("enrollment_challenge_invalid",400);state.scenario="ready";return respond({success:true,destination:canonical})}
    if(url.pathname==="/api/auth/google")return respond({url:"https://google.synthetic.test/authorize"})
    if(url.pathname==="/api/auth/sign-in")return error("invalid_credentials",401)
    if(url.pathname==="/api/auth/sign-out")return respond({success:true})
    if(url.pathname==="/api/onboarding")return respond({authenticated:true,stripeFirstRequired:true,workspaces:[],signupMode:"open",companyName:"Editable metadata is not authority"})
    if(url.pathname==="/api/mca/setup")return respond({...readiness,dismissed:body?.dismissed??false})
    if(url.pathname==="/api/mca/onboarding/business")return respond({legalName:"Synthetic business",einPresent:false,revision:0,registered:false})
    return error("unexpected_fixture_request",400)
  })
  const page = await context.newPage()
  page.setDefaultTimeout(5000)
  page.on("pageerror", error => { browserErrors.push(error.message); console.error(`BROWSER ERROR ${error.message}`) })
  if (scenario === "pending") await page.clock.install()
  await page.goto(`${origin}/?screen=${screen}&scenario=${scenario}&next=${encodeURIComponent(canonical)}`, {waitUntil:"networkidle"})
  return {page,context,calls,navigations,state}
}
async function check(name, action) {
  if (process.env.MCA_BROWSER_CASE && !new RegExp(process.env.MCA_BROWSER_CASE).test(name)) return
  try { await action(); results.push({name,status:"PASS"}); console.log(`PASS ${name}`) }
  catch(error) { results.push({name,status:"FAIL",error:error.message}); console.error(`FAIL ${name}: ${error.message}`) }
}
try {
  await check("Login stages locally, focuses password, and clears stale error on Change email",async()=>{
    const f=await fixture("login");await f.page.getByLabel("Work email").fill("unknown@example.test");await f.page.getByRole("button",{name:"Next",exact:true}).click();assert.equal(await f.page.locator(":focus").getAttribute("name"),"password");assert.equal(f.calls.length,0);await f.page.getByLabel("Password",{exact:true}).fill("Synthetic unused password");await f.page.getByRole("button",{name:"Login",exact:true}).click();await f.page.getByRole("alert").waitFor();assert.equal(await f.page.locator(":focus").getAttribute("role"),"alert");await f.page.getByRole("button",{name:"Change email"}).click();assert.equal(await f.page.getByRole("alert").count(),0);assert.equal(await f.page.locator(":focus").getAttribute("name"),"email");await f.context.close()
  })
  await check("mobile native details traps Tab, restores body and closes on Escape/desktop resize",async()=>{
    const f=await fixture("mobile","ready",{width:390,height:844});const summary=f.page.locator("summary");await summary.click();await f.page.waitForFunction(()=>document.body.style.overflow==="hidden");await summary.focus();await f.page.keyboard.press("Shift+Tab");assert.equal(await f.page.locator(":focus").innerText(),"Get Started");await f.page.keyboard.press("Tab");assert.equal(await f.page.locator(":focus").evaluate(el=>el.tagName),"SUMMARY");await f.page.keyboard.press("Escape");await f.page.waitForFunction(()=>!document.querySelector("details").open&&document.body.style.overflow!=="hidden");await summary.click();await f.page.setViewportSize({width:1440,height:900});await f.page.waitForFunction(()=>!document.querySelector("details").open&&document.body.style.overflow!=="hidden");await f.context.close()
  })
  await check("live start guards repeated click, keeps empty bodies and retries with the same browser binding",async()=>{
    const f=await fixture("start","start-failed");f.state.holdStart=new Promise(resolve=>{f.state.releaseStart=resolve});await f.page.getByRole("button",{name:"Start 14-day free trial"}).evaluate(button=>{button.click();button.click()});await f.page.getByRole("button",{name:"Opening secure Checkout…"}).waitFor();await f.page.waitForFunction(()=>document.querySelector("button").disabled);f.state.releaseStart();await f.page.getByRole("alert").waitFor();assert.equal(f.state.startCalls,1);await f.page.getByRole("button",{name:"Start 14-day free trial"}).click();await f.page.waitForURL("https://checkout.stripe.test/synthetic");assert.equal(f.state.startCalls,2);assert.equal(f.state.sessionCalls,2);assert.ok(f.calls.every(call=>JSON.stringify(call.body)==="{}"));assert.equal((await f.context.cookies(origin)).find(c=>c.name==="mca_enrollment_binding")?.httpOnly,true);await f.context.close()
  })
  await check("unsupported browser cannot start a purchase and preserves Login/help and existing completion",async()=>{
    const f=await fixture("start","unsupported");await f.page.getByText(/browser cannot safely start a new trial/i).waitFor();const button=f.page.getByRole("button",{name:"Start 14-day free trial"});assert.equal(await button.isDisabled(),true);await button.evaluate(button=>{button.click();button.click()});assert.equal(f.state.sessionCalls,0);assert.equal(f.state.startCalls,0);assert.equal(f.navigations.length,0);assert.equal(await f.page.getByRole("link",{name:"Login",exact:true}).getAttribute("href"),"/sign-in");await f.page.getByRole("link",{name:"Get help"}).waitFor();await f.page.goto(`${origin}/?screen=enrollment`,{waitUntil:"networkidle"});await f.page.getByRole("button",{name:"Enter your CRM"}).waitFor();assert.equal(f.state.sessionCalls,0);assert.equal(f.state.startCalls,0);await f.context.close()
  })
  await check("ready purchase requires explicit claim, guards repeats and preserves destination on refresh/back",async()=>{
    const f=await fixture("enrollment");assert.equal(f.state.claimCalls,0);assert.match(await f.page.locator("time").innerText(),/Oct 15, 2026.*UTC/);await f.page.reload({waitUntil:"networkidle"});assert.equal(f.state.claimCalls,0);f.state.holdClaim=new Promise(resolve=>{f.state.releaseClaim=resolve});await f.page.getByRole("button",{name:"Enter your CRM"}).evaluate(button=>{button.click();button.click()});await f.page.getByRole("button",{name:"Finishing secure access…"}).waitFor();f.state.releaseClaim();await f.page.waitForURL(`${origin}/settings/business`);assert.equal(f.state.claimCalls,1);assert.deepEqual(f.calls.find(c=>c.path.endsWith("/claim")).body,{enrollmentId:id,destination:"business",generation:3});await f.page.goBack({waitUntil:"networkidle"});await f.page.getByRole("button",{name:"Continue to your workspace"}).waitFor();assert.equal(f.state.claimCalls,1);await f.context.close()
  })
  await check("cross-tab start serializes first cookie bootstrap and reuses the browser binding",async()=>{
    const f=await fixture("start");assert.equal(await f.page.evaluate(()=>Boolean(navigator.locks)),true);const other=await f.context.newPage();await other.goto(`${origin}/?screen=start`,{waitUntil:"networkidle"});f.state.holdStart=new Promise(resolve=>{f.state.releaseStart=resolve});await f.page.getByRole("button",{name:"Start 14-day free trial"}).click();await f.page.getByRole("button",{name:"Opening secure Checkout…"}).waitFor();await other.getByRole("button",{name:"Start 14-day free trial"}).click();await other.getByRole("button",{name:"Opening secure Checkout…"}).waitFor();assert.equal(f.state.sessionCalls,1);f.state.releaseStart();await Promise.all([f.page.waitForURL(/checkout.stripe.test/),other.waitForURL(/checkout.stripe.test/)]);assert.equal(f.state.sessionCalls,2);const sessions=f.calls.filter(c=>c.path.endsWith("/session"));assert.match(sessions[1].cookie,/mca_enrollment_binding=synthetic-browser-binding/);assert.ok(f.calls.filter(c=>c.path.endsWith("/start")).every(c=>c.cookie.includes("mca_enrollment_binding=synthetic-browser-binding")));await f.context.close()
  })
  for(const scenario of ["mfa","mfa-enroll"])await check(`${scenario} uses reviewed account-security continuation`,async()=>{const f=await fixture("enrollment",scenario);await f.page.getByRole("button",{name:"Enter your CRM"}).click();await f.page.waitForURL(/account-security/);const url=new URL(f.page.url());assert.equal(url.searchParams.get("next"),canonical);assert.equal(url.searchParams.get(scenario==="mfa"?"challenge":"required"),"1");await f.context.close()})
  await check("wrong account offers explicit switch without new purchase or raw provider data",async()=>{const f=await fixture("enrollment","wrong");await f.page.getByRole("button",{name:"Enter your CRM"}).click();await f.page.getByRole("button",{name:"Sign out and use another account"}).waitFor();assert.doesNotMatch(await f.page.locator("body").innerText(),/RAW synthetic/);assert.equal(f.state.startCalls,0);await f.context.close()})
  await check("email challenge expires neutrally and permits explicit resend with canonical context",async()=>{
    const f=await fixture("enrollment","expired",{width:390,height:844});await f.page.getByLabel("Checkout email").fill("purchase@example.test");await f.page.getByRole("button",{name:"Send verification code"}).click();await f.page.getByLabel("Email verification code").waitFor();assert.equal(await f.page.locator(":focus").getAttribute("name"),"token");await f.page.getByLabel("Email verification code").fill("123456");await f.page.getByRole("button",{name:"Verify and continue"}).click();await f.page.getByRole("alert").waitFor();assert.doesNotMatch(await f.page.locator("body").innerText(),/RAW synthetic/);await f.page.getByRole("button",{name:"Request a new code"}).click();await f.page.waitForFunction(()=>document.querySelector('input[name="token"]').value==="");assert.deepEqual(f.calls.find(c=>c.path.endsWith("/auth")).body,{enrollmentId:id,destination:"business",generation:3,email:"purchase@example.test"});assert.deepEqual(f.calls.find(c=>c.path.endsWith("/verify")).body,{challengeId:"22222222-2222-4222-8222-222222222222",email:"purchase@example.test",token:"123456"});assert.match(await f.page.getByRole("link",{name:"Login with password"}).getAttribute("href"),/next=/);await f.context.close()
  })
  await check("Google completion keeps canonical enrollment and uses external browser navigation",async()=>{const f=await fixture("enrollment","auth");await f.page.getByRole("button",{name:"Continue with Google"}).click();await f.page.waitForURL(/google.synthetic.test/);assert.deepEqual(f.calls.find(c=>c.path==="/api/auth/google").body,{next:canonical});await f.context.close()})
  await check("accepted email verification reloads canonical completion without claiming automatically",async()=>{const f=await fixture("enrollment","auth");await f.page.getByLabel("Checkout email").fill("purchase@example.test");await f.page.getByRole("button",{name:"Send verification code"}).click();await f.page.getByLabel("Email verification code").fill("123456");await f.page.getByRole("button",{name:"Verify and continue"}).click();await f.page.waitForURL(`${origin}${canonical}`);await f.page.getByRole("button",{name:"Enter your CRM"}).waitFor();assert.equal(f.state.claimCalls,0);assert.equal(f.state.startCalls,0);await f.context.close()})
  await check("pending confirmation polls at most twelve times, never starts/claims, and cleans up",async()=>{
    const f=await fixture("enrollment","pending");for(let n=0;n<13;n++){await f.page.clock.fastForward(5000);await f.page.waitForTimeout(50)}assert.equal(f.state.statusCalls,12);assert.equal(f.state.startCalls,0);assert.equal(f.state.claimCalls,0);await f.page.getByText(/Confirmation is taking longer/).waitFor();await f.page.getByRole("button",{name:"Retry confirmation",exact:true}).click();await f.page.waitForTimeout(50);assert.equal(f.state.statusCalls,13);await f.page.goto(`${origin}/?screen=start`);const after=f.state.statusCalls;await f.page.clock.fastForward(60000);assert.equal(f.state.statusCalls,after);await f.context.close()
  })
  for(const scenario of ["stale","outage","recover"])await check(`${scenario} presents retry/support without duplicate Checkout`,async()=>{const f=await fixture("enrollment",scenario);assert.match(await f.page.locator("body").innerText(),/support|recovery/i);assert.doesNotMatch(await f.page.locator("body").innerText(),/RAW synthetic|Start 14-day/);assert.equal(f.state.startCalls,0);await f.context.close()})
  await check("precompany billing is explicit and uses returned external portal",async()=>{const f=await fixture("enrollment","recover");assert.equal(f.calls.some(c=>c.path.endsWith("/billing")),false);await f.page.getByRole("button",{name:"Manage or cancel billing"}).click();await f.page.waitForURL(/billing.stripe.test/);assert.deepEqual(f.calls.find(c=>c.path.endsWith("/billing")).body,{enrollmentId:id,destination:"business",generation:3});await f.context.close()})
  await check("account-only legacy onboarding hides company/seat/no-card creation under rollout",async()=>{const f=await fixture("legacy");await f.page.getByRole("link",{name:/Pricing/}).waitFor({timeout:2500});assert.equal(await f.page.locator('input').count(),0);assert.doesNotMatch(await f.page.locator("body").innerText(),/no card|Create company/);assert.equal(f.calls.filter(c=>c.method==="POST").length,0);await f.context.close()})
  await check("optional setup only reads until explicit hide and stores no EIN",async()=>{const f=await fixture("setup");await f.page.getByLabel("Legal business name").waitFor();assert.equal(f.calls.filter(c=>c.method==="POST").length,0);assert.equal(await f.page.getByLabel("EIN",{exact:true}).getAttribute("type"),"password");await f.page.getByLabel("EIN",{exact:true}).fill("123456789");assert.deepEqual(await f.page.evaluate(()=>({local:Object.keys(localStorage),session:Object.keys(sessionStorage)})),{local:[],session:[]});await f.page.getByRole("button",{name:"Hide workspace setup checklist"}).click();await f.page.getByRole("button",{name:"Resume checklist"}).waitFor();assert.deepEqual(f.calls.find(c=>c.method==="POST").body,{dismissed:true,progressive:true});await f.context.close()})
  await check("CRM preserves dismissed checklist resume and authoritative trial billing link",async()=>{const f=await fixture("dashboard");await f.page.getByRole("link",{name:"Resume getting started"}).waitFor({timeout:2500});assert.match(await f.page.locator("time").innerText(),/Oct 15, 2026.*UTC/);await f.page.getByRole("link",{name:"Manage or cancel billing"}).waitFor();assert.equal(f.calls.filter(c=>c.method==="POST").length,0);await f.context.close()})
  assert.deepEqual(browserErrors,[],"actual browser components must not throw")
} finally {
  await fs.writeFile(`${directory}/results.json`,JSON.stringify({results,browserErrors},null,2))
  await browser.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve))
}
console.log(JSON.stringify({tests:results.length,pass:results.filter(r=>r.status==="PASS").length,fail:results.filter(r=>r.status==="FAIL").length,browserErrors},null,2))
if(results.some(r=>r.status==="FAIL"))process.exitCode=1
