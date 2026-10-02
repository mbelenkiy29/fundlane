"use client"
import { useState } from "react"
import { requestJson } from "@/lib/mca/client"
import { authErrorMessage } from "@/lib/mca/auth-navigation"
import { BILLING_PLANS } from "@/lib/mca/billing-catalog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
export function ActivateAccount({email,companyName}:{email:string;companyName:string}) {
  const [name,setName]=useState(companyName),[busy,setBusy]=useState(false),[error,setError]=useState(""),[paid,setPaid]=useState(false)
  async function activate() {
    setBusy(true);setError("")
    try {const result=await requestJson<{status:string}>("/api/billing/signup-activate",{method:"POST",body:JSON.stringify({companyName:name,terms:true,activate:true})});if(result.status==="paid_required")setPaid(true);else window.location.assign("/onboarding?setup=1")}
    catch(error){setError(authErrorMessage(error))}finally{setBusy(false)}
  }
  async function confirmPaid() {
    setBusy(true);setError("")
    try{const result=await requestJson<{url:string}>("/api/billing/checkout",{method:"POST",body:JSON.stringify({selectedSeats:1,onboarding:true})});window.location.assign(result.url)}catch(error){setError(authErrorMessage(error));setBusy(false)}
  }
  return <><p>Verified email: {email}</p><p>Your eligible 14-day trial starts when you activate. Afterward, ${BILLING_PLANS[0].monthlyUsd}/month includes one user, plus applicable tax. Cancel before the trial ends to avoid a subscription charge. Additional seats are available in Plans &amp; Billing.</p>
    {error && <p role="alert" className="text-destructive">{error} <a href="/account-security?next=%2Factivate" className="underline">Account security</a></p>}
    {paid?<><p>This account is not eligible for another free trial. No subscription has been started. Review and explicitly confirm the ${BILLING_PLANS[0].monthlyUsd}/month paid subscription in Stripe.</p><Button disabled={busy} onClick={()=>void confirmPaid()}>{busy?"Opening Stripe…":"Review paid subscription in Stripe"}</Button></>:<form className="space-y-5" onSubmit={e=>{e.preventDefault();void activate()}}>
      <Label className="grid gap-2">Company name<Input value={name} onChange={e=>setName(e.target.value)} minLength={2} maxLength={200} required/></Label>
      <Label className="flex items-start gap-2"><input type="checkbox" required/><span>I agree to the <a href="/terms" className="underline">Terms of Service</a> and <a href="/privacy" className="underline">Privacy Policy</a>, and authorize the subscription terms shown above.</span></Label>
      <Button disabled={busy} className="w-full">{busy?"Activating…":"Activate account & start free trial"}</Button>
    </form>}
  </>
}
