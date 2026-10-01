"use client"
import {useState} from "react"

export function AuditExport({filters}:{filters:{actor?:string;action?:string;workspace?:string;from?:string;to?:string}}) {
  const [code,setCode]=useState("")
  const [verified,setVerified]=useState(false)
  const [message,setMessage]=useState("")
  const [busy,setBusy]=useState(false)
  async function stepUp() {
    setBusy(true);setMessage("")
    try {
      const response=await fetch("/api/platform/step-up",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({code})})
      if (!response.ok) { const data=await response.json();throw new Error(data?.error?.message??"Verification failed.") }
      setVerified(true);setCode("");setMessage("Authenticator verified for a short period.")
    } catch (error) { setVerified(false);setMessage(error instanceof Error?error.message:"Verification failed.") }
    finally {setBusy(false)}
  }
  return <div className="space-y-2">
    <div className="flex gap-2"><input aria-label="Authenticator code" autoComplete="one-time-code" inputMode="numeric" value={code} onChange={event=>setCode(event.target.value)} placeholder="Authenticator code"/><button type="button" disabled={busy||!code} onClick={stepUp}>Verify for export</button></div>
    {message?<p role="status">{message}</p>:null}
    <form method="post" action="/api/platform/audit/export">
      {Object.entries(filters).map(([key,value])=><input key={key} type="hidden" name={key} value={value??""}/>)}
      <button type="submit" disabled={!verified}>Export CSV</button>
    </form>
  </div>
}
