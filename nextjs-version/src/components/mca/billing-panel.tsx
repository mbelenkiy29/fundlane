"use client"
import { useCallback, useEffect, useRef, useState } from "react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { SeatSelector } from "./seat-selector"
import { requestJson } from "@/lib/mca/client"
import { formatBillingMoney, quotedSeatIncrease, validSelectedSeats, type BillingRecovery } from "@/lib/mca/billing-display"
import { monthlyPriceCents } from "@/lib/mca/billing-catalog"
import type { CompanyAccess } from "@/lib/mca/company-access"

type BillingResponse = { enabled: boolean; seatSyncEnabled:boolean; seatsCountPendingInvites:boolean; testMode: boolean; occupiedSeats: number; activeSeats:number;pendingInvitationSeats:number; canManagePayment: boolean; cardRequiredTrial?: boolean; access: CompanyAccess; recovery: BillingRecovery; actionRequiredInvoice: null | {id:string;url:string|null}; paymentFailedInvoice: null | {id:string}; state: null | {selected_seats:number;pending_seats:number|null;pending_seats_at:string|null}; billing: null | { subscriptionId: string | null; status: string; seatLimit: number; paymentPastDue: number; periodEnd:string|null } }
const date = (value:string) => new Date(value).toLocaleString()
export function BillingCancellation({ enabled, busy, onCancel }: { enabled:boolean;busy:boolean;onCancel:()=>void }) {
  return <div className="space-y-2"><Button variant="outline" disabled={!enabled||busy} onClick={onCancel}>Cancel at period end</Button><p className="text-sm text-muted-foreground">Cancellation remains available while company access is paused, including when a seat reduction is scheduled. Cancellation replaces the pending reduction. Monthly fees continue until the effective cancellation date. Outstanding invoices and administrative suspensions remain in effect.</p></div>
}
export function BillingRecoveryDetails({ recovery }: { recovery: BillingRecovery }) {
  if (!recovery.paymentRequired && !recovery.verificationPending && !recovery.invoices.length) return null
  return <Card><CardHeader><CardTitle>Outstanding invoices</CardTitle></CardHeader><CardContent className="space-y-4">
    <p>Outstanding balance: {formatBillingMoney(recovery.overdueAmount)} USD{recovery.verificationPending ? " (verification pending; this balance may be incomplete)" : ""}.</p>
    <p>Monthly fees continue during suspension until the subscription’s effective cancellation date. All applicable overdue invoices, including missed months, must be verified paid before otherwise-eligible access can resume. Separate administrative suspensions remain in effect; payment does not restart a canceled subscription.</p>
    {recovery.verificationPending && <p role="status">Verification pending. Invoice details or payment confirmation are not yet fully verified. If you have paid, use Refresh billing to check again; returning from payment does not restore access.</p>}
    <ul className="space-y-4">{recovery.invoices.map(invoice => <li key={invoice.id} className="rounded-lg border p-4 space-y-2">
      <p className="font-medium break-all">Invoice {invoice.id}</p>
      <p>Period: {invoice.periodStart ? date(invoice.periodStart) : "Verification pending"} – {invoice.periodEnd ? date(invoice.periodEnd) : "Verification pending"}</p>
      <p>Remaining: {formatBillingMoney(invoice.amountRemaining)} USD · Status: {invoice.status.replaceAll("_", " ")}</p>
      {invoice.hostedInvoiceUrl ? <Button asChild variant="outline"><a href={invoice.hostedInvoiceUrl} aria-label={`Review and pay invoice ${invoice.id}`}>Review and pay invoice</a></Button> : <p role="status">Payment link unavailable — verification pending. Refresh billing or open payment settings for help.</p>}
    </li>)}</ul>
    <p className="text-sm text-muted-foreground">Already paid? Payment verification is pending until billing is refreshed and all required payments are confirmed. Use Refresh billing to check; returning from payment does not restore access. Stripe confirms payment for each invoice. Payment settings and cancellation remain available while company access is paused.</p>
  </CardContent></Card>
}
export function BillingProrationPolicy({ enabled }: { enabled:boolean }) {
  return enabled?<p className="text-sm text-muted-foreground">Paid seat increases are prorated for the rest of the current period and invoiced immediately; the seat becomes available only after payment. Seat decreases take effect at the next renewal with no mid-cycle credit. Trial seat changes have no charge.</p>:null
}
export function BillingPanel({ onboarding = false, onContinue }: { onboarding?: boolean; onContinue?: () => void }) {
  const [state,setState]=useState<BillingResponse|null>(null),[seats,setSeats]=useState(1),[busy,setBusy]=useState(false),[error,setError]=useState(""),[notice,setNotice]=useState("")
  const [preview,setPreview]=useState<{selectedSeats:number;prorationAmount:number|null;currency:string}|null>(null)
  const autoPortalOpened=useRef(false)
  const hasSubscription=Boolean(state?.billing?.subscriptionId&&!['canceled','incomplete_expired'].includes(state.billing.status))
  const paidIncrease=Boolean(state?.seatSyncEnabled&&hasSubscription&&state.billing?.status==="active"&&seats>(state.billing?.seatLimit??0))
  const increaseQuoted=quotedSeatIncrease(preview,seats)
  const minimumSeats=state?.seatSyncEnabled&&!state.seatsCountPendingInvites?Math.max(1,state.activeSeats):Math.max(1,state?.occupiedSeats??0)
  const load=useCallback(async()=>{ const result=await requestJson<BillingResponse>("/api/billing");setState(result);setPreview(null);setSeats(result.state?.selected_seats??result.billing?.seatLimit??1) },[])
  useEffect(()=>{void load().catch(e=>setError(e instanceof Error?e.message:"Billing could not be loaded."))},[load])
  const action=useCallback(async(kind:"checkout"|"portal"|"seats"|"sync"|"cancel", selectedSeats = seats)=>{
    setBusy(true);setError("");setNotice("")
    try {const result=await requestJson<{url?:string;cancelAt?:string|null;alreadyCanceled?:boolean}>(`/api/billing/${kind}`,{method:"POST",body:JSON.stringify(kind==="checkout"?{selectedSeats,onboarding}:kind==="seats"?{selectedSeats}:kind==="portal"?{onboarding}:{})});if(result.url){window.location.assign(result.url);return}await load();setNotice(kind==="cancel"?(result.alreadyCanceled?"Subscription is already canceled. Outstanding invoices remain due.":`Cancellation confirmed for ${result.cancelAt?date(result.cancelAt):"the current period end"}. Outstanding invoices remain due.`):kind==="seats"?"Seat change submitted. Increases activate after payment; reductions take effect at renewal.":"Billing refreshed.")}
    catch(e){setError(e instanceof Error?e.message:"Billing action failed.")}finally{setBusy(false)}
  },[load,onboarding,seats])
  const previewIncrease=useCallback(async()=>{
    setBusy(true);setError("");setPreview(null)
    try { setPreview(await requestJson<{selectedSeats:number;prorationAmount:number|null;currency:string}>("/api/billing/seats/preview",{method:"POST",body:JSON.stringify({selectedSeats:seats})})) }
    catch(e){setError(e instanceof Error?e.message:"Seat preview is unavailable.")}finally{setBusy(false)}
  },[seats])
  useEffect(()=>{if(!autoPortalOpened.current&&state?.canManagePayment&&new URLSearchParams(window.location.search).get("billingAction")==="portal") {autoPortalOpened.current=true;void action("portal")}},[action,state?.canManagePayment])
  return <div className="space-y-6"><header><h1 className="text-3xl font-bold">{onboarding?(state?.cardRequiredTrial?"Finish company setup":"Your company trial is ready"):"Plans & Billing"}</h1><p className="mt-2 text-muted-foreground">One monthly plan for your company. {state?.seatSyncEnabled&&!state.seatsCountPendingInvites?"Active members use licensed seats; pending invitations are licensed when accepted.":"Active members and pending invitations reserve seats."}</p></header>
    {error&&<p role="alert" className="text-destructive">{error}</p>}{notice&&<p role="status">{notice}</p>}
    {!state?<Button variant="outline" onClick={()=>void load().catch(e=>setError(e.message))}>Load billing</Button>:<>
      {state.enabled&&state.testMode&&<p className="rounded-lg bg-muted p-3 text-sm">Test mode — no real payments are collected.</p>}
      {state.actionRequiredInvoice&&<p role="alert" className="rounded-lg border border-amber-500 p-3 text-sm">Invoice {state.actionRequiredInvoice.id} needs payment authentication. {state.actionRequiredInvoice.url?<a className="underline" href={state.actionRequiredInvoice.url}>Complete payment on Stripe</a>:"Open Payment settings & invoices below to review it."} Seats and access update after payment is verified.</p>}
      {state.paymentFailedInvoice&&!state.actionRequiredInvoice&&<p role="alert" className="rounded-lg border border-amber-500 p-3 text-sm">Invoice {state.paymentFailedInvoice.id} could not be paid. <a className="underline" href="/settings/billing?billingAction=portal">Update your card in Payment settings &amp; invoices</a>. Seats and access update after payment is verified.</p>}
      <Card><CardHeader><CardTitle>Company access: {state.access.status.replaceAll("_"," ")}</CardTitle></CardHeader><CardContent className="space-y-2">
        {!state.access.allowed&&<p role="alert" className="text-destructive">Access is paused: {state.access.reason?.replaceAll("_"," ")}. {state.access.manualPaused?"Contact support to resolve this suspension.":"Review outstanding invoices and subscription status below to resolve billing. Payment must be verified before eligible access resumes."}</p>}
        {state.access.trialEndsAt&&<p>Trial ends {date(state.access.trialEndsAt)}.{state.access.status==="trialing"?" Stripe automatically charges for your licensed seats when the trial ends unless you cancel before then in Plans & Billing or the Stripe billing portal.":state.cardRequiredTrial?"":" No card required; up to 5 trial users."}</p>}
        {state.access.graceEndsAt&&<p>Payment grace ends {date(state.access.graceEndsAt)}. Settle outstanding invoices to keep access.</p>}
        <p>{state.seatSyncEnabled&&!state.seatsCountPendingInvites?`${state.activeSeats} active licensed members · ${state.pendingInvitationSeats} pending invitations (licensed on acceptance) · Current licensed seat limit: ${state.access.seatLimit}`:`${state.activeSeats} active members + ${state.pendingInvitationSeats} pending invitations = ${state.occupiedSeats} seats reserved · Current invitation limit: ${state.access.seatLimit}`}</p>
        <p>Selected paid seats: {state.state?.selected_seats??1} · Purchased seats: {state.billing?.subscriptionId?state.billing.seatLimit:0}</p>
        {state.billing?.subscriptionId&&<p>Current monthly price: {formatBillingMoney(monthlyPriceCents(state.billing.seatLimit))} USD · Subscription: {state.billing.status}</p>}
        {state.state?.pending_seats&&<p>Scheduled seats: {state.state.pending_seats} ({formatBillingMoney(monthlyPriceCents(state.state.pending_seats))}/month), effective {state.state.pending_seats_at?date(state.state.pending_seats_at):"at renewal"}. {state.seatSyncEnabled&&!state.seatsCountPendingInvites?"Pending invitations use a licensed seat when accepted.":"This lower limit applies to new invitations now."}</p>}
        {state.seatSyncEnabled&&state.state?.pending_seats&&state.billing?.status==="active"&&<Button variant="outline" disabled={busy||!state.enabled} onClick={()=>void action("seats",state.billing!.seatLimit)}>Cancel scheduled seat reduction</Button>}
        {state.billing?.periodEnd&&<p>Current period ends {date(state.billing.periodEnd)}.</p>}
      </CardContent></Card>
      <BillingRecoveryDetails recovery={state.recovery}/>
      <Card><CardHeader><CardTitle>Monthly subscription</CardTitle></CardHeader><CardContent className="space-y-4"><SeatSelector value={seats} onChange={value=>{setSeats(value);setPreview(null)}} minimum={minimumSeats}/>
        <p className="text-sm text-muted-foreground">{state.cardRequiredTrial?"Checkout collects a card and starts the trial shown there for new companies. After the trial, Stripe charges for the selected seats unless you cancel before it ends in Plans & Billing or the Stripe billing portal. Trial seat changes take effect immediately; paid increases activate after payment and reductions apply at renewal.":state.seatSyncEnabled&&!state.seatsCountPendingInvites?"Checkout activates paid access immediately and ends the no-card trial. Seat increases are prorated and activate after payment. Reductions apply at renewal and cannot go below active members.":"Checkout activates paid access immediately and ends the no-card trial. Seat increases are prorated and activate after payment. Reductions apply at renewal and cannot go below active members plus pending invitations."}</p>
        <BillingProrationPolicy enabled={state.seatSyncEnabled}/>
        {preview?.selectedSeats===seats&&<p role="status">{increaseQuoted?`Estimated proration for this seat increase: ${formatBillingMoney(preview.prorationAmount!)} ${preview.currency.toUpperCase()}. This excludes unrelated invoice charges; taxes and account changes may affect the final amount. Confirm to submit the increase.`:"Seat proration could not be verified. Retry the preview before confirming."}</p>}
        <div className="flex flex-wrap gap-3"><Button disabled={!state.enabled||busy||!validSelectedSeats(seats)||seats<minimumSeats||state.billing?.status==="incomplete"} onClick={()=>void (paidIncrease&&!increaseQuoted?previewIncrease():action(hasSubscription?"seats":"checkout"))}>{paidIncrease?increaseQuoted?"Confirm seat increase":"Preview seat increase":hasSubscription?"Update paid seats":"Subscribe now"}</Button>{state.canManagePayment&&<Button variant="outline" disabled={busy||!state.enabled} onClick={()=>void action("portal")}>Payment settings & invoices</Button>}<Button variant="outline" disabled={busy} onClick={()=>void action("sync")}>Refresh billing</Button></div>
        {state.billing?.status==="incomplete"&&<p className="text-sm text-muted-foreground">Your initial payment is incomplete. Resolve it in payment settings before changing seats.</p>}
        {state.canManagePayment&&<BillingCancellation enabled={state.enabled} busy={busy} onCancel={()=>void action("cancel")}/>}
        {!state.enabled&&<p className="text-sm text-muted-foreground">Online checkout is not enabled yet. Contact support for subscription help.</p>}
        <p className="text-sm text-muted-foreground">Use Cancel at period end to stop renewal, or Payment settings &amp; invoices to manage payment. Monthly fees continue during suspension until the effective cancellation date, normally the current period end. Cancellation does not restart a trial or forgive outstanding invoices. All applicable overdue invoices, including missed months, must be verified paid before otherwise-eligible access resumes.</p>
      </CardContent></Card>
    </>}{onContinue&&(!state||!state.cardRequiredTrial||state.access.allowed)&&<Button onClick={onContinue}>Continue to employee invitations</Button>}
  </div>
}
