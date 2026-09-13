"use client"
import { useState } from "react"
import { requestJson } from "@/lib/mca/client"
import { authErrorMessage } from "@/lib/mca/auth-navigation"
import { VerificationForm } from "@/components/mca/auth/verification-form"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from "@/components/ui/card"
export function SignupForm1(props: React.ComponentProps<"div">) {
  const [email,setEmail]=useState(""),[verify,setVerify]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState("")
  async function run(action:()=>Promise<void>) { setBusy(true);setError("");try { await action() } catch(e) {setError(authErrorMessage(e))} finally {setBusy(false)} }
  return <div {...props}><Card><CardHeader><CardTitle>{verify ? "Verify your email" : "Create your company workspace"}</CardTitle><CardDescription>{verify ? "Open the verification link in your email, or enter the code below if your email includes one." : "Create your account, verify your email, then set up your company and invite employees."}</CardDescription></CardHeader><CardContent>
    {error && <p role="alert" className="mb-4 text-destructive">{error}</p>}
    {verify ? <VerificationForm busy={busy} onVerify={code=>run(async()=>{await requestJson("/api/auth/verify",{method:"POST",body:JSON.stringify({email,code})});window.location.href="/onboarding?setup=1"})} onResend={()=>run(async()=>{await requestJson("/api/auth/resend",{method:"POST",body:JSON.stringify({email})})})} /> :
      <form className="space-y-4" onSubmit={e=>{e.preventDefault();const f=new FormData(e.currentTarget);void run(async()=>{const input=Object.fromEntries(f.entries());setEmail(String(input.email));const result=await requestJson<{verificationRequired:boolean}>("/api/auth/company-signup",{method:"POST",body:JSON.stringify(input)});if(result.verificationRequired)setVerify(true);else window.location.href="/onboarding?setup=1"})}}>
        {[["companyName","Company name","text"],["name","Your name","text"],["email","Email","email"],["password","Password (at least 12 characters)","password"]].map(([name,label,type])=><Label key={name} className="grid gap-2">{label}<Input name={name} type={type} required minLength={type==="password"?12:2} autoComplete={type==="password"?"new-password":type==="email"?"email":"off"}/></Label>)}
        <Label className="flex gap-2"><input type="checkbox" name="terms" required/>I agree to the terms of service and privacy policy.</Label>
        <Button disabled={busy} className="w-full">{busy?"Creating account…":"Create account"}</Button><a href="/sign-in" className="block text-sm underline">Already have an account? Sign in first.</a>
      </form>}
  </CardContent></Card></div>
}
