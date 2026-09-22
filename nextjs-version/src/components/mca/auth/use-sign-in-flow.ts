"use client"
import { useEffect, useState } from "react"
import { requestJson } from "@/lib/mca/client"
import { authErrorMessage, currentAuthContinuation } from "@/lib/mca/auth-navigation"
export function useSignInFlow() {
  const [error,setError]=useState("")
  const [working,setWorking]=useState(false)
  const [codeSent,setCodeSent]=useState(false)
  const [email,setEmail]=useState("")
  useEffect(()=>{if(new URLSearchParams(window.location.search).has("error"))setError("Sign-in could not be completed. Please try again or request a new verification link.")},[])
  async function finish() {
    window.location.href=currentAuthContinuation()
  }
  async function run(action:()=>Promise<void>) {
    setWorking(true);setError("")
    try { await action() } catch(error) { setError(authErrorMessage(error)) } finally { setWorking(false) }
  }
  return { error,busy:working,codeSent,finish,run,
    password:(email:string,password:string)=>run(async()=>{ await requestJson("/api/auth/sign-in",{method:"POST",body:JSON.stringify({email,password})});await finish() }),
    sendCode:(email:string)=>run(async()=>{ setEmail(email);await requestJson("/api/auth/resend",{method:"POST",body:JSON.stringify({email,next:currentAuthContinuation()})});setCodeSent(true) }),
    verify:(code:string)=>run(async()=>{ await requestJson("/api/auth/verify",{method:"POST",body:JSON.stringify({email,code})});await finish() }),
  }
}
