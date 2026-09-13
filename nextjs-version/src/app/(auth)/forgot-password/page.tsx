"use client"
import { useState } from "react"
import Link from "next/link"
import { AuthShell } from "@/components/mca/auth-shell"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { requestJson } from "@/lib/mca/client"
import { authErrorMessage } from "@/lib/mca/auth-navigation"
export default function ForgotPasswordPage() {
  const [email,setEmail]=useState(""),[busy,setBusy]=useState(false),[error,setError]=useState(""),[sent,setSent]=useState(false)
  return <AuthShell title="Recover your account" description="We'll email a time-limited link to set your password. Existing accounts keep their company data.">
    <form className="space-y-5" onSubmit={async e=>{e.preventDefault();setBusy(true);setError("");try{await requestJson("/api/auth/recovery/request",{method:"POST",body:JSON.stringify({email})});setSent(true)}catch(e){setError(authErrorMessage(e))}finally{setBusy(false)}}}>
      <Label className="grid gap-2">Work email<Input type="email" autoComplete="email" value={email} onChange={e=>setEmail(e.target.value)} required/></Label>
      {sent && <p role="status">If this address belongs to an account, a recovery link is on its way. Open it in this browser to continue.</p>}
      {error && <p role="alert" className="text-destructive">{error}</p>}
      <Button className="w-full" disabled={busy}>{busy?"Sending link…":"Send recovery link"}</Button>
      <Button asChild variant="ghost" className="w-full"><Link href="/sign-in">Back to sign in</Link></Button>
    </form>
  </AuthShell>
}
