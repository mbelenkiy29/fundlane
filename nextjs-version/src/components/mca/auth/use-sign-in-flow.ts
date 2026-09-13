"use client"
import { useState } from "react"
import { requestJson } from "@/lib/mca/client"
import { authErrorMessage, safeAuthReturnTo } from "@/lib/mca/auth-navigation"
export function useSignInFlow() {
  const [error,setError]=useState("")
  const [working,setWorking]=useState(false)
  const [codeSent,setCodeSent]=useState(false)
  const [email,setEmail]=useState("")
  async function finish() {
    const target=safeAuthReturnTo(new URLSearchParams(window.location.search).get("returnTo"))
    window.location.href=`/onboarding?returnTo=${encodeURIComponent(target)}`
  }
  async function run(action:()=>Promise<void>) {
    setWorking(true);setError("")
    try { await action() } catch(error) { setError(authErrorMessage(error)) } finally { setWorking(false) }
  }
  return { error,busy:working,codeSent,finish,run,
    password:(email:string,password:string)=>run(async()=>{ await requestJson("/api/auth/sign-in",{method:"POST",body:JSON.stringify({email,password})});await finish() }),
    sendCode:(email:string)=>run(async()=>{ setEmail(email);await requestJson("/api/auth/resend",{method:"POST",body:JSON.stringify({email})});setCodeSent(true) }),
    verify:(code:string)=>run(async()=>{ await requestJson("/api/auth/verify",{method:"POST",body:JSON.stringify({email,code})});await finish() }),
  }
}
