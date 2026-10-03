import test from "node:test"
import assert from "node:assert/strict"
import {billingTimeZone,formatBillingDate,formatBillingMoney,quotedSeatIncrease,validSelectedSeats} from "../src/lib/mca/billing-display"
import {BILLING_CATALOG,monthlyPriceCents} from "../src/lib/mca/billing-catalog"
import { spawnSync } from "node:child_process"
import type { BillingRecovery } from "../src/lib/mca/billing-display"
import { renderBillingEmailContent } from "../src/lib/mca/email"
test("seat selection supports quantities above trial cap and quotes exact graduated boundaries",()=>{
  for(const [seats,cents] of [[1,39900],[5,71500],[10,111000],[11,117900],[20,180000],[21,185900]]){
    assert.equal(validSelectedSeats(seats),true);assert.equal(monthlyPriceCents(seats),cents)
  }
  for(const value of [0,-1,1.5,NaN,Infinity,100001])assert.equal(validSelectedSeats(value),false)
  assert.equal(validSelectedSeats(100000),true)
})
test("money retains cents and distinguishes currencies",()=>{
  assert.equal(formatBillingMoney(BILLING_CATALOG.base.unitAmountCents),"$399.00")
  assert.equal(formatBillingMoney("12345","eur"),"€123.45")
  assert.equal(formatBillingMoney(0),"$0.00")
  assert.equal(formatBillingMoney("900719925474099301"),"$9,007,199,254,740,993.01")
  assert.equal(formatBillingMoney("-12345"),"-$123.45")
  assert.throws(()=>formatBillingMoney(Number.MAX_SAFE_INTEGER+1),/safe integer/)
})
test("paid increase confirmation requires a matching verified amount, including zero",()=>{
  assert.equal(quotedSeatIncrease(null,6),false)
  assert.equal(quotedSeatIncrease({selectedSeats:6,prorationAmount:null},6),false)
  assert.equal(quotedSeatIncrease({selectedSeats:5,prorationAmount:1234},6),false)
  assert.equal(quotedSeatIncrease({selectedSeats:6,prorationAmount:NaN},6),false)
  assert.equal(quotedSeatIncrease({selectedSeats:6,prorationAmount:0},6),true)
  assert.equal(quotedSeatIncrease({selectedSeats:6,prorationAmount:1234},6),true)
})
test("application cancellation control is available without an access gate and explains scheduled reductions and debt",()=>{
  const result=spawnSync(process.execPath,["--import","tsx","-e",`
    const React=require('react');const {renderToStaticMarkup}=require('react-dom/server');
    const {BillingCancellation}=require('./src/components/mca/billing-panel.tsx');
    console.log(renderToStaticMarkup(React.createElement(BillingCancellation,{enabled:true,busy:false,onCancel:()=>{}})));
  `],{encoding:"utf8"})
  assert.equal(result.status,0,result.stderr)
  assert.match(result.stdout,/Cancel at period end/);assert.doesNotMatch(result.stdout,/ disabled="/)
  assert.match(result.stdout,/including when a seat reduction is scheduled/)
  assert.match(result.stdout,/Outstanding invoices and administrative suspensions remain in effect/)
})
test("purchased-seat policy copy appears only with a billing preview capability",()=>{
  const result=spawnSync(process.execPath,["--import","tsx","-e",`
    const React=require('react');const {renderToStaticMarkup}=require('react-dom/server');
    const {BillingProrationPolicy}=require('./src/components/mca/billing-panel.tsx');
    console.log(JSON.stringify([false,true].map(enabled=>renderToStaticMarkup(React.createElement(BillingProrationPolicy,{enabled})))));
  `],{encoding:"utf8"})
  assert.equal(result.status,0,result.stderr)
  const [disabled,enabled]=JSON.parse(result.stdout.trim()) as string[]
  assert.equal(disabled,"")
  assert.match(enabled,/You choose how many seats to buy/)
  assert.match(enabled,/no mid-cycle credit/)
})

// Render client components in a separate runtime without the suite's react-server condition.
function renderRecovery(recovery: BillingRecovery) {
  const result = spawnSync(process.execPath, ["--import", "tsx", "-e", `
    const React = require('react');
    const { renderToStaticMarkup } = require('react-dom/server');
    const { BillingRecoveryDetails } = require('./src/components/mca/billing-panel.tsx');
    console.log(renderToStaticMarkup(React.createElement(BillingRecoveryDetails, { recovery: ${JSON.stringify(recovery)} })));
  `], { encoding: "utf8" })
  assert.equal(result.status, 0, result.stderr)
  return result.stdout.trim()
}
test("recovery renders each invoice with exact cents, distinct payment links and full-payment policy", () => {
  const html = renderRecovery({ overdueAmount: 52245, paymentRequired: true, verificationPending: false, invoices: [
    { id: "in_one", status: "open", amountRemaining: 39900, periodStart: "2026-07-01T00:00:00Z", periodEnd: "2026-08-01T00:00:00Z", hostedInvoiceUrl: "https://invoice.stripe.com/i/one" },
    { id: "in_two", status: "uncollectible", amountRemaining: 12345, periodStart: "2026-08-01T00:00:00Z", periodEnd: "2026-09-01T00:00:00Z", hostedInvoiceUrl: "https://invoice.stripe.com/i/two" },
  ] })
  for (const amount of ["$522.45", "$399.00", "$123.45"]) assert.ok(html.includes(amount))
  assert.match(html, /href="https:\/\/invoice.stripe.com\/i\/one"/)
  assert.match(html, /aria-label="Review and pay invoice in_two"/)
  assert.match(html, /Status: uncollectible/)
  assert.match(html, /Monthly fees continue during suspension until/)
  assert.match(html, /including missed months, must be verified paid/)
  assert.match(html, /payment does not restart a canceled subscription/)
})
test("unavailable links and incomplete verification do not present recovery as settled", () => {
  const html = renderRecovery({ overdueAmount: 12345, paymentRequired: true, verificationPending: true, invoices: [
    { id: "in_pending", status: "draft", amountRemaining: 12345, periodStart: "", periodEnd: "", hostedInvoiceUrl: null },
  ] })
  assert.match(html, /role="status"/)
  assert.match(html, /Payment link unavailable — verification pending/)
  assert.match(html, /this balance may be incomplete/)
  assert.match(html, /returning from payment does not restore access/)
  assert.doesNotMatch(html, /href=|Invalid Date/)
  assert.match(renderRecovery({ overdueAmount: 0, paymentRequired: false, verificationPending: true, invoices: [] }), /Verification pending/)
  assert.equal(renderRecovery({ overdueAmount: 0, paymentRequired: false, verificationPending: false, invoices: [] }), "")
})
test("renewal and suspension emails disclose continuing fees, cancellation and verified full recovery", () => {
  for (const kind of ["renewal_payment_failed", "billing_paused"]) {
    const content = renderBillingEmailContent({ data: { kind }, actionUrl: "https://app.example/settings/billing" })
    for (const body of [content.text, content.html]) {
      assert.match(body, /Monthly fees continue during suspension until the subscription’s effective cancellation date/)
      assert.match(body, /pay or cancel/)
      assert.match(body, /All applicable overdue invoices/)
      assert.match(body, /verified paid before otherwise-eligible access resumes/)
    }
  }
})
test("paused notice directs administrators to payment and cancellation without exposing that link to members", () => {
  const result = spawnSync(process.execPath, ["--import", "tsx", "-e", `
    const React = require('react');
    const { renderToStaticMarkup } = require('react-dom/server');
    const { CompanyPaused } = require('./src/components/mca/company-paused.tsx');
    console.log(JSON.stringify([true, false].map(canManage => renderToStaticMarkup(React.createElement(CompanyPaused, { canManage })))));
  `], { encoding: "utf8" })
  assert.equal(result.status, 0, result.stderr)
  const [admin, member] = JSON.parse(result.stdout)
  assert.match(admin, /href="\/settings\/billing"/)
  assert.match(admin, /pay or cancel subscription/)
  assert.match(admin, /monthly fees continue during suspension until the effective cancellation date/)
  assert.doesNotMatch(member, /href="\/settings\/billing"/)
  assert.match(member, /Ask your company administrator/)
})

const TRIAL_END="2026-10-15T03:30:00.000Z"
function inZone(tz:string, script:string){
  const result=spawnSync(process.execPath,["--import","tsx","-e",script],{encoding:"utf8",env:{...process.env,TZ:tz}})
  assert.equal(result.status,0,result.stderr)
  return JSON.parse(result.stdout.trim()) as string[]
}
test("trial end shows in the company's stored time zone, not UTC, with the zone named",()=>{
  assert.equal(formatBillingDate(TRIAL_END,"America/New_York"),"Oct 14, 2026, 11:30 PM EDT")
  assert.equal(formatBillingDate(TRIAL_END,"America/Los_Angeles"),"Oct 14, 2026, 8:30 PM PDT")
  assert.equal(formatBillingDate(TRIAL_END,"UTC"),"Oct 15, 2026, 3:30 AM UTC")
  assert.equal(formatBillingDate("not a date","America/New_York"),"not a date")
  assert.equal(billingTimeZone(" America/Chicago "),"America/Chicago")
  for(const zone of [null,undefined,""," ","Not/AZone"])assert.equal(billingTimeZone(zone),undefined)
})
test("without a stored company zone the trial end uses the viewer's own zone",()=>{
  // TZ stands in for the viewer's browser zone; the company zone wins whenever one is stored.
  const [none,invalid,company]=inZone("Asia/Tokyo",`
    const {formatBillingDate}=require('./src/lib/mca/billing-display.ts');
    console.log(JSON.stringify([formatBillingDate(${JSON.stringify(TRIAL_END)},null),formatBillingDate(${JSON.stringify(TRIAL_END)},"Not/AZone"),formatBillingDate(${JSON.stringify(TRIAL_END)},"America/New_York")]))
  `)
  assert.equal(none,"Oct 15, 2026, 12:30 PM GMT+9")
  assert.equal(invalid,none)
  assert.equal(company,"Oct 14, 2026, 11:30 PM EDT")
})
test("server-rendered trial end is stable regardless of the server's zone, so hydration matches",()=>{
  const script=`
    const React=require('react');const {renderToString}=require('react-dom/server');
    const {BillingDate}=require('./src/components/mca/billing-panel.tsx');
    console.log(JSON.stringify([${JSON.stringify("America/New_York")},null].map(timeZone=>renderToString(React.createElement(BillingDate,{value:${JSON.stringify(TRIAL_END)},timeZone})))));
  `
  const tokyo=inZone("Asia/Tokyo",script), chicago=inZone("America/Chicago",script)
  assert.deepEqual(tokyo,chicago)
  assert.equal(tokyo[0],`<time dateTime="${TRIAL_END}">Oct 14, 2026, 11:30 PM EDT</time>`)
  // No stored zone: the server cannot know the viewer's, so it renders UTC and the client re-renders after hydration.
  assert.equal(tokyo[1],`<time dateTime="${TRIAL_END}">Oct 15, 2026, 3:30 AM UTC</time>`)
})
test("Plans & Billing 'Trial ends' line renders the company zone with its name, not UTC or the plain locale string",()=>{
  const script=`
    const React=require('react');const {renderToString}=require('react-dom/server');
    const {BillingTrialEnds}=require('./src/components/mca/billing-panel.tsx');
    const props=${JSON.stringify([{trialEndsAt:TRIAL_END,timeZone:"America/Los_Angeles",status:"trialing"},{trialEndsAt:TRIAL_END,timeZone:"Not/AZone",status:"trial",cardRequiredTrial:false}])};
    console.log(JSON.stringify(props.map(p=>renderToString(React.createElement(BillingTrialEnds,p)))));
  `
  // Server zone New York: the old toLocaleString() would print "10/14/2026, 11:30:00 PM" with no zone name.
  const [company,fallback]=inZone("America/New_York",script)
  assert.match(company,new RegExp(`^<p>Trial ends <time dateTime="${TRIAL_END}">Oct 14, 2026, 8:30 PM PDT</time>\\.(<!-- -->)? Stripe automatically charges`))
  assert.doesNotMatch(company,/UTC|10\/14\/2026/)
  // A bad stored zone falls back to the viewer's zone; on the server that is an explicit, labeled UTC.
  assert.match(fallback,new RegExp(`^<p>Trial ends <time dateTime="${TRIAL_END}">Oct 15, 2026, 3:30 AM UTC</time>\\.(<!-- -->)? No card required; up to 5 trial users\\.</p>$`))
})
