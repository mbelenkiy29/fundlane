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
  assert.match(result.html, /Manage or cancel billing/)
  assert.doesNotMatch(result.html, /company name|name="seats"|Invite your employees/i)
  assert.deepEqual(result.requests, [])
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
    response=async()=>({checkoutUrl:'https://checkout.stripe.test/synthetic',enrollmentId:'11111111-1111-4111-8111-111111111111'});
    (async()=>{const tree=mod.TrialCheckoutStart({available:true});await tree.props.onStart();console.log(JSON.stringify({calls,navigations}));})().catch(error=>{console.error(error);process.exitCode=1});
  `)
  assert.deepEqual(result.calls, [{ path: "/api/enrollment/session", input: {} }, { path: "/api/enrollment/start", input: {} }])
  assert.deepEqual(result.navigations, ["https://checkout.stripe.test/synthetic"])
})

test("generic signup routes to pricing under the dedicated rollout without provider readiness", () => {
  const result = runClient(`${renderSetup}
    mock.module('next/navigation',{exports:{redirect:destination=>{throw {destination}}}});
    const Page=require('./src/app/(auth)/sign-up/page.tsx').default;
    let destination;try{Page()}catch(error){destination=error.destination}console.log(JSON.stringify({destination}));
  `, { MCA_STRIPE_FIRST_ONBOARDING_ENABLED: "true", MCA_SIGNUP_MODE: "open" })
  assert.equal(result.destination, "/pricing")
})

test("unavailable purchase offers explicit account switch and canonical password recovery", () => {
  const html = runClient(`${renderSetup}const assert=require('node:assert/strict');${load}console.log(JSON.stringify(renderToStaticMarkup(React.createElement(EnrollmentCompletion,{continuation:${JSON.stringify(locator)},initialStatus:{state:'unavailable',nextAction:'authenticate'}}))));`) as string
  assert.match(html, /Sign out and use another account/)
  assert.match(html, /href="\/forgot-password\?next=/)
})
