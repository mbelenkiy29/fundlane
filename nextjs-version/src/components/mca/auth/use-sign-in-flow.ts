"use client"
import { useEffect, useState } from "react"
import { requestJson } from "@/lib/mca/client"
import { authErrorMessage, currentAuthContinuation } from "@/lib/mca/auth-navigation"
export function useSignInFlow() {
  const [error,setError]=useState("")
  const [working,setWorking]=useState(false)
  const [codeSent,setCodeSent]=useState(false)
  const [mfaRequired,setMfaRequired]=useState(false)
  const [email,setEmail]=useState("")
  useEffect(()=>{if(new URLSearchParams(window.location.search).has("error"))setError("Sign-in could not be completed. Please try again or request a new verification link.")},[])
  async function finish() {
    window.location.href=currentAuthContinuation()
  }
  async function run(action:()=>Promise<void>) {
    setWorking(true);setError("")
    try { await action() } catch(error) { setError(authErrorMessage(error)) } finally { setWorking(false) }
  }
  return { error,busy:working,codeSent,mfaRequired,finish,run,clearError:()=>setError(""),
    password:(email:string,password:string)=>run(async()=>{ const result=await requestJson<{mfaRequired?:boolean}>("/api/auth/sign-in",{method:"POST",body:JSON.stringify({email,password})}); if(result.mfaRequired){ setMfaRequired(true); return } await finish() }),
    sendCode:(email:string)=>run(async()=>{ setEmail(email);await requestJson("/api/auth/resend",{method:"POST",body:JSON.stringify({email,next:currentAuthContinuation()})});setCodeSent(true) }),
    verify:(code:string)=>run(async()=>{ await requestJson("/api/auth/verify",{method:"POST",body:JSON.stringify({email,code})});await finish() }),
    verifyTotp:(code:string)=>run(async()=>{ await requestJson("/api/auth/mfa",{method:"POST",body:JSON.stringify({action:"challenge",code})});await finish() }),
  }
}
