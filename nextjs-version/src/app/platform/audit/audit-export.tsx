"use client"
import {useState} from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { PlatformSection } from "@/components/mca/platform/presentation"

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
  return <PlatformSection title="Export audit records" description="Verify a fresh authenticator code before exporting these filtered records.">
    <div className="flex flex-wrap gap-2"><Input className="w-56" aria-label="Authenticator code" autoComplete="one-time-code" inputMode="numeric" value={code} onChange={event=>setCode(event.target.value)} placeholder="Authenticator code"/><Button type="button" disabled={busy||!code} onClick={stepUp}>Verify for export</Button></div>
    {message?<p role="status">{message}</p>:null}
    <form method="post" action="/api/platform/audit/export">
      {Object.entries(filters).map(([key,value])=><input key={key} type="hidden" name={key} value={value??""}/>)}
      <Button type="submit" variant="outline" disabled={!verified}>Export CSV</Button>
    </form>
  </PlatformSection>
}
