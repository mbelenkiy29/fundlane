"use client"
import { Suspense,useEffect,useState } from "react"
import { useSearchParams } from "next/navigation"
import { AuthShell } from "@/components/mca/auth-shell"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { VerificationForm } from "@/components/mca/auth/verification-form"
import { requestJson } from "@/lib/mca/client"
import { authErrorMessage } from "@/lib/mca/auth-navigation"
import { GoogleButton } from "@/components/mca/auth/google-button"
export default function AcceptInvitePage(){return <Suspense><AcceptInvite/></Suspense>}
function AcceptInvite(){
  const token=useSearchParams().get("token")
  const [invite,setInvite]=useState<{email:string;workspace_name:string}|null>(null),[signedIn,setSignedIn]=useState(false),[signup,setSignup]=useState(false),[verify,setVerify]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState("")
  async function run(action:()=>Promise<void>){setBusy(true);setError("");try{await action()}catch(e){setError(authErrorMessage(e))}finally{setBusy(false)}}
  useEffect(()=>{if(!token)return;let cancelled=false;Promise.all([requestJson<{email:string;workspace_name:string}>(`/api/invitations/accept?token=${encodeURIComponent(token)}`),requestJson<{authenticated:boolean}>("/api/onboarding")]).then(([inv,account])=>{if(!cancelled){setInvite(inv);setSignedIn(account.authenticated)}}).catch(e=>{if(!cancelled)setError(authErrorMessage(e))});return()=>{cancelled=true}},[token])
  async function accept(){await requestJson("/api/invitations/accept",{method:"POST",body:JSON.stringify({token})});window.location.href="/dashboard"}
  return <AuthShell title="Join your company" description={invite?`Accept your invitation to ${invite.workspace_name} using ${invite.email}.`:"Accept your invitation to join your team's workspace."}>
    {error&&<p role="alert" className="mb-4 text-destructive">{error}</p>}
    {invite&&!signedIn&&<div className="mb-4"><GoogleButton disabled={busy}/></div>}
    {!token?<p>This invitation is missing or has expired. Ask your administrator to resend it.</p>:!invite?<p>Checking invitation…</p>:signedIn?<><Button disabled={busy} className="w-full" onClick={()=>run(accept)}>Accept invitation</Button><Button variant="ghost" className="mt-3" onClick={()=>run(async()=>{await requestJson("/api/auth/sign-out",{method:"POST"});setSignedIn(false)})}>Use another account</Button></>:verify?<><p className="mb-4">Verify your email using the email link, then return to this invitation. If your email includes a code, enter it here.</p><VerificationForm busy={busy} onVerify={code=>run(async()=>{await requestJson("/api/auth/verify",{method:"POST",body:JSON.stringify({email:invite.email,code})});await accept()})} onResend={()=>run(async()=>{await requestJson("/api/auth/resend",{method:"POST",body:JSON.stringify({email:invite.email,next:`/accept-invite?token=${encodeURIComponent(token)}`})})})}/><Button variant="ghost" onClick={()=>window.location.reload()}>I verified my email</Button></>:<form className="space-y-5" onSubmit={e=>{e.preventDefault();const f=new FormData(e.currentTarget);void run(async()=>{const result=await requestJson<{verificationRequired?:boolean}>(signup?"/api/auth/company-signup":"/api/auth/sign-in",{method:"POST",body:JSON.stringify({...Object.fromEntries(f.entries()),email:invite.email})});if(result.verificationRequired)setVerify(true);else await accept()})}}>
      <input type="hidden" name="next" value={token ? `/accept-invite?token=${encodeURIComponent(token)}` : "/onboarding"}/>
      {signup&&<Label className="grid gap-2">Your name<Input name="name" minLength={2} required/></Label>}<Label className="grid gap-2">Password<Input name="password" type="password" autoComplete={signup?"new-password":"current-password"} minLength={signup?12:1} required/></Label>
      <Button disabled={busy} className="w-full">{signup?"Create account and join":"Sign in and join"}</Button><Button type="button" variant="outline" className="w-full" onClick={()=>setSignup(!signup)}>{signup?"Use an existing account":"Create a new account"}</Button><a href={`/forgot-password?next=${encodeURIComponent(`/accept-invite?token=${encodeURIComponent(token)}`)}`} className="block text-sm underline">Recover an existing account</a>
    </form>}
  </AuthShell>
}
