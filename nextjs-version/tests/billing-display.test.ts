import test from "node:test"
import assert from "node:assert/strict"
import {formatBillingMoney,quotedSeatIncrease,validSelectedSeats} from "../src/lib/mca/billing-display"
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
