"use client"
import { useEffect, useRef, useState } from "react"
import { requestJson } from "@/lib/mca/client"
import { authErrorMessage } from "@/lib/mca/auth-navigation"
import { BILLING_PLANS } from "@/lib/mca/billing-catalog"
import { Button } from "@/components/ui/button"
async function redirectToStripe(restart=false) {
  const result=await requestJson<{url:string}>("/api/billing/signup-checkout",{method:"POST",body:JSON.stringify({restart})})
  window.location.assign(result.url)
}
export function GetStarted({canceled}:{canceled:boolean}) {
  const started=useRef(false),[busy,setBusy]=useState(!canceled),[error,setError]=useState("")
  async function open(restart=false) {
    setBusy(true);setError("")
    try {await redirectToStripe(restart)}
    catch(error){setError(authErrorMessage(error));setBusy(false)}
  }
  useEffect(()=>{if (!canceled && !started.current){started.current=true;void redirectToStripe().catch(error=>{setError(authErrorMessage(error));setBusy(false)})}},[canceled])
  return <main className="mx-auto flex min-h-svh max-w-lg flex-col justify-center gap-5 p-6">
    <a href="/" className="font-semibold underline">Fundlane</a><h1 className="text-3xl font-semibold">Get started with Fundlane</h1>
    <p>{canceled?"Card setup was canceled. Your trial has not started and no subscription charge was made.":"Save your card securely with Stripe, then create and verify your Fundlane account. Your eligible 14-day trial starts only when you activate your account."}</p>
    <p className="text-muted-foreground">${BILLING_PLANS[0].monthlyUsd}/month after the trial, including one user, plus applicable tax. Cancel before the trial ends to avoid a subscription charge.</p>
    {error && <p role="alert" className="text-destructive">{error}</p>}
    <Button disabled={busy} onClick={()=>void open()}>{busy?"Opening Stripe…":"Continue to Stripe"}</Button>
    {error && <Button variant="outline" onClick={()=>void open(true)} disabled={busy}>Start a new signup</Button>}
    <a href="/sign-in" className="underline">Already have an account? Log in</a>
    <p className="text-sm"><a href="/terms" className="underline">Terms of Service</a> · <a href="/privacy" className="underline">Privacy Policy</a></p>
  </main>
}
