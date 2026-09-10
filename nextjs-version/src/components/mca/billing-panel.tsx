"use client"
import { useCallback, useEffect, useRef, useState } from "react"
import { PricingTable, useOrganization, useSession } from "@clerk/nextjs"
import { useSubscription } from "@clerk/nextjs/experimental"
import { OrganizationProfileProvider, OrganizationProfileBillingPanel } from "@clerk/ui/experimental"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { requestJson } from "@/lib/mca/client"

type BillingResponse = { enabled: boolean; occupiedSeats: number; billing: null | { planName: string; status: string; seatLimit: number; paymentPastDue: number; syncedAt: string } }
export function BillingPanel({ onboarding = false, onContinue }: { onboarding?: boolean; onContinue?: () => void }) {
  const { organization } = useOrganization()
  const { session } = useSession()
  const sessionRef = useRef(session)
  sessionRef.current = session
  const orgRef = useRef(organization?.id)
  orgRef.current = organization?.id
  const [state, setState] = useState<BillingResponse | null>(null)
  const [error, setError] = useState("")
  const [ready, setReady] = useState(false)
  const inFlight = useRef<string | null>(null)
  const sync = useCallback(async () => {
    const requestedOrg = orgRef.current
    if (!requestedOrg || inFlight.current === requestedOrg) return
    inFlight.current = requestedOrg
    setError("")
    try {
      const current = await requestJson<BillingResponse>("/api/billing/sync", { method: "POST" })
      if (orgRef.current !== requestedOrg) return
      setState(current)
      await sessionRef.current?.reload()
      if (orgRef.current === requestedOrg) setReady(true)
    } catch (e) { if (orgRef.current === requestedOrg) setError(e instanceof Error ? e.message : "Billing could not be loaded.") }
    finally { if (inFlight.current === requestedOrg) inFlight.current = null }
  }, [])
  useEffect(() => { setReady(false); setState(null); void sync() }, [organization?.id, sync])
  useEffect(() => { const onFocus = () => void sync(); window.addEventListener("focus", onFocus); return () => window.removeEventListener("focus", onFocus) }, [sync])
  return <div className="space-y-6">
    <header><h1 className="text-3xl font-bold">{onboarding ? "Choose your company plan" : "Plans & Billing"}</h1><p className="mt-2 text-muted-foreground">Plans cover your whole company, including the owner. You can start on Free and upgrade when you need more seats.</p></header>
    {error && <div role="alert" className="rounded-lg border border-destructive/30 p-4 text-sm"><p>{error}</p><Button className="mt-3" variant="outline" onClick={() => void sync()}>Retry billing sync</Button></div>}
    {state?.billing && <Card><CardHeader><CardTitle>{state.billing.planName}</CardTitle></CardHeader><CardContent><p>{state.occupiedSeats} of {state.billing.seatLimit} seats reserved</p>{Boolean(state.billing.paymentPastDue) && <p className="text-destructive">Payment needs attention. Update your payment method before inviting employees.</p>}{state.occupiedSeats > state.billing.seatLimit && <p className="text-muted-foreground">Your existing team keeps access. Upgrade or free seats before inviting more people.</p>}</CardContent></Card>}
    {!ready && !error && <p role="status">Loading company billing…</p>}
    {ready && <BillingControls onChange={sync} onboarding={onboarding} />}
    {onContinue && <Button onClick={onContinue}>Continue to employee invitations</Button>}
  </div>
}
function BillingControls({ onChange, onboarding }: { onChange: () => Promise<void>; onboarding: boolean }) {
  const { data } = useSubscription({ for: "organization" })
  const version = data?.updatedAt?.getTime()
  useEffect(() => { if (version) void onChange() }, [version, onChange])
  return <>
    <PricingTable for="organization" newSubscriptionRedirectUrl={onboarding ? "/onboarding?setup=1" : "/settings/billing"} />
    {!onboarding && <OrganizationProfileProvider><OrganizationProfileBillingPanel /></OrganizationProfileProvider>}
  </>
}
