"use client"
import { useState } from "react"
import { AuthShell } from "@/components/mca/auth-shell"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { requestJson } from "@/lib/mca/client"
import { authErrorMessage, currentAuthContinuation } from "@/lib/mca/auth-navigation"
export default function ResetPasswordPage() {
  const [password,setPassword]=useState(""),[confirm,setConfirm]=useState(""),[busy,setBusy]=useState(false),[error,setError]=useState("")
  return <AuthShell title="Choose a new password" description="Open the recovery link from your email, then set a new password. Other sessions will be signed out.">
    <form className="space-y-5" onSubmit={async e=>{e.preventDefault();setBusy(true);setError("");try{if(password!==confirm)throw new Error("Passwords do not match.");await requestJson("/api/auth/recovery/reset",{method:"POST",body:JSON.stringify({password})});window.location.href=currentAuthContinuation()}catch(e){setError(authErrorMessage(e))}finally{setBusy(false)}}}>
      <Label className="grid gap-2">New password<Input type="password" autoComplete="new-password" minLength={12} value={password} onChange={e=>setPassword(e.target.value)} required/></Label>
      <Label className="grid gap-2">Confirm password<Input type="password" autoComplete="new-password" value={confirm} onChange={e=>setConfirm(e.target.value)} required/></Label>
      {error && <p role="alert" className="text-destructive">{error}</p>}<Button className="w-full" disabled={busy}>Reset password</Button>
    </form><Button variant="ghost" className="mt-4 w-full" onClick={()=>window.location.href=`/forgot-password?next=${encodeURIComponent(currentAuthContinuation())}`}>Request a new recovery link</Button>
  </AuthShell>
}
