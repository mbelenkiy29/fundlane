"use client"
import { useCallback, useEffect, useRef, useState } from "react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { requestJson } from "@/lib/mca/client"
import { BILLING_PLANS, type PaidBillingPlanSlug } from "@/lib/mca/billing-catalog"

type BillingResponse = { enabled: boolean; testMode: boolean; occupiedSeats: number; canManagePayment: boolean; billing: null | { subscriptionId: string | null; planSlug: string; planName: string; status: string; seatLimit: number; paymentPastDue: number; syncedAt: string } }
export function BillingPanel({ onboarding = false, onContinue }: { onboarding?: boolean; onContinue?: () => void }) {
  const [state, setState] = useState<BillingResponse | null>(null)
  const [error, setError] = useState("")
  const [busy, setBusy] = useState(false)
  const inFlight = useRef(false)
  const mounted = useRef(false)
  const sync = useCallback(async () => {
    if (inFlight.current) return
    inFlight.current = true
    if (mounted.current) setError("")
    try {
      const current = await requestJson<BillingResponse>("/api/billing/sync", { method: "POST" })
      if (mounted.current) setState(current)
    } catch (e) { if (mounted.current) setError(e instanceof Error ? e.message : "Billing could not be loaded.") }
    finally { inFlight.current = false }
  }, [])
  useEffect(() => { mounted.current = true; void sync(); return () => { mounted.current = false } }, [sync])
  useEffect(() => { const onFocus = () => void sync(); window.addEventListener("focus", onFocus); return () => window.removeEventListener("focus", onFocus) }, [sync])
  async function openPayment(planSlug?: PaidBillingPlanSlug) {
    setBusy(true); setError("")
    try {
      const portal = !planSlug || Boolean(state?.billing?.subscriptionId) || state?.billing?.status === "incomplete"
      const result = await requestJson<{ url: string }>(portal ? "/api/billing/portal" : "/api/billing/checkout", { method: "POST", body: JSON.stringify({ ...(portal ? {} : { planSlug }), onboarding }) })
      window.location.assign(result.url)
    } catch (e) { setError(e instanceof Error ? e.message : "Payment settings could not be opened."); setBusy(false) }
  }
  return <div className="space-y-6">
    <header><h1 className="text-3xl font-bold">{onboarding ? "Choose your company plan" : "Plans & Billing"}</h1><p className="mt-2 text-muted-foreground">Plans cover your whole company, including the owner. You can start on Free and upgrade when you need more seats.</p></header>
    {state?.testMode && state.enabled && <p className="rounded-lg bg-muted p-3 text-sm">Billing is in test mode. No real payments are collected.</p>}
    {error && <div role="alert" className="rounded-lg border border-destructive/30 p-4 text-sm"><p>{error}</p><Button className="mt-3" variant="outline" onClick={() => void sync()}>Retry billing sync</Button></div>}
    {state?.billing && <Card><CardHeader><CardTitle>{state.billing.planName}</CardTitle></CardHeader><CardContent><p>{state.occupiedSeats} of {state.billing.seatLimit} seats reserved</p>{Boolean(state.billing.paymentPastDue) && <p className="text-destructive">Payment needs attention. Update your payment method before inviting employees.</p>}{state.occupiedSeats > state.billing.seatLimit && <p className="text-muted-foreground">Your existing team keeps access. Upgrade or free seats before inviting more people.</p>}</CardContent></Card>}
    {!state && !error && <p role="status">Loading company billing…</p>}
    {state && !state.enabled && <p className="text-muted-foreground">Company billing is not enabled yet.</p>}
    {state?.enabled && <>
      <div className="grid gap-4 md:grid-cols-3">{BILLING_PLANS.map(plan => <Card key={plan.slug}><CardHeader><CardTitle>{plan.name}</CardTitle></CardHeader><CardContent className="space-y-4"><p><span className="text-3xl font-semibold">${plan.monthlyUsd}</span> / month</p><p>{plan.seats} {plan.seats === 1 ? "seat" : "seats"}</p>{plan.slug === "free_org" ? <p className="text-sm text-muted-foreground">{state.billing?.subscriptionId ? "Cancel your paid plan in Payment settings to return to Free." : "Included with your company."}</p> : <Button disabled={busy || state.billing?.planSlug === plan.slug} onClick={() => void openPayment(plan.slug)}>{state.billing?.planSlug === plan.slug ? "Current plan" : state.billing?.subscriptionId ? "Change plan" : `Choose ${plan.name}`}</Button>}</CardContent></Card>)}</div>
      {state.canManagePayment && <Button variant="outline" disabled={busy} onClick={() => void openPayment()}>Payment settings</Button>}
    </>}
    {onContinue && <Button onClick={onContinue}>Continue to employee invitations</Button>}
  </div>
}
