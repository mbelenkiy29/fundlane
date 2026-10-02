import assert from "node:assert/strict"
import test from "node:test"
import { interactionSetup, renderSetup, runClient } from "./helpers/public-entry-render"

const locator = { enrollmentId: "11111111-1111-4111-8111-111111111111", destination: "business", generation: 3 }
const load = `let mod;try{mod=require('./src/components/mca/onboarding/enrollment-completion.tsx')}catch(error){if(error.code!=='MODULE_NOT_FOUND')throw error}assert.ok(mod?.EnrollmentCompletion,'live enrollment completion is implemented');const { EnrollmentCompletion }=mod;`

test("completion renders authoritative trial date and explicit claim without SSR requests", () => {
  const result = runClient(`${renderSetup}
    const assert=require('node:assert/strict');${load}
    const requests=[];global.fetch=async (...args)=>{requests.push(args);throw Error('no render requests')};
    console.log(JSON.stringify({html:renderToStaticMarkup(React.createElement(EnrollmentCompletion,{continuation:${JSON.stringify(locator)},initialStatus:{state:'ready',nextAction:'claim',trialEndsAt:'2026-10-15T18:30:00.000Z'}})),requests}));
  `)
  assert.match(result.html, /Enter your CRM/)
  assert.match(result.html, /Oct 15, 2026/)
  assert.match(result.html, /UTC/)
  assert.match(result.html, /base monthly first-user price of \$399\/month USD/)
  assert.match(result.html, /applicable Checkout discounts and tax/)
  assert.match(result.html, /Manage or cancel billing/)
  assert.doesNotMatch(result.html, /company name|name="seats"|Invite your employees/i)
  assert.deepEqual(result.requests, [])
})

for (const [destination, returnedDestination] of [["business", "/settings/business"], ["crm", "/dashboard"], ["billing", "/settings/billing"], ["business", "/settings/billing"]]) {
  test(`claimed Continue replays once before selecting A and navigating ${destination} to ${returnedDestination}`, () => {
    const continuation = { ...locator, destination }
    const result = runClient(`${interactionSetup}
      let activeWorkspace='B',resolveClaim;const pending=new Promise(resolve=>{resolveClaim=resolve});
      const originalB={basics:'Company B',customer:'cus_B',subscription:'sub_B'};
      const companies={A:{basics:'Company A',customer:'cus_A',subscription:'sub_A'},B:{...originalB}};
      response=async(path)=>{if(path.endsWith('/claim')){await pending;activeWorkspace='A';return {workspaceId:'A',destination:${JSON.stringify(returnedDestination)}}}return {state:'claimed',nextAction:'continue',destination:'/settings/business'};};
      ${load}
      (async()=>{const props={continuation:${JSON.stringify(continuation)},initialStatus:{state:'claimed',nextAction:'continue',destination:'/settings/business'}};
        const view=render(EnrollmentCompletion,props);await Promise.resolve();
        const before={activeWorkspace,calls:[...calls],navigations:[...navigations]};
        const onClick=button(view.tree,'Continue to your workspace').props.onClick;
        const first=onClick(),second=onClick();await Promise.resolve();
        const held={activeWorkspace,calls:[...calls],navigations:[...navigations],html:render(EnrollmentCompletion,props).markup};
        resolveClaim();await Promise.all([first,second]);
        console.log(JSON.stringify({before,held,activeWorkspace,calls,navigations,companies,originalB}));
      })().catch(error=>{console.error(error);process.exitCode=1});
    `)
    assert.equal(result.before.activeWorkspace, "B")
    assert.equal(result.before.calls.length, 1)
    assert.match(result.before.calls[0].path, /^\/api\/enrollment\/status\?/)
    assert.deepEqual(result.before.navigations, [])
    assert.equal(result.held.activeWorkspace, "B")
    assert.deepEqual(result.held.navigations, [], "navigation waits for explicit authorized replay")
    assert.match(result.held.html, /<button[^>]*disabled/)
    assert.deepEqual(result.calls.filter((call: {path:string}) => call.path === "/api/enrollment/claim"), [{path:"/api/enrollment/claim",input:continuation}])
    assert.equal(result.activeWorkspace, "A")
    assert.deepEqual(result.navigations, [returnedDestination], "only the replay destination is trusted")
    assert.deepEqual(result.companies.B, result.originalB)
  })
}

for (const code of ["membership_inactive", "totp_required", "totp_enrollment_required", "authentication_required", "enrollment_identity_mismatch"]) {
  test(`claimed Continue handles ${code} without selecting or opening the workspace`, () => {
    const result = runClient(`${interactionSetup}
      response=async(path)=>{if(path.endsWith('/claim')){const error=new Error('RAW provider data');error.code=${JSON.stringify(code)};throw error}return {state:'claimed',nextAction:'continue',destination:'/settings/business'};};
      ${load}
      (async()=>{const props={continuation:${JSON.stringify(locator)},initialStatus:{state:'claimed',nextAction:'continue',destination:'/settings/business'}};const view=render(EnrollmentCompletion,props);await button(view.tree,'Continue to your workspace').props.onClick();console.log(JSON.stringify({calls,navigations,html:render(EnrollmentCompletion,props).markup}));})().catch(error=>{console.error(error);process.exitCode=1});
    `)
    assert.equal(result.calls.filter((call: {path:string}) => call.path === "/api/enrollment/claim").length, 1)
    if (code.startsWith("totp_")) {
      assert.match(result.navigations[0], /^\/account-security\?/)
      assert.equal(new URL(result.navigations[0], "https://fundlane.test").searchParams.get("next"), "/enrollment?enrollment=11111111-1111-4111-8111-111111111111&destination=business&generation=3")
    } else {
      assert.deepEqual(result.navigations, [])
      assert.match(result.html, /role="alert"/)
    }
    assert.doesNotMatch(result.html, /RAW provider/)
  })
}

test("claimed Continue rejects a noncanonical replay destination", () => {
  const result = runClient(`${interactionSetup}
    response=async(path)=>path.endsWith('/claim')?{workspaceId:'A',destination:'https://foreign.example.test'}:{state:'claimed',nextAction:'continue',destination:'/settings/business'};
    ${load}
    (async()=>{const props={continuation:${JSON.stringify(locator)},initialStatus:{state:'claimed',nextAction:'continue',destination:'/settings/business'}};await button(render(EnrollmentCompletion,props).tree,'Continue to your workspace').props.onClick();console.log(JSON.stringify({navigations,html:render(EnrollmentCompletion,props).markup}));})().catch(error=>{console.error(error);process.exitCode=1});
  `)
  assert.deepEqual(result.navigations, [])
  assert.match(result.html, /role="alert"/)
})

test("completion pending and recovery never offer another Checkout start", () => {
  for (const status of [{ state: "pending", nextAction: "wait" }, { state: "recovery_required", nextAction: "recover" }, { state: "unavailable", nextAction: "authenticate" }]) {
    const html = runClient(`${renderSetup}const assert=require('node:assert/strict');${load}console.log(JSON.stringify(renderToStaticMarkup(React.createElement(EnrollmentCompletion,{continuation:${JSON.stringify(locator)},initialStatus:${JSON.stringify(status)}}))));`) as string
    assert.doesNotMatch(html, /Start 14-day|\/api\/enrollment\/start|href="\/pricing"/)
    if (status.state === "pending") assert.match(html, /confirming|confirmation/i)
    if (status.state === "recovery_required") assert.match(html, /review|support/i)
    if (status.state === "unavailable") assert.match(html, /Verify your email|correct account/i)
  }
})

test("completion claim preserves canonical locator and MFA context without raw errors", () => {
  const result = runClient(`${interactionSetup}
    response=async(path)=>{if(path.endsWith('/claim')){const e=new Error('RAW provider data');e.code='totp_required';throw e}return {state:'ready',nextAction:'claim'};};
    ${load}
    (async()=>{const props={continuation:${JSON.stringify(locator)},initialStatus:{state:'ready',nextAction:'claim'}};let view=render(EnrollmentCompletion,props);await button(view.tree,'Enter your CRM').props.onClick();console.log(JSON.stringify({calls,navigations,html:render(EnrollmentCompletion,props).markup}));})().catch(error=>{console.error(error);process.exitCode=1});
  `)
  const claim = result.calls.find((call: {path:string}) => call.path === "/api/enrollment/claim")
  assert.deepEqual(claim.input, locator)
  assert.match(result.navigations[0], /^\/account-security\?challenge=1&next=/)
  assert.equal(new URL(result.navigations[0], "https://fundlane.test").searchParams.get("next"), "/enrollment?enrollment=11111111-1111-4111-8111-111111111111&destination=business&generation=3")
  assert.doesNotMatch(result.html, /RAW provider/)
})

test("live trial start bootstraps before Checkout with empty bodies and external navigation", () => {
  const result = runClient(`${interactionSetup}
    let mod;try{mod=require('./src/components/marketing/trial-checkout-start.tsx')}catch(error){if(error.code!=='MODULE_NOT_FOUND')throw error}assert.ok(mod?.TrialCheckoutStart,'live trial start is implemented');
    dispatcher.useSyncExternalStore=(_subscribe,getSnapshot)=>getSnapshot();
    Object.defineProperty(globalThis,'navigator',{configurable:true,value:{locks:{request:async(_name,action)=>action(null)}}});
    response=async()=>({checkoutUrl:'https://checkout.stripe.test/synthetic',enrollmentId:'11111111-1111-4111-8111-111111111111'});
    (async()=>{render(mod.TrialCheckoutStart,{available:true});const tree=render(mod.TrialCheckoutStart,{available:true}).tree;await tree.props.onStart();console.log(JSON.stringify({calls,navigations}));})().catch(error=>{console.error(error);process.exitCode=1});
  `)
  assert.deepEqual(result.calls, [{ path: "/api/enrollment/session", input: {} }, { path: "/api/enrollment/start", input: {} }])
  assert.deepEqual(result.navigations, ["https://checkout.stripe.test/synthetic"])
})

test("unsupported cross-tab coordination disables new Checkout before browser binding requests", () => {
  const result = runClient(`${interactionSetup}
    dispatcher.useSyncExternalStore=(_subscribe,getSnapshot)=>getSnapshot();
    Object.defineProperty(globalThis,'navigator',{configurable:true,value:{}});
    const { TrialCheckoutStart }=require('./src/components/marketing/trial-checkout-start.tsx');
    render(TrialCheckoutStart,{available:true});const view=render(TrialCheckoutStart,{available:true});
    console.log(JSON.stringify({html:view.markup,calls,navigations}));
  `)
  assert.match(result.html, /browser cannot safely start a new trial/i)
  assert.match(result.html, /<button[^>]*disabled/)
  assert.match(result.html, /href="\/sign-in"[^>]*>Login/)
  assert.match(result.html, /href="\/help\/set-up-your-company"/)
  assert.deepEqual(result.calls, [])
  assert.deepEqual(result.navigations, [])
})

test("removing coordinator support before an existing handler runs still makes no enrollment request", () => {
  const result = runClient(`${interactionSetup}
    dispatcher.useSyncExternalStore=(_subscribe,getSnapshot)=>getSnapshot();
    Object.defineProperty(globalThis,'navigator',{configurable:true,value:{locks:{request:async(_name,action)=>action(null)}}});
    const { TrialCheckoutStart }=require('./src/components/marketing/trial-checkout-start.tsx');
    response=async()=>({enrollmentId:'11111111-1111-4111-8111-111111111111',checkoutUrl:'https://checkout.stripe.test/synthetic'});
    (async()=>{render(TrialCheckoutStart,{available:true});const tree=render(TrialCheckoutStart,{available:true}).tree;navigator.locks=undefined;await tree.props.onStart();console.log(JSON.stringify({html:render(TrialCheckoutStart,{available:true}).markup,calls,navigations}));})().catch(error=>{console.error(error);process.exitCode=1});
  `)
  assert.deepEqual(result.calls, [])
  assert.deepEqual(result.navigations, [])
  assert.match(result.html, /browser cannot safely start a new trial/i)
})

test("generic signup always redirects home, including under the dedicated rollout", () => {
  const result = runClient(`${renderSetup}
    mock.module('next/navigation',{exports:{redirect:destination=>{throw {destination}}}});
    const Page=require('./src/app/(auth)/sign-up/page.tsx').default;
    let destination;try{Page()}catch(error){destination=error.destination}console.log(JSON.stringify({destination}));
  `, { MCA_STRIPE_FIRST_ONBOARDING_ENABLED: "true", MCA_SIGNUP_MODE: "open" })
  assert.equal(result.destination, "/")
})

test("unavailable purchase offers explicit account switch and canonical password recovery", () => {
  const html = runClient(`${renderSetup}const assert=require('node:assert/strict');${load}console.log(JSON.stringify(renderToStaticMarkup(React.createElement(EnrollmentCompletion,{continuation:${JSON.stringify(locator)},initialStatus:{state:'unavailable',nextAction:'authenticate'}}))));`) as string
  assert.match(html, /Sign out and use another account/)
  assert.match(html, /href="\/forgot-password\?next=/)
})
